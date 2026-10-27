import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { emptyMapV2 } from '@openvibe/content'
import { createCreatorAssetStore, createCreatorWorldStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import type { EventInput } from 'openvibe-sdk/events'
import { afterEach, describe, expect, it } from 'vitest'
import { createGamesActorLimits } from '../net/actorLimits.js'
import type { NetworkUser } from '../net/networkAuth.js'
import { createAssetRoutes } from './assetRoutes.js'

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

const BUILD = {
  statics: [
    {
      id: 'st-1',
      shape: { type: 'box', size: [2, 2, 2] },
      pos: [-1, 0, 0],
      yaw: 0,
      color: '#8a8d90',
    },
    {
      id: 'st-2',
      shape: { type: 'box', size: [2, 2, 2] },
      pos: [1, 0, 0],
      yaw: 0,
      color: '#9a9187',
    },
  ],
  nodes: [{ id: 'no-1', node: 'oak_tree', pos: [0, 0, 3] }],
  props: [],
  lights: [{ id: 'li-1', type: 'point', pos: [0, 4, 0] }],
}
const SCRIPT = {
  format: 'games-quickjs@1',
  id: 'welcome',
  version: '1.0.0',
  entry: 'welcome.js',
  source: "function onPlayerJoin(e) { game.message(e.player.id, 'Welcome!') }",
  hooks: ['onPlayerJoin'],
  capabilities: ['players.read', 'player.message'],
}

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

async function setup(perPerson = 3) {
  const db = await openTestDb()
  const worlds = createCreatorWorldStore(db)
  const events: EventInput[] = []
  const handler = createAssetRoutes({
    store: createCreatorAssetStore(db),
    worlds,
    resolveUser: async (token) => USERS[token] ?? null,
    limits: createGamesActorLimits({ env: {} }),
    address: () => '127.0.0.1',
    log: createConsoleLogger({ app: 'asset-routes-test' }, 'error'),
    perPerson,
    events: {
      db,
      sink: {
        enabled: true,
        enqueue: async (_t, event) => {
          expect(db.inTransaction()).toBe(true)
          events.push(event)
        },
      },
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
  const call = async (method: string, path: string, as?: string, body?: unknown) => {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(as ? { authorization: `Bearer ${as}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await resp.text()
    return {
      status: resp.status,
      body: (text ? JSON.parse(text) : null) as Record<string, unknown> & {
        assets?: Record<string, unknown>[]
        issues?: string[]
      },
    }
  }
  return { db, worlds, events, call }
}

describe('asset store routes', () => {
  it('publishes a build and a script, lists them by kind, and keeps bodies out of the list', async () => {
    const { worlds, call } = await setup()
    const world = await worlds.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      title: 'Moon base',
      summary: '',
      map: emptyMapV2(),
      now: 1,
    })
    expect(
      (await call('POST', '/api/assets', undefined, { kind: 'prefab', title: 'x', body: BUILD }))
        .status,
    ).toBe(401)
    expect(
      (await call('POST', '/api/assets', 'guest', { kind: 'prefab', title: 'x', body: BUILD }))
        .status,
    ).toBe(401)
    const build = await call('POST', '/api/assets', 'kim', {
      kind: 'prefab',
      title: '  Two crates and a tree ',
      summary: 'A camp corner',
      body: BUILD,
      from_world: world.id,
    })
    expect(build.status).toBe(201)
    expect(build.body).toMatchObject({
      kind: 'prefab',
      title: 'Two crates and a tree',
      owner: 'kim',
      status: 'published',
      uses: 0,
      contents: { statics: 2, nodes: 1, props: 0, lights: 1, pieces: 4 },
      from_world: { id: world.id, title: 'Moon base', url: `/worlds/${world.id}` },
    })
    expect(build.body.id).toMatch(/^a[0-9a-z]{10}$/)
    // A credit names a world you build: someone else's is refused.
    expect(
      (
        await call('POST', '/api/assets', 'lee', {
          kind: 'script',
          title: 'Hi',
          body: SCRIPT,
          from_world: world.id,
        })
      ).body.error,
    ).toBe('invalid_world')
    const script = await call('POST', '/api/assets', 'lee', {
      kind: 'script',
      title: 'Welcome',
      body: SCRIPT,
    })
    expect(script.status).toBe(201)
    expect(script.body.contents).toEqual({
      hooks: ['onPlayerJoin'],
      capabilities: ['players.read', 'player.message'],
    })

    const all = await call('GET', '/api/assets')
    expect(all.body.assets?.map((a) => a.title)).toEqual(['Welcome', 'Two crates and a tree'])
    expect(all.body.assets?.[0]).not.toHaveProperty('body')
    expect(all.body.assets?.[0]).not.toHaveProperty('status')
    expect((await call('GET', '/api/assets?kind=prefab')).body.assets?.map((a) => a.kind)).toEqual([
      'prefab',
    ])
    expect((await call('GET', '/api/assets?kind=sound')).status).toBe(400)
    const one = await call('GET', `/api/assets/${String(build.body.id)}`)
    expect((one.body.body as { statics: unknown[] }).statics).toHaveLength(2)
    const mine = await call('GET', '/api/assets/mine', 'kim')
    expect(mine.body).toMatchObject({ max: 3, staff: false })
    expect(mine.body.assets?.map((a) => a.status)).toEqual(['published'])
  })

  it('refuses what a creator world would refuse, and past the per-person limit', async () => {
    const { call } = await setup(1)
    const model = await call('POST', '/api/assets', 'kim', {
      kind: 'prefab',
      title: 'Statue',
      body: { statics: [{ ...BUILD.statics[0], model: 'm1' }] },
    })
    expect(model.status).toBe(422)
    expect(model.body.error).toBe('asset_invalid')
    const badScript = await call('POST', '/api/assets', 'kim', {
      kind: 'script',
      title: 'Bad',
      body: { ...SCRIPT, capabilities: ['network.fetch'] },
    })
    expect(badScript.status).toBe(422)
    expect(
      (await call('POST', '/api/assets', 'kim', { kind: 'sound', title: 'Boom', body: {} })).body
        .issues,
    ).toEqual(['kind: prefab or script'])
    expect(
      (await call('POST', '/api/assets', 'kim', { kind: 'prefab', title: '', body: BUILD })).body
        .error,
    ).toBe('invalid_title')
    expect(
      (await call('POST', '/api/assets', 'kim', { kind: 'prefab', title: 'One', body: BUILD }))
        .status,
    ).toBe(201)
    const full = await call('POST', '/api/assets', 'kim', {
      kind: 'prefab',
      title: 'Two',
      body: BUILD,
    })
    expect(full.status).toBe(409)
    expect(full.body.error).toBe('asset_limit')
  })

  it('counts a use once per person and never its creator; staff hide and restore with an event; owner deletes', async () => {
    const { call, events } = await setup()
    const id = String(
      (await call('POST', '/api/assets', 'kim', { kind: 'prefab', title: 'Camp', body: BUILD }))
        .body.id,
    )
    expect((await call('POST', `/api/assets/${id}/use`)).status).toBe(401)
    const used = await call('POST', `/api/assets/${id}/use`, 'lee')
    expect(used.status).toBe(200)
    expect(used.body.uses).toBe(1)
    expect((used.body.body as { nodes: unknown[] }).nodes).toHaveLength(1)
    expect((await call('POST', `/api/assets/${id}/use`, 'lee')).body.uses).toBe(1)
    expect((await call('POST', `/api/assets/${id}/use`, 'kim')).body.uses).toBe(1)

    // The creator renames it; nobody else may, and the creator cannot hide or unhide it.
    expect(
      (await call('PATCH', `/api/assets/${id}`, 'kim', { title: 'Camp corner' })).body.title,
    ).toBe('Camp corner')
    expect((await call('PATCH', `/api/assets/${id}`, 'lee', { title: 'Mine now' })).status).toBe(
      404,
    )
    expect((await call('PATCH', `/api/assets/${id}`, 'kim', { status: 'hidden' })).status).toBe(403)

    const hidden = await call('PATCH', `/api/assets/${id}`, 'staff', { status: 'hidden' })
    expect(hidden.body.status).toBe('hidden')
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual(['asset.hidden'])
    expect(validate('games.moderation.action@1', events[0]?.payload).valid).toBe(true)
    expect((await call('GET', '/api/assets')).body.assets).toEqual([])
    expect((await call('GET', `/api/assets/${id}`)).status).toBe(404)
    expect((await call('POST', `/api/assets/${id}/use`, 'lee')).status).toBe(404)
    expect((await call('GET', `/api/assets/${id}`, 'kim')).body.status).toBe('hidden')
    await call('PATCH', `/api/assets/${id}`, 'staff', { status: 'published' })
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual([
      'asset.hidden',
      'asset.restored',
    ])

    expect((await call('DELETE', `/api/assets/${id}`, 'lee')).status).toBe(404)
    expect((await call('DELETE', `/api/assets/${id}`, 'kim')).status).toBe(204)
    expect((await call('GET', `/api/assets/${id}`)).status).toBe(404)
  })
})
