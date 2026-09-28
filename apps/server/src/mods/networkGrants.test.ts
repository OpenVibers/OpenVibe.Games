import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createContent } from '@openvibe/content'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createConsoleLogger } from '@openvibe/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { CAP_ANNOUNCE, CAP_PLACE_PROP } from './contentPack.js'
import {
  createNetworkModGrants,
  type ModGrantAuthority,
  type ModPrincipal,
} from './networkGrants.js'
import { ModError, ModRegistry, type ModActor } from './registry.js'
import { handleModsRequest } from './routes.js'
import { MOD_ID, sampleManifest } from './testFixtures.js'

/**
 * Mod principals in Network (roadmap WS-M task 3, ADR-013): the mods API asks Network first and applies only what
 * it answered (install grants what Network approved; a refusal or an unreachable Network changes nothing here);
 * applyNetwork makes an install's copy follow its principal (a staff change in Network, or the boot read); the
 * client maps Network's answers to ModErrors.
 */
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

/** A Network stand-in: approves only what `allow` lists; `down` makes every call fail. */
function fakeNetwork(allow: string[]) {
  const calls: string[] = []
  let principal: ModPrincipal | null = null
  const state = { down: false }
  const ensure = () => {
    if (state.down)
      throw new ModError('mod.grants_unavailable', 'OpenVibe.Network could not be asked', 503)
    if (!principal) throw new ModError('mod.not_found', 'no such mod principal', 404)
    return principal
  }
  const grants: ModGrantAuthority = {
    async register(manifest, approve) {
      calls.push(`register:${[...approve].join(',')}`)
      if (state.down)
        throw new ModError('mod.grants_unavailable', 'OpenVibe.Network could not be asked', 503)
      const requested = (manifest as { permissions: { capabilities: string[] } }).permissions
        .capabilities
      const approved = approve.filter((c) => allow.includes(c))
      principal = {
        mod_id: MOD_ID,
        owner: 'games',
        status: 'active',
        requested,
        approved,
        pending: requested.filter((c) => !approved.includes(c)),
        revoked: [],
        revision: 1,
      }
      return principal
    },
    async change(_id, capability, action) {
      calls.push(`${action}:${capability}`)
      const p = ensure()
      p.approved =
        action === 'approve'
          ? [...new Set([...p.approved, capability])]
          : p.approved.filter((c) => c !== capability)
      p.revision++
      return p
    },
    async revoke() {
      calls.push('revoke')
      const p = ensure()
      p.status = 'revoked'
      p.approved = []
      return p
    },
    async list() {
      return principal ? [principal] : []
    },
  }
  return { grants, calls, state }
}

