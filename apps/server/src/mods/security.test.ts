import { createContent } from '@openvibe/content'
import { openTestStore } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { describe, expect, it, vi } from 'vitest'
import { CAP_ANNOUNCE, CAP_PLACE_PROP, placeableByMod, validateContentPack } from './contentPack.js'
import { ModRegistry, type ModActor } from './registry.js'
import {
  CPU_STRIKES,
  FLOOD_WINDOWS,
  ModRuntime,
  ModThrottledError,
  type ModHost,
} from './runtime.js'
import { sampleManifest } from './testFixtures.js'

/**
 * Mod security (roadmap WS-M tasks 4 and 5, ADR-013):
 *   namespace escape   a mod reaches only its own placements, through frozen bindings, with items a player cannot
 *                      loot or use to move items; nothing in a pack can name another owner
 *   event flood        host effects past the minute's allowance are refused, and a sustained flood disables only
 *                      that mod
 *   resource budget    a mod over its declared CPU budget reconcile after reconcile is disabled; the others run
 *   forged ownership   every prop a mod places is owned by that mod, whatever the pack says; an unknown or
 *                      another runtime's principal changes nothing here
 */
const STAFF: ModActor = {
  audit: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
  subject: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
}
const content = createContent()
const log = createConsoleLogger({ app: 'test' }, 'error')
const A = 'mod_01JABCDEFGHJKMNPQRSTVWXYZA'
const B = 'mod_01JABCDEFGHJKMNPQRSTVWXYZB'

function world(opts: { slowMs?: number } = {}) {
  const entities = new Map<string, { item: string; owner: string }>()
  const said: string[] = []
  let n = 0
  const host: ModHost = {
    announce: (text) => said.push(text),
    placeProp: ({ item, owner }) => {
      if (opts.slowMs) {
        const until = performance.now() + opts.slowMs
        while (performance.now() < until) {
          // a pack that is expensive to run
        }
      }
      const id = `ent_${++n}`
      entities.set(id, { item, owner })
      return id
    },
    removeEntity: (id) => entities.delete(id),
    entityExists: (id) => entities.has(id),
  }
  return { host, entities, said }
}

async function setup(effectsPerMinute = 60) {
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const store = await openTestStore()
  const registry = new ModRegistry(store, content, undefined, clock.now)
  const runtime = new ModRuntime(registry, content, log, {
    reconcileEveryTicks: 1,
    now: clock.now,
    effectsPerMinute,
  })
  const install = (id: string, pack: unknown, approve: string[], cpuMs = 50) =>
    registry.install(
      {
        manifest: sampleManifest({ id, resources: { cpuMs, memoryMb: 0, storageMb: 0 } }),
        pack,
        approve,
        enable: true,
      },
      STAFF,
    )
  return { store, registry, runtime, clock, install }
}

const prop = (key: string, pos: [number, number, number] = [10, 0, 10]) => ({
  key,
  item: 'workbench',
  pos,
})

