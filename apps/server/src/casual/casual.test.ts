import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Db } from 'openvibe-sdk/db'
import { openTestDb } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { packDigest, vibeHeroes } from '@openvibe/casual'
import { ServerMetrics } from '../observability/metrics.js'
import { createHttpServer } from '../net/httpServer.js'
import { createGamesActorLimits } from '../net/actorLimits.js'
import type { NetworkUser } from '../net/networkAuth.js'
import { createCasualRoutes } from './routes.js'
import { casualGameOf, casualHead } from './page.js'

const log = createConsoleLogger({ app: 'test' }, 'error')
// Answers are read freely in assertions; their shapes are what the tests check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>
const GUEST = 'g0000000000000000000000000000001'
const ANA = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1'
const DIGEST = packDigest(vibeHeroes)
let db: Db
let server: Server
let base = ''
let dir = ''
let clock = Date.UTC(2026, 9, 14, 12)
const users = new Map<string, NetworkUser>([
  ['ana-token', { id: '1', name: 'ana', rank: null, subjectId: ANA }],
])

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'casual-'))
  const dist = join(dir, 'dist')
  mkdirSync(dist)
  writeFileSync(
    join(dist, 'casual.html'),
    '<!doctype html><html><head><!--casual:head--></head><body><main id="app"></main></body></html>',
  )
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>portal</title>')
  db = await openTestDb()
  const routes = createCasualRoutes({
    db,
    networkAuthUrl: 'http://network.test/api/auth/me',
    limits: createGamesActorLimits({ env: {} }),
    address: () => '127.0.0.1',
    log,
    now: () => clock,
    resolveUser: async (_url, token) => users.get(token) ?? null,
  })
  server = createHttpServer(
    dist,
    new ServerMetrics(),
    log,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    {
      handle: routes,
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await db.query('TRUNCATE casual_saves, casual_ledger, casual_actions')
  clock = Date.UTC(2026, 9, 14, 12)
})

async function call(
  path: string,
  opts: { body?: unknown; guest?: string; bearer?: string; digest?: string; method?: string } = {},
): Promise<{ status: number; body: Body }> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.guest) headers['x-guest-token'] = opts.guest
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  if (opts.digest) headers['x-casual-digest'] = opts.digest
  const r = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    redirect: 'manual',
  })
  const text = await r.text()
  let body: Body = {}
  try {
    body = JSON.parse(text) as Body
  } catch {
    body = { text, location: r.headers.get('location') }
  }
  return { status: r.status, body }
}

const S = '/api/v1/casual/vibe-heroes'
const act = (
  action: unknown,
  key: string,
  who: { guest?: string; bearer?: string } = { guest: GUEST },
) => call(`${S}/actions`, { body: { key, action }, digest: DIGEST, ...who })