async function start(grants: ModGrantAuthority) {
  const registry = new ModRegistry(openSqliteStore(':memory:'), createContent())
  server = createServer((req, res) => {
    if (!handleModsRequest(req, res, { registry, authorize: async () => STAFF, grants, log })) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/mods`
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { registry, base, post }
}

const manifest = sampleManifest({
  permissions: { capabilities: [CAP_PLACE_PROP, CAP_ANNOUNCE] },
} as never)
const pack = { props: [{ key: 'bench', item: 'workbench', pos: [0, 0, 0] }] }

describe('mod principals in Network', () => {
  it('installs with what Network approved, and asks it before every grant change', async () => {
    const net = fakeNetwork([CAP_PLACE_PROP])
    const { registry, post, base } = await start(net.grants)
    const created = await post('', {
      manifest,
      pack,
      approve: [CAP_PLACE_PROP, CAP_ANNOUNCE],
      enable: true,
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ id: MOD_ID, granted: [CAP_PLACE_PROP] })
    expect(net.calls).toEqual([`register:${CAP_PLACE_PROP},${CAP_ANNOUNCE}`])

    expect((await post(`/${MOD_ID}/grants`, { capability: CAP_ANNOUNCE })).status).toBe(200)
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(true)
    expect(
      (await fetch(`${base}/${MOD_ID}/grants/${CAP_ANNOUNCE}`, { method: 'DELETE' })).status,
    ).toBe(200)
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
    expect(net.calls.slice(1)).toEqual([`approve:${CAP_ANNOUNCE}`, `revoke:${CAP_ANNOUNCE}`])
    // Network's events arrive after the API applied its answers: an older revision changes nothing.
    expect((await post(`/${MOD_ID}/grants`, { capability: CAP_ANNOUNCE })).status).toBe(200)
    registry.applyNetwork({
      mod_id: MOD_ID,
      status: 'active',
      approved: [CAP_PLACE_PROP],
      revision: 1,
    })
    registry.applyNetwork({
      mod_id: MOD_ID,
      status: 'active',
      approved: [CAP_PLACE_PROP],
      revision: 3,
    })
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(true)
    expect(registry.auditLog(MOD_ID).some((a) => a.actor === 'network')).toBe(false)
    // A newer one (a staff change in Network) applies.
    registry.applyNetwork({
      mod_id: MOD_ID,
      status: 'active',
      approved: [CAP_PLACE_PROP],
      revision: 5,
    })
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
    expect(
      (await fetch(`${base}/${MOD_ID}/grants/${CAP_ANNOUNCE}`, { method: 'DELETE' })).status,
    ).toBe(200)

    // Network unreachable: 503, and nothing changes here.
    net.state.down = true
    const refused = await post(`/${MOD_ID}/grants`, { capability: CAP_ANNOUNCE })
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as { code: string }).code).toBe('mod.grants_unavailable')
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
    net.state.down = false

    expect((await post(`/${MOD_ID}/revoke`, { reason: 'done' })).status).toBe(200)
    expect(registry.get(MOD_ID)?.mod.status).toBe('revoked')
    expect(net.calls.at(-1)).toBe('revoke')
  })

  it('refuses an install Network could not register, and stores nothing', async () => {
    const net = fakeNetwork([])
    net.state.down = true
    const { registry, post } = await start(net.grants)
    expect((await post('', { manifest, pack, approve: [CAP_PLACE_PROP] })).status).toBe(503)
    expect(registry.get(MOD_ID)).toBeNull()
  })

  it("applyNetwork makes an install's copy follow its principal", () => {
    const registry = new ModRegistry(openSqliteStore(':memory:'), createContent())
    registry.install({ manifest, pack, approve: [CAP_PLACE_PROP], enable: true }, STAFF)
    expect(
      registry.applyNetwork({
        mod_id: 'mod_01JZZZZZZZZZZZZZZZZZZZZZZZ',
        status: 'active',
        approved: [],
      }),
    ).toBeNull()
    registry.applyNetwork({ mod_id: MOD_ID, status: 'active', approved: [CAP_ANNOUNCE] })
    expect([...(registry.get(MOD_ID)?.granted ?? [])]).toEqual([CAP_ANNOUNCE])
    registry.applyNetwork({
      mod_id: MOD_ID,
      status: 'active',
      approved: [CAP_ANNOUNCE, 'games.not.bindable'],
    })
    expect([...(registry.get(MOD_ID)?.granted ?? [])]).toEqual([CAP_ANNOUNCE])
    expect(registry.auditLog(MOD_ID).some((a) => a.actor === 'network')).toBe(true)
    registry.applyNetwork({ mod_id: MOD_ID, status: 'revoked', approved: [] })
    expect(registry.get(MOD_ID)?.mod.status).toBe('revoked')
    expect(registry.isGranted(MOD_ID, CAP_ANNOUNCE)).toBe(false)
  })

  it('the client sends the principal token and maps Network answers', async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = []
    const answers: Response[] = [
      Response.json(
        {
          mod_id: MOD_ID,
          owner: 'games',
          status: 'active',
          requested: [],
          approved: [],
          pending: [],
          revoked: [],
          revision: 1,
        },
        { status: 201 },
      ),
      Response.json({ error: 'mod.not_requested', detail: 'not requested' }, { status: 422 }),
      Response.json({ error: 'server' }, { status: 502 }),
    ]
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return answers.shift() as Response
    }) as unknown as typeof fetch
    const scopes: (string | undefined)[] = []
    const client = createNetworkModGrants({
      networkUrl: 'http://network.test',
      tokens: {
        getToken: async (ctx) => {
          scopes.push(ctx?.scope)
          return 'tok'
        },
      },
      fetchImpl,
    })
    expect((await client.register(manifest, [CAP_PLACE_PROP], 'usr_x')).revision).toBe(1)
    expect(seen[0]).toMatchObject({
      url: 'http://network.test/internal/mods',
      auth: 'Bearer tok',
      body: { approve: [CAP_PLACE_PROP], actor: 'usr_x' },
    })
    await expect(client.change(MOD_ID, CAP_ANNOUNCE, 'approve', 'usr_x')).rejects.toMatchObject({
      code: 'mod.not_requested',
      status: 422,
    })
    await expect(client.revoke(MOD_ID, 'usr_x')).rejects.toMatchObject({ status: 503 })
    expect(scopes.every((s) => s === 'mods.grant.manage')).toBe(true)
  })
})
