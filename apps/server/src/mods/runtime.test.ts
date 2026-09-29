import { createContent } from '@openvibe/content'
import type { PgPersistenceStore } from '@openvibe/persistence'
import { openTestStore } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import type { EventSink } from '../platform/gameEvents.js'
import { CAP_ANNOUNCE, CAP_PLACE_PROP } from './contentPack.js'
import { ModError, ModRegistry, type ModActor } from './registry.js'
import { ModCapabilityError, ModRuntime, type ModHost } from './runtime.js'
import { MOD_ID, sampleManifest } from './testFixtures.js'

const STAFF: ModActor = {
  audit: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
  subject: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
}
const content = createContent()
const log = createConsoleLogger({ app: 'test' }, 'error')

const PACK = {
  announcements: [{ text: 'Welcome to the square', everySeconds: 60 }],
  props: [
    { key: 'bench', item: 'workbench', pos: [10, 0, 10] as [number, number, number], yaw: 0 },
    { key: 'fire', item: 'campfire', pos: [12, 0, 10] as [number, number, number] },
  ],
}

/** The world as the runtime sees it: a map of entities plus what was said. */
function fakeHost() {
  const entities = new Map<string, { item: string; owner: string }>()
  const said: string[] = []
  let n = 0
  const host: ModHost = {
    announce: (text) => said.push(text),
    placeProp: ({ item, owner }) => {
      const id = `ent_${++n}`
      entities.set(id, { item, owner })
      return id
    },
    removeEntity: (id) => entities.delete(id),
    entityExists: (id) => entities.has(id),
  }
  return { host, entities, said }
}

function captureSink(): EventSink & { types: string[] } {
  const types: string[] = []
  return {
    enabled: true,
    types,
    enqueue: async (_t, e) => {
      types.push(e.event_type)
    },
  }
}

