import { emptyMapV2 } from '@openvibe/content'
import { createCreatorWorldStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { expect, it } from 'vitest'
import { createWorldSharing } from './sharing.js'
import { mayJoin } from './worldHost.js'
import type { GameConnection } from '../game/systems/context.js'

const KIM = 'usr_01J0000000000000000000000K'
const LEE = 'usr_01J0000000000000000000000M'
const SAM = 'usr_01J0000000000000000000000N'
const PEOPLE: Record<string, { subject: { type: 'user'; id: string }; username: string; display_name: string }> = {
  [LEE]: { subject: { type: 'user', id: LEE }, username: 'lee', display_name: 'Lee' },
  [SAM]: { subject: { type: 'user', id: SAM }, username: 'sam', display_name: 'Sam' },
  [KIM]: { subject: { type: 'user', id: KIM }, username: 'kim', display_name: 'Kim' },
}
const log = createConsoleLogger({ app: 'world-sharing-test' }, 'error')

it('a draft shared with Specific people is visible to them and joinable, and only to them', async () => {
  const db = await openTestDb()
  const store = createCreatorWorldStore(db)
  const world = await store.create({
    ownerSubject: KIM,
    ownerName: 'kim',
    title: 'Secret test world',
    summary: '',
    map: emptyMapV2(),
    now: 1,
  })
  const sent: unknown[] = []
  const sharing = createWorldSharing({
    db,
    store,
    log,
    network: {
      async json(input) {
        const { path, json, query } = input as { path: string; json?: unknown; query?: Record<string, string> }
        if (path === '/internal/identity/resolve') {
          const name = String(query?.username ?? '').toLowerCase()
          const person = Object.values(PEOPLE).find((p) => p.username === name)
          if (!person) throw Object.assign(new Error('not found'), { status: 404 })
          return { ...person, banned: false, deleted: false }
        }
        if (path === '/internal/identity/resolve-batch') {
          const results: Record<string, unknown> = {}
          for (const id of ((json as { subject_ids?: string[] }).subject_ids ?? [])) if (PEOPLE[id]) results[id] = { ...PEOPLE[id], banned: false, deleted: false }
          return { results }
        }
        if (path === '/internal/notifications/push') return { queued: true }
        throw Object.assign(new Error('not found'), { status: 404 })
      },
    },
    events: { async publish(event) { sent.push(event) } },
    notify: async () => {},
  })
  await sharing.register(world)
  expect(await sharing.audienceOf(world)).toBe('private')

  const kim = { id: '', name: 'kim', rank: null, subjectId: KIM }
  const lee = { id: '', name: 'lee', rank: null, subjectId: LEE }
  const sam = { id: '', name: 'sam', rank: null, subjectId: SAM }
  expect(await sharing.canView(lee, world.id)).toBe(false)

  await sharing.shares.update(sharing.viewer(kim), { service: 'games', kind: 'world', id: world.id }, {
    audience: 'people',
    members: [{ name: '@lee', role: 'viewer' }],
  })
  expect((await sharing.audienceOf({ ...world, status: 'draft' }))).toBe('people')
  expect(await sharing.canView(lee, world.id)).toBe(true)
  expect(await sharing.canView(sam, world.id)).toBe(false)
  expect(await sharing.canView(null, world.id)).toBe(false)
  expect(await sharing.canEdit(lee, world.id)).toBe(false)

  const as = (subject: string | null, rank: GameConnection['identity'] extends never ? never : 'admin' | null = null): GameConnection => ({
    identity: subject ? { subject, rank, authIat: null } : { guestKeyHash: 'a'.repeat(64) },
    send: () => {},
    close: () => {},
  })
  // The join still needs the world to be a draft and the person on its list.
  expect(mayJoin({ ...world, status: 'draft' }, as(LEE), true)).toBe(true)
  expect(mayJoin({ ...world, status: 'draft' }, as(SAM), false)).toBe(false)
  expect(mayJoin({ ...world, status: 'draft' }, as(null), false)).toBe(false)

  // Publishing widens it to Everyone; unpublishing narrows it to Only me.
  await sharing.syncFromStatus(world.id, 'published')
  expect((await sharing.audienceOf({ ...world, status: 'published' }))).toBe('public')
  expect(await sharing.canView(sam, world.id)).toBe(true)
  await sharing.syncFromStatus(world.id, 'draft')
  expect(await sharing.canView(sam, world.id)).toBe(false)
  await sharing.work()
  expect(sent.length).toBeGreaterThan(0)
  expect(JSON.stringify(sent)).not.toContain('Secret test world')
})
