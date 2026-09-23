import { createRequire } from 'node:module'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createEventsClient, createOutbox, type SqliteDatabase } from 'openvibe-sdk/events'
import { createMockPlatform } from 'openvibe-sdk/testing'
import { describe, expect, it } from 'vitest'
import { loadPlatformConfig } from '../config.js'
import {
  EVENT_SOURCE,
  GameEventRecorder,
  modEvent,
  outboxSink,
  playerJoinedEvent,
  playerLeftEvent,
  progressEvents,
  worldSavedEvent,
  type EventSink,
} from './gameEvents.js'
import { createPlatformClient } from './serviceClient.js'

interface Contracts {
  validate(
    ref: string,
    value: unknown,
  ): { valid: boolean; errors: { path: string; message: string }[] }
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as Contracts

const SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
const signedIn = { playerId: 'pl_1', slot: 0, name: 'Ana', subjectId: SUBJECT }
const guest = { playerId: 'pl_2', slot: 0, name: 'Guest', subjectId: null }

function capture(): EventSink & { events: { event_type: string; payload: unknown }[] } {
  const events: { event_type: string; payload: unknown }[] = []
  return {
    enabled: true,
    events,
    enqueue: (e) => events.push(e as { event_type: string; payload: unknown }),
  }
}

describe('event envelopes', () => {
  it('are valid events.event-envelope@1 once prepared', () => {
    const client = createEventsClient(
      createPlatformClient({
        ...loadPlatformConfig({}),
        clientSecret: 'x',
        eventsUrl: 'http://127.0.0.1:1',
      })!.client,
      { source: EVENT_SOURCE },
    )
    const all = [
      playerJoinedEvent(signedIn, { world: 'scrapcity', restored: true }),
      playerJoinedEvent(guest, { world: 'scrapcity', restored: false }),
      playerLeftEvent(signedIn, { world: 'scrapcity', sessionSeconds: 61.4 }),
      ...progressEvents(
        signedIn,
        { levels: { mining: 2 }, unlocks: [] },
        { levels: { mining: 4, woodcutting: 1 }, unlocks: ['craft_still'] },
        'scrapcity',
      ),
      worldSavedEvent('scrapcity', { reason: 'shutdown', entities: 3, players: 1, sinceMs: 0 }),
      modEvent(
        'revoked',
        {
          id: 'mod_01JABCDEFGHJKMNPQRSTVWXYZ0',
          name: 'M',
          version: '1.0.0',
          target: 'games.browser',
          trustTier: 'unreviewed',
        },
        { type: 'user', id: SUBJECT },
        { reason: 'test' },
      ),
    ]
    for (const input of all) {
      const env = client.prepare(input)
      const r = contracts.validate('events.event-envelope@1', env)
      expect(r.errors, env.event_type).toEqual([])
      expect(env.source).toBe('games')
    }
  })

  it('name the subject for signed-in players and keep guests internal', () => {
    const a = playerJoinedEvent(signedIn, { world: 'w', restored: false })
    expect(a.actor).toEqual({ type: 'user', id: SUBJECT })
    expect(a.visibility).toBe('subject')
    const b = playerJoinedEvent(guest, { world: 'w', restored: false })
    expect(b.actor).toEqual({ type: 'service', id: 'games' })
    expect(b.visibility).toBe('internal')
    expect((b.payload as { player: Record<string, unknown> }).player.subject).toBeUndefined()
  })

  it('report only real progression gains: one event per raised skill, one per new blueprint', () => {
    const events = progressEvents(
      signedIn,
      { levels: { mining: 3, farming: 5 }, unlocks: ['a'] },
      { levels: { mining: 5, farming: 5 }, unlocks: ['a', 'b'] },
      'w',
    )
    expect(events.map((e) => [e.event_type, e.payload])).toEqual([
      [
        'games.skill.leveled',
        expect.objectContaining({ skill: 'mining', level: 5, previous_level: 3 }),
      ],
      ['games.blueprint.unlocked', expect.objectContaining({ recipe: 'b' })],
    ])
    expect(
      progressEvents(
        signedIn,
        { levels: { m: 4 }, unlocks: [] },
        { levels: { m: 2 }, unlocks: [] },
        'w',
      ),
    ).toEqual([])
  })
})

describe('GameEventRecorder', () => {
  it('diffs each save against the last persisted progress', () => {
    const sink = capture()
    const rec = new GameEventRecorder(sink, 'w', 60_000, () => 0)
    rec.recordJoin(signedIn, { levels: { mining: 2 }, unlocks: [] }, true)
    rec.recordPlayersSaved([
      { player: signedIn, progress: { levels: { mining: 3 }, unlocks: [] } },
    ])()
    // Saved again with no change: nothing new.
    rec.recordPlayersSaved([
      { player: signedIn, progress: { levels: { mining: 3 }, unlocks: [] } },
    ])()
    rec.recordLeave(signedIn)()
    expect(sink.events.map((e) => e.event_type)).toEqual([
      'games.player.joined',
      'games.skill.leveled',
      'games.player.left',
    ])
  })

  it('does not advance the baseline when the save is not committed', () => {
    const sink = capture()
    const rec = new GameEventRecorder(sink, 'w', 60_000, () => 0)
    rec.recordJoin(signedIn, { levels: { mining: 2 }, unlocks: [] }, true)
    // Rolled back: the commit callback never runs, so the next save reports it again.
    rec.recordPlayersSaved([{ player: signedIn, progress: { levels: { mining: 3 }, unlocks: [] } }])
    rec.recordPlayersSaved([
      { player: signedIn, progress: { levels: { mining: 3 }, unlocks: [] } },
    ])()
    expect(sink.events.filter((e) => e.event_type === 'games.skill.leveled')).toHaveLength(2)
  })

  it('checkpoints world saves at most once per interval, always on shutdown', () => {
    let now = 0
    const sink = capture()
    const rec = new GameEventRecorder(sink, 'w', 60_000, () => now)
    now = 10_000
    rec.recordWorldSaved(5, 1, 'checkpoint')()
    now = 70_000
    rec.recordWorldSaved(2, 0, 'checkpoint')()
    now = 80_000
    rec.recordWorldSaved(1, 1, 'checkpoint')()
    rec.recordWorldSaved(0, 0, 'shutdown')()
    const saved = sink.events.filter((e) => e.event_type === 'games.world.saved')
    expect(saved.map((e) => e.payload)).toEqual([
      expect.objectContaining({ reason: 'checkpoint', entities_written: 7, players_written: 1 }),
      expect.objectContaining({ reason: 'shutdown', entities_written: 1, players_written: 1 }),
    ])
  })
})

describe('transactional outbox → OpenVibe.Events (mock platform)', () => {
  it('publishes with the games service token only what committed', async () => {
    const platform = createMockPlatform({
      clients: {
        games: {
          secret: 's3cret',
          grants: [{ capability: 'events.event.publish', audience: 'openvibe.events' }],
        },
      },
    })
    const cfg = {
      ...loadPlatformConfig({}),
      clientSecret: 's3cret',
      networkUrl: platform.origins.network,
      eventsUrl: platform.origins.events,
    }
    const pc = createPlatformClient(cfg, platform.fetch)!
    const store = openSqliteStore(':memory:')
    const outbox = createOutbox(store.db as unknown as SqliteDatabase, {
      events: createEventsClient(pc.client, { source: EVENT_SOURCE }),
    })
    outbox.ensureSchema()
    const sink = outboxSink(outbox)

    // Committed with the change it describes.
    store.transaction(() => {
      store.meta.set('env_time', '0.5')
      sink.enqueue(playerJoinedEvent(signedIn, { world: 'w', restored: false }))
    })
    // Rolled back: the event never existed.
    expect(() =>
      store.transaction(() => {
        store.meta.set('env_time', '0.9')
        sink.enqueue(playerLeftEvent(signedIn, { world: 'w', sessionSeconds: 1 }))
        throw new Error('rollback')
      }),
    ).toThrow('rollback')
    // Outside a transaction the outbox refuses.
    expect(() =>
      sink.enqueue(playerLeftEvent(signedIn, { world: 'w', sessionSeconds: 1 })),
    ).toThrow()

    expect(outbox.pending()).toBe(1)
    const stats = await outbox.flush()
    expect(stats).toEqual({ sent: 1, failed: 0, rejected: 0 })
    expect(platform.state.events.map((e) => [e.event.event_type, e.publisher])).toEqual([
      ['games.player.joined', 'svc:games'],
    ])
    expect(store.meta.get('env_time')).toBe('0.5')
    await outbox.stop()
    store.close()
  })

  it('keeps events queued while the grant is missing', async () => {
    const platform = createMockPlatform({ clients: { games: { secret: 's3cret', grants: [] } } })
    const cfg = {
      ...loadPlatformConfig({}),
      clientSecret: 's3cret',
      networkUrl: platform.origins.network,
      eventsUrl: platform.origins.events,
    }
    const store = openSqliteStore(':memory:')
    const outbox = createOutbox(store.db as unknown as SqliteDatabase, {
      events: createEventsClient(createPlatformClient(cfg, platform.fetch)!.client, {
        source: EVENT_SOURCE,
      }),
    })
    outbox.ensureSchema()
    store.transaction(() =>
      outboxSink(outbox).enqueue(
        worldSavedEvent('w', { reason: 'shutdown', entities: 0, players: 0, sinceMs: 0 }),
      ),
    )
    const stats = await outbox.flush()
    expect(stats.sent).toBe(0)
    expect(outbox.pending() + outbox.rejected()).toBe(1)
    await outbox.stop()
    store.close()
  })
})
