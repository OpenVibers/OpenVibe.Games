import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContent, setMapOverride, surfPack } from '@openvibe/content'
import type { PersistenceStore } from '@openvibe/persistence'
import { openPgStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createRapierWorld, loadRapier, type RapierModule } from '@openvibe/physics/rapier'
import {
  PROTOCOL_VERSION,
  defaultAppearance,
  type ClientMessage,
  type ServerMessage,
  type ServerSay,
} from '@openvibe/protocol'
import { createConsoleLogger } from '@openvibe/shared'
import type { Db } from 'openvibe-sdk/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SURF_ROOM_TIMING, loadConfig } from '../config.js'
import { hashGuestKey } from '../net/guestIdentity.js'
import { ServerMetrics } from '../observability/metrics.js'
import type { GameConnection } from './gameServer.js'
import { GameServer } from './gameServer.js'
import { GameWorld } from './gameWorld.js'
import { loadSurfOverride } from './surfMaps.js'
import type { ServerContext } from './systems/context.js'
import { PgSurfRecords } from '../platform/surfRuns.js'
import type { SurfRunRecord } from './surfRecords.js'
import { CHAT_RATE_CAPACITY } from './chatCommands.js'
import type { PlayerSession } from './playerSession.js'

const MAP = 'surf_lagoon'
const dir = mkdtempSync(join(tmpdir(), 'openvibe-chat-'))
const config = {
  ...loadConfig({ MAP_PATH: join(dir, 'map.json'), GAMES_PLACE_ID: MAP }),
  ...SURF_ROOM_TIMING,
  placeId: MAP,
  sandbox: true,
}
const log = createConsoleLogger({ app: 'test' }, 'error')

let rapier: RapierModule
let db: Db
let physics: ReturnType<typeof createRapierWorld> | null = null
let store: PersistenceStore
let world: GameWorld
let game: GameServer
let records: PgSurfRecords

interface TestClient {
  conn: GameConnection
  inbox: ServerMessage[]
  closed: { code: number; reason: string } | null
}

interface WelcomedClient extends TestClient {
  hello(token: string): Promise<void>
  send(msg: ClientMessage): void
}