/** A store whose mods.setStatus rejects while `fail()` is true (the disable write never lands). */
function failingDisableStore(store: PgPersistenceStore, fail: () => boolean): PgPersistenceStore {
  const wrapped = Object.create(store) as PgPersistenceStore
  Object.defineProperty(wrapped, 'mods', {
    value: new Proxy(store.mods, {
      get(target, prop, receiver) {
        if (prop === 'setStatus') {
          return async (...args: unknown[]): Promise<void> => {
            if (fail()) throw new Error('db down')
            return (target.setStatus as (...a: unknown[]) => Promise<void>)(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }),
  })
  return wrapped
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function setup(store?: PgPersistenceStore) {
  const db = store ?? (await openTestStore())
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const sink = captureSink()
  const registry = new ModRegistry(db, content, sink, clock.now)
  const runtime = new ModRuntime(registry, content, log, {
    reconcileEveryTicks: 30,
    now: clock.now,
  })
  return { store: db, registry, runtime, sink, clock }
}

describe('mod registry', () => {
  it('installs with the approved subset only and audits install + grants', async () => {
    const { registry, sink } = await setup()
    const view = await registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    expect([...view.granted]).toEqual([CAP_PLACE_PROP])
    expect(registry.isGranted(MOD_ID, CAP_PLACE_PROP)).toBe(true)
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
    expect(
      (await registry.auditLog(MOD_ID)).map((a) => [a.action, a.capability]).reverse(),
    ).toEqual([
      ['install', null],
      ['grant', CAP_PLACE_PROP],
      ['enable', null],
    ])
    expect(sink.types).toEqual(['games.mod.installed'])
  })

  it('refuses grants that were not requested or have no binding', async () => {
    const { registry } = await setup()
    const manifest = sampleManifest({
      permissions: { capabilities: [CAP_ANNOUNCE, 'media.object.read'] },
    })
    await expect(
      registry.install({ manifest, pack: {}, approve: [CAP_PLACE_PROP] }, STAFF),
    ).rejects.toThrow(ModError)
    await expect(
      registry.install({ manifest, pack: {}, approve: ['media.object.read'] }, STAFF),
    ).rejects.toThrow(/no binding/)
    // A pack section needs its capability to at least be requested.
    await expect(
      registry.install({ manifest, pack: { props: PACK.props }, approve: [] }, STAFF),
    ).rejects.toThrow(/does not request/)
  })

  it('never lets a trust tier stand in for a grant', async () => {
    const { registry } = await setup()
    await registry.install(
      {
        manifest: sampleManifest(),
        pack: PACK,
        approve: [],
        trustTier: 'first-party',
        enable: true,
      },
      STAFF,
    )
    expect(registry.get(MOD_ID)?.mod.trustTier).toBe('first-party')
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
    expect(registry.isGranted(MOD_ID, CAP_PLACE_PROP)).toBe(false)
  })

  it('refuses executable runtimes until sandboxed execution exists', async () => {
    const { registry } = await setup()
    await expect(
      registry.install(
        { manifest: sampleManifest({ runtime: 'source-quickjs@1' }), pack: {}, approve: [] },
        STAFF,
      ),
    ).rejects.toThrow(/cannot run here/)
  })
})

describe('mod runtime seam', () => {
  it('a denied capability cannot be reached: the binding throws and the host is never called', async () => {
    const { registry, runtime, clock } = await setup()
    await registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    const { host, said } = fakeHost()
    const api = runtime.bindingsFor(MOD_ID, host)
    expect(() => api.announce('hello')).toThrow(ModCapabilityError)
    expect(said).toEqual([])
    // The API object is all a mod gets: frozen, no host or registry on it.
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.keys(api).sort()).toEqual(['announce', 'modId', 'placeProp', 'removeProp'])
    expect(() => {
      ;(api as unknown as Record<string, unknown>).announce = () => host.announce('bypass')
    }).toThrow(TypeError)
    expect(() => api.announce('hello')).toThrow(ModCapabilityError)
    expect(said).toEqual([])

    // The pack's announcements are denied every time they come due, and audited once.
    runtime.tick(1, host)
    for (let t = 2; t < 400; t++) {
      clock.advance(10_000)
      runtime.tick(t, host)
    }
    expect(said).toEqual([])
    await registry.flushWrites()
    const denials = (await registry.auditLog(MOD_ID)).filter((a) => a.action === 'deny')
    expect(denials.map((a) => a.capability)).toEqual([CAP_ANNOUNCE])
  })

  it('places the pack, and a revoked mod stops affecting the world on the next tick', async () => {
    const { registry, runtime, clock, sink } = await setup()
    await registry.install(
      {
        manifest: sampleManifest(),
        pack: PACK,
        approve: [CAP_PLACE_PROP, CAP_ANNOUNCE],
        enable: true,
      },
      STAFF,
    )
    const { host, entities, said } = fakeHost()
    runtime.tick(1, host)
    expect([...entities.values()]).toEqual([
      { item: 'workbench', owner: MOD_ID },
      { item: 'campfire', owner: MOD_ID },
    ])
    clock.advance(61_000)
    runtime.tick(31, host)
    expect(said).toEqual(['[Town Square] Welcome to the square'])

    await registry.revoke(MOD_ID, STAFF, 'test')
    runtime.tick(32, host) // the very next tick
    expect(entities.size).toBe(0)
    clock.advance(600_000)
    for (let t = 33; t < 200; t++) runtime.tick(t, host)
    expect(said).toHaveLength(1)
    expect(entities.size).toBe(0)
    expect(() => runtime.bindingsFor(MOD_ID, host).placeProp('x', 'workbench', [0, 0, 0])).toThrow(
      ModCapabilityError,
    )
    // Revoked is terminal.
    await expect(registry.enable(MOD_ID, STAFF)).rejects.toThrow(/stays revoked/)
    await expect(registry.grant(MOD_ID, CAP_ANNOUNCE, STAFF)).rejects.toThrow(/revoked/)

    await registry.flushWrites()
    const actions = (await registry.auditLog(MOD_ID)).map((a) => a.action)
    for (const a of ['install', 'grant', 'use', 'revoke_grant', 'revoke', 'retract']) {
      expect(actions, a).toContain(a)
    }
    expect(sink.types).toEqual(['games.mod.installed', 'games.mod.revoked'])
  })

  it('revoking one capability retracts only what it allowed', async () => {
    const { registry, runtime, sink } = await setup()
    await registry.install(
      {
        manifest: sampleManifest(),
        pack: PACK,
        approve: [CAP_PLACE_PROP, CAP_ANNOUNCE],
        enable: true,
      },
      STAFF,
    )
    const { host, entities } = fakeHost()
    runtime.tick(1, host)
    expect(entities.size).toBe(2)
    await registry.revokeGrant(MOD_ID, CAP_PLACE_PROP, STAFF)
    runtime.tick(2, host)
    expect(entities.size).toBe(0)
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(true)
    await registry.grant(MOD_ID, CAP_PLACE_PROP, STAFF)
    runtime.tick(3, host)
    expect(entities.size).toBe(2)
    expect(sink.types).toEqual([
      'games.mod.installed',
      'games.mod.grants_changed',
      'games.mod.grants_changed',
    ])
  })

  it('disable retracts, enable restores, and a missing prop is placed again', async () => {
    const { registry, runtime } = await setup()
    await registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    const { host, entities } = fakeHost()
    runtime.tick(1, host)
    await registry.disable(MOD_ID, STAFF)
    runtime.tick(2, host)
    expect(entities.size).toBe(0)
    await registry.enable(MOD_ID, STAFF)
    runtime.tick(3, host)
    expect(entities.size).toBe(2)
    const [first] = [...entities.keys()]
    entities.delete(first!)
    runtime.tick(4, host) // not a registry change: waits for the once-a-second reconcile
    expect(entities.size).toBe(1)
    runtime.tick(3 + 30, host)
    expect(entities.size).toBe(2)
    await registry.flushWrites()
  })

  it('a failed disable write keeps an over-budget mod running: strikes are not cleared', async () => {
    const store = await openTestStore()
    let fail = true
    const { registry, runtime } = await setup(failingDisableStore(store, () => fail))
    await registry.install(
      {
        manifest: sampleManifest({ resources: { cpuMs: 0, memoryMb: 0, storageMb: 0 } }),
        pack: PACK,
        approve: [CAP_PLACE_PROP, CAP_ANNOUNCE],
        enable: true,
      },
      STAFF,
    )
    const { host } = fakeHost()
    // Drive enough reconciles for CPU_STRIKES to trip the budget; let each failed disable settle so the
    // next reconcile enforces again instead of being suppressed as already in flight.
    for (let t = 1; t <= 200; t += 30) {
      runtime.tick(t, host)
      await settle()
    }
    await registry.flushWrites()
    expect(registry.isActive(MOD_ID)).toBe(true) // the disable never landed
    const enforced = (await registry.auditLog(MOD_ID)).filter(
      (a) => a.action === 'budget_enforced',
    ).length
    expect(enforced).toBeGreaterThanOrEqual(2) // it kept being enforced, not reset to a clean slate

    // The write lands now: the next reconcile disables it for good.
    fail = false
    for (const t of [211, 241, 271, 301]) {
      runtime.tick(t, host)
      await settle()
    }
    expect(registry.isActive(MOD_ID)).toBe(false)
    await registry.flushWrites()
  })

  it('a placement write that keeps failing rolls the mirror back and the next tick re-places', async () => {
    const store = await openTestStore()
    let fail = true
    const wrapped = {
      ...store,
      mods: {
        ...store.mods,
        setPlacement: async (placement: Parameters<typeof store.mods.setPlacement>[0]) => {
          if (fail) throw new Error('db down')
          await store.mods.setPlacement(placement)
        },
      },
    } as PgPersistenceStore
    const { registry, runtime } = await setup(wrapped)
    await registry.install(
      {
        manifest: sampleManifest(),
        pack: PACK,
        approve: [CAP_PLACE_PROP, CAP_ANNOUNCE],
        enable: true,
      },
      STAFF,
    )
    const { host } = fakeHost()
    runtime.tick(1, host)
    await registry.flushWrites()
    // The writes gave up: the mirror was rolled back so it agrees with the database (empty).
    expect(registry.placements(MOD_ID)).toEqual([])
    expect(registry.writeFailures).toBeGreaterThanOrEqual(1)
    expect(await store.mods.placements(MOD_ID)).toEqual([])

    // The database recovers: the next reconcile places the props again and the rows land.
    fail = false
    runtime.tick(31, host)
    await registry.flushWrites()
    expect(
      registry
        .placements(MOD_ID)
        .map((p) => p.key)
        .sort(),
    ).toEqual(['bench', 'fire'])
    expect((await store.mods.placements(MOD_ID)).map((p) => p.key).sort()).toEqual([
      'bench',
      'fire',
    ])
  })

  it('revocation survives a restart: the next boot retracts what the old process left', async () => {
    const store = await openTestStore()
    const a = await setup(store)
    await a.registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    const world = fakeHost()
    a.runtime.tick(1, world.host)
    expect(world.entities.size).toBe(2)
    await a.registry.revoke(MOD_ID, STAFF)
    // The process dies before its next tick: the props are still in the world.
    await a.registry.flushWrites()
    expect(world.entities.size).toBe(2)

    const b = await setup(store)
    await b.registry.load()
    expect(b.registry.get(MOD_ID)?.mod.status).toBe('revoked')
    b.runtime.tick(1, world.host)
    expect(world.entities.size).toBe(0)
    await b.registry.flushWrites()
  })
})
