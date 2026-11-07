import { emptyMapV2, parseMapFile } from '@openvibe/content'
import { createCreatorWorldStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { expect, it } from 'vitest'
import { EXAMPLE_WORLDS } from './exampleWorlds.js'
import { seedExampleWorlds } from './seedExampleWorlds.js'

const OFFICIAL = { subject: 'usr_01JZ0000000000000000000AAA', name: 'goosely' }
const PERSON = 'usr_01JZ0000000000000000000BBB'
const quiet = createConsoleLogger({ app: 'example-worlds-test' }, 'error')

it('publishes both example worlds for the official account, and a second run changes nothing', async () => {
  const db = await openTestDb()
  const store = createCreatorWorldStore(db)
  const first = await seedExampleWorlds({ store, official: OFFICIAL, log: quiet })
  expect(first.map((r) => r.action)).toEqual(['created', 'created'])
  const published = await store.listPublished(10, 0)
  expect(published.map((w) => w.title).sort()).toEqual(['Beacon Hill', 'The Workshop'])
  for (const world of published) {
    expect(world.ownerSubject).toBe(OFFICIAL.subject)
    expect(world.status).toBe('published')
    expect(world.publishedAt).toBeTruthy()
    const stored = await store.map(world.id)
    expect(parseMapFile(stored?.map).ok).toBe(true)
  }

  const again = await seedExampleWorlds({ store, official: OFFICIAL, log: quiet, now: Date.now() + 1000 })
  expect(again.map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
  expect((await store.listPublished(10, 0)).length).toBe(2)
})

it('never touches a person\'s world, even one with the same title', async () => {
  const db = await openTestDb()
  const store = createCreatorWorldStore(db)
  const theirs = await store.create({
    ownerSubject: PERSON,
    ownerName: 'alex',
    title: EXAMPLE_WORLDS[0]!.title,
    summary: 'mine',
    map: emptyMapV2(),
    now: 1000,
  })
  const before = await store.map(theirs.id)

  await seedExampleWorlds({ store, official: OFFICIAL, log: quiet })

  const after = await store.get(theirs.id)
  expect(after).toMatchObject({ ownerSubject: PERSON, status: 'draft', title: EXAMPLE_WORLDS[0]!.title })
  expect(await store.map(theirs.id)).toEqual(before)
  expect((await store.listByOwner(PERSON)).length).toBe(1)
})

it('--revise puts back a map that drifted, and is unchanged afterwards', async () => {
  const db = await openTestDb()
  const store = createCreatorWorldStore(db)
  const created = await seedExampleWorlds({ store, official: OFFICIAL, log: quiet })
  const id = created[0]!.id
  await store.saveMap(id, emptyMapV2(), null, 2000)

  const revised = await seedExampleWorlds({ store, official: OFFICIAL, log: quiet, revise: true })
  expect(revised.map((r) => r.action)).toEqual(['revised', 'unchanged'])
  const stored = await store.map(id)
  expect(parseMapFile(stored?.map).ok).toBe(true)
  expect(JSON.stringify(stored?.map)).toContain('terrain-0')

  const again = await seedExampleWorlds({ store, official: OFFICIAL, log: quiet, revise: true })
  expect(again.map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
})

it('refuses a seed the creator-world gate would refuse, before writing anything', async () => {
  const db = await openTestDb()
  const store = createCreatorWorldStore(db)
  // A creator world may not carry NPCs; the seed check must stop before a row exists.
  const original = EXAMPLE_WORLDS[0]!.map
  try {
    ;(EXAMPLE_WORLDS[0]!.map as unknown as { npcs: unknown[] }).npcs = [
      { id: 'npc-1', npc: 'townsfolk', pos: [0, 0, 0] },
    ]
    await expect(seedExampleWorlds({ store, official: OFFICIAL, log: quiet })).rejects.toThrow(/npcs/)
    expect(await store.listPublished(10, 0)).toEqual([])
  } finally {
    ;(EXAMPLE_WORLDS[0] as unknown as { map: typeof original }).map = original
  }
})
