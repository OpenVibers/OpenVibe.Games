/**
 * The Wave 12 platform boundary exercised on the real authoritative server
 * (headless Havok, real PostgreSQL schema through in-memory PGlite,
 * protocol-level connections), across a restart:
 *
 *  - a signed-in player is keyed by the canonical subject;
 *  - a guest presenting an account key as its token is refused;
 *  - a mod's props enter the world through the runtime seam, a denied
 *    capability never takes effect, and a revoked mod's props are gone on
 *    the next tick;
 *  - lifecycle events commit with the state they describe and reach
 *    OpenVibe.Events (mock) with the games service token;
 *  - a restart restores the authoritative state: characters, world props,
 *    the world clock and the mod registry — without duplicating mod props.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContent } from '@openvibe/content'
import { openPgStore, type PgPersistenceStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createHeadlessHavokWorld } from '@openvibe/physics/havok'
import {
  PROTOCOL_VERSION,
  defaultAppearance,
  type ClientMessage,
  type ServerMessage,
} from '@openvibe/protocol'
import { createConsoleLogger } from '@openvibe/shared'
import type { Db } from 'openvibe-sdk/db'
import { createEventsClient, createPgOutbox, type PgOutbox } from 'openvibe-sdk/events'
import { createMockPlatform } from 'openvibe-sdk/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { loadHavok } from '../havokLoader.js'
import { CAP_ANNOUNCE, CAP_PLACE_PROP } from '../mods/contentPack.js'
import { ModRegistry, type ModActor } from '../mods/registry.js'
import { ModRuntime } from '../mods/runtime.js'
import { sampleManifest } from '../mods/testFixtures.js'
import { ServerMetrics } from '../observability/metrics.js'
import { GameEventRecorder, outboxSink } from '../platform/gameEvents.js'
import { createPlatformClient } from '../platform/serviceClient.js'
import { GameServer, type GameConnection } from './gameServer.js'
import { GameWorld } from './gameWorld.js'

const SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
const MOD_A = 'mod_01JAAAAAAAAAAAAAAAAAAAAAAA'
const MOD_B = 'mod_01JBBBBBBBBBBBBBBBBBBBBBBB'
const STAFF: ModActor = { audit: SUBJECT, subject: { type: 'user', id: SUBJECT } }
const log = createConsoleLogger({ app: 'test' }, 'error')

const dir = mkdtempSync(join(tmpdir(), 'openvibe-platform-'))
const config = loadConfig({
  MAP_PATH: join(dir, 'map.json'),
  OV_NETWORK_AUTH_URL: 'http://network.test/api/auth/me',
})
let havok: unknown
/** One in-memory PGlite database for the whole file; the restart tests share its state. */
let db: Db

beforeAll(async () => {
  havok = await loadHavok()
  db = await openTestDb()
  // openvibe.network's /api/auth/me for the one signed-in test account.
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== 'Bearer tok-ana') return new Response('{}', { status: 401 })
    return Response.json({ user: { id: 57, username: 'ana', role: 'user', subject_id: SUBJECT } })
  })
}, 60_000)

afterAll(() => {
  vi.unstubAllGlobals()
})

interface Boot {
  store: PgPersistenceStore
  world: GameWorld
  game: GameServer
  registry: ModRegistry
  outbox: PgOutbox
  dispose(): void
}

async function boot(platform: ReturnType<typeof createMockPlatform>): Promise<Boot> {
  const content = createContent()
  const physics = createHeadlessHavokWorld(havok)
  // The store rides on the shared database; close() is never called (the instance is shared).
  const store = openPgStore(db, { placeId: config.placeId })
  await store.ensurePlace()
  const world = new GameWorld(content, physics, log)
  await world.seedOrRestore(store)
  const pc = createPlatformClient(
    {
      ...config.platform,
      clientSecret: 's3cret',
      networkUrl: platform.origins.network,
      eventsUrl: platform.origins.events,
    },
    platform.fetch,
  )!
  const outbox = createPgOutbox(db, {
    events: createEventsClient(pc.client, { source: 'games' }),
  })
  const sink = outboxSink(outbox, db)
  const registry = new ModRegistry(store, content, sink, Date.now, log.child({ system: 'mods' }))
  await registry.load()
  const runtime = new ModRuntime(registry, content, log.child({ system: 'mods' }), {
    reconcileEveryTicks: 30,
  })
  const recorder = new GameEventRecorder(sink, content.world.id, 0)
  const game = new GameServer(config, world, store, new ServerMetrics(), log, {
    events: recorder,
    mods: runtime,
  })
  await game.load()
  return {
    store,
    world,
    game,
    registry,
    outbox,
    dispose() {
      physics.dispose()
    },
  }
}

