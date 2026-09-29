/**
 * Single-use WebSocket upgrade tickets (ADR-0007 netcode + decision 8: the
 * WebSocket authenticates at the upgrade).
 *
 * A client first calls POST /api/ws-ticket (HTTP; signed-in callers present
 * their access token as today's HTTP auth, local guests present their guest
 * token in the X-Guest-Token header). The server resolves the identity, binds
 * it to a fresh 32-byte base64url ticket and returns it. The browser then
 * opens /ws?ticket=… and the upgrade handler validates-and-consumes BEFORE
 * accepting the socket.
 *
 * With VALKEY_URL the tickets live in Valkey and THAT is the source of truth:
 * issue is SET … PX … NX, consume is GETDEL, both async and awaited, so several
 * instances share one single-use ticket. Without it, an in-process Map (also
 * single-use, swept on issue and consume, capped). An infrastructure error
 * fails closed (503 at the HTTP endpoint, 401 at the upgrade): a ticket that
 * cannot be verified is never accepted.
 *
 * A ticket is bound to either:
 *   - subject (usr_…, gst_…) — a Network account or service principal, plus an
 *     optional hashed guest key to adopt on first sign-in; or
 *   - the SHA-256 of a raw guest token (a guest key, never the token itself).
 * A guest ticket never carries a subject; an account ticket never carries a
 * guest key as its identity. The raw guest token is read only from the
 * X-Guest-Token header, never from the query string (finding: it must not land
 * in proxy logs, Referer or browser history).
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Valkey } from 'openvibe-sdk/valkey'
import { resolveNetworkUser } from './networkAuth.js'
import { isGuestToken } from '../platform/accounts.js'
import { hashGuestKey } from './guestIdentity.js'

export const TICKET_TTL_MS = 30_000
const TICKET_BYTES = 32
/** Hard cap on live in-memory tickets: a flood cannot grow the Map without end. */
export const MAX_MEMORY_TICKETS = 10_000
/** The only header a raw guest token is ever read from. */
export const GUEST_TOKEN_HEADER = 'x-guest-token'

/**
 * The identity bound to a ticket. `subject` is a canonical openvibe.network
 * subject (usr_…/gst_…) and `guestKeyHash` is the SHA-256 hex of a raw guest
 * token. Exactly one of subject/guestKeyHash is set per ticket.
 *
 * `adoptGuestKeyHash` rides along on a subject ticket only: it is the hashed
 * guest key whose character joins this account on first sign-in. It comes from
 * the authenticated ticket request, never from `hello`.
 */
export type TicketIdentity =
  | {
      subject: string
      rank: 'owner' | 'admin' | 'moderator' | null
      authIat: number | null
      adoptGuestKeyHash?: string
    }
  | { guestKeyHash: string }

/** The auth header / cookie a ticket was issued against, replayed to /ws upgrade. */
export interface ResolvedTicket {
  identity: TicketIdentity
  consumed: boolean
  expiresAt: number
}

export interface WsTicketStoreOptions {
  /** Shared Valkey (ADR-035); null = in-memory only. */
  valkey?: Valkey | null
  /** Test seam. */
  now?: () => number
}

