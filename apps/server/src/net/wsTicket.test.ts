import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_MEMORY_TICKETS,
  TICKET_TTL_MS,
  createWsTicketStore,
  isGuestTicket,
  isSubjectTicket,
} from './wsTicket.js'
import { hashGuestKey } from './guestIdentity.js'
import type { Valkey } from 'openvibe-sdk/valkey'

/**
 * WebSocket upgrade tickets (ADR-0007 netcode + decision 8):
 *  - 32 random bytes base64url;
 *  - single-use, 30 s TTL;
 *  - bound to either a subject (usr_…/gst_…) or a hashed guest key;
 *  - a guest ticket never carries a subject, and an account ticket never
 *    carries a guest key.
 * With Valkey, Valkey is the source of truth: SET … PX … NX on issue and
 * GETDEL on consume, so exactly one of two racing consumers wins.
 */
describe('wsTicket store', () => {
  let now = 1_000_000
  beforeEach(() => {
    now = 1_000_000
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const subject = { subject: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0', rank: 'admin' as const, authIat: 1 }
  const guest = { guestKeyHash: hashGuestKey('openvibe-guest-1') }

  it('issues a base64url ticket with 32 bytes of randomness', async () => {
    const store = createWsTicketStore({ now: () => now })
    const { token, expiresAt } = await store.issue(subject)
    // 32 bytes → 43 base64url chars (no padding).
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt).toBe(now + TICKET_TTL_MS)
  })

  it('returns the bound identity and consumes the ticket atomically', async () => {
    const store = createWsTicketStore({ now: () => now })
    const { token } = await store.issue(subject)
    const got = await store.consume(token)
    expect(got).not.toBeNull()
    expect(isSubjectTicket(got!.identity)).toBe(true)
    if (isSubjectTicket(got!.identity)) {
      expect(got!.identity.subject).toBe(subject.subject)
      expect(got!.identity.rank).toBe('admin')
    }
    // Second consume: nothing left, returns null.
    expect(await store.consume(token)).toBeNull()
  })

  it('refuses expired tickets', async () => {
    const store = createWsTicketStore({ now: () => now })
    const { token } = await store.issue(subject)
    now += TICKET_TTL_MS + 1
    expect(await store.consume(token)).toBeNull()
  })

  it('refuses unknown tickets', async () => {
    const store = createWsTicketStore({ now: () => now })
    expect(await store.consume('not-a-real-ticket')).toBeNull()
  })

  it('binds guest tickets to a hashed key, never to a subject', async () => {
    const store = createWsTicketStore({ now: () => now })
    const { token } = await store.issue(guest)
    const got = await store.consume(token)
    expect(got).not.toBeNull()
    expect(isGuestTicket(got!.identity)).toBe(true)
    expect(isSubjectTicket(got!.identity)).toBe(false)
    if (isGuestTicket(got!.identity)) {
      // The store carries the HASH; the raw guest token never lands.
      expect(got!.identity.guestKeyHash).toBe(guest.guestKeyHash)
      expect(got!.identity.guestKeyHash).not.toContain('openvibe-guest-1')
      expect(got!.identity.guestKeyHash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('sweeps expired tickets on issue, not only on consume', async () => {
    const store = createWsTicketStore({ now: () => now })
    const a = (await store.issue(subject)).token
    now += TICKET_TTL_MS + 1
    // Issuing a fresh ticket sweeps the expired one; no consume happened.
    const b = (await store.issue(subject)).token
    expect(await store.consume(a)).toBeNull()
    expect(await store.consume(b)).not.toBeNull()
  })

  it('caps the in-memory store, evicting the oldest ticket', async () => {
    const store = createWsTicketStore({ now: () => now })
    const first = (await store.issue(subject)).token
    for (let i = 0; i < MAX_MEMORY_TICKETS - 1; i++) await store.issue(subject)
    // One more than the cap: the oldest is gone, the newest survives.
    const last = (await store.issue(subject)).token
    expect(await store.consume(first)).toBeNull()
    expect(await store.consume(last)).not.toBeNull()
  })

  it('reset() drops every in-memory ticket (test seam)', async () => {
    const store = createWsTicketStore({ now: () => now })
    const { token } = await store.issue(subject)
    store.reset()
    expect(await store.consume(token)).toBeNull()
  })

  it('with Valkey, two racing consumes of one ticket have exactly one winner', async () => {
    const valkey = fakeValkey()
    const store = createWsTicketStore({ valkey, now: () => now })
    const { token } = await store.issue(subject)
    const results = await Promise.all([store.consume(token), store.consume(token)])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(1)
  })

  it('with Valkey, issue writes SET … PX … NX and consume removes the key', async () => {
    const valkey = fakeValkey()
    const store = createWsTicketStore({ valkey, now: () => now })
    const { token } = await store.issue(subject)
    const entry = valkey._store.get(valkey.key('ws-ticket', token))
    expect(entry?.value).toContain(subject.subject)
    expect(entry?.ttlMs).toBe(TICKET_TTL_MS)
    expect(await store.consume(token)).not.toBeNull()
    expect(valkey._store.has(valkey.key('ws-ticket', token))).toBe(false)
  })

  it('with Valkey, a store error propagates (the caller fails closed)', async () => {
    const valkey = fakeValkey()
    valkey._fail = true
    const store = createWsTicketStore({ valkey, now: () => now })
    await expect(store.issue(subject)).rejects.toThrow()
    await expect(store.consume('anything')).rejects.toThrow()
  })
})

interface FakeEntry {
  value: string
  ttlMs: number
}

/**
 * A minimal iovalkey stand-in: SET with PX/NX and an atomic GETDEL. The
 * check-and-delete in getdel is synchronous, so two racing consumers cannot
 * both win (the same guarantee a real GETDEL gives).
 */
function fakeValkey(): Valkey & { _store: Map<string, FakeEntry>; _fail: boolean } {
  const store = new Map<string, FakeEntry>()
  const fake = {
    _store: store,
    _fail: false,
    client: {
      async set(key: string, value: string, ...args: unknown[]) {
        if (fake._fail) throw new Error('valkey down')
        const px = args.indexOf('PX')
        const ttlMs = px >= 0 ? Number(args[px + 1]) : 0
        const nx = args.includes('NX')
        if (nx && store.has(key)) return null
        // Yield AFTER the NX check so a racing SET sees the entry.
        await Promise.resolve()
        store.set(key, { value, ttlMs })
        return 'OK'
      },
      async getdel(key: string) {
        if (fake._fail) throw new Error('valkey down')
        const entry = store.get(key)
        if (!entry) return null
        // Atomic consume: delete before any await.
        store.delete(key)
        return entry.value
      },
    },
    prefix: '',
    key: (...parts: string[]) => parts.join(':'),
    duplicate: () => fake,
    ready: async () => ({ ok: true as const, detail: { store: 'valkey' as const } }),
    close: async () => undefined,
  }
  return fake as unknown as Valkey & { _store: Map<string, FakeEntry>; _fail: boolean }
}
