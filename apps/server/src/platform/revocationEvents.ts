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
 *
 * The same endpoint takes network.subject.merged (roadmap WS-B task 5, ADR-029): two accounts became one, and
 * `onMerged` moves the folded-in account's characters to the survivor (store.identity.mergeSubject), once per
 * merge. network.account.export_requested and network.account.deleted (roadmap WS-B task 7, ADR-033) go to
 * `onAccountEvent` (./accountData.ts), answered once it resolved (500 when it failed, so Events retries).
 * network.mod.grants_changed (WS-M task 3, ADR-013) goes to `onModGrants`: the install's copy of its grants follows
 * its principal in Network. One subscription per topic (TOPICS).
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
) => {
  event?: {
    event_id?: string
    event_type?: string
    source?: string
    payload?: {
      subject?: { id?: string } | string
      valid_after?: string
      merge_id?: string
      from?: string
      into?: string
      export_id?: string
      deletion_id?: string
      aliases?: unknown
    }
  }
} | null

const { createRevocationStore } = req('openvibe-sdk/auth') as {
  createRevocationStore(db: unknown, opts?: { table?: string }): RevocationStore
}
const { parseDelivery } = req('openvibe-sdk/events') as { parseDelivery: ParseDelivery }

export const TOPIC = 'network.user.token_valid_after'
export const MERGE_TOPIC = 'network.subject.merged'
export const MOD_GRANTS_TOPIC = 'network.mod.grants_changed'
export const TOPICS = [
  TOPIC,
  MERGE_TOPIC,
  'network.account.export_requested',
  'network.account.deleted',
  MOD_GRANTS_TOPIC,
] as const
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/
const MERGE_RE = /^mrg_[0-9A-HJKMNP-TV-Z]{26}$/
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
  /** An account merge: move `from`'s characters to `into` (returns what moved; `already` when applied before). */
  onMerged?: (
    from: string,
    into: string,
    mergeId: string,
  ) => { moved: number; kept: number; already: boolean }
  /** Account export or deletion (ADR-033): resolves to the outcome; a rejection is answered 500 and redelivered. */
  onAccountEvent?: (
    event: NonNullable<NonNullable<ReturnType<ParseDelivery>>['event']>,
  ) => Promise<string>
  /** A mod principal changed in Network: make the install's grants match (returns the outcome). */
  onModGrants?: (payload: {
    mod_id: string
    owner: string
    status: string
    approved: string[]
    revision: number
  }) => string
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
    if (
      req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.headers['cf-connecting-ip']
    ) {
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
      if (
        event.event_type === 'network.account.export_requested' ||
        event.event_type === 'network.account.deleted'
      ) {
        if (!opts.onAccountEvent) {
          stats.ignored++
          send(res, 200, { event_id: event.event_id ?? null, outcome: 'ignored:no_handler' })
          return
        }
        opts.onAccountEvent(event).then(
          (outcome) => {
            if (outcome.startsWith('ignored')) stats.ignored++
            send(res, 200, { event_id: event.event_id ?? null, outcome })
          },
          (err: unknown) => {
            opts.log.warn('account event failed (Events retries)', {
              type: event.event_type,
              error: String((err as Error)?.message ?? err),
            })
            send(res, 500, { error: 'not applied' })
          },
        )
        return
      }
      if (event.event_type === MOD_GRANTS_TOPIC) {
        const p = (event.payload ?? {}) as {
          mod_id?: unknown
          owner?: unknown
          status?: unknown
          approved?: unknown
          revision?: unknown
        }
        let outcome: string
        if (event.source !== 'network') outcome = 'ignored:source'
        else if (!opts.onModGrants) outcome = 'ignored:no_handler'
        else if (
          typeof p.mod_id !== 'string' ||
          !Array.isArray(p.approved) ||
          typeof p.status !== 'string'
        )
          outcome = 'ignored:payload'
        else if (p.owner !== 'games') outcome = 'ignored:owner'
        else
          outcome = opts.onModGrants({
            mod_id: p.mod_id,
            owner: p.owner,
            status: p.status,
            approved: p.approved.map(String),
            revision: Number(p.revision) || 0,
          })
        if (outcome.startsWith('ignored')) stats.ignored++
        send(res, 200, { event_id: event.event_id ?? null, outcome })
        return
      }
      if (event.event_type === MERGE_TOPIC) {
        const p = event.payload ?? {}
        let outcome = 'merged'
        if (event.source !== 'network') outcome = 'ignored:source'
        else if (!opts.onMerged) outcome = 'ignored:no_handler'
        else if (
          !MERGE_RE.test(String(p.merge_id ?? '')) ||
          !SUBJECT_RE.test(String(p.from ?? '')) ||
          !SUBJECT_RE.test(String(p.into ?? '')) ||
          p.from === p.into
        )
          outcome = 'ignored:payload'
        else {
          const r = opts.onMerged(String(p.from), String(p.into), String(p.merge_id))
          outcome = r.already ? 'unchanged' : 'merged'
          if (!r.already)
            opts.log.info('account merged: characters moved', { moved: r.moved, kept: r.kept })
        }
        if (outcome.startsWith('ignored')) stats.ignored++
        send(res, 200, { event_id: event.event_id ?? null, outcome })
        return
      }
      const outcome = store.apply(event)
      let closed = 0
      if (outcome === 'revoked') {
        stats.revoked++
        const sub = event.payload?.subject
        const subject = (typeof sub === 'object' && sub ? sub.id : undefined) ?? ''
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
 * Create Games' subscriptions to TOPICS at Events where missing (idempotent: an existing one, even
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
  const token = await opts.tokens.getToken({
    audience: 'openvibe.events',
    scope: 'events.subscription.manage',
  })
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
  const list = await f(`${opts.eventsUrl}/api/v1/subscriptions`, { headers })
  if (!list.ok) throw new Error(`Events answered ${list.status} listing subscriptions`)
  const body = (await list.json()) as {
    subscriptions?: { id: string; topic_pattern: string; endpoint: string }[]
  }
  let created = 0
  for (const topic of TOPICS) {
    if (
      (body.subscriptions ?? []).some(
        (s) => s.topic_pattern === topic && s.endpoint === opts.endpoint,
      )
    )
      continue
    const r = await f(`${opts.eventsUrl}/api/v1/subscriptions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ topic_pattern: topic, endpoint: opts.endpoint, secret: opts.secret }),
    })
    if (r.status === 409) continue
    if (!r.ok) throw new Error(`Events answered ${r.status} creating the ${topic} subscription`)
    opts.log.info('events subscription created', { topic, endpoint: opts.endpoint })
    created++
  }
  return created ? 'created' : 'exists'
}