export interface WsTicketStore {
  /** Issue a fresh ticket bound to `identity`. The token is what the client uses. */
  issue(identity: TicketIdentity): Promise<{ token: string; expiresAt: number }>
  /**
   * Validate AND consume a ticket atomically. Returns the bound identity
   * or null when the ticket is unknown, expired, or already used. Throws on
   * an infrastructure error so the caller can fail closed.
   */
  consume(token: string): Promise<ResolvedTicket | null>
  /** Test seam: drop every in-memory ticket (Valkey entries expire on their own). */
  reset(): void
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function isSubject(value: string): boolean {
  return /^usr_[0-9A-HJKMNP-TV-Z]{26}$|^gst_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}

/**
 * In-memory ticket store: one Map, single-use. Lookups and consumes are O(1);
 * expired entries are swept when a ticket is issued and when one is consumed,
 * and the Map is capped so an unauthenticated flood cannot exhaust memory.
 */
function createInMemoryBase(
  now: () => number,
): Omit<WsTicketStore, 'reset'> & { reset: () => void } {
  const live = new Map<string, ResolvedTicket>()
  const sweep = (): void => {
    const t = now()
    for (const [k, v] of live) if (v.expiresAt <= t) live.delete(k)
  }
  /** Oldest-first eviction (a Map preserves insertion order). */
  const cap = (): void => {
    while (live.size >= MAX_MEMORY_TICKETS) {
      const oldest = live.keys().next().value
      if (oldest === undefined) break
      live.delete(oldest)
    }
  }
  return {
    async issue(identity) {
      sweep()
      cap()
      const expiresAt = now() + TICKET_TTL_MS
      const token = base64url(randomBytes(TICKET_BYTES))
      live.set(token, { identity, consumed: false, expiresAt })
      return { token, expiresAt }
    },
    async consume(token) {
      // O(1): no full sweep here — expiry is checked on the one entry, and
      // expired entries are swept (and the map capped) whenever a ticket is
      // issued, so a consume flood cannot make every lookup scan the map.
      const entry = live.get(token)
      if (!entry) return null
      // Single-use: consume atomically by deleting the entry before returning.
      // A second attempt with the same token sees nothing and gets null.
      live.delete(token)
      if (entry.expiresAt <= now()) return null
      return entry
    },
    reset() {
      live.clear()
    },
  }
}

/**
 * Valkey-backed ticket store: Valkey IS the source of truth (not a mirror of
 * an in-process Map). Issue is an atomic SET … PX … NX; consume is an atomic
 * GETDEL, so across instances exactly one consumer wins. Errors propagate to
 * the caller, which fails closed.
 */
function createValkeyTicketStore(valkey: Valkey, now: () => number): WsTicketStore {
  const c = valkey.client
  const key = (token: string): string => valkey.key('ws-ticket', token)
  return {
    async issue(identity) {
      const expiresAt = now() + TICKET_TTL_MS
      const token = base64url(randomBytes(TICKET_BYTES))
      const payload = JSON.stringify({ identity, expiresAt })
      const reply = await c.set(key(token), payload, 'PX', TICKET_TTL_MS, 'NX')
      if (reply === null) throw new Error('ws ticket collision')
      return { token, expiresAt }
    },
    async consume(token) {
      const raw = await c.getdel(key(token))
      if (typeof raw !== 'string') return null
      let parsed: { identity?: unknown; expiresAt?: unknown }
      try {
        parsed = JSON.parse(raw) as { identity?: unknown; expiresAt?: unknown }
      } catch {
        return null
      }
      if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now()) return null
      if (!parsed.identity || typeof parsed.identity !== 'object') return null
      return {
        identity: parsed.identity as TicketIdentity,
        consumed: false,
        expiresAt: parsed.expiresAt,
      }
    },
    reset() {
      /* Valkey entries expire on their own; nothing local to clear. */
    },
  }
}

export function createWsTicketStore(opts: WsTicketStoreOptions = {}): WsTicketStore {
  const now = opts.now ?? (() => Date.now())
  if (opts.valkey) return createValkeyTicketStore(opts.valkey, now)
  return createInMemoryBase(now)
}

/** Type guard: a resolved identity is a Network account (subject) ticket. */
export function isSubjectTicket(id: TicketIdentity): id is {
  subject: string
  rank: 'owner' | 'admin' | 'moderator' | null
  authIat: number | null
  adoptGuestKeyHash?: string
} {
  return 'subject' in id && typeof id.subject === 'string' && isSubject(id.subject)
}

/** Type guard: a resolved identity is a guest ticket. */
export function isGuestTicket(id: TicketIdentity): id is { guestKeyHash: string } {
  return 'guestKeyHash' in id && typeof id.guestKeyHash === 'string'
}

/**
 * What POST /api/ws-ticket resolves to when the call succeeds. The body is
 * sent as JSON with the TTL so a misbehaving client can refresh itself
 * before reconnecting instead of starting a handshake that will fail.
 */
export interface IssueTicketResult {
  ticket: string
  /** Unix ms when the ticket expires. */
  expiresAt: number
}