describe('mod security', () => {
  it('namespace escape: a mod reaches only its own placements, through frozen bindings', async () => {
    const { registry, runtime, install } = await setup()
    const w = world()
    await install(A, { props: [prop('bench')] }, [CAP_PLACE_PROP])
    await install(B, { props: [prop('bench', [20, 0, 20])] }, [CAP_PLACE_PROP])
    runtime.tick(1, w.host)
    expect([...w.entities.values()].map((e) => e.owner).sort()).toEqual([A, B])
    const apiA = runtime.bindingsFor(A, w.host)
    expect(Object.isFrozen(apiA)).toBe(true)
    expect(() => {
      ;(apiA as unknown as Record<string, unknown>).placeProp = () => 'x'
    }).toThrow()
    // The same key under B is B's: A removing "bench" removes only its own.
    expect(apiA.removeProp('bench')).toBe(true)
    expect([...w.entities.values()].map((e) => e.owner)).toEqual([B])
    expect(apiA.removeProp('bench')).toBe(false)
    await registry.flushWrites()
    expect(
      (await registry.auditLog(B)).some(
        (a) => a.action === 'use' && JSON.stringify(a.detail ?? {}).includes('removed'),
      ),
    ).toBe(false)
    // Only inert items: anything with health, storage, a shop, a machine or a vehicle part is refused, at install
    // and at the binding.
    const loot = content.allItems().find((i) => placeableByMod(content, i.id) !== null)
    expect(loot).toBeDefined()
    expect(
      validateContentPack({ props: [{ key: 'x', item: loot!.id, pos: [0, 0, 0] }] }, content).ok,
    ).toBe(false)
    expect(() => apiA.placeProp('x', loot!.id, [0, 0, 0])).toThrow(/not allowed/)
  })

  it('event flood: past the allowance calls are refused, and only the flooding mod is disabled', async () => {
    const { registry, runtime, clock, install } = await setup(10)
    const w = world()
    await install(A, { announcements: [{ text: 'spam', everySeconds: 60 }] }, [CAP_ANNOUNCE])
    await install(B, { announcements: [{ text: 'hello', everySeconds: 60 }] }, [CAP_ANNOUNCE])
    const apiA = runtime.bindingsFor(A, w.host)
    const apiB = runtime.bindingsFor(B, w.host)
    let refused = 0
    for (let i = 0; i < 25; i++) {
      try {
        apiA.announce(`spam ${i}`)
      } catch (err) {
        if (err instanceof ModThrottledError) refused++
      }
    }
    expect(w.said.length).toBe(10)
    expect(refused).toBe(15)
    await registry.flushWrites()
    expect((await registry.auditLog(A)).filter((a) => a.action === 'throttled').length).toBe(1)
    apiB.announce('still here')
    expect(w.said.at(-1)).toContain('still here')
    // Flooding minute after minute: the mod is disabled, the other is not.
    for (let minute = 0; minute < FLOOD_WINDOWS; minute++) {
      clock.advance(60_000)
      for (let i = 0; i < 12; i++) {
        try {
          apiA.announce('spam')
        } catch {
          // refused
        }
      }
    }
    // The disable the flood triggers is a fire-and-forget registry write; wait for it to commit.
    await vi.waitFor(() => expect(registry.get(A)?.mod.status).toBe('disabled'))
    await registry.flushWrites()
    expect(
      (await registry.auditLog(A)).some(
        (a) => a.action === 'budget_enforced' && JSON.stringify(a.detail).includes('event_flood'),
      ),
    ).toBe(true)
    expect(registry.get(B)?.mod.status).toBe('enabled')
    expect(() => apiA.announce('after')).toThrow()
  })

  it('resource budget: a mod over its CPU budget reconcile after reconcile is disabled; the others run', async () => {
    const { registry, runtime, install } = await setup()
    const slow = world({ slowMs: 3 })
    await install(A, { props: [prop('bench')] }, [CAP_PLACE_PROP], 1)
    await install(B, { props: [] }, [], 50)
    // A's prop keeps vanishing, so every reconcile places it again: slow, over its 1 ms budget.
    for (let t = 1; t <= CPU_STRIKES + 2; t++) {
      slow.entities.clear()
      runtime.tick(t, slow.host)
    }
    // The disable the budget triggers is a fire-and-forget registry write; wait for it to commit.
    await vi.waitFor(() => expect(registry.get(A)?.mod.status).toBe('disabled'))
    await registry.flushWrites()
    const enforced = (await registry.auditLog(A)).find((a) => a.action === 'budget_enforced')
    expect(enforced?.detail).toMatchObject({ reason: 'cpu', budget_ms: 1, reconciles: CPU_STRIKES })
    expect(registry.get(B)?.mod.status).toBe('enabled')
    // Disabled means retracted on the next reconcile.
    runtime.tick(CPU_STRIKES + 3, slow.host)
    expect([...slow.entities.values()].filter((e) => e.owner === A)).toEqual([])
    await registry.flushWrites()
  })

  it("forged ownership: props are the mod's whatever the pack says; unknown or foreign principals change nothing", async () => {
    const { registry, runtime, install } = await setup()
    const w = world()
    expect(
      validateContentPack(
        { props: [{ ...prop('x'), owner: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' }] },
        content,
      ).ok,
    ).toBe(false)
    await install(A, { props: [prop('bench')] }, [CAP_PLACE_PROP])
    runtime.tick(1, w.host)
    expect([...w.entities.values()]).toEqual([{ item: 'workbench', owner: A }])
    // A principal Games does not have, or that another runtime owns, is not applied here.
    expect(
      await registry.applyNetwork({
        mod_id: B,
        status: 'active',
        approved: [CAP_PLACE_PROP, CAP_ANNOUNCE],
      }),
    ).toBeNull()
    expect(registry.get(B)).toBeNull()
    // A grant the manifest never requested cannot be applied, even from Network.
    const manifestA = sampleManifest({ id: A, permissions: { capabilities: [CAP_PLACE_PROP] } })
    expect(manifestA.permissions.capabilities).not.toContain('games.world.teleport')
    await registry.applyNetwork({
      mod_id: A,
      status: 'active',
      approved: [CAP_PLACE_PROP, 'games.world.teleport'],
    })
    expect([...(registry.get(A)?.granted ?? [])]).toEqual([CAP_PLACE_PROP])
  })
})
