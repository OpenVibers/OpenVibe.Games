/**
 * One production mod lifecycle (roadmap WS-M task 6, ADR-013): install → grant → use → revoke, against the
 * running Games server, with the operator's `probe` principal (grant probe games.mod.manage on openvibe.games).
 *
 *   sudo sh -c 'set -a; . /etc/openvibe/probe.env; set +a; cd /opt/openvibe.games; \
 *     node --import tsx apps/server/scripts/modLifecycleProof.ts'
 *
 * A fresh mod each run (a new mod_<ULID>) with one inert prop far from spawn:
 *   1. install with nothing approved (Games registers mod:<id> in Network: games.prop.place pending);
 *   2. grant games.prop.place (Network approves it first);
 *   3. use: the runtime places the prop within a few ticks (audit `use`);
 *   4. revoke: every grant ends in Network and here, and the runtime retracts the prop (audit `retract`).
 * Prints each step and the audit trail; exits 1 if any step is missing. Env: OV_OAUTH_CLIENT_ID (probe),
 * OV_OAUTH_CLIENT_SECRET, OV_NETWORK_INTERNAL_URL (default http://127.0.0.1:4000), GAMES_URL (default
 * http://127.0.0.1:8000). Nothing secret is printed.
 */
import { randomBytes } from 'node:crypto'

const NETWORK = (process.env.OV_NETWORK_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')
const GAMES = (process.env.GAMES_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '')
const CAP = 'games.prop.place'

function ulid(): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let t = Date.now()
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = A[t % 32] + time
    t = Math.floor(t / 32)
  }
  const r = randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += A[(r[i] ?? 0) % 32]
  return time + rand
}

async function token(): Promise<string> {
  const secret = process.env.OV_OAUTH_CLIENT_SECRET
  if (!secret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set')
  const res = await fetch(`${NETWORK}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.OV_OAUTH_CLIENT_ID ?? 'probe',
      client_secret: secret,
      audience: 'openvibe.games',
      scope: 'games.mod.manage',
    }),
  })
  const body = (await res.json()) as { access_token?: string; error?: string }
  if (!res.ok || !body.access_token)
    throw new Error(`no games.mod.manage token: ${res.status} ${body.error ?? ''}`)
  return body.access_token
}

async function main(): Promise<void> {
  const tok = await token()
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${GAMES}/api/v1/mods${path}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    }
  }
  const id = `mod_${ulid()}`
  const failures: string[] = []
  const step = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`)
    if (!ok) failures.push(name)
  }
  const manifest = {
    id,
    name: 'Lifecycle proof',
    version: '1.0.0',
    description:
      'WS-M task 6: install, grant, use, revoke. One inert prop far from spawn; retracted at the end.',
    // A publisher is a user or an app; the proof publishes as a synthetic app of its own.
    publisher: { type: 'app', id: `app_${ulid()}` },
    target: 'games.browser',
    runtime: 'games-content@1',
    permissions: { capabilities: [CAP] },
    resources: { cpuMs: 1, memoryMb: 0, storageMb: 0 },
    compatibility: { runtime: '>=1.0.0 <2.0.0' },
  }
  const pack = { props: [{ key: 'proof-bench', item: 'workbench', pos: [3900, 0, 3900] }] }

  let r = await api('POST', '', { manifest, pack, approve: [], enable: true })
  step(
    'install',
    r.status === 201 && Array.isArray(r.body.granted) && (r.body.granted as unknown[]).length === 0,
    `${r.status} ${id} granted=${JSON.stringify(r.body.granted)}`,
  )
  r = await api('POST', `/${id}/grants`, { capability: CAP })
  step(
    'grant',
    r.status === 200 && JSON.stringify(r.body.granted) === JSON.stringify([CAP]),
    `${r.status} granted=${JSON.stringify(r.body.granted)}`,
  )

  const audit = async () =>
    ((await api('GET', `/${id}/audit?limit=100`)).body.audit ?? []) as {
      action: string
      capability: string | null
      actor: string
    }[]
  let used = false
  for (let i = 0; i < 30 && !used; i++) {
    await new Promise((res) => setTimeout(res, 1000))
    used = (await audit()).some((a) => a.action === 'use' && a.capability === CAP)
  }
  step('use', used, used ? 'the runtime placed the prop' : 'no use within 30 s')

  r = await api('POST', `/${id}/revoke`, { reason: 'WS-M task 6 lifecycle proof: done' })
  step(
    'revoke',
    r.status === 200 && r.body.status === 'revoked',
    `${r.status} status=${String(r.body.status)}`,
  )
  let retracted = false
  for (let i = 0; i < 30 && !retracted; i++) {
    await new Promise((res) => setTimeout(res, 1000))
    retracted = (await audit()).some((a) => a.action === 'retract')
  }
  step('retract', retracted, retracted ? 'the prop is gone' : 'no retract within 30 s')
  const trail = (await audit()).map((a) => `${a.action}${a.capability ? `(${a.capability})` : ''}`)
  console.log(`audit: ${trail.join(' → ')}`)
  console.log(`mod: ${id}`)
  if (failures.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(String((err as Error)?.message ?? err))
  process.exit(2)
})
