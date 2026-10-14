import { describe, expect, it } from 'vitest'
import { sql } from 'openvibe-sdk/db'
import { openTestStore } from '@openvibe/persistence/testing'
import { loadPlatformConfig } from '../config.js'
import { recordHaul, recordJoined, recordRound } from '../game/progression.js'
import { createPlatformClient } from './serviceClient.js'
import { PLAY_TITLES, PlaySync, toPlayer } from './playSync.js'

const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
const guest = `guest:${'a'.repeat(64)}`

function fakePlay() {
  const posts: { method: string; path: string; body: Record<string, unknown> }[] = []
  let failures = 0
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('audience')).toBe('openvibe.play')
      expect(form.get('scope')).toBe('play.title.manage play.result.write')
      return reply(200, { access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 })
    }
    expect(url.origin).toBe('http://play.test')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-token')
    if (failures > 0 && url.pathname.endsWith('/scores')) {
      failures--
      return reply(503, { code: 'play.unavailable' })
    }
    posts.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/v1/, ''),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return reply(200, {})
  }
  return {
    fetchImpl,
    posts,
    failNextScores: () => {
      failures = 1
    },
  }
}

async function setup(env: Record<string, string> = { GAMES_PLAY_URL: 'http://play.test/' }) {
  const store = await openTestStore()
  const fake = fakePlay()
  const config = loadPlatformConfig({
    OV_OAUTH_CLIENT_SECRET: 'secret',
    OV_NETWORK_INTERNAL_URL: 'http://network.test',
    ...env,
  })
  const platform = createPlatformClient(config, fake.fetchImpl as never)!
  const warnings: string[] = []
  const sync = new PlaySync({
    db: store.db,
    url: config.playUrl,
    tokens: platform.tokens,
    fetchImpl: fake.fetchImpl,
    warn: (m) => warnings.push(m),
  })
  return { store, fake, sync, warnings }
}

describe('PlaySync (OpenVibe.Play, ADR-0007 decision 10)', () => {
  it('is off without GAMES_PLAY_URL', async () => {
    const { sync } = await setup({})
    expect(sync.enabled).toBe(false)
  })

  it('maps account keys to Play players and skips what Play would refuse', () => {
    expect(toPlayer(subject)).toBe(subject)
    expect(toPlayer(guest)).toBe(guest)
    expect(toPlayer('gst_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe('guest:gst_01JABCDEFGHJKMNPQRSTVWXYZ0')
    expect(toPlayer('usr_lowercase')).toBeNull()
    expect(toPlayer('guest:short')).toBeNull()
  })

  it('registers both titles, then posts rounds, hauls and unlocks once each', async () => {
    const { store, fake, sync } = await setup()
    await recordJoined(store.db, subject, 500)
    await recordHaul(store.db, subject, 'haul-1', 'Scrapper', 100, 1000)
    await recordRound(
      store.db,
      'salvage-rush',
      'round-1',
      [
        { key: subject, name: 'Scrapper', score: 12, rank: 1 },
        { key: guest, name: 'Guest', score: 4, rank: 2 },
      ],
      2000,
    )
    const first = await sync.syncOnce()
    expect(first.rounds).toBe(2)
    expect(first.hauls).toBe(1)
    expect(first.unlocks).toBeGreaterThan(0)

    const defined = fake.posts.filter((p) => p.method === 'PUT').map((p) => p.path)
    expect(defined).toEqual(Object.keys(PLAY_TITLES).map((id) => `/titles/${id}`))
    const sr = fake.posts.find((p) => p.method === 'PUT' && p.path === '/titles/salvage-rush')!.body
    expect(sr.boards).toEqual([{ id: 'best', name: 'Best round', kind: 'best' }])
    expect((sr.achievements as unknown[]).length).toBeGreaterThan(0)

    const rounds = fake.posts.filter((p) => p.path === '/titles/salvage-rush/scores')
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.body).toMatchObject({ board: 'best', ref: 'round-1', at: 2000 })
    expect(rounds[0]!.body.entries).toEqual([
      { player: guest, name: 'Guest', score: 4 },
      { player: subject, name: 'Scrapper', score: 12 },
    ])
    const hauls = fake.posts.filter((p) => p.path === '/titles/scraplandia/scores')
    expect(hauls.map((p) => p.body)).toEqual([
      {
        board: 'haul',
        ref: 'haul-1',
        at: 1000,
        entries: [{ player: subject, name: 'Scrapper', score: 100 }],
      },
    ])
    const unlocks = fake.posts.filter((p) => p.path.endsWith('/unlocks'))
    expect(unlocks.length).toBe(first.unlocks)
    for (const u of unlocks) {
      const title = u.path.split('/')[2]! as keyof typeof PLAY_TITLES
      const known = PLAY_TITLES[title].achievements.map((a) => a.id)
      expect(known).toContain((u.body.achievements as string[])[0])
    }

    // Nothing new: the second pass posts nothing and does not register the titles again.
    const before = fake.posts.length
    expect(await sync.syncOnce()).toEqual({ rounds: 0, hauls: 0, unlocks: 0, adoptions: 0 })
    expect(fake.posts.length).toBe(before)
  })

  it('keeps its place when Play fails and resumes there', async () => {
    const { store, fake, sync } = await setup()
    await recordHaul(store.db, subject, 'haul-1', 'Scrapper', 100, 1000)
    await recordHaul(store.db, subject, 'haul-2', 'Scrapper', 50, 1100)
    await sync.defineTitles()
    fake.failNextScores()
    await expect(sync.syncOnce()).rejects.toThrow(/answered 503/)
    expect(fake.posts.filter((p) => p.path === '/titles/scraplandia/scores')).toHaveLength(0)
    const again = await sync.syncOnce()
    expect(again.hauls).toBe(2)
    expect(
      fake.posts.filter((p) => p.path === '/titles/scraplandia/scores').map((p) => p.body.ref),
    ).toEqual(['haul-1', 'haul-2'])
  })

  it('adopts a converted guest in both titles, once; merges are left to Play', async () => {
    const { store, fake, sync } = await setup()
    await store.db.exec(sql`
      INSERT INTO identity_adoptions (adoption_key, subject_id, source, moved, conflicts, adopted_at)
      VALUES (${guest}, ${subject}, 'guest', 1, 0, 3000), ('merge:m1', ${subject}, 'merge', 1, 0, 3100)
    `)
    expect((await sync.syncOnce()).adoptions).toBe(1)
    const adopts = fake.posts.filter((p) => p.path.endsWith('/adopt'))
    expect(adopts.map((p) => p.path)).toEqual(
      Object.keys(PLAY_TITLES).map(
        (id) => `/titles/${id}/players/${encodeURIComponent(guest)}/adopt`,
      ),
    )
    expect(adopts.every((p) => p.body.person === subject)).toBe(true)
    expect((await sync.syncOnce()).adoptions).toBe(0)
  })
})
