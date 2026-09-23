import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createContent } from '@openvibe/content'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createConsoleLogger } from '@openvibe/shared'
import { verifyUserToken } from 'openvibe-sdk/auth'
import { createMockPlatform } from 'openvibe-sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createStaffAuthorizer } from '../platform/staffAuth.js'
import { CAP_ANNOUNCE, CAP_PLACE_PROP } from './contentPack.js'
import { ModRegistry, type ModActor } from './registry.js'
import { handleModsRequest } from './routes.js'
import { MOD_ID, sampleManifest } from './testFixtures.js'

const log = createConsoleLogger({ app: 'test' }, 'error')
const STAFF: ModActor = {
  audit: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
  subject: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
}
let server: Server | null = null

afterEach(() => {
  server?.close()
  server = null
})

async function start(authorize: (req: IncomingMessage) => Promise<ModActor | null>) {
  const registry = new ModRegistry(openSqliteStore(':memory:'), createContent())
  server = createServer((req, res) => {
    if (!handleModsRequest(req, res, { registry, authorize, log })) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/mods`
  return { registry, base }
}

const installBody = {
  manifest: sampleManifest(),
  pack: { props: [{ key: 'bench', item: 'workbench', pos: [0, 0, 0] }] },
  approve: [CAP_PLACE_PROP],
  enable: true,
}

describe('mods HTTP API', () => {
  it('lets staff install, grant and revoke, and anyone read', async () => {
    const { base } = await start(async (req) =>
      req.headers.authorization === 'Bearer staff' ? STAFF : null,
    )
    const post = (path: string, body: unknown, auth = 'Bearer staff') =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const denied = await post('', installBody, 'Bearer nobody')
    expect(denied.status).toBe(403)
    expect(denied.headers.get('content-type')).toContain('application/problem+json')
    expect(await denied.json()).toMatchObject({
      code: 'capability.denied',
      error: expect.any(String),
    })

    const created = await post('', installBody)
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      id: MOD_ID,
      status: 'enabled',
      granted: [CAP_PLACE_PROP],
    })

    const list = (await (await fetch(base)).json()) as { mods: { id: string }[] }
    expect(list.mods.map((m) => m.id)).toEqual([MOD_ID])
    expect(await (await fetch(`${base}/${MOD_ID}`)).json()).toMatchObject({
      manifest: { id: MOD_ID },
    })

    expect((await post(`/${MOD_ID}/grants`, { capability: CAP_ANNOUNCE })).status).toBe(200)
    const revoked = await (await post(`/${MOD_ID}/revoke`, { reason: 'test' })).json()
    expect(revoked).toMatchObject({ status: 'revoked', granted: [] })
    expect((await post(`/${MOD_ID}/enable`, {})).status).toBe(409)

    const audit = await fetch(`${base}/${MOD_ID}/audit`, {
      headers: { authorization: 'Bearer staff' },
    })
    const actions = ((await audit.json()) as { audit: { action: string }[] }).audit.map(
      (a) => a.action,
    )
    expect(actions).toEqual(expect.arrayContaining(['install', 'grant', 'revoke_grant', 'revoke']))
    expect((await fetch(`${base}/${MOD_ID}/audit`)).status).toBe(403)
  })

  it('answers invalid manifests with problem+json and the reasons', async () => {
    const { base } = await start(async () => STAFF)
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...installBody, manifest: { ...sampleManifest(), id: 'nope' } }),
    })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { code: string; errors: string[] }
    expect(body.code).toBe('mod.manifest_invalid')
    expect(body.errors.join(' ')).toMatch(/\/id/)
    const bad = await fetch(base, { method: 'POST', body: '{not json' })
    expect(bad.status).toBe(400)
  })
})

describe('staff authorization', () => {
  it('accepts a principal token carrying games.mod.manage and nothing less', async () => {
    const platform = createMockPlatform()
    const authorize = createStaffAuthorizer({
      networkAuthUrl: null,
      networkUrl: platform.origins.network,
      editorKey: null,
      verifyPrincipal: (t) =>
        verifyUserToken(t, {
          jwks: platform.keys.jwks,
          audience: 'openvibe.games',
          allowServiceTokens: true,
        }),
    })
    const req = (token: string) =>
      ({
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as IncomingMessage
    const good = platform.signServiceToken('codes', {
      audience: 'openvibe.games',
      capabilities: ['games.mod.manage'],
    })
    expect(await authorize(req(good))).toEqual({
      audit: 'svc:codes',
      subject: { type: 'service', id: 'codes' },
    })
    const noCap = platform.signServiceToken('codes', {
      audience: 'openvibe.games',
      capabilities: ['games.mod.read'],
    })
    expect(await authorize(req(noCap))).toBeNull()
    const wrongAud = platform.signServiceToken('codes', {
      audience: 'openvibe.media',
      capabilities: ['games.mod.manage'],
    })
    expect(await authorize(req(wrongAud))).toBeNull()
    expect(await authorize(req('not-a-token'))).toBeNull()
  })

  it('falls back to the editor key only without a Network', async () => {
    const authorize = createStaffAuthorizer({
      networkAuthUrl: null,
      networkUrl: 'http://x',
      editorKey: 'k3y',
    })
    const withKey = {
      headers: { 'x-editor-key': 'k3y' },
    } as unknown as IncomingMessage
    expect(await authorize(withKey)).toMatchObject({ audit: 'editor-key' })
    const wrong = {
      headers: { 'x-editor-key': 'nope' },
    } as unknown as IncomingMessage
    expect(await authorize(wrong)).toBeNull()
  })
})
