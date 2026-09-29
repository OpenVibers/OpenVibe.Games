/**
 * The write-behind flusher (ADR-0007 decision 5): the tick hands over a copy-on-write snapshot and
 * never awaits I/O; one transaction runs at a time; a failed transaction restores the dirtiness; a
 * disconnect save lands after an earlier checkpoint of the same character; shutdown drains.
 */
import { describe, expect, it } from 'vitest'
import { createContent } from '@openvibe/content'
import { openTestStore } from '@openvibe/persistence/testing'
import type {
  ConstraintDto,
  PersistenceStore,
  PlayerDto,
  WorldEntityDto,
} from '@openvibe/persistence'
import type { ConstraintId, BodyId, PhysicsWorld } from '@openvibe/physics'
import { createConsoleLogger } from '@openvibe/shared'
import { quat, vec3 } from '@openvibe/shared'
import { sql, type Tx } from 'openvibe-sdk/db'
import { createPgOutbox } from 'openvibe-sdk/events'
import { ServerMetrics } from '../observability/metrics.js'
import { GameEventRecorder, outboxSink } from '../platform/gameEvents.js'
import type { EventPlayer, ProgressSnapshot } from '../platform/gameEvents.js'
import { RegionTracker } from '@openvibe/gameplay'
import { Flusher, type FlushCharacter, type FlushPayload } from './flusher.js'
import { GameWorld } from './gameWorld.js'
import { NpcManager } from './npcManager.js'

const log = createConsoleLogger({ app: 'flusher-test' }, 'error')

/** A PhysicsWorld that keeps no simulation — enough to build a GameWorld and spawn entities. */
function stubPhysics(): PhysicsWorld {
  let n = 0
  const id = (p: string) => `${p}${++n}` as unknown as BodyId
  return {
    step: () => {},
    addBody: () => id('b'),
    removeBody: () => {},
    getTransform: () => {},
    setTransform: () => {},
    setMotionType: () => {},
    getLinearVelocity: () => {},
    setLinearVelocity: () => {},
    getAngularVelocity: () => {},
    setAngularVelocity: () => {},
    isSettled: () => true,
    wake: () => {},
    addConstraint: () => `c${++n}` as unknown as ConstraintId,
    removeConstraint: () => {},
    setConstraintMotor: () => {},
    applyForce: () => {},
    raycast: () => null,
    sweepCapsule: () => null,
    dispose: () => {},
  }
}

function entityDto(id: string): WorldEntityDto {
  return {
    id,
    kind: 'prop',
    defId: 'wooden_crate',
    ownerId: null,
    pos: [1, 2, 3],
    rot: [0, 0, 0, 1],
    motion: 'frozen',
    state: null,
    updatedAt: 1,
  }
}

function constraintDto(id: string): ConstraintDto {
  return { id, type: 'weld', entityA: 'a', entityB: 'b', params: null, updatedAt: 1 }
}

function playerDto(id: string, name: string, token = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'): PlayerDto {
  return {
    id,
    token,
    name,
    pos: [0, 1, 0],
    yaw: 0,
    inventory: { size: 24, hotbar: 6, slots: [] },
    skills: {},
    friends: [],
    appearance: null,
    charSlot: 0,
    armor: null,
    reputation: {},
    unlocks: [],
    activeJob: null,
    stats: null,
    updatedAt: 1,
  }
}

const fakeSession = {} as unknown as FlushCharacter['session']
const eventPlayerOf = (id: string, name: string, subjectId: string | null = null): EventPlayer => ({
  playerId: id,
  slot: 0,
  name,
  subjectId,
})
const emptyProgress: ProgressSnapshot = { levels: {}, unlocks: [] }

function character(dto: PlayerDto): FlushCharacter {
  return {
    session: fakeSession,
    dto,
    player: eventPlayerOf(dto.id, dto.name, dto.subjectId ?? null),
    progress: emptyProgress,
  }
}

function payload(over: Partial<FlushPayload> = {}): FlushPayload {
  return {
    reason: 'checkpoint',
    leaving: false,
    worldSaved: false,
    meta: {},
    entityUpserts: [],
    entityDeletes: [],
    npcUpserts: [],
    constraintUpserts: [],
    constraintDeletes: [],
    characters: [],
    worldSavedCount: 0,
    restore: () => {},
    ...over,
  }
}

