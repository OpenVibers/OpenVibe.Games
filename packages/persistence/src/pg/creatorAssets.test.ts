import { describe, expect, it } from 'vitest'
import { sql } from 'openvibe-sdk/db'
import { openTestDb } from '../testing.js'
import { createIdentityRepository } from './platformRepositories.js'
import { createCreatorAssetStore } from './creatorAssets.js'

const KIM = 'usr_01J0000000000000000000000K'
const LEE = 'usr_01J0000000000000000000000L'
const ZED = 'usr_01J0000000000000000000000Z'
const BUILD = {
  v: 1,
  statics: [],
  nodes: [{ id: 'no-1', node: 'oak_tree', pos: [0, 0, 0] }],
  props: [],
  lights: [],
}
const SCRIPT = {
  format: 'games-quickjs@1',
  id: 'welcome',
  version: '1.0.0',
  entry: 'welcome.js',
  source: '',
  hooks: [],
}

describe('creator assets store', () => {
  it('publishes, lists by kind and owner, counts a use once per person, hides and removes', async () => {
    const db = await openTestDb()
    const store = createCreatorAssetStore(db)
    const build = await store.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      kind: 'prefab',
      title: 'Oak',
      summary: 'One tree',
      body: BUILD,
      fromWorld: { id: 'w0000000001', title: 'Moon base' },
      now: 1000,
    })
    expect(build.id).toMatch(/^a[0-9a-z]{10}$/)
    expect(build).toMatchObject({
      status: 'published',
      uses: 0,
      fromWorld: { id: 'w0000000001', title: 'Moon base' },
    })
    expect(build.body).toEqual(BUILD)
    const script = await store.create({
      ownerSubject: LEE,
      ownerName: 'lee',
      kind: 'script',
      title: 'Welcome',
      summary: '',
      body: SCRIPT,
      now: 2000,
    })
    expect(script.fromWorld).toBeNull()

    expect((await store.listPublished(null, 10, 0)).map((a) => a.id)).toEqual([script.id, build.id])
    expect((await store.listPublished('prefab', 10, 0)).map((a) => a.id)).toEqual([build.id])
    expect((await store.listPublished(null, 1, 1)).map((a) => a.id)).toEqual([build.id])
    expect(await store.countByOwner(KIM)).toBe(1)
    expect((await store.listByOwner(LEE)).map((a) => a.id)).toEqual([script.id])

    expect(await store.countUse(build.id, LEE, 3000)).toBe(true)
    expect(await store.countUse(build.id, LEE, 3001)).toBe(false)
    expect((await store.get(build.id))?.uses).toBe(1)

    const hidden = await store.update(build.id, { status: 'hidden' }, 4000)
    expect(hidden?.status).toBe('hidden')
    expect((await store.listPublished(null, 10, 0)).map((a) => a.id)).toEqual([script.id])
    expect(
      (await store.update(build.id, { title: 'Big oak', status: 'published' }, 4001))?.title,
    ).toBe('Big oak')

    await store.rename(KIM, 'kimberly')
    expect((await store.get(build.id))?.ownerName).toBe('kimberly')
    expect(await store.remove(build.id)).toBe(true)
    expect(await store.get(build.id)).toBeNull()
    expect(await db.many(sql`SELECT * FROM creator_asset_uses`)).toEqual([])
  })

  it('follows the account: export, merge into the survivor (uses recounted) and erasure', async () => {
    const db = await openTestDb()
    const store = createCreatorAssetStore(db)
    const identity = createIdentityRepository(db)
    const mk = (owner: string, title: string) =>
      store.create({
        ownerSubject: owner,
        ownerName: owner.slice(-1),
        kind: 'prefab',
        title,
        summary: '',
        body: BUILD,
        now: 1,
      })
    const kims = await mk(KIM, 'Kim build')
    const lees = await mk(LEE, 'Lee build')
    const zeds = await mk(ZED, 'Zed build')
    // KIM used LEE's and ZED's builds; LEE used ZED's too.
    await store.countUse(lees.id, KIM, 2)
    await store.countUse(zeds.id, KIM, 3)
    await store.countUse(zeds.id, LEE, 4)

    const out = await identity.exportSubject(KIM)
    expect(out.creatorAssets.map((a) => a.id)).toEqual([kims.id])
    expect(out.creatorAssetUses.map((u) => u.asset_id).sort()).toEqual([lees.id, zeds.id].sort())

    // KIM folds into LEE: KIM's build is LEE's; KIM's use of LEE's own build no longer counts, and ZED's build
    // counts one use by LEE, not two.
    await identity.mergeSubject(KIM, LEE, 'merge-1', 10)
    expect((await store.get(kims.id))?.ownerSubject).toBe(LEE)
    expect((await store.get(lees.id))?.uses).toBe(0)
    expect((await store.get(zeds.id))?.uses).toBe(1)

    expect(await identity.eraseSubjects([LEE])).toMatchObject({ creator_assets: 2 })
    expect((await store.listByOwner(LEE)).length).toBe(0)
    expect(await db.many(sql`SELECT subject FROM creator_asset_uses`)).toEqual([])
    expect((await store.get(zeds.id))?.ownerSubject).toBe(ZED)
  })
})