function connect(game: GameServer) {
  const inbox: ServerMessage[] = []
  let closed: { code: number; reason: string } | null = null
  const conn: GameConnection = {
    send: (text) => inbox.push(JSON.parse(text) as ServerMessage),
    close: (code, reason) => {
      closed = { code, reason }
    },
  }
  const hello = async (token: string, auth?: string) => {
    const msg = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      token,
      ...(auth ? { auth } : {}),
      slot: 0,
      name: 'Ana',
      appearance: defaultAppearance(),
    } as ClientMessage
    game.onMessage(conn, msg)
    for (let i = 0; i < 100 && !closed && !inbox.some((m) => m.t === 'welcome'); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    return { welcome: inbox.find((m) => m.t === 'welcome'), closed: closed as typeof closed }
  }
  return { conn, inbox, hello }
}

const propsOwnedBy = (world: GameWorld, owner: string) =>
  [...world.entities.ofKind('prop')].filter((e) => e.owner === owner)

describe('Games on platform identity, events and mods (real server, restart)', () => {
  const platform = createMockPlatform({
    clients: {
      games: {
        secret: 's3cret',
        grants: [{ capability: 'events.event.publish', audience: 'openvibe.events' }],
      },
    },
  })
  let signedInPlayerId = ''
  let timeBefore = 0

  it('runs identity, mods and events against the live world', async () => {
    const a = await boot(platform)

    // A guest cannot claim an account key as its token.
    const intruder = connect(a.game)
    const refused = await intruder.hello(SUBJECT)
    expect(refused.welcome).toBeUndefined()
    expect(refused.closed).toEqual({ code: 4007, reason: 'invalid_guest_token' })

    // The signed-in player is keyed by the canonical subject.
    const ana = connect(a.game)
    const joined = await ana.hello('abcdefgh12', 'tok-ana')
    expect(joined.welcome).toBeDefined()
    signedInPlayerId = (joined.welcome as { playerId: string }).playerId
    // The tick never awaits I/O; shutdown queues the final checkpoint, drain waits for it.
    a.game.shutdown()
    await a.game.drain()
    expect(await a.store.players.findById(signedInPlayerId)).toMatchObject({
      token: SUBJECT,
      subjectId: SUBJECT,
    })

    // Mod A: props granted, announcements requested but denied.
    await a.registry.install(
      {
        manifest: sampleManifest({ id: MOD_A }),
        pack: {
          announcements: [{ text: 'hello world', everySeconds: 60 }],
          props: [{ key: 'bench', item: 'workbench', pos: [20, 0, 20] }],
        },
        approve: [CAP_PLACE_PROP],
        enable: true,
      },
      STAFF,
    )
    // Mod B: stays installed across the restart.
    await a.registry.install(
      {
        manifest: sampleManifest({ id: MOD_B, name: 'Campfire' }),
        pack: { props: [{ key: 'fire', item: 'campfire', pos: [-20, 0, -20] }] },
        approve: [CAP_PLACE_PROP],
        enable: true,
      },
      STAFF,
    )
    a.game.step()
    const benches = propsOwnedBy(a.world, MOD_A)
    expect(benches.map((e) => e.prop?.defId)).toEqual(['workbench'])
    expect(propsOwnedBy(a.world, MOD_B).map((e) => e.prop?.defId)).toEqual(['campfire'])
    expect(ana.inbox.some((m) => m.t === 'announce')).toBe(false)
    await a.registry.flushWrites()
    expect(
      (await a.registry.auditLog(MOD_A)).some(
        (x) => x.action === 'deny' && x.capability === CAP_ANNOUNCE,
      ),
    ).toBe(true)

    // Revoke: gone on the very next tick, and players are told it despawned.
    await a.registry.revoke(MOD_A, STAFF, 'test')
    a.game.step()
    expect(propsOwnedBy(a.world, MOD_A)).toEqual([])
    expect(a.world.entities.get(benches[0]!.id)).toBeUndefined()

    a.game.onDisconnect(ana.conn)
    a.game.shutdown()
    await a.game.drain()
    await a.registry.flushWrites()
    timeBefore = (await a.store.meta.get('env_time')) as number
    expect(timeBefore).toBeGreaterThan(0)

    // Everything committed is published with the games principal.
    await a.outbox.flush()
    await a.outbox.stop()
    const types = platform.state.events.map((e) => e.event.event_type)
    expect(types).toEqual(
      expect.arrayContaining([
        'games.player.joined',
        'games.player.left',
        'games.mod.installed',
        'games.mod.revoked',
        'games.world.saved',
      ]),
    )
    expect(new Set(platform.state.events.map((e) => e.publisher))).toEqual(new Set(['svc:games']))
    const joinedEvent = platform.state.events.find(
      (e) => e.event.event_type === 'games.player.joined',
    )
    expect(joinedEvent?.event.actor).toEqual({ type: 'user', id: SUBJECT })
    a.dispose()
  }, 60_000)

  it('restores the authoritative state after a restart', async () => {
    const b = await boot(platform)
    // World clock, mod registry and mod props came back from disk.
    expect(await b.store.meta.get('env_time')).toBe(timeBefore)
    expect(b.registry.get(MOD_A)?.mod.status).toBe('revoked')
    expect(b.registry.get(MOD_B)?.mod.status).toBe('enabled')
    expect(propsOwnedBy(b.world, MOD_A)).toEqual([])
    expect(propsOwnedBy(b.world, MOD_B)).toHaveLength(1)
    // The runtime adopts the restored prop instead of placing a second one.
    for (let i = 0; i < 40; i++) b.game.step()
    expect(propsOwnedBy(b.world, MOD_B)).toHaveLength(1)

    // The account comes back to the same character, by subject.
    const ana = connect(b.game)
    const again = await ana.hello('zyxwvut98', 'tok-ana')
    expect(again.welcome).toMatchObject({ playerId: signedInPlayerId })
    expect((await b.store.players.listByToken(SUBJECT)).map((p) => p.id)).toEqual([
      signedInPlayerId,
    ])
    b.game.onDisconnect(ana.conn)
    b.game.shutdown()
    await b.game.drain()
    await b.registry.flushWrites()
    await b.outbox.stop()
    b.dispose()
  }, 60_000)

  it('a guest who signs in keeps their character (guest conversion, WS-B task 8)', async () => {
    const c = await boot(platform)
    const guest = connect(c.game)
    const played = await guest.hello('guestconv77')
    expect(played.welcome).toBeDefined()
    const guestPlayer = (played.welcome as { playerId: string }).playerId
    c.game.shutdown()
    await c.game.drain()
    await c.registry.flushWrites()
    await c.outbox.stop()
    c.dispose()
    const d = await boot(platform)
    const signedIn = connect(d.game)
    expect((await signedIn.hello('guestconv77', 'tok-ana')).welcome).toBeDefined()
    const mine = await d.store.players.listByToken(SUBJECT)
    expect(mine.some((p) => p.id === guestPlayer)).toBe(true)
    expect(await d.store.players.listByToken('guestconv77')).toEqual([])
    d.game.shutdown()
    await d.game.drain()
    await d.registry.flushWrites()
    await d.outbox.stop()
    d.dispose()
  }, 60_000)

  it('a sign-out everywhere closes the signed-in session, never a guest (WS-B task 4)', async () => {
    const c = await boot(platform)
    const ana = connect(c.game)
    expect((await ana.hello('abcdefgh12', 'tok-ana')).welcome).toBeDefined()
    const guest = connect(c.game)
    expect((await guest.hello('guest00042')).welcome).toBeDefined()
    expect(c.game.revokeSubject('usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2ZZ', Date.now())).toBe(0)
    expect(c.game.revokeSubject(SUBJECT, Date.now())).toBe(1)
    expect(ana.inbox.some((m) => m.t === 'reject' && m.reason === 'signed_out')).toBe(true)
    expect(guest.inbox.some((m) => m.t === 'reject')).toBe(false)
    c.game.shutdown()
    await c.game.drain()
    await c.registry.flushWrites()
    await c.outbox.stop()
    c.dispose()
  }, 60_000)
})