/** Wraps a store, delaying every transaction so a checkpoint's job stays in flight. */
function slowStore(store: PersistenceStore, ms: number): PersistenceStore {
  const wrapped = Object.create(store) as PersistenceStore
  Object.defineProperty(wrapped, 'transaction', {
    value: async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
      await new Promise((r) => setTimeout(r, ms))
      return store.transaction(fn)
    },
  })
  return wrapped
}

/** Counts transactions and lets one (or the next) fail. */
function flakyStore(
  store: PersistenceStore,
  fail: () => boolean,
): { store: PersistenceStore; txCount: () => number } {
  let count = 0
  const wrapped = Object.create(store) as PersistenceStore
  Object.defineProperty(wrapped, 'transaction', {
    value: async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
      count++
      if (fail()) throw new Error('db down')
      return store.transaction(fn)
    },
  })
  return { store: wrapped, txCount: () => count }
}

function fakeEvents() {
  let id = 0
  let seq = 0
  return {
    prepare: (envelope: Record<string, unknown>) => ({ ...envelope, event_id: `evt_${++id}` }),
    publish: async (envelopes: unknown) => {
      const list = Array.isArray(envelopes) ? envelopes : [envelopes]
      return {
        results: list.map((e) => ({ event_id: (e as { event_id: string }).event_id, seq: ++seq })),
      }
    },
  }
}

