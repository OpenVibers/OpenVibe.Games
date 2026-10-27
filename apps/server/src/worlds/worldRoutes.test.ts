import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { emptyMapV2, type MapFileV2 } from '@openvibe/content'
import { createCreatorWorldStore, type CreatorWorld } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { createRequire } from 'node:module'
import type { EventInput } from 'openvibe-sdk/events'
import { afterEach, describe, expect, it } from 'vitest'
import { createGamesActorLimits } from '../net/actorLimits.js'
import type { NetworkUser } from '../net/networkAuth.js'
import { cleanText, createWorldRoutes, parseIfMatch } from './worldRoutes.js'

const { validate } = createRequire(import.meta.url)('openvibe-contracts') as {
  validate(id: string, v: unknown): { valid: boolean; errors?: unknown }
}

const KIM = 'usr_01J0000000000000000000000K'
const LEE = 'usr_01J0000000000000000000000L'
const STAFF = 'usr_01J0000000000000000000000S'
const USERS: Record<string, NetworkUser> = {
  kim: { id: '1', name: 'kim', rank: null, subjectId: KIM },
  lee: { id: '2', name: 'lee', rank: null, subjectId: LEE },
  staff: { id: '3', name: 'mod', rank: 'admin', subjectId: STAFF },
  guest: { id: '4', name: 'guest', rank: null, subjectId: null },
}

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

