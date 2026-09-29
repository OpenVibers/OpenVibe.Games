import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { acceptUpgrade } from './wsTransport.js'
import { createWsTicketStore } from './wsTicket.js'
import { createActorLimiter } from 'openvibe-sdk/limits'

/**
 * WebSocket upgrade gate (ADR-0007 netcode + decision 8). The transport
 * refuses an upgrade before the WS handshake whenever the ticket is missing,
 * bad, expired, already used, or the address has crossed its per-window
 * limit.
 */

/** A fake socket that records what was written/destroyed. */
function fakeSocket(remoteAddress = '127.0.0.1'): Socket & {
  _writes: Buffer[]
  _destroyed: boolean
} {
  const pt = new PassThrough() as unknown as Socket
  const writes: Buffer[] = []
  const fake = Object.assign(pt, {
    remoteAddress,
    destroyed: false,
    _writes: writes,
    _destroyed: false,
    write(chunk: string | Buffer) {
      writes.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
      return true
    },
    destroy() {
      ;(this as unknown as { _destroyed: boolean })._destroyed = true
    },
    end(chunk?: string | Buffer) {
      if (chunk) writes.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
      ;(this as unknown as { _destroyed: boolean })._destroyed = true
      return this
    },
  }) as Socket & { _writes: Buffer[]; _destroyed: boolean }
  return fake
}

/** A fake request with a URL, headers, and a socket object so pendingIdentities can stamp it. */
function fakeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' } as never,
  } as unknown as IncomingMessage
}

/** A limits helper with effectively no per-minute cap (tests that don't care). */
function openLimits() {
  const limiter = createActorLimiter({
    limits: { minute: 10_000 },
    actor: (req) => (req as { ovActor?: string }).ovActor ?? null,
  })
  return {
    editorActor: (token: string) => `editor:${token}`,
    // Unused by acceptUpgrade; present so the object shape matches the real
    // GamesActorLimits.
    mapSave: () => Promise.resolve(true),
    asset: () => Promise.resolve(true),
    modWrite: () => Promise.resolve(true),
    ticket: () => Promise.resolve(true),
    upgrade: (req: unknown, _res: unknown, actor: string) =>
      new Promise<boolean>((resolve) => {
        ;(req as { ovActor?: string }).ovActor = actor
        limiter('games.ws.upgrade', { minute: 10_000 })(req as never, _res as never, () =>
          resolve(true),
        )
      }),
  }
}

