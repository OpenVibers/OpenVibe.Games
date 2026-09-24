import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { createConsoleLogger } from '@openvibe/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRevocationEvents, ensureRevocationSubscription, TOPIC } from './revocationEvents.js'

/**
 * POST /internal/events for network.user.token_valid_after: signature v2 only, loopback only, the
 * cutoff moves once (a redelivery changes nothing, anything not from Network is ignored) and the
 * person's sessions are closed through onRevoked; the boot subscription is created once.
 */
const req = createRequire(import.meta.url)
const Database = req('better-sqlite3') as new (path: string) => unknown
const { signDeliveryHeaders } = req('openvibe-sdk/events') as {
  signDeliveryHeaders(body: string, secret: string): Record<string, string>
}
const SECRET = 'x'.repeat(40)
const SUBJECT = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3'
const log = createConsoleLogger({ app: 'test' }, 'error')
const closedFor: [string, number][] = []
const events = createRevocationEvents({
  db: new Database(':memory:'),
  secrets: [SECRET],
  onRevoked: (s, ms) => {
    closedFor.push([s, ms])
    return 2
  },
  log,
})
let server: Server
let url: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (!events.handle(req, res)) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/events`
})
afterAll(() => server.close())

const at = Date.parse('2026-09-24T20:00:00Z')
const envelope = (over: Record<string, unknown> = {}) => ({
  event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3',
  event_type: TOPIC,
  version: 1,
  source: 'network',
  payload: { subject: { type: 'user', id: SUBJECT }, valid_after: new Date(at).toISOString(), reason: 'signed_out_everywhere' },
  ...over,
})
const post = async (event: unknown, headers: Record<string, string> = {}, secret = SECRET) => {
  const body = JSON.stringify({ event, seq: 1 })
  const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } })
  return { status: r.status, body: (await r.json()) as { outcome?: string; closed?: number } }
}

describe('revocation events', () => {
  it('applies a signed delivery once and closes the sessions', async () => {
    expect(await post(envelope())).toMatchObject({ status: 200, body: { outcome: 'revoked', closed: 2 } })
    expect(closedFor).toEqual([[SUBJECT, at]])
    expect(events.store.isRevoked({ subject_id: SUBJECT, iat: at / 1000 - 1 })).toBe(true)
    expect((await post(envelope())).body.outcome).toBe('unchanged')
    expect((await post(envelope({ source: 'live' }))).body.outcome).toBe('ignored:source')
    expect(closedFor.length).toBe(1)
  })

  it('refuses forged, proxied and non-POST requests', async () => {
    expect((await post(envelope(), {}, 'y'.repeat(40))).status).toBe(401)
    expect((await post(envelope(), { 'x-forwarded-for': '1.2.3.4' })).status).toBe(403)
    expect((await fetch(url)).status).toBe(405)
  })

  it('creates the subscription once', async () => {
    const subs: { topic_pattern: string; endpoint: string }[] = []
    const fake = (async (u: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        subs.push(JSON.parse(String(init.body)) as { topic_pattern: string; endpoint: string })
        return Response.json({ id: 'sub_1' }, { status: 201 })
      }
      return Response.json({ subscriptions: subs.map((s, i) => ({ id: `sub_${i + 1}`, ...s })) })
    }) as unknown as typeof fetch
    const opts = { eventsUrl: 'http://events.test', endpoint: 'http://127.0.0.1:8000/internal/events', secret: SECRET, tokens: { getToken: async () => 'tok' }, fetchImpl: fake, log }
    expect(await ensureRevocationSubscription(opts)).toBe('created')
    expect(await ensureRevocationSubscription(opts)).toBe('exists')
    expect(subs).toEqual([{ topic_pattern: TOPIC, endpoint: opts.endpoint, secret: SECRET }])
  })
})