/**
 * POST /api/ws-ticket handler: resolves identity from the request and
 * issues a single-use ticket. Returns null and writes an error response
 * itself when the request is unauthenticated or malformed.
 *
 *   - Signed-in: `Authorization: Bearer <Network access token>` (the same
 *     token `/auth/me` validates). An optional `X-Guest-Token: <raw>` asks
 *     for that guest's character to be adopted into the account; it is
 *     hashed here and never stored raw.
 *   - Guest: `X-Guest-Token: <raw guest token>` (the same token the
 *     client's `openvibe.token` cookie carries). Never a query parameter.
 *
 * A ticket store failure fails closed with 503.
 */
export interface WsTicketEndpointOptions {
  tickets: WsTicketStore
  /** openvibe.network /api/auth/me endpoint, or null in local development. */
  networkAuthUrl: string | null
  log?: {
    info?(msg: string, meta?: Record<string, unknown>): void
    warn(msg: string, meta?: Record<string, unknown>): void
  }
}

const TICKET_BODY_LIMIT = 1024

function headerValue(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name]
  return typeof v === 'string' && v.length > 0 ? v : null
}

export async function handleWsTicketRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WsTicketEndpointOptions,
): Promise<boolean> {
  // Exact path match: /api/ws-ticketX is not this endpoint.
  if ((req.url ?? '').split('?')[0] !== '/api/ws-ticket') return false
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
    res.end('{"error":"method_not_allowed"}')
    return true
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
  const guest = headerValue(req, GUEST_TOKEN_HEADER)
  // Drain the request body — clients should never send a payload, but if
  // they do (a misbehaving retry layer) we cap it so an upload probe
  // can't hang the handler. The 413 is written BEFORE destroying the
  // request so a fetch client sees the status, not a half-closed socket.
  const chunks: Buffer[] = []
  let size = 0
  let tooBig = false
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > TICKET_BODY_LIMIT) {
      tooBig = true
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end('{"error":"body_too_large"}')
      req.destroy()
      return
    }
    chunks.push(c)
  })
  await new Promise<void>((r) => {
    req.on('end', r)
    req.on('close', r)
    req.on('error', r)
  })
  if (tooBig) return true
  void chunks
  let identity: TicketIdentity | null = null
  if (bearer) {
    const user = await resolveNetworkUser(opts.networkAuthUrl, bearer)
    if (!user || !user.subjectId) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"auth_failed"}')
      return true
    }
    // Guest conversion (WS-B task 8): the guest token comes from the
    // authenticated HTTP request, not from `hello`. An account-shaped value
    // is never accepted — that would open someone else's characters.
    let adoptGuestKeyHash: string | undefined
    if (guest !== null) {
      if (!isGuestToken(guest)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"error":"invalid_guest_token"}')
        return true
      }
      adoptGuestKeyHash = hashGuestKey(guest)
    }
    identity = {
      subject: user.subjectId,
      rank: user.rank,
      authIat: tokenIat(bearer),
      ...(adoptGuestKeyHash ? { adoptGuestKeyHash } : {}),
    }
  } else if (guest !== null) {
    if (!isGuestToken(guest)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_guest_token"}')
      return true
    }
    identity = { guestKeyHash: hashGuestKey(guest) }
  } else {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"unauthenticated"}')
    return true
  }
  let issued: { token: string; expiresAt: number }
  try {
    issued = await opts.tickets.issue(identity)
  } catch (err: unknown) {
    // A ticket that cannot be issued is never handed out: fail closed.
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"error":"ticket_unavailable"}')
    opts.log?.warn('ws ticket issue failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  const body: IssueTicketResult = { ticket: issued.token, expiresAt: issued.expiresAt }
  res.end(JSON.stringify(body))
  opts.log?.info?.('ws ticket issued', {
    subject: 'subject' in identity ? identity.subject : undefined,
    guest: 'guestKeyHash' in identity,
  })
  return true
}

/** A JWT's iat (seconds), read from a token the Network has already accepted. */
function tokenIat(jwt: string): number | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { iat?: unknown }
    return typeof claims.iat === 'number' ? claims.iat : null
  } catch {
    return null
  }
}
