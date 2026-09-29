/**
 * Editor and mods HTTP routes authorize on the Network staff capability
 * `staff.games.manage` (and, for the mods API, the service capability
 * `games.mod.manage`). The legacy shared secret is gone: a request without a bearer, or
 * with a bearer that the mock Network rejects, is refused.
 *
 * Boots a tiny mock openvibe.network + the real createHttpServer, then
 * exercises:
 *   - /api/map-assets: POST refused without a staff bearer (403)
 *   - /api/map-assets: POST refused when the bearer resolves to a non-staff
 *     user (403)
 *   - /api/map-assets: POST accepted when the bearer resolves to admin
 *   - /api/v1/mods: install POST refused without a bearer (403)
 *   - /api/v1/mods: install POST accepted when the bearer is a Network
 *     user with staff.games.manage (201)
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContent } from '@openvibe/content'
import { openTestStore } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ServerMetrics } from '../observability/metrics.js'
import { createHttpServer } from './httpServer.js'
import { createStaffAuthorizer } from '../platform/staffAuth.js'
import { ModRegistry } from '../mods/registry.js'
import { handleModsRequest } from '../mods/routes.js'
import { sampleManifest } from '../mods/testFixtures.js'
import { CAP_PLACE_PROP } from '../mods/contentPack.js'

const log = createConsoleLogger({ app: 'test' }, 'error')

let mockNet: Server | null = null
let mockNetUrl = ''
let dir = ''
let server: Server | null = null
let port = 0

beforeAll(async () => {
  // Tiny mock openvibe.network: tokens map to users (admin / user) and the
  // staff role is derived from the user record exactly as the real
  // Network does (canEditMap uses staff.games.manage).
  const users = new Map<string, { subject_id: string; role: 'admin' | 'user' }>([
    ['staff-token', { subject_id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0', role: 'admin' }],
    ['user-token', { subject_id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ1', role: 'user' }],
  ])
  mockNet = createServer((req, res) => {
    if (req.url === '/api/auth/me') {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      const u = bearer ? users.get(bearer) : undefined
      if (!u) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"forbidden"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ user: { id: 1, username: bearer, ...u } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => mockNet!.listen(0, '127.0.0.1', r))
  mockNetUrl = `http://127.0.0.1:${(mockNet.address() as AddressInfo).port}/api/auth/me`

  dir = mkdtempSync(join(tmpdir(), 'ovg-staff-'))
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'map.json'), JSON.stringify({ v: 2, terrains: [], statics: [] }))
  const _d = mkdtempSync(join(tmpdir(), 'ovg-mod-store-'))
  void _d
  const registry = new ModRegistry(await openTestStore(), createContent())
  await registry.load()
  const authorize = createStaffAuthorizer({
    networkAuthUrl: mockNetUrl,
    networkUrl: mockNetUrl.replace(/\/api\/auth\/me$/, ''),
  })

  const metrics = new ServerMetrics()
  server = createHttpServer(
    null,
    metrics,
    log,
    join(dir, 'data', 'map.json'),
    { networkAuthUrl: mockNetUrl },
    undefined,
    undefined,
    null,
    {
      handle: (req, res) => handleModsRequest(req, res, { registry, authorize, log }),
    },
  )
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterEach(() => {
  // Registry state is per-test; we keep the server running for speed.
})

afterAll(() => {
  server?.close()
  mockNet?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const baseUrl = () => `http://127.0.0.1:${port}`

describe('editor HTTP routes', () => {
  it('refuses POST /api/map-assets without a bearer (403)', async () => {
    const resp = await fetch(`${baseUrl()}/api/map-assets`, { method: 'POST', body: 'x' })
    expect(resp.status).toBe(403)
  })

  it('refuses POST /api/map-assets when the bearer is not staff (403)', async () => {
    const resp = await fetch(`${baseUrl()}/api/map-assets`, {
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
    expect(resp.status).toBe(403)
  })

  it('refuses POST /api/map-assets when the mock Network rejects the bearer (403)', async () => {
    const resp = await fetch(`${baseUrl()}/api/map-assets`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-in-mock' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
    expect(resp.status).toBe(403)
  })

  it('accepts POST /api/map-assets from a staff.games.manage session (200)', async () => {
    // The mock Network resolves `staff-token` to an admin whose role grants
    // staff.games.manage; canEditMap admits exactly that (owner/admin).
    const resp = await fetch(`${baseUrl()}/api/map-assets`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; hash: string }
    expect(body.ok).toBe(true)
    expect(body.hash).toMatch(/^sha256-[a-f0-9]+$/)
  })
})

describe('mods HTTP API', () => {
  it('refuses an install POST without a bearer (capability.denied)', async () => {
    const resp = await fetch(`${baseUrl()}/api/v1/mods`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: sampleManifest(),
        pack: { props: [{ key: 'bench', item: 'workbench', pos: [0, 0, 0] }] },
        approve: [CAP_PLACE_PROP],
        enable: true,
      }),
    })
    expect(resp.status).toBe(403)
  })

  it('refuses a non-staff bearer (capability.denied)', async () => {
    const resp = await fetch(`${baseUrl()}/api/v1/mods`, {
      method: 'POST',
      headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: sampleManifest(),
        pack: { props: [{ key: 'bench', item: 'workbench', pos: [0, 0, 0] }] },
        approve: [CAP_PLACE_PROP],
        enable: true,
      }),
    })
    expect(resp.status).toBe(403)
  })

  it('accepts a staff bearer (201) and the install is reachable by id', async () => {
    const resp = await fetch(`${baseUrl()}/api/v1/mods`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: sampleManifest(),
        pack: { props: [{ key: 'bench', item: 'workbench', pos: [0, 0, 0] }] },
        approve: [CAP_PLACE_PROP],
        enable: true,
      }),
    })
    expect(resp.status).toBe(201)
    const view = (await resp.json()) as { id: string }
    expect(typeof view.id).toBe('string')
    const get = await fetch(`${baseUrl()}/api/v1/mods/${view.id}`)
    expect(get.status).toBe(200)
  })
})