describe('write-behind flusher', () => {
  it('a final (shutdown) checkpoint behind one in flight is queued, not coalesced', async () => {
    const store = await openTestStore()
    const flusher = new Flusher(slowStore(store, 100), new ServerMetrics(), log, undefined)
    flusher.checkpoint(() => payload({ entityUpserts: [entityDto('early')] }))
    flusher.checkpoint(() => payload({ entityUpserts: [entityDto('coalesced')] }))
    flusher.checkpoint(() => payload({ entityUpserts: [entityDto('final')] }), { final: true })
    expect(await flusher.drain()).toBe(true)
    const ids = (await store.worldEntities.loadAll()).map((e) => e.id).sort()
    expect(ids).toEqual(['early', 'final'])
  })

  it('drain gives up at its deadline while a transaction hangs', async () => {
    const store = await openTestStore()
    const flusher = new Flusher(slowStore(store, 2000), new ServerMetrics(), log, undefined)
    flusher.checkpoint(() => payload({ entityUpserts: [entityDto('slow')] }))
    const t0 = performance.now()
    expect(await flusher.drain(100)).toBe(false)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(await flusher.drain()).toBe(true)
  })

  it('a failed disconnect save is retried in place until it lands', async () => {
    const store = await openTestStore()
    let failuresLeft = 2
    const { store: flaky, txCount } = flakyStore(store, () => failuresLeft-- > 0)
    const flusher = new Flusher(flaky, new ServerMetrics(), log, undefined)
    flusher.savePlayer(
      payload({ characters: [character(playerDto('p-retry', 'Retry'))], leaving: true }),
      () => false,
      [10, 10, 10],
    )
    expect(await flusher.drain()).toBe(true)
    expect(txCount()).toBe(3)
    expect((await store.players.findById('p-retry'))?.name).toBe('Retry')
  })

  it('a failed disconnect save stops retrying once the character is back online', async () => {
    const store = await openTestStore()
    const { store: flaky, txCount } = flakyStore(store, () => true)
    const flusher = new Flusher(flaky, new ServerMetrics(), log, undefined)
    let restored = 0
    flusher.savePlayer(
      payload({ characters: [character(playerDto('p-back', 'Back'))], restore: () => restored++ }),
      () => true,
      [10, 10, 10],
    )
    expect(await flusher.drain()).toBe(true)
    expect(txCount()).toBe(1)
    expect(restored).toBe(1)
  })

  it('(a) checkpoint returns synchronously while a slow transaction is pending', async () => {
    const store = await openTestStore()
    const metrics = new ServerMetrics()
    const flusher = new Flusher(slowStore(store, 150), metrics, log, undefined)
    let built = 0
    const t0 = performance.now()
    flusher.checkpoint(() => {
      built++
      return payload({ entityUpserts: [entityDto('e1')] })
    })
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(50) // returned before the transaction finished
    expect(built).toBe(1)
    expect(flusher.pending).toBe(1)
    await flusher.drain()
    expect(await store.worldEntities.loadAll()).toHaveLength(1)
    expect(metrics.persistRowsWritten).toBe(1)
  })

  it('(b) a failed transaction restores dirtiness and the next checkpoint writes it', async () => {
    const store = await openTestStore()
    let failuresLeft = 1
    const { store: flaky } = flakyStore(store, () => failuresLeft-- > 0)
    const flusher = new Flusher(flaky, new ServerMetrics(), log, undefined)

    const restored: string[] = []
    let sessionsDirty = 0
    // The snapshot's rows (a real GameWorld clears its dirty flags and put them back in restore; the
    // contract tested here is that the flusher calls restore on failure and retries from a fresh build).
    const build = (): FlushPayload =>
      payload({
        entityUpserts: [entityDto('e1')],
        entityDeletes: ['gone'],
        constraintUpserts: [constraintDto('c1')],
        characters: [character(playerDto('p1', 'Scrapper'))],
        restore: () => {
          restored.push('restore')
          sessionsDirty++
        },
      })

    flusher.checkpoint(build)
    await flusher.drain()
    expect(restored).toEqual(['restore'])
    expect(sessionsDirty).toBe(1)
    expect(await store.worldEntities.loadAll()).toHaveLength(0)

    // The next checkpoint carries the restored rows.
    flusher.checkpoint(build)
    await flusher.drain()
    expect((await store.worldEntities.loadAll()).map((e) => e.id)).toEqual(['e1'])
    expect((await store.constraints.loadAll()).map((c) => c.id)).toEqual(['c1'])
    expect((await store.players.findById('p1'))?.name).toBe('Scrapper')
    expect(restored).toEqual(['restore']) // a successful flush does not restore
  })

  it('(c) coalesces checkpoints: at most one extra transaction', async () => {
    const store = await openTestStore()
    const { store: counted, txCount } = flakyStore(store, () => false)
    const flusher = new Flusher(slowStore(counted, 100), new ServerMetrics(), log, undefined)
    let built = 0
    const build = () => {
      built++
      return payload({ entityUpserts: [entityDto(`e${built}`)] })
    }
    flusher.checkpoint(build)
    flusher.checkpoint(build) // coalesced: build not called, dirty flags stay set
    flusher.checkpoint(build)
    expect(built).toBe(1)
    await flusher.drain()
    expect(txCount()).toBe(1)

    flusher.checkpoint(build) // queue empty again: one more transaction at most
    await flusher.drain()
    expect(txCount()).toBe(2)
    expect(built).toBe(2)
  })

  it('(d) a disconnect save queued after a checkpoint of the same character lands last', async () => {
    const store = await openTestStore()
    const flusher = new Flusher(slowStore(store, 50), new ServerMetrics(), log, undefined)
    flusher.checkpoint(() => payload({ characters: [character(playerDto('p1', 'before'))] }))
    flusher.savePlayer(payload({ characters: [character(playerDto('p1', 'after'))] }))
    await flusher.drain()
    expect((await store.players.findById('p1'))?.name).toBe('after')
  })

  it('(e) drain writes everything a shutdown checkpoint carries', async () => {
    const store = await openTestStore()
    const flusher = new Flusher(store, new ServerMetrics(), log, undefined)
    flusher.checkpoint(() =>
      payload({
        reason: 'shutdown',
        entityUpserts: [entityDto('e1'), entityDto('e2')],
        npcUpserts: [entityDto('npc1')],
        constraintUpserts: [constraintDto('c1')],
        characters: [character(playerDto('p1', 'Scrapper'))],
      }),
    )
    expect(await flusher.drain()).toBe(true)
    expect(await store.worldEntities.loadAll()).toHaveLength(3)
    expect(await store.constraints.loadAll()).toHaveLength(1)
    expect(await store.players.findById('p1')).not.toBeNull()
  })

  it('(f) outbox rows commit with the world rows and roll back with them', async () => {
    const store = await openTestStore()
    const outbox = createPgOutbox(store.db, { events: fakeEvents() as never })
    const sink = outboxSink(outbox, store.db)
    const recorder = new GameEventRecorder(sink, 'testworld', 0, () => 1)
    const flusher = new Flusher(store, new ServerMetrics(), log, recorder)
    const rows = async (): Promise<number> =>
      Number(await store.db.value(sql`SELECT count(*) FROM event_outbox`))

    // Rollback: the character row and its games.player.left event commit together or not at all.
    await expect(
      store.transaction(async (t) => {
        await store.players.upsertMany([playerDto('p1', 'Scrapper')])
        await recorder.recordLeave(t, eventPlayerOf('p1', 'Scrapper'))
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await rows()).toBe(0)
    expect(await store.players.findById('p1')).toBeNull()

    // Commit: a leaving save writes both.
    flusher.savePlayer(
      payload({ leaving: true, characters: [character(playerDto('p1', 'Scrapper'))] }),
    )
    await flusher.drain()
    expect(await store.players.findById('p1')).not.toBeNull()
    expect(await rows()).toBe(1)

    // A failed transaction writes neither.
    let fail = true
    const { store: flaky } = flakyStore(store, () => {
      const now = fail
      fail = false
      return now
    })
    const failing = new Flusher(flaky, new ServerMetrics(), log, recorder)
    failing.savePlayer(
      payload({ leaving: true, characters: [character(playerDto('p2', 'Other'))] }),
    )
    await failing.drain()
    expect(await store.players.findById('p2')).toBeNull()
    expect(await rows()).toBe(1)
  })

  it('(g) guest keys are hashed: a raw guest token never appears in characters', async () => {
    const store = await openTestStore()
    const flusher = new Flusher(store, new ServerMetrics(), log, undefined)
    const raw = 'guestbrowsertoken0123456789abcdef'
    flusher.savePlayer(payload({ characters: [character(playerDto('g1', 'Guest', raw))] }))
    await flusher.drain()
    const row = await store.db.maybe<{ account_key: string }>(
      sql`SELECT account_key FROM characters WHERE id = 'g1'`,
    )
    expect(row?.account_key).toMatch(/^guest:[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(raw)
    expect((await store.players.findByToken(raw))?.id).toBe('g1')
  })

  it('(h) NPCs write only what changed', async () => {
    const store = await openTestStore()
    const content = createContent()
    const world = { content } as unknown as GameWorld
    const npcs = new NpcManager(
      world,
      new RegionTracker(32),
      {
        onAttackPlayer: () => {},
        soundsThisTick: () => [],
        hostilesNear: () => [],
      },
      log,
    )
    await npcs.seedOrRestore(store)
    const boot = npcs.takeDirty(1000)
    expect(boot.length).toBeGreaterThan(0)
    // Nothing changed since: nothing to write.
    expect(npcs.takeDirty(1000)).toEqual([])
    // One NPC takes a hit: exactly that one is written.
    const victim = boot[0]!.id
    expect(npcs.damage(victim as never, 1, 1000)).toBe('hurt')
    const changed = npcs.takeDirty(1000)
    expect(changed.map((d) => d.id)).toEqual([victim])
    // restoreDirty puts a failed flush's ids back.
    npcs.restoreDirty(changed.map((d) => d.id))
    expect(npcs.takeDirty(1000).map((d) => d.id)).toEqual([victim])
  })
})

describe('GameWorld dirty snapshot', () => {
  it('takeDirty clears flags and restoreDirty puts entities, deletes and constraints back', async () => {
    const store = await openTestStore()
    const world = new GameWorld(createContent(), stubPhysics(), log)
    const a = world.spawnProp({
      defId: 'wooden_crate',
      pos: vec3(1, 1, 1),
      rot: quat(),
      motion: 'frozen',
    })
    const b = world.spawnProp({
      defId: 'metal_barrel',
      pos: vec3(2, 1, 2),
      rot: quat(),
      motion: 'frozen',
    })
    world.addConstraintRecord(a, b, 'weld', {}, 'c1')

    const first = world.takeDirty()
    expect(first.entityUpserts.map((e) => e.id).sort()).toEqual([a.id, b.id].sort())
    expect(first.constraintUpserts.map((c) => c.id)).toEqual(['c1'])
    expect(world.takeDirty().entityUpserts).toEqual([])

    world.restoreDirty(first)
    const again = world.takeDirty()
    expect(again.entityUpserts.map((e) => e.id).sort()).toEqual([a.id, b.id].sort())
    expect(again.constraintUpserts.map((c) => c.id)).toEqual(['c1'])

    // Deletes: a despawned entity is re-armed only while it is really gone.
    world.despawn(a.id)
    const del = world.takeDirty()
    expect(del.entityDeletes).toEqual([a.id])
    world.restoreDirty(del)
    expect(world.takeDirty().entityDeletes).toEqual([a.id])
    await world.flushDirty(store)
    expect(world.takeDirty().entityDeletes).toEqual([])
  })
})