async function setup(perPerson = 2) {
  const db = await openTestDb()
  const store = createCreatorWorldStore(db)
  const calls = {
    applied: [] as string[],
    changed: [] as (string | null)[],
    removed: [] as string[],
    events: [] as EventInput[],
  }
  const handler = createWorldRoutes({
    store,
    host: {
      online: () => new Map(),
      applyMap: (id) => calls.applied.push(id),
      changed: async (world: CreatorWorld | null, id: string) => {
        calls.changed.push(world ? `${id}:${world.status}` : null)
      },
      remove: async (id, within) => {
        calls.removed.push(id)
        await db.tx(async (t) => {
          await store.remove(id)
          await within?.(t)
        })
      },
    },
    resolveUser: async (token) => USERS[token] ?? null,
    limits: createGamesActorLimits({ env: {} }),
    address: () => '127.0.0.1',
    log: createConsoleLogger({ app: 'world-routes-test' }, 'error'),
    perPerson,
    events: {
      db,
      sink: {
        enabled: true,
        enqueue: async (_t, event) => {
          expect(db.inTransaction()).toBe(true)
          calls.events.push(event)
        },
      },
      siteUrl: 'https://openvibe.games',
    },
  })
  server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (
    method: string,
    path: string,
    as?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(as ? { authorization: `Bearer ${as}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await resp.text()
    return {
      status: resp.status,
      etag: resp.headers.get('etag'),
      body: (text ? JSON.parse(text) : null) as Record<string, unknown> & {
        worlds?: Record<string, unknown>[]
        issues?: string[]
      },
    }
  }
  return { call, calls, store }
}

describe('/api/worlds', () => {
  it('cleans titles: trimmed, control characters out, length capped', () => {
    expect(cleanText('  Moon\u0007  base ', 60)).toBe('Moon base')
    expect(cleanText('x'.repeat(61), 60)).toBeNull()
    expect(cleanText(42, 60)).toBeNull()
  })

  it('reads If-Match the way it arrives through Cloudflare (a weak ETag) or straight', () => {
    expect(parseIfMatch('W/"abc123"')).toBe('abc123')
    expect(parseIfMatch('"abc123"')).toBe('abc123')
    expect(parseIfMatch(undefined)).toBeNull()
    expect(parseIfMatch('')).toBeNull()
  })

  it("remixes a published world into a new draft of the remixer's own, credited and counted", async () => {
    const { call } = await setup(2)
    const made = await call('POST', '/api/worlds', 'kim', {
      title: 'Moon base',
      summary: 'Low gravity vibes',
    })
    const id = String(made.body.id)
    const map = await call('GET', `/api/worlds/${id}/map`, 'kim')
    const next: MapFileV2 = { ...emptyMapV2(), spawn: [7, 1, 7] }
    await call('PUT', `/api/worlds/${id}/map`, 'kim', next, { 'if-match': map.etag ?? '' })

    // Signed in only, and never someone else's draft.
    expect((await call('POST', `/api/worlds/${id}/remix`)).status).toBe(401)
    expect((await call('POST', `/api/worlds/${id}/remix`, 'guest')).status).toBe(401)
    expect((await call('POST', `/api/worlds/${id}/remix`, 'lee')).status).toBe(404)
    expect((await call('POST', '/api/worlds/wnothere0000/remix', 'lee')).status).toBe(404)

    await call('PATCH', `/api/worlds/${id}`, 'kim', { status: 'published' })
    const remix = await call('POST', `/api/worlds/${id}/remix`, 'lee')
    expect(remix.status).toBe(201)
    const rid = String(remix.body.id)
    expect(rid).not.toBe(id)
    expect(remix.body).toMatchObject({
      title: 'Moon base (remix)',
      summary: 'Low gravity vibes',
      status: 'draft',
      edit_url: `/editor?world=${rid}`,
      remixed_from: { id, title: 'Moon base', owner: 'kim', url: `/worlds/${id}` },
      remixes: 0,
    })
    // The copy is the remixer's: the same map, editable by them, not by the original's owner.
    const copy = await call('GET', `/api/worlds/${rid}/map`, 'lee')
    expect(copy.status).toBe(200)
    expect((copy.body as unknown as MapFileV2).spawn).toEqual([7, 1, 7])
    expect((await call('GET', `/api/worlds/${rid}/map`, 'kim')).status).toBe(404)
    // The original counts it, publicly.
    const listed = (await call('GET', '/api/worlds')).body.worlds ?? []
    expect(listed.find((w) => w.id === id)).toMatchObject({ remixes: 1, remixed_from: null })

    // Remixing your own world makes a copy without counting; the per-person limit still holds.
    const own = await call('POST', `/api/worlds/${id}/remix`, 'kim')
    expect(own.status).toBe(201)
    expect(
      ((await call('GET', '/api/worlds')).body.worlds ?? []).find((w) => w.id === id),
    ).toMatchObject({ remixes: 1 })
    const full = await call('POST', `/api/worlds/${id}/remix`, 'kim')
    expect(full.status).toBe(409)
    expect(full.body.error).toBe('world_limit')
  })

  it('lets a signed-in person make, save, publish and delete a world; staff take one down', async () => {
    const { call, calls } = await setup()
    expect((await call('POST', '/api/worlds', undefined, { title: 'x' })).status).toBe(401)
    expect((await call('POST', '/api/worlds', 'guest', { title: 'x' })).status).toBe(401)
    expect((await call('POST', '/api/worlds', 'kim', { title: '   ' })).status).toBe(422)

    const made = await call('POST', '/api/worlds', 'kim', {
      title: 'Moon base',
      summary: 'Low gravity vibes',
    })
    expect(made.status).toBe(201)
    const id = String(made.body.id)
    expect(made.body).toMatchObject({
      status: 'draft',
      edit_url: `/editor?world=${id}`,
      play_url: `/play?world=${id}`,
    })

    // A draft is the owner's (and staff's) only.
    expect((await call('GET', '/api/worlds')).body.worlds).toEqual([])
    expect((await call('GET', `/api/worlds/${id}`)).status).toBe(404)
    expect((await call('GET', `/api/worlds/${id}`, 'lee')).status).toBe(404)
    expect((await call('GET', `/api/worlds/${id}`, 'staff')).status).toBe(200)
    const map = await call('GET', `/api/worlds/${id}/map`, 'kim')
    expect(map.status).toBe(200)
    expect(map.etag).toMatch(/^"[0-9a-f]{24}"$/)

    // Saves: creator limits, If-Match, owner only.
    const uploads: MapFileV2 = {
      ...emptyMapV2(),
      textures: [{ name: 'photo', url: '/map-assets/a.png' }],
    }
    const refused = await call('PUT', `/api/worlds/${id}/map`, 'kim', uploads)
    expect(refused.status).toBe(422)
    expect(refused.body.issues?.some((i) => i.startsWith('textures:'))).toBe(true)
    const next: MapFileV2 = { ...emptyMapV2(), spawn: [2, 1, 2] }
    const saved = await call('PUT', `/api/worlds/${id}/map`, 'kim', next, {
      'if-match': `W/${map.etag ?? ''}`,
    })
    expect(saved.status).toBe(200)
    expect(calls.applied).toEqual([id])
    expect(
      (await call('PUT', `/api/worlds/${id}/map`, 'kim', next, { 'if-match': map.etag ?? '' }))
        .status,
    ).toBe(409)
    expect((await call('PUT', `/api/worlds/${id}/map`, 'lee', next)).status).toBe(404)
    expect((await call('PUT', `/api/worlds/${id}/map`, 'staff', next)).status).toBe(404)

    // Publishing lists it for everyone, without the owner's fields.
    expect((await call('PATCH', `/api/worlds/${id}`, 'kim', { status: 'hidden' })).status).toBe(403)
    expect((await call('PATCH', `/api/worlds/${id}`, 'kim', { status: 'published' })).status).toBe(
      200,
    )
    expect(calls.changed).toEqual([`${id}:published`])
    // The first publication is an event (Quest's "Publish a creator world"); publishing again is not.
    expect(calls.events.map((e) => e.event_type)).toEqual(['games.world.published'])
    const published = calls.events[0] as EventInput & { payload: Record<string, unknown> }
    expect(published.payload).toMatchObject({
      world: id,
      owner: { type: 'user', id: KIM },
      title: 'Moon base',
      url: `https://openvibe.games/play?world=${id}`,
    })
    expect(validate('games.world.published@1', published.payload)).toMatchObject({ valid: true })
    expect((await call('PATCH', `/api/worlds/${id}`, 'kim', { status: 'draft' })).status).toBe(200)
    expect((await call('PATCH', `/api/worlds/${id}`, 'kim', { status: 'published' })).status).toBe(
      200,
    )
    expect(calls.events).toHaveLength(1)
    const listed = (await call('GET', '/api/worlds')).body.worlds ?? []
    expect(listed.map((w) => w.id)).toEqual([id])
    expect(listed[0]).toMatchObject({
      title: 'Moon base',
      owner: 'kim',
      summary: 'Low gravity vibes',
    })
    expect(listed[0]).not.toHaveProperty('status')
    expect((await call('GET', `/api/worlds/${id}/map`)).status).toBe(200)

    // Staff take it down; the owner cannot put it back, nor can staff edit its title.
    expect((await call('PATCH', `/api/worlds/${id}`, 'staff', { title: 'Mine now' })).status).toBe(
      403,
    )
    expect((await call('PATCH', `/api/worlds/${id}`, 'staff', { status: 'hidden' })).status).toBe(
      200,
    )
    expect(calls.events.at(-1)).toMatchObject({
      event_type: 'games.moderation.action',
      payload: { action: 'world.hidden', target: { type: 'world', id, owner_subject: KIM } },
    })
    expect((await call('GET', '/api/worlds')).body.worlds).toEqual([])
    expect((await call('PATCH', `/api/worlds/${id}`, 'kim', { status: 'published' })).status).toBe(
      403,
    )
    expect((await call('GET', '/api/worlds/mine', 'staff')).body).toMatchObject({ staff: true })

    // Limits: two per person here.
    expect((await call('POST', '/api/worlds', 'kim', { title: 'Two' })).status).toBe(201)
    expect((await call('POST', '/api/worlds', 'kim', { title: 'Three' })).status).toBe(409)
    expect(((await call('GET', '/api/worlds/mine', 'kim')).body.worlds ?? []).length).toBe(2)

    expect((await call('DELETE', `/api/worlds/${id}`, 'lee')).status).toBe(404)
    expect((await call('DELETE', `/api/worlds/${id}`, 'kim')).status).toBe(204)
    expect(calls.removed).toEqual([id])
    // The owner deleting is not moderation; games staff deleting someone else's world is.
    expect(calls.events.filter((e) => e.event_type === 'games.moderation.action')).toHaveLength(1)
    const other = String((await call('POST', '/api/worlds', 'lee', { title: 'Lee world' })).body.id)
    expect((await call('DELETE', `/api/worlds/${other}`, 'staff')).status).toBe(204)
    expect(calls.events.at(-1)).toMatchObject({
      event_type: 'games.moderation.action',
      actor: { type: 'user', id: STAFF },
      payload: {
        action: 'world.deleted',
        target: { type: 'world', id: other, owner_subject: LEE },
      },
    })
    expect((await call('GET', `/api/worlds/${id}`, 'kim')).status).toBe(404)
    expect((await call('GET', '/api/worlds/not-an-id')).status).toBe(404)
  })
})