describe('casual sessions', () => {
  it('creates a guest’s save on first visit with the ad link’s source, once', async () => {
    const first = await call(`${S}/session`, { body: { src: 'x', c: 'launch-1' }, guest: GUEST })
    expect(first.status).toBe(200)
    expect(first.body.created).toBe(true)
    expect(first.body.digest).toBe(DIGEST)
    expect(first.body.player).toEqual({ signedIn: false, name: null })
    expect(first.body.state.team).toEqual(['gus', 'tess', 'milo', 'rook'])
    const again = await call(`${S}/session`, { body: { src: 'other' }, guest: GUEST })
    expect(again.body.created).toBe(false)
    expect(await db.many(sql`SELECT source, campaign, player_name FROM casual_saves`)).toEqual([
      { source: 'x', campaign: 'launch-1', player_name: null },
    ])
    expect((await db.many(sql`SELECT asset FROM casual_ledger ORDER BY id`)).length).toBe(7)
  })

  it('refuses a request with no identity, a bad body or the wrong method', async () => {
    expect((await call(`${S}/session`, { body: {} })).status).toBe(401)
    expect((await call(`${S}/session`, { method: 'GET' })).status).toBe(405)
    expect((await call('/api/v1/casual/nope/session', { body: {}, guest: GUEST })).status).toBe(404)
    const r = await fetch(`${base}${S}/session`, {
      method: 'POST',
      headers: { 'x-guest-token': GUEST, 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(r.status).toBe(415)
  })

  it('answers an expired sign-in as such instead of falling back to the guest', async () => {
    const r = await call(`${S}/session`, { body: {}, bearer: 'old-token', guest: GUEST })
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('session_expired')
  })
})

describe('casual actions', () => {
  it('applies a battle once per key, with ledger lines, and replays the same answer', async () => {
    await call(`${S}/session`, { body: {}, guest: GUEST })
    const one = await act({ t: 'battle', stage: 1 }, 'key-0000001')
    expect(one.status).toBe(200)
    expect(one.body.result.won).toBe(true)
    expect(one.body.state.stage.cleared).toBe(1)
    expect(one.body.version).toBe(1)
    const gold = one.body.state.wallet.gold
    const replay = await act({ t: 'battle', stage: 1 }, 'key-0000001')
    expect(replay.body.replay).toBe(true)
    expect(replay.body.state.wallet.gold).toBe(gold)
    expect(replay.body.result.battle).toEqual(one.body.result.battle)
    const lines = await db.many<{ action_key: string; asset: string; delta: number }>(
      sql`SELECT action_key, asset, delta FROM casual_ledger WHERE action_key = 'key-0000001' ORDER BY id`,
    )
    expect(lines).toEqual([
      { action_key: 'key-0000001', asset: 'gold', delta: 350 },
      { action_key: 'key-0000001', asset: 'gems', delta: 15 },
      { action_key: 'key-0000001', asset: 'shard:ivy', delta: 5 },
    ])
  })

  it('answers a refusal without changing anything', async () => {
    await call(`${S}/session`, { body: {}, guest: GUEST })
    const r = await act({ t: 'battle', stage: 5 }, 'key-0000002')
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('locked_stage')
    const row = await db.one<{ version: number }>(sql`SELECT version FROM casual_saves`)
    expect(row.version).toBe(0)
  })

  it('asks a stale page to reload, and refuses malformed actions', async () => {
    await call(`${S}/session`, { body: {}, guest: GUEST })
    const stale = await call(`${S}/actions`, {
      body: { key: 'key-0000003', action: { t: 'collect' } },
      digest: 'deadbeef',
      guest: GUEST,
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('content_changed')
    expect((await act({ t: 'grant', gold: 1e9 }, 'key-0000004')).status).toBe(400)
    expect((await act({ t: 'collect' }, 'short')).status).toBe(400)
  })

  it('needs a save first', async () => {
    const r = await act({ t: 'login' }, 'key-0000005')
    expect(r.status).toBe(404)
  })
})

describe('signing in', () => {
  it('takes over the guest’s save on that browser, names it, and lists it on the board', async () => {
    await call(`${S}/session`, { body: {}, guest: GUEST })
    await act({ t: 'battle', stage: 1 }, 'key-0000010')
    const r = await call(`${S}/session`, { body: {}, bearer: 'ana-token', guest: GUEST })
    expect(r.status).toBe(200)
    expect(r.body.created).toBe(false)
    expect(r.body.player).toEqual({ signedIn: true, name: 'ana' })
    expect(r.body.state.stage.cleared).toBe(1)
    expect(await db.many(sql`SELECT account_key, player_name FROM casual_saves`)).toEqual([
      { account_key: ANA, player_name: 'ana' },
    ])
    const board = await call(`${S}/leaderboard`)
    expect(board.body.entries).toEqual([
      { rank: 1, name: 'ana', stage: 1, power: expect.any(Number) },
    ])
    const ledger = await call(`${S}/ledger`, { bearer: 'ana-token' })
    expect(ledger.status).toBe(200)
    expect(ledger.body.lines[0].asset).toBe('shard:ivy')
    expect(ledger.body.next).toBeNull()
  })

  it('keeps guests off the board', async () => {
    await call(`${S}/session`, { body: {}, guest: GUEST })
    await act({ t: 'battle', stage: 1 }, 'key-0000020')
    expect((await call(`${S}/leaderboard`)).body.entries).toEqual([])
  })
})

describe('the casual page', () => {
  it('serves /play/<game> with the game’s share card and keeps the campaign through redirects', async () => {
    const page = await fetch(`${base}/play/vibe-heroes?src=x&c=t1`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<body data-game="vibe-heroes">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).toContain('https://openvibe.games/casual/vibe-heroes/card.png')
    expect(html).toContain('"@type":"WebApplication"')
    const slash = await call('/play/vibe-heroes/?src=x&c=t1')
    expect(slash.status).toBe(301)
    expect(slash.body.location).toBe('/play/vibe-heroes?src=x&c=t1')
    expect((await fetch(`${base}/play/not-a-game`)).status).toBe(404)
    expect((await fetch(`${base}/casual.html`)).status).toBe(404)
  })

  it('names only real games and escapes what it writes', () => {
    expect(casualGameOf('/play/vibe-heroes')).toBe('vibe-heroes')
    expect(casualGameOf('/play/../etc')).toBeNull()
    expect(casualHead('vibe-heroes')).toContain('<title>Vibe Heroes · OpenVibe.Games</title>')
  })
})
