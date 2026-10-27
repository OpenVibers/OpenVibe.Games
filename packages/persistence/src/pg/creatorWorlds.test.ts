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

    // A team (migration 0015): editors, the worlds they edit, an invite that runs out.
    await store.addMember(world.id, LEE, 'lee', 5)
    await store.addMember(world.id, LEE, 'lee b', 6)
    expect(await store.members(world.id)).toEqual([{ subject: LEE, name: 'lee b', addedAt: 5 }])
    expect(await store.isMember(world.id, LEE)).toBe(true)
    expect((await store.listByMember(LEE)).map((w) => w.id)).toEqual([world.id])
    await store.setInvite(world.id, 'h1', 2000)
    expect(await store.inviteExpires(world.id, 1500)).toBe(2000)
    expect((await store.byInvite('h1', 1500))?.id).toBe(world.id)
    expect(await store.byInvite('h1', 2500)).toBeNull()
    expect(await store.inviteExpires(world.id, 2500)).toBeNull()
    await store.setInvite(world.id, null, null)
    expect(await store.byInvite('h1', 1500)).toBeNull()
    expect(await store.removeMember(world.id, LEE)).toBe(true)
    expect(await store.isMember(world.id, LEE)).toBe(false)
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

    // Team places follow the account too (migration 0015): KIM edits ZED's world and LEE's world.
    const ZED = 'usr_01J0000000000000000000000Z'
    const zeds = await store.create({
      ownerSubject: ZED,
      ownerName: 'zed',
      title: 'Z',
      summary: '',
      map: MAP,
      now: 2,
    })
    const lees = await store.create({
      ownerSubject: LEE,
      ownerName: 'lee',
      title: 'L',
      summary: '',
      map: MAP,
      now: 3,
    })
    await store.addMember(zeds.id, KIM, 'kim', 4)
    await store.addMember(lees.id, KIM, 'kim', 4)
    expect(
      (await identity.exportSubject(KIM)).creatorWorldTeams.map((t) => t.world_id).sort(),
    ).toEqual([zeds.id, lees.id].sort())

    await identity.mergeSubject(KIM, LEE, 'merge-1', 10)
    expect((await store.get(kims.id))?.ownerSubject).toBe(LEE)
    // KIM's place on ZED's team is LEE's now; on LEE's own world it is gone (an owner needs no team place).
    expect((await store.members(zeds.id)).map((m) => m.subject)).toEqual([LEE])
    expect(await store.members(lees.id)).toEqual([])

    const erased = await identity.eraseSubjects([LEE])
    expect(erased.creator_worlds).toBe(2)
    expect(await store.get(kims.id)).toBeNull()
    // Erased from every team, and ZED's world stays ZED's.
    expect(await store.members(zeds.id)).toEqual([])
    expect((await store.get(zeds.id))?.ownerSubject).toBe(ZED)
  })
})
