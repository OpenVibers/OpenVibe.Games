import { describe, expect, it } from 'vitest'
import { sql } from 'openvibe-sdk/db'
import { accountKey } from '../accountKey.js'
import { MIGRATIONS_DIR, openTestDb, openTestStore } from '../testing.js'
import { openPgStore } from './pgStore.js'
import type { PlayerDto, WorldEntityDto } from '../dto.js'

function makeEntity(id: string): WorldEntityDto {
  return {
    id,
    kind: 'prop',
    defId: 'wooden_crate',
    ownerId: 'player1',
    pos: [1, 2, 3],
    rot: [0, 0, 0, 1],
    motion: 'dynamic',
    state: null,
    updatedAt: 1000,
  }
}

function makePlayer(overrides: Partial<PlayerDto> = {}): PlayerDto {
  return {
    id: 'p1',
    token: 'usr_01J0000000000000000000000A',
    name: 'Scrapper',
    pos: [0, 1, 0],
    yaw: 1.5,
    armor: { defId: 'padded_jacket', count: 1, meta: { dur: 12 } },
    reputation: { openvibeville: 12, rustjaw: -30 },
    unlocks: ['craft_still'],
    activeJob: { job: 'lumber_run', progress: 3 },
    inventory: {
      size: 24,
      hotbar: 6,
      slots: [{ i: 0, stack: { defId: 'wood_plank', count: 10 } }],
    },
    skills: { woodcutting: 120, mining: 40 },
    friends: ['p2', 'p3'],
    stats: { health: 90, hunger: 80, thirst: 70, stamina: 100 },
    charSlot: 0,
    appearance: {
      body: 'female',
      skin: 3,
      hairStyle: 'bun',
      hairColor: 2,
      facialHair: 'none',
      top: 1,
      bottom: 2,
      shoes: 3,
      height: 1.02,
      build: 0.95,
    },
    updatedAt: 2000,
    ...overrides,
  }
}

