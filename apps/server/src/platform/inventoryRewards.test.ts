import { describe, expect, it } from 'vitest'
import { sql, type Db } from 'openvibe-sdk/db'
import { openTestStore } from '@openvibe/persistence/testing'
import { loadPlatformConfig } from '../config.js'
import { recordHaul, recordJoined, recordRound } from '../game/progression.js'
import { createPlatformClient } from './serviceClient.js'
import { InventoryRewards } from './inventoryRewards.js'

const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
const aliases = ['fx_toxic', 'fx_golden', 'hat_cowboy', 'fx_neon', 'px_flames', 'px_stars']

function fakeNetwork() {
  const grants: Record<string, unknown>[] = []
  const calls: string[] = []
  let failures = 0
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('grant_type')).toBe('client_credentials')
      expect(form.get('audience')).toBe('openvibe.inventory')
      expect(form.get('scope')).toBe('inventory.item.grant')
      return reply(200, { access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 })
    }
    if (url.pathname === '/api/v1/definitions') {
      expect(url.searchParams.get('issuer')).toBe('service:live')
      return reply(200, {
        definitions: aliases.map((alias, i) => ({
          id: `itd_${i}`,
          issuer: 'service:live',
          aliases: [alias],
        })),
      })
    }
    if (url.pathname === '/api/v1/grants') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-token')
      if (failures-- > 0) return reply(503, { code: 'inventory.unavailable' })
      grants.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return reply(201, { instance: { id: 'iti_1' } })
    }
    return reply(404, {})
  }
  return {
    fetchImpl,
    grants,
    calls,
    fail: () => {
      failures = 1
    },
  }
}

async function setup(enabled = true) {
  const store = await openTestStore()
  const fake = fakeNetwork()
  const config = loadPlatformConfig({
    OV_OAUTH_CLIENT_SECRET: 'secret',
    OV_NETWORK_INTERNAL_URL: 'http://network.test',
    GAMES_INVENTORY_URL: 'http://inventory.test',
    GAMES_ITEMS: enabled ? 'on' : 'off',
  })
  const platform = createPlatformClient(config, fake.fetchImpl as never)!
  // A clock the tests move: a failed grant waits out its backoff before the timer asks again.
  const clock = { at: Date.now() }
  const items = new InventoryRewards({
    db: store.db,
    url: config.inventoryUrl,
    enabled: config.items,
    tokens: platform.tokens,
    fetchImpl: fake.fetchImpl,
    now: () => clock.at,
  })
  const advance = (ms: number) => {
    clock.at += ms
  }
  return { store, fake, items, advance }
}

async function state(db: Db, key: string, game: string, achievement: string) {
  return db.maybe<{
    item_state: string | null
    item_error: string | null
    item_attempts: number
  }>(sql`
    SELECT item_state, item_error, item_attempts FROM game_achievements
    WHERE account_key = ${key} AND game_id = ${game} AND achievement_id = ${achievement}
  `)
}

describe('Inventory achievement rewards', () => {
  it('grants an account unlock once with earned origin and stable idempotency key', async () => {
    const { store, fake, items } = await setup()
    await recordHaul(store.db, subject, 'haul-1', 'Player', 100, 1000)
    await items.settleSubject(subject)
    await items.retryPending()
    expect(fake.grants).toEqual([
      expect.objectContaining({
        definition_id: 'itd_0',
        subject,
        origin: 'earned',
        idempotency_key: `games:scraplandia:first-haul:${subject}`,
      }),
    ])
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: 'granted',
      item_attempts: 1,
    })
  })

  it('leaves guest unlocks alone until adoption moves them to the subject', async () => {
    const { store, fake, items } = await setup()
    const guest = 'guest-test-key'
    await store.players.upsert({
      id: 'guest-character',
      token: guest,
      name: 'Guest',
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
    })
    await recordRound(
      store.db,
      'salvage-rush',
      'round-1',
      [{ key: guest, name: 'Guest', score: 1, rank: 2 }],
      1000,
    )
    await items.retryPending()
    expect(fake.grants).toHaveLength(0)
    await store.identity.adoptGuestCharacter(guest, subject, 2000)
    await items.settleSubject(subject)
    expect(fake.grants).toEqual([expect.objectContaining({ subject, definition_id: 'itd_3' })])
  })

  it('records a failure and retries it after its backoff', async () => {
    const { store, fake, items, advance } = await setup()
    fake.fail()
    await recordHaul(store.db, subject, 'haul-1', 'Player', 100, 1000)
    await items.settleSubject(subject)
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: 'failed',
      item_attempts: 1,
    })
    await items.retryPending()
    expect(fake.grants).toHaveLength(0)
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: 'failed',
      item_attempts: 1,
    })
    advance(3 * 60_000)
    await items.retryPending()
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: 'granted',
      item_attempts: 2,
    })
    expect(fake.grants).toHaveLength(1)
  })

  it('backfills an older unlocked achievement with no item state', async () => {
    const { store, fake, items } = await setup()
    await recordHaul(store.db, subject, 'old-haul', 'Player', 100, 1000)
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: null,
    })
    await items.retryPending()
    expect(fake.grants).toHaveLength(1)
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: 'granted',
    })
  })

  it('retries a failed grant on the timer', async () => {
    const { store, fake, items, advance } = await setup()
    fake.fail()
    await recordHaul(store.db, subject, 'haul-timer', 'Player', 100, 1000)
    await items.settleSubject(subject)
    advance(3 * 60_000)
    items.start(20)
    try {
      const deadline = Date.now() + 2000
      while (
        (await state(store.db, subject, 'scraplandia', 'first-haul'))?.item_state !== 'granted' &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
        item_state: 'granted',
        item_attempts: 2,
      })
    } finally {
      items.stop()
    }
  })

  it('exports grant state and moves it with account achievements', async () => {
    const { store, items } = await setup()
    const from = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ1'
    await recordHaul(store.db, from, 'haul-merge', 'Player', 100, 1000)
    await items.settleSubject(from)
    expect((await store.identity.exportSubject(from)).gameAchievements).toEqual([
      expect.objectContaining({
        achievement_id: 'first-haul',
        item_state: 'granted',
        item_instance: 'iti_1',
      }),
    ])
    await store.identity.mergeSubject(from, subject, 'merge-1', 2000)
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: 'granted',
    })
    expect(await state(store.db, from, 'scraplandia', 'first-haul')).toBeNull()
    await store.identity.eraseSubjects([subject])
    expect(await state(store.db, subject, 'scraplandia', 'first-haul')).toBeNull()
  })

  it('does nothing when off or the achievement has no reward', async () => {
    const off = await setup(false)
    await recordHaul(off.store.db, subject, 'haul-1', 'Player', 100, 1000)
    await off.items.settleSubject(subject)
    await off.items.retryPending()
    expect(off.fake.calls).toEqual([])
    expect(await state(off.store.db, subject, 'scraplandia', 'first-haul')).toMatchObject({
      item_state: null,
      item_attempts: 0,
    })
    const on = await setup()
    await recordJoined(on.store.db, subject, 1000)
    await on.items.settleSubject(subject)
    await on.items.retryPending()
    expect(on.fake.calls).toEqual([])
    expect(await state(on.store.db, subject, 'scraplandia', 'first-visit')).toMatchObject({
      item_state: null,
      item_attempts: 0,
    })
  })
})
