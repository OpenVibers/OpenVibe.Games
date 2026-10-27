import { describe, expect, it } from 'vitest'
import { sql } from 'openvibe-sdk/db'
import { openTestDb } from '../testing.js'
import { openPgStore } from './pgStore.js'
import { createIdentityRepository } from './platformRepositories.js'
import { createCreatorWorldStore, mapRevision } from './creatorWorlds.js'

const KIM = 'usr_01J0000000000000000000000K'
const LEE = 'usr_01J0000000000000000000000L'
const MAP = {
  v: 2,
  terrains: [],
  statics: [],
  nodes: [],
  props: [],
  lights: [],
  zones: [],
  models: [],
  textures: [],
}

describe('creator worlds store', () => {
  it('creates, lists, saves with If-Match, publishes once and removes the world with its place', async () => {
    const db = await openTestDb()
    const store = createCreatorWorldStore(db)
    const world = await store.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      title: 'Moon base',
      summary: '',
      map: MAP,
      now: 1000,
    })
    expect(world.id).toMatch(/^w[0-9a-z]{10}$/)
    expect(world).toMatchObject({
      status: 'draft',
      revision: mapRevision(MAP),
      publishedAt: null,
      plays: 0,
      remixedFrom: null,
      remixes: 0,
    })
    // A remix keeps its credit as it was copied; the original counts remixes.
    const remix = await store.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      title: 'Moon base (remix)',
      summary: '',
      map: MAP,
      now: 1001,
      remixedFrom: { id: world.id, title: 'Moon base', owner: 'kim' },
    })
    expect(remix.remixedFrom).toEqual({ id: world.id, title: 'Moon base', owner: 'kim' })
    await store.countRemix(world.id)
    expect((await store.get(world.id))?.remixes).toBe(1)
    await store.remove(remix.id)
    expect(await store.countByOwner(KIM)).toBe(1)
    expect(await store.listPublished(10, 0)).toEqual([])

    const next = { ...MAP, lights: [] as unknown[], spawn: [1, 2, 3] }
    expect(await store.saveMap(world.id, next, 'stale', 2000)).toBe('conflict')
    const saved = await store.saveMap(world.id, next, world.revision, 2000)
    expect(saved).not.toBe('conflict')
    expect((await store.map(world.id))?.map).toEqual(next)
    expect(await store.saveMap('wnope000000', next, null, 2000)).toBeNull()

    const published = await store.update(world.id, { status: 'published' }, 3000)
    expect(published?.publishedAt).toBe(3000)
    await store.update(world.id, { status: 'draft' }, 4000)
    const again = await store.update(world.id, { status: 'published', title: 'Moon base 2' }, 5000)
    expect(again).toMatchObject({ publishedAt: 3000, title: 'Moon base 2' })
    expect((await store.listPublished(10, 0)).map((w) => w.id)).toEqual([world.id])
    await store.countPlay(world.id)
    expect((await store.get(world.id))?.plays).toBe(1)
    await store.rename(KIM, 'Kim')
    expect((await store.get(world.id))?.ownerName).toBe('Kim')

    // The place's rows go with the world.
    const place = `world:${world.id}`
    const placeStore = openPgStore(db, { placeId: place })
    await placeStore.ensurePlace('Moon base')
    await placeStore.meta.set('world_seeded', true)
    expect(await store.remove(world.id)).toBe(true)
    expect(await store.get(world.id)).toBeNull()
    expect(await db.maybe(sql`SELECT 1 FROM places WHERE id = ${place}`)).toBeNull()
    expect(await db.maybe(sql`SELECT 1 FROM world_meta WHERE place_id = ${place}`)).toBeNull()
  })

  it('follows the account: export, merge and erasure (ADR-033, ADR-029)', async () => {
    const db = await openTestDb()
    const store = createCreatorWorldStore(db)
    const identity = createIdentityRepository(db)
    const kims = await store.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      title: 'A',
      summary: 's',
      map: MAP,
      now: 1,
    })
    const exported = await identity.exportSubject(KIM)
    expect(exported.creatorWorlds).toHaveLength(1)
    expect(exported.creatorWorlds[0]).toMatchObject({ id: kims.id, title: 'A' })
    expect(exported.creatorWorlds[0]).not.toHaveProperty('owner_subject')

    await identity.mergeSubject(KIM, LEE, 'merge-1', 10)
    expect((await store.get(kims.id))?.ownerSubject).toBe(LEE)

    const erased = await identity.eraseSubjects([LEE])
    expect(erased.creator_worlds).toBe(1)
    expect(await store.get(kims.id)).toBeNull()
  })
})
