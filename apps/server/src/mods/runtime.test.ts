import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContent } from '@openvibe/content'
import { openSqliteStore, type SqlitePersistenceStore } from '@openvibe/persistence/sqlite'
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
  return { enabled: true, types, enqueue: (e) => types.push(e.event_type) }
}

function setup(store: SqlitePersistenceStore = openSqliteStore(':memory:')) {
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const sink = captureSink()
  const registry = new ModRegistry(store, content, sink, clock.now)
  const runtime = new ModRuntime(registry, store, content, log, {
    reconcileEveryTicks: 30,
    now: clock.now,
  })
  return { store, registry, runtime, sink, clock }
}

describe('mod registry', () => {
  it('installs with the approved subset only and audits install + grants', () => {
    const { registry, sink } = setup()
    const view = registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    expect([...view.granted]).toEqual([CAP_PLACE_PROP])
    expect(registry.isGranted(MOD_ID, CAP_PLACE_PROP)).toBe(true)
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
    expect(
      registry
        .auditLog(MOD_ID)
        .map((a) => [a.action, a.capability])
        .reverse(),
    ).toEqual([
      ['install', null],
      ['grant', CAP_PLACE_PROP],
      ['enable', null],
    ])
    expect(sink.types).toEqual(['games.mod.installed'])
  })

  it('refuses grants that were not requested or have no binding', () => {
    const { registry } = setup()
    const manifest = sampleManifest({
      permissions: { capabilities: [CAP_ANNOUNCE, 'media.object.read'] },
    })
    expect(() =>
      registry.install({ manifest, pack: {}, approve: [CAP_PLACE_PROP] }, STAFF),
    ).toThrow(ModError)
    expect(() =>
      registry.install({ manifest, pack: {}, approve: ['media.object.read'] }, STAFF),
    ).toThrow(/no binding/)
    // A pack section needs its capability to at least be requested.
    expect(() =>
      registry.install({ manifest, pack: { props: PACK.props }, approve: [] }, STAFF),
    ).toThrow(/does not request/)
  })

  it('never lets a trust tier stand in for a grant', () => {
    const { registry } = setup()
    registry.install(
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

  it('refuses executable runtimes until sandboxed execution exists', () => {
    const { registry } = setup()
    expect(() =>
      registry.install(
        { manifest: sampleManifest({ runtime: 'source-quickjs@1' }), pack: {}, approve: [] },
        STAFF,
      ),
    ).toThrow(/cannot run here/)
  })
})

describe('mod runtime seam', () => {
  it('a denied capability cannot be reached: the binding throws and the host is never called', () => {
    const { registry, runtime, clock } = setup()
    registry.install(
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
    const denials = registry.auditLog(MOD_ID).filter((a) => a.action === 'deny')
    expect(denials.map((a) => a.capability)).toEqual([CAP_ANNOUNCE])
  })

  it('places the pack, and a revoked mod stops affecting the world on the next tick', () => {
    const { registry, runtime, clock, sink } = setup()
    registry.install(
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

    registry.revoke(MOD_ID, STAFF, 'test')
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
    expect(() => registry.enable(MOD_ID, STAFF)).toThrow(/stays revoked/)
    expect(() => registry.grant(MOD_ID, CAP_ANNOUNCE, STAFF)).toThrow(/revoked/)

    const actions = registry.auditLog(MOD_ID).map((a) => a.action)
    for (const a of ['install', 'grant', 'use', 'revoke_grant', 'revoke', 'retract']) {
      expect(actions, a).toContain(a)
    }
    expect(sink.types).toEqual(['games.mod.installed', 'games.mod.revoked'])
  })

  it('revoking one capability retracts only what it allowed', () => {
    const { registry, runtime, sink } = setup()
    registry.install(
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
    registry.revokeGrant(MOD_ID, CAP_PLACE_PROP, STAFF)
    runtime.tick(2, host)
    expect(entities.size).toBe(0)
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(true)
    registry.grant(MOD_ID, CAP_PLACE_PROP, STAFF)
    runtime.tick(3, host)
    expect(entities.size).toBe(2)
    expect(sink.types).toEqual([
      'games.mod.installed',
      'games.mod.grants_changed',
      'games.mod.grants_changed',
    ])
  })

  it('disable retracts, enable restores, and a missing prop is placed again', () => {
    const { registry, runtime } = setup()
    registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    const { host, entities } = fakeHost()
    runtime.tick(1, host)
    registry.disable(MOD_ID, STAFF)
    runtime.tick(2, host)
    expect(entities.size).toBe(0)
    registry.enable(MOD_ID, STAFF)
    runtime.tick(3, host)
    expect(entities.size).toBe(2)
    const [first] = [...entities.keys()]
    entities.delete(first!)
    runtime.tick(4, host) // not a registry change: waits for the once-a-second reconcile
    expect(entities.size).toBe(1)
    runtime.tick(3 + 30, host)
    expect(entities.size).toBe(2)
  })

  it('revocation survives a restart: the next boot retracts what the old process left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openvibe-mods-'))
    const path = join(dir, 'world.db')
    const a = setup(openSqliteStore(path))
    a.registry.install(
      { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
      STAFF,
    )
    const world = fakeHost()
    a.runtime.tick(1, world.host)
    expect(world.entities.size).toBe(2)
    a.registry.revoke(MOD_ID, STAFF)
    // The process dies before its next tick: the props are still in the world.
    a.store.close()
    expect(world.entities.size).toBe(2)

    const b = setup(openSqliteStore(path))
    expect(b.registry.get(MOD_ID)?.mod.status).toBe('revoked')
    b.runtime.tick(1, world.host)
    expect(world.entities.size).toBe(0)
    b.store.close()
  })
})
