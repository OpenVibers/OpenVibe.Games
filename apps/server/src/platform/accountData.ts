/**
 * Account export and deletion → Games (roadmap WS-B task 7, ADR-033; Contracts 0.71.0). Both arrive at POST
 * /internal/events (./revocationEvents.ts) and are applied once per export or deletion (account_data_events, kept by
 * this adapter beside the outbox); the delivery is answered after Network took the part or the confirmation, so a
 * failure is redelivered without erasing twice.
 *
 *   network.account.export_requested  Games' part (POST /internal/account-exports/:id/parts, service token):
 *                                     characters.json (without the sign-in token) and structures.json.
 *   network.account.deleted           the person's game sessions are closed first (each close saves its character),
 *                                     then store.identity.eraseSubjects removes their characters and adoption rows;
 *                                     their structures stay in the world without an owner. Games then confirms
 *                                     with counts.
 */
import type Database from 'better-sqlite3'
import type { Logger } from '@openvibe/shared'
import type { IdentityRepository } from '@openvibe/persistence'

export const ACCOUNT_TOPICS = [
  'network.account.export_requested',
  'network.account.deleted',
] as const
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/
const EXPORT_RE = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/
const DELETION_RE = /^del_[0-9A-HJKMNP-TV-Z]{26}$/

export interface AccountEvent {
  event_id?: string
  event_type?: string
  source?: string
  payload?: { export_id?: string; deletion_id?: string; subject?: unknown; aliases?: unknown }
}
export type Send = (path: string, body: unknown) => Promise<{ ok: boolean; status: number }>

interface Record_ {
  id: string
  outcome: string | null
  sent_at: string | null
  applied_at: string
}

export function createAccountData(opts: {
  db: Database.Database
  identity: IdentityRepository
  send: Send
  /** Close the subjects' game sessions and resolve once their characters were saved (so the erasure comes after). */
  closeSessions: (subjects: string[]) => Promise<void>
  log: Logger
}): { apply(event: AccountEvent): Promise<string> } {
  opts.db.exec(`CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome TEXT,
    sent_at TEXT,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
  const get = opts.db.prepare<[string], Record_>(
    'SELECT id, outcome, sent_at, applied_at FROM account_data_events WHERE id = ?',
  )
  const markSent = opts.db.prepare('UPDATE account_data_events SET sent_at = ? WHERE id = ?')

  async function apply(event: AccountEvent): Promise<string> {
    if (!event || !ACCOUNT_TOPICS.includes(event.event_type as (typeof ACCOUNT_TOPICS)[number]))
      return 'ignored:type'
    if (event.source !== 'network') return 'ignored:source'
    const p = event.payload ?? {}
    const subject = String(p.subject ?? '')
    if (!SUBJECT_RE.test(subject)) return 'ignored:payload'
    if (event.event_type === 'network.account.export_requested') {
      const id = String(p.export_id ?? '')
      if (!EXPORT_RE.test(id)) return 'ignored:payload'
      if (get.get(id)?.sent_at) return 'unchanged'
      const data = opts.identity.exportSubject(subject)
      const files = [
        { name: 'characters.json', content: data.characters },
        ...(data.structures.length ? [{ name: 'structures.json', content: data.structures }] : []),
      ]
      const res = await opts.send(`/internal/account-exports/${id}/parts`, { subject, files })
      const outcome = res.ok
        ? 'exported'
        : res.status === 409 || res.status === 404
          ? 'closed'
          : null
      if (!outcome) throw new Error(`export part refused: ${res.status}`)
      opts.db
        .prepare(
          'INSERT OR REPLACE INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          id,
          'export',
          subject,
          JSON.stringify({ result: outcome, characters: data.characters.length }),
          new Date().toISOString(),
        )
      return outcome
    }
    const id = String(p.deletion_id ?? '')
    if (!DELETION_RE.test(id)) return 'ignored:payload'
    let rec = get.get(id)
    let result = 'confirmed'
    if (!rec) {
      const aliases = Array.isArray(p.aliases)
        ? p.aliases.map(String).filter((s) => SUBJECT_RE.test(s))
        : []
      const subjects = [subject, ...aliases]
      await opts.closeSessions(subjects)
      const erased = opts.identity.eraseSubjects(subjects)
      opts.db
        .prepare('INSERT INTO account_data_events (id, kind, subject, outcome) VALUES (?, ?, ?, ?)')
        .run(id, 'deletion', subject, JSON.stringify({ erased }))
      opts.log.info('account deleted: game data erased', { ...erased })
      rec = get.get(id) as Record_
      result = 'erased'
    }
    if (rec.sent_at) return 'unchanged'
    const o = JSON.parse(rec.outcome ?? '{}') as { erased?: Record<string, number> }
    const erased = Object.fromEntries(
      Object.entries(o.erased ?? {}).filter(([k]) => k !== 'structures_unowned'),
    )
    const retained = { structures_unowned: o.erased?.structures_unowned ?? 0 }
    const res = await opts.send(`/internal/account-deletions/${id}/confirmations`, {
      subject,
      completed_at: rec.applied_at,
      erased,
      retained,
    })
    if (!res.ok && res.status !== 404) throw new Error(`confirmation refused: ${res.status}`)
    markSent.run(new Date().toISOString(), id)
    return result
  }

  return { apply }
}

/** Network calls with the games principal's token (audience openvibe.network). */
export function networkSender(opts: {
  networkUrl: string
  tokens: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> }
  fetchImpl?: typeof fetch
}): Send {
  const f = opts.fetchImpl ?? fetch
  return async (path, body) => {
    const token = await opts.tokens.getToken({ audience: 'openvibe.network' })
    const r = await f(`${opts.networkUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    return { ok: r.ok, status: r.status }
  }
}