describe('ws upgrade gate', () => {
  it('refuses an upgrade with no ticket (401 + destroy)', async () => {
    const tickets = createWsTicketStore()
    const limits = openLimits()
    const sock = fakeSocket()
    const ok = await acceptUpgrade(
      tickets,
      limits,
      { warn: () => undefined } as never,
      fakeReq('/ws'),
      sock,
    )
    expect(ok).toBe(false)
    expect(sock._destroyed).toBe(true)
    expect(Buffer.concat(sock._writes).toString('utf8')).toContain('401')
  })

  it('refuses an upgrade with a ticket the store has never issued', async () => {
    const tickets = createWsTicketStore()
    const sock = fakeSocket()
    const ok = await acceptUpgrade(
      tickets,
      openLimits(),
      { warn: () => undefined } as never,
      fakeReq('/ws?ticket=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      sock,
    )
    expect(ok).toBe(false)
    expect(sock._destroyed).toBe(true)
    expect(Buffer.concat(sock._writes).toString('utf8')).toContain('401')
  })

  it('accepts a fresh ticket, then refuses a second upgrade with the same token (single-use)', async () => {
    const tickets = createWsTicketStore()
    const limits = openLimits()
    const { token } = await tickets.issue({
      subject: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
      rank: null,
      authIat: null,
    })
    const a = fakeSocket('10.0.0.1')
    expect(
      await acceptUpgrade(
        tickets,
        limits,
        { warn: () => undefined } as never,
        fakeReq(`/ws?ticket=${token}`),
        a,
      ),
    ).toBe(true)
    expect(a._destroyed).toBe(false)
    // A second attempt with the same token: refused (the first consume
    // deleted it from the store).
    const b = fakeSocket('10.0.0.2')
    expect(
      await acceptUpgrade(
        tickets,
        limits,
        { warn: () => undefined } as never,
        fakeReq(`/ws?ticket=${token}`),
        b,
      ),
    ).toBe(false)
    expect(b._destroyed).toBe(true)
    expect(Buffer.concat(b._writes).toString('utf8')).toContain('401')
  })

  it('refuses an expired ticket', async () => {
    let now = 1_000_000
    const tickets = createWsTicketStore({ now: () => now })
    const { token } = await tickets.issue({
      guestKeyHash: 'a'.repeat(64),
    })
    now += 31_000
    const sock = fakeSocket()
    const ok = await acceptUpgrade(
      tickets,
      openLimits(),
      { warn: () => undefined } as never,
      fakeReq(`/ws?ticket=${token}`),
      sock,
    )
    expect(ok).toBe(false)
    expect(sock._destroyed).toBe(true)
  })

  it('refuses upgrades past the per-address rate limit (429)', async () => {
    const tickets = createWsTicketStore()
    // The SDK limiter lets a single name carry its own per-minute cap, so
    // the test is independent of createGamesActorLimits' production routing.
    const limiter = createActorLimiter({
      limits: { minute: 120 },
      actor: (req) => (req as { ovActor?: string }).ovActor ?? null,
    })
    const wrapped = (req: unknown, res: unknown, actor: string) =>
      new Promise<boolean>((resolve) => {
        ;(req as { ovActor?: string }).ovActor = actor
        limiter('games.ws.upgrade', { minute: 2 })(req as never, res as never, () => resolve(true))
        const r = res as { writableEnded?: boolean; headersSent?: boolean }
        if (r.writableEnded || r.headersSent) resolve(false)
      })
    const warn = vi.fn()
    for (let i = 0; i < 2; i++) {
      const sock = fakeSocket('10.0.0.99')
      const { token } = await tickets.issue({
        subject: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
        rank: null,
        authIat: null,
      })
      expect(
        await acceptUpgrade(
          tickets,
          { upgrade: wrapped } as never,
          { warn } as never,
          fakeReq(`/ws?ticket=${token}`),
          sock,
        ),
      ).toBe(true)
    }
    const sock = fakeSocket('10.0.0.99')
    const { token } = await tickets.issue({
      subject: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
      rank: null,
      authIat: null,
    })
    expect(
      await acceptUpgrade(
        tickets,
        { upgrade: wrapped } as never,
        { warn } as never,
        fakeReq(`/ws?ticket=${token}`),
        sock,
      ),
    ).toBe(false)
    expect(sock._destroyed).toBe(true)
    expect(Buffer.concat(sock._writes).toString('utf8')).toContain('429')
  })

  it('does not let a spoofed X-Forwarded-For escape the per-address limit', async () => {
    const tickets = createWsTicketStore()
    const limiter = createActorLimiter({
      limits: { minute: 120 },
      actor: (req) => (req as { ovActor?: string }).ovActor ?? null,
    })
    const wrapped = (req: unknown, res: unknown, actor: string) =>
      new Promise<boolean>((resolve) => {
        ;(req as { ovActor?: string }).ovActor = actor
        limiter('games.ws.upgrade', { minute: 2 })(req as never, res as never, () => resolve(true))
        const r = res as { writableEnded?: boolean; headersSent?: boolean }
        if (r.writableEnded || r.headersSent) resolve(false)
      })
    // Same TCP peer every time, a different spoofed X-Forwarded-For each time.
    // Without a trusted proxy the limit must key on the socket address, so the
    // third upgrade is refused even though the header claims a new client.
    for (let i = 0; i < 2; i++) {
      const { token } = await tickets.issue({
        subject: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
        rank: null,
        authIat: null,
      })
      expect(
        await acceptUpgrade(
          tickets,
          { upgrade: wrapped } as never,
          { warn: vi.fn() } as never,
          fakeReq(`/ws?ticket=${token}`, { 'x-forwarded-for': `203.0.113.${i}` }),
          fakeSocket('10.0.0.99'),
        ),
      ).toBe(true)
    }
    const { token } = await tickets.issue({
      subject: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
      rank: null,
      authIat: null,
    })
    const sock = fakeSocket('10.0.0.99')
    expect(
      await acceptUpgrade(
        tickets,
        { upgrade: wrapped } as never,
        { warn: vi.fn() } as never,
        fakeReq(`/ws?ticket=${token}`, { 'x-forwarded-for': '198.51.100.7' }),
        sock,
      ),
    ).toBe(false)
    expect(Buffer.concat(sock._writes).toString('utf8')).toContain('429')
  })

  it('fails closed with 503 when the ticket store errors', async () => {
    const tickets = {
      issue: async () => {
        throw new Error('x')
      },
      consume: async () => {
        throw new Error('valkey down')
      },
      reset: () => undefined,
    }
    const sock = fakeSocket()
    const ok = await acceptUpgrade(
      tickets,
      openLimits(),
      { warn: () => undefined } as never,
      fakeReq('/ws?ticket=whatever'),
      sock,
    )
    expect(ok).toBe(false)
    expect(sock._destroyed).toBe(true)
    expect(Buffer.concat(sock._writes).toString('utf8')).toContain('503')
  })
})
