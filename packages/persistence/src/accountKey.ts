import { createHash } from 'node:crypto'

/**
 * The canonical account key stored in `characters.account_key` (ADR-0006).
 *
 * Signed-in accounts use their canonical openvibe.network subject (`usr_…`, or `gst_…` for a Network
 * guest), which is already a key. Local guests (ADR-0004) use `guest:` + sha256hex(their browser
 * token) — the raw token is never stored. The function is idempotent: a value that is already an
 * account key passes through unchanged, so a DTO read back from the database can be written again
 * without re-hashing.
 */
const SUBJECT = /^(usr|gst)_/
const GUEST_KEY = /^guest:/

export function accountKey(token: string): string {
  if (SUBJECT.test(token) || GUEST_KEY.test(token)) return token
  return `guest:${createHash('sha256').update(token).digest('hex')}`
}