describe('postgres store', () => {
  it('roundtrips world entities with batch upsert and chunking', async () => {
    const store = await openTestStore()
    await store.worldEntities.upsertMany([makeEntity('a'), makeEntity('b')])
    const loaded = await store.worldEntities.loadAll()
    expect(loaded).toHaveLength(2)
    expect(loaded.find((e) => e.id === 'a')).toEqual(makeEntity('a'))

    const moved = {
      ...makeEntity('a'),
      pos: [9, 9, 9] as [number, number, number],
      motion: 'frozen' as const,
    }
    await store.worldEntities.upsertMany([moved])
    expect((await store.worldEntities.loadAll()).find((e) => e.id === 'a')).toEqual(moved)

    // A batch over the 500-row chunk boundary.
    const many = Array.from({ length: 601 }, (_, i) => makeEntity(`bulk-${i}`))
    await store.worldEntities.upsertMany(many)
    expect(await store.worldEntities.loadAll()).toHaveLength(603)

    await store.worldEntities.deleteMany(['a', 'bulk-0'])
    expect(await store.worldEntities.loadAll()).toHaveLength(601)
    await store.close()
  })

  it('roundtrips characters by subject token including json columns', async () => {
    const store = await openTestStore()
    const player = makePlayer()
    await store.players.upsert(player)
    expect(await store.players.findByToken(player.token)).toEqual(player)
    expect(await store.players.findByToken('nope')).toBeNull()
    await store.close()
  })

  it('hashes a guest token: the raw token is never stored', async () => {
    const store = await openTestStore()
    const guest = makePlayer({ id: 'g1', token: 'guestbrowsertoken0123456789abcdef' })
    await store.players.upsert(guest)
    // Lookup by the raw token hashes first and finds the row.
    const found = await store.players.findByToken(guest.token)
    expect(found?.id).toBe('g1')
    expect(found?.token).toBe(accountKey(guest.token))
    expect(found?.token).not.toBe(guest.token)
    // The raw token appears nowhere in the table.
    const rows = await store.db.many<Record<string, unknown>>(sql`SELECT * FROM characters`)
    expect(JSON.stringify(rows)).not.toContain(guest.token)
    expect(rows[0]?.account_key).toBe(accountKey(guest.token))
    await store.close()
  })

  it('roundtrips constraints with json params', async () => {
    const store = await openTestStore()
    await store.worldEntities.upsertMany([makeEntity('a'), makeEntity('b')])
    const params = {
      anchorA: [0.5, 0, 0],
      anchorB: [-0.5, 0, 0],
      axisA: [0, 1, 0],
      axisB: [0, 1, 0],
      limits: { min: -1, max: 1 },
    }
    await store.constraints.upsertMany([
      { id: 'c1', type: 'weld', entityA: 'a', entityB: 'b', params: null, updatedAt: 100 },
      { id: 'c2', type: 'hinge', entityA: 'a', entityB: 'b', params, updatedAt: 100 },
    ])
    expect(await store.constraints.loadAll()).toEqual([
      { id: 'c1', type: 'weld', entityA: 'a', entityB: 'b', params: null, updatedAt: 100 },
      { id: 'c2', type: 'hinge', entityA: 'a', entityB: 'b', params, updatedAt: 100 },
    ])
    await store.constraints.deleteMany(['c1', 'c2'])
    expect(await store.constraints.loadAll()).toEqual([])
    await store.close()
  })

  it('persists resource state json and meta values as objects', async () => {
    const store = await openTestStore()
    const node: WorldEntityDto = {
      ...makeEntity('r1'),
      kind: 'resource',
      defId: 'scrap_metal',
      motion: 'static',
      state: { remaining: 12, perUse: 2, provenance: { mapSourceId: 'n1' } },
    }
    await store.worldEntities.upsertMany([node])
    expect((await store.worldEntities.loadAll())[0]?.state).toEqual({
      remaining: 12,
      perUse: 2,
      provenance: { mapSourceId: 'n1' },
    })
    await store.meta.set('env_time', 0.34)
    await store.meta.set('world_seeded', true)
    await store.meta.set('market_village', { wood_plank: { stock: 4, at: 10 } })
    expect(await store.meta.get('env_time')).toBe(0.34)
    expect(await store.meta.get('world_seeded')).toBe(true)
    expect(await store.meta.get('market_village')).toEqual({ wood_plank: { stock: 4, at: 10 } })
    expect(await store.meta.get('missing')).toBeNull()
    await store.close()
  })

  it('rolls back every write in a transaction and commits together', async () => {
    const store = await openTestStore()
    await expect(
      store.transaction(async () => {
        await store.players.upsert(makePlayer({ id: 'p1' }))
        await store.meta.set('env_weather', 'rain')
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(await store.players.findById('p1')).toBeNull()
    expect(await store.meta.get('env_weather')).toBeNull()

    await store.transaction(async () => {
      await store.players.upsert(makePlayer({ id: 'p2' }))
      await store.meta.set('env_weather', 'fog')
    })
    expect(await store.players.findById('p2')).not.toBeNull()
    expect(await store.meta.get('env_weather')).toBe('fog')
    await store.close()
  })

  it('is place-scoped: a second store on the same database sees only its own rows', async () => {
    const db = await openTestDb()
    const a = openPgStore(db, { placeId: 'scraplandia' })
    const b = openPgStore(db, { placeId: 'otherplace' })
    await a.ensurePlace()
    await b.ensurePlace()
    await a.worldEntities.upsertMany([makeEntity('a1')])
    expect(await a.worldEntities.loadAll()).toHaveLength(1)
    expect(await b.worldEntities.loadAll()).toHaveLength(0)
    expect(MIGRATIONS_DIR).toContain('migrations')
    expect(a.placeId).toBe('scraplandia')
    expect(b.placeId).toBe('otherplace')
  })
})
