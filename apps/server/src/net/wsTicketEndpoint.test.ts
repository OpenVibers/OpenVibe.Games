import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createWsTicketStore,
  handleWsTicketRequest,
  isSubjectTicket,
  type TicketIdentity,
} from './wsTicket.js'
import { hashGuestKey } from './guestIdentity.js'

/**
 * POST /api/ws-ticket — the entry point every browser and the slice test
 * hit before opening /ws. Identity comes from the Authorization header
 * (Network bearer) or the X-Guest-Token HEADER — never a query parameter,
 * which would leak the long-lived guest credential into logs and history.
 * A bearer plus X-Guest-Token binds the subject AND an adoption hint.
 */
describe('/api/ws-ticket endpoint', () => {
  let server: Server
  let mockNet: Server
  let url: string
  const tickets = createWsTicketStore()
  const SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
  const GUEST = 'guesttoken1234'

  beforeAll(async () => {
    // A tiny openvibe.network: one accepted bearer, a canonical subject.
    mockNet = createServer((req, res) => {
      if (req.url === '/api/auth/me') {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
        if (bearer !== 'staff-token') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            user: { id: 1, username: 'admin', role: 'admin', subject_id: SUBJECT },
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => mockNet.listen(0, '127.0.0.1', r))
    const networkAuthUrl = `http://127.0.0.1:${(mockNet.address() as AddressInfo).port}/api/auth/me`
    server = createServer((req, res) => {
      void handleWsTicketRequest(req, res, { tickets, networkAuthUrl })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => tickets.reset())
  afterAll(() => {
    server?.close()
    mockNet?.close()
  })

  it('issues a subject ticket for an accepted Network bearer', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token' },
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ticket: string }
    const resolved = await tickets.consume(body.ticket)
    expect(resolved).not.toBeNull()
    expect(isSubjectTicket(resolved!.identity)).toBe(true)
    if (isSubjectTicket(resolved!.identity)) expect(resolved!.identity.subject).toBe(SUBJECT)
  })

  it('rejects a bearer the Network refuses (401)', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    })
    expect(resp.status).toBe(401)
  })

  it('binds an adoption hint from X-Guest-Token on a signed-in ticket', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'x-guest-token': GUEST },
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ticket: string }
    const resolved = await tickets.consume(body.ticket)
    expect(resolved?.identity).toEqual<TicketIdentity>({
      subject: SUBJECT,
      rank: 'admin',
      authIat: null,
      adoptGuestKeyHash: hashGuestKey(GUEST),
    })
  })

  it('rejects an account-shaped x-guest-token on a signed-in request (400)', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'x-guest-token': SUBJECT },
    })
    expect(resp.status).toBe(400)
  })

  it('issues a guest ticket for the X-Guest-Token header', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { 'x-guest-token': GUEST },
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ticket: string; expiresAt: number }
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    const resolved = await tickets.consume(body.ticket)
    expect(resolved?.identity).toEqual<TicketIdentity>({ guestKeyHash: hashGuestKey(GUEST) })
  })

  it('ignores a guest token in the query string: the header is the only source', async () => {
    const resp = await fetch(`${url}/api/ws-ticket?guest=${GUEST}`, { method: 'POST' })
    expect(resp.status).toBe(401)
  })

  it('rejects an empty request (no Authorization, no X-Guest-Token)', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, { method: 'POST' })
    expect(resp.status).toBe(401)
  })

  it('rejects a non-POST request', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'GET',
      headers: { 'x-guest-token': GUEST },
    })
    expect(resp.status).toBe(405)
  })

  it('rejects a guest token that looks like an account key', async () => {
    // An account-shaped raw token is never accepted — it would let one
    // browser open someone else's characters. The server refuses first.
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { 'x-guest-token': SUBJECT },
    })
    expect(resp.status).toBe(400)
  })

  it('rejects a body larger than the cap', async () => {
    const resp = await fetch(`${url}/api/ws-ticket`, {
      method: 'POST',
      headers: { 'x-guest-token': GUEST },
      body: 'x'.repeat(2048),
    })
    expect(resp.status).toBe(413)
  })

  it('is an exact path: /api/ws-ticketX is not this endpoint', async () => {
    let wrote = false
    const req = {
      url: '/api/ws-ticketX',
      method: 'POST',
      headers: {},
      on: () => undefined,
    } as never
    const res = {
      writeHead: () => {
        wrote = true
      },
      end: () => undefined,
    } as never
    const handled = await handleWsTicketRequest(req, res, { tickets, networkAuthUrl: null })
    expect(handled).toBe(false)
    expect(wrote).toBe(false)
  })
})
