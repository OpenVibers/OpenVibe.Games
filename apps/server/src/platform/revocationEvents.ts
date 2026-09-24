/**
 * Sign-out everywhere reaches Games (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after).
 *
 * POST /internal/events is the endpoint of Games' Events subscription to that topic, signed with
 * GAMES_EVENTS_SECRET (signature v2 only) and loopback only (a request carrying a forwarding header
 * came through nginx and is refused). A delivery moves the person's cutoff in the SDK's revocation
 * store (only ever forward; anything not from Network is ignored), then `onRevoked` closes the game
 * sessions they opened with an older sign-in. New sign-ins already fail: Games checks every token with
 * the Network's /api/auth/me, which applies the same cutoff.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Logger } from '@openvibe/shared'

const req = createRequire(import.meta.url)

interface RevocationStore {
  apply(event: unknown): string
  isRevoked(claims: { iat?: number; subject_id?: string } | null | undefined): boolean
  cutoffFor(subject: string): number
}
type ParseDelivery = (
  raw: Buffer,
  headers: IncomingMessage['headers'],
  secret: string,
  opts: { requireV2: boolean },
) => { event?: { event_id?: string; event_type?: string; payload?: { subject?: { id?: string }; valid_after?: string } } } | null

const { createRevocationStore } = req('openvibe-sdk/auth') as {
  createRevocationStore(db: unknown, opts?: { table?: string }): RevocationStore
}
const { parseDelivery } = req('openvibe-sdk/events') as { parseDelivery: ParseDelivery }

export const TOPIC = 'network.user.token_valid_after'
const PATH = '/internal/events'
const MAX_BODY = 256 * 1024

export interface RevocationEvents {
  /** Answers POST /internal/events (returns true when the request was ours). */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  store: RevocationStore
  stats: { received: number; revoked: number; closed: number; refused: number; ignored: number }
}

export function createRevocationEvents(opts: {
  db: unknown
  secrets: string[]
  onRevoked: (subjectId: string, validAfterMs: number) => number
  log: Logger
}): RevocationEvents {
  const store = createRevocationStore(opts.db, { table: 'token_revocations' })
  const stats = { received: 0, revoked: 0, closed: 0, refused: 0, ignored: 0 }
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if ((req.url ?? '').split('?')[0] !== PATH) return false
    if (req.method !== 'POST') {
      send(res, 405, { error: 'POST only' })
      return true
    }
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
      send(res, 403, { error: 'internal route' })
      return true
    }
    if (opts.secrets.length === 0) {
      send(res, 503, { error: 'GAMES_EVENTS_SECRET is not set' })
      return true
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let delivery: ReturnType<ParseDelivery> = null
      for (const s of opts.secrets) {
        delivery = parseDelivery(raw, req.headers, s, { requireV2: true })
        if (delivery) break
      }
      if (!delivery || !delivery.event) {
        stats.refused++
        send(res, 401, { error: 'bad signature' })
        return
      }
      stats.received++
      const event = delivery.event
      const outcome = store.apply(event)
      let closed = 0
      if (outcome === 'revoked') {
        stats.revoked++
        const subject = event.payload?.subject?.id ?? ''
        closed = opts.onRevoked(subject, Date.parse(event.payload?.valid_after ?? ''))
        stats.closed += closed
        if (closed) opts.log.info('signed out everywhere: sessions closed', { closed })
      } else if (outcome.startsWith('ignored')) stats.ignored++
      send(res, 200, { event_id: event.event_id ?? null, outcome, closed })
    })
    return true
  }

  return { handle, store, stats }
}

/**
 * Create Games' subscription to TOPIC at Events if it is missing (idempotent: an existing one, even
 * disabled by an operator, is left as it is). Needs the grant games events.subscription.manage.
 */
export async function ensureRevocationSubscription(opts: {
  eventsUrl: string
  endpoint: string
  secret: string
  tokens: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> }
  fetchImpl?: typeof fetch
  log: Logger
}): Promise<'exists' | 'created'> {
  const f = opts.fetchImpl ?? fetch
  const token = await opts.tokens.getToken({ audience: 'openvibe.events', scope: 'events.subscription.manage' })
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
  const list = await f(`${opts.eventsUrl}/api/v1/subscriptions`, { headers })
  if (!list.ok) throw new Error(`Events answered ${list.status} listing subscriptions`)
  const body = (await list.json()) as { subscriptions?: { id: string; topic_pattern: string; endpoint: string }[] }
  const found = (body.subscriptions ?? []).find((s) => s.topic_pattern === TOPIC && s.endpoint === opts.endpoint)
  if (found) return 'exists'
  const r = await f(`${opts.eventsUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ topic_pattern: TOPIC, endpoint: opts.endpoint, secret: opts.secret }),
  })
  if (r.status === 409) return 'exists'
  if (!r.ok) throw new Error(`Events answered ${r.status} creating the ${TOPIC} subscription`)
  opts.log.info('events subscription created', { topic: TOPIC, endpoint: opts.endpoint })
  return 'created'
}