function connect(name: string): WelcomedClient {
  const inbox: ServerMessage[] = []
  const state: { closed: { code: number; reason: string } | null } = { closed: null }
  const conn: GameConnection = {
    send: (text) => inbox.push(JSON.parse(text) as ServerMessage),
    close: (code, reason) => {
      state.closed = { code, reason }
    },
  }
  return {
    conn,
    inbox,
    get closed() {
      return state.closed
    },
    async hello(token: string): Promise<void> {
      conn.identity = { guestKeyHash: hashGuestKey(token) }
      game.onMessage(conn, {
        t: 'hello',
        v: PROTOCOL_VERSION,
        contentDigest: world.content.digest,
        slot: 0,
        name,
        appearance: defaultAppearance(),
      })
      for (let i = 0; i < 200 && !state.closed && !inbox.some((m) => m.t === 'welcome'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      delete conn.identity
    },
    send(msg: ClientMessage): void {
      game.onMessage(conn, msg)
    },
  }
}

function ctxOf(): ServerContext {
  return (game as unknown as { ctx: ServerContext }).ctx
}

function sessionOf(client: TestClient): PlayerSession {
  const session = ctxOf().sessions.getByConn(client.conn)
  if (!session) throw new Error('client has no session')
  return session
}

function say(client: WelcomedClient, text: string): void {
  client.send({ t: 'say', text })
}

function chatTexts(client: TestClient): string[] {
  return client.inbox.filter((m): m is ServerSay => m.t === 'say').map((m) => m.text)
}

/** Async command replies land after the handler's records query; wait for one. */
async function waitForChat(
  client: TestClient,
  predicate: (text: string) => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (chatTexts(client).some(predicate)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`chat reply not received; saw: ${chatTexts(client).join(' | ')}`)
}

function msOf(text: string): number {
  const [minutes, rest] = text.split(':')
  const [seconds, millis] = rest!.split('.')
  return Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(millis)
}

async function seedRun(accountKey: string, playerName: string, timeMs: number, createdAt: number) {
  const run: SurfRunRecord = {
    id: crypto.randomUUID(),
    mapId: MAP,
    accountKey,
    playerName,
    timeMs,
    splits: [timeMs],
    track: [{ tick: 1, x: 0, y: 0, z: 0, yaw: 0 }],
    tickRate: SURF_ROOM_TIMING.tickRate,
    startedTick: 0,
    finishedTick: 100,
    startFrac: 0,
    finishFrac: 0.5,
    fails: 0,
    createdAt,
  }
  await records.record(run)
}

beforeAll(async () => {
  rapier = await loadRapier()
  db = await openTestDb()
  const content = createContent([], surfPack(MAP))
  setMapOverride(loadSurfOverride(MAP), content.world.id)
  store = openPgStore(db, { placeId: MAP })
  await store.ensurePlace()
  physics = createRapierWorld(rapier)
  world = new GameWorld(content, physics, log)
  await world.seedOrRestore(store)

  records = new PgSurfRecords(db)
  // Eleven ordinary runs (9.000 … 19.000 s) plus Alice's 12.345 s PB. The
  // top ten therefore runs 9.000 … 17.000 with Alice's PB in fifth place.
  for (let i = 0; i < 11; i++) {
    await seedRun(`guest:seed-${i}`, `Racer ${i}`, 9_000 + i * 1000, 1_000 + i)
  }
  await seedRun(`guest:${hashGuestKey('alice-token')}`, 'Alice', 12_345, 2_000)

  game = new GameServer(config, world, store, new ServerMetrics(), log, { surf: records })
  await game.load()
}, 120_000)

afterAll(async () => {
  game?.shutdown()
  await game?.drain()
  physics?.dispose()
})

describe('chat with two live clients', () => {
  it('refuses chat before welcome, then echoes say and say_team to both', async () => {
    const early = connect('Early')
    game.onMessage(early.conn, { t: 'say', text: 'too soon' })
    expect(early.closed).toEqual({ code: 4001, reason: 'hello_first' })
    expect(early.inbox).toEqual([])

    const ana = connect('Ana')
    const bea = connect('Bea')
    await ana.hello('ana-one-token')
    await bea.hello('bea-one-token')
    expect(ana.inbox.some((m) => m.t === 'welcome')).toBe(true)
    expect(bea.inbox.some((m) => m.t === 'welcome')).toBe(true)

    say(ana, 'hello room')
    expect(chatTexts(ana)).toContain('hello room')
    expect(chatTexts(bea)).toContain('hello room')
    const line = bea.inbox.find((m): m is ServerSay => m.t === 'say' && m.text === 'hello room')
    expect(line).toMatchObject({ channel: 'say', from: 'Ana' })

    // Untrusted text survives as text on the wire (the client renderer is
    // covered by chat.test.ts; this proves the server never turns it into
    // markup or loses it).
    const xss = '<img src=x onerror="alert(1)">'
    say(ana, xss)
    expect(bea.inbox).toContainEqual(
      expect.objectContaining({ t: 'say', channel: 'say', from: 'Ana', text: xss }),
    )

    bea.send({ t: 'say_team', text: 'team line' })
    expect(ana.inbox).toContainEqual(
      expect.objectContaining({ t: 'say', channel: 'say_team', from: 'Bea', text: 'team line' }),
    )

    say(ana, '!b')
    expect(chatTexts(bea)).toContain('No bonuses on this map.')
  })

  it('resets the run with !r, keeps /r silent, and leaves the finish state cleared', async () => {
    const ana = connect('Ana')
    const bea = connect('Bea')
    await ana.hello('ana-two-token')
    await bea.hello('bea-two-token')
    const session = sessionOf(ana)
    const run = session.surf!
    run.status = 'running'
    run.startTick = 1
    run.lastTick = 101
    run.reached = 1
    run.splits = [{ stage: 1, timeMs: 1_000 }]

    say(ana, '!r')
    const reset = ana.inbox.filter((m) => m.t === 'surf_state').at(-1)
    expect(reset).toMatchObject({
      t: 'surf_state',
      running: false,
      elapsedMs: 0,
      stage: 0,
      splits: [],
      practice: false,
    })
    expect(run.finishResult).toBeNull()
    expect(chatTexts(bea)).toContain('Ana restarted the run.')

    // Arm a finished card-like state again: /r must reset it without a line.
    run.status = 'running'
    run.splits = [{ stage: 1, timeMs: 500 }]
    const before = bea.inbox.length
    say(ana, '/r')
    const silentReset = ana.inbox.filter((m) => m.t === 'surf_state').at(-1)
    expect(silentReset).toMatchObject({ running: false, elapsedMs: 0, splits: [] })
    expect(bea.inbox.slice(before).filter((m) => m.t === 'say')).toEqual([])
  })

  it('reports !top ascending as ten lines and !wr/!pr from the records store', async () => {
    const alice = connect('Alice')
    await alice.hello('alice-token')

    say(alice, '!top')
    await waitForChat(alice, (text) => text.startsWith('Top '))
    const topLines = chatTexts(alice).filter((text) => /^\d+\. \d+:\d\d\.\d\d\d {2}/.test(text))
    expect(topLines).toHaveLength(10)
    const times = topLines.map((text) => msOf(/^\d+\. (\d+:\d\d\.\d\d\d) {2}/.exec(text)![1]!))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times[0]).toBe(9_000)
    expect(times.at(-1)).toBe(17_000)
    expect(chatTexts(alice)).toContain('Top 10 — surf_lagoon')

    say(alice, '!wr')
    await waitForChat(alice, (text) => text.includes(' WR: '))
    expect(chatTexts(alice)).toContain('surf_lagoon WR: 0:09.000')

    say(alice, '!pr')
    await waitForChat(alice, (text) => text.startsWith('Your PB on '))
    expect(chatTexts(alice)).toContain('Your PB on surf_lagoon: 0:12.345')
  })

  it('refuses !stage outside practice, travels stages in practice, and never writes a run', async () => {
    const dana = connect('Dana')
    await dana.hello('dana-token')
    const session = sessionOf(dana)
    const startX = session.move.pos.x
    const startZ = session.move.pos.z

    say(dana, '!stage 1')
    expect(chatTexts(dana)).toContain('Practice mode is off. Type !practice first.')
    expect(session.move.pos.x).toBe(startX)
    expect(session.move.pos.z).toBe(startZ)
    expect(session.surfPractice).toBe(false)

    say(dana, '!practice')
    expect(session.surfPractice).toBe(true)
    expect(chatTexts(dana)).toContain('Dana entered practice — runs are not ranked.')

    say(dana, '!stage 2')
    const checkpoint = session.surf!.map.checkpoints.find((z) => z.stage === 2)!
    expect(session.move.pos.x).toBeCloseTo(checkpoint.spawn!.x)
    expect(session.move.pos.y).toBeCloseTo(checkpoint.spawn!.y)
    expect(session.move.pos.z).toBeCloseTo(checkpoint.spawn!.z)
    expect(chatTexts(dana)).toContain('Dana moved to stage 2.')

    // Force the worst case: a run that would otherwise finish on this tick.
    // Practice skips the run state machine entirely, so no surf_finish and
    // no row for Dana's account may appear.
    const finish = session.surf!.map.finish
    session.surf!.status = 'running'
    session.surf!.reached = session.surf!.map.checkpoints.length
    session.surf!.startTick = 0
    session.moveSegments.push({
      from: { x: finish.min[0], y: finish.min[1], z: finish.min[2] - 1 },
      to: {
        x: (finish.min[0] + finish.max[0]) / 2,
        y: (finish.min[1] + finish.max[1]) / 2,
        z: (finish.min[2] + finish.max[2]) / 2,
      },
      yaw: 0,
    })
    ctxOf().systems.surf.tick(ctxOf(), 0.01)
    expect(dana.inbox.some((m) => m.t === 'surf_finish')).toBe(false)
    const danaKey = `guest:${hashGuestKey('dana-token')}`
    const rows = await db.many<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM surf_runs WHERE account_key = $1',
      [danaKey],
    )
    expect(Number(rows[0]!.n)).toBe(0)

    say(dana, '!practice')
    expect(session.surfPractice).toBe(false)
    expect(session.move.pos.x).toBeCloseTo(startX)
    expect(session.move.pos.z).toBeCloseTo(startZ)
  })

  it('holds the burst rate limit for a fresh client', async () => {
    const frank = connect('Frank')
    await frank.hello('frank-token')
    const bea = connect('Bea')
    await bea.hello('bea-five-token')
    const before = bea.inbox.length
    for (let i = 0; i < CHAT_RATE_CAPACITY + 3; i++) say(frank, `spam ${i}`)
    const received = bea.inbox
      .slice(before)
      .filter((m): m is ServerSay => m.t === 'say' && m.from === 'Frank')
    expect(received).toHaveLength(CHAT_RATE_CAPACITY)
  })
})
