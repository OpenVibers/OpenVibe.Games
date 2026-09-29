/**
 * Account keys (ADR-0006).
 *
 * A signed-in account is keyed by its canonical openvibe.network subject
 * (`usr_…`, or `gst_…` for a Network guest) taken from the token's
 * `subject_id` claim.
 *
 * Local guests keep their browser token (ADR-0004). A guest token may use
 * letters, digits, `_` and `-` only (the client mints alphanumerics), and
 * may not start with a subject prefix, so it can never equal a subject:
 * a guest presenting `usr_…` as its token cannot open someone else's
 * characters.
 */

/** The client mints `[A-Za-z0-9]{32}` (apps/client/src/net/connection.ts getIdentity). */
const GUEST_TOKEN = /^[A-Za-z0-9_-]{8,64}$/
/** Prefixes of canonical subject ids; a guest token may not look like one. */
const SUBJECT_PREFIX = /^(usr|gst|app|mod|svc)_/i

export function isGuestToken(token: unknown): token is string {
  return typeof token === 'string' && GUEST_TOKEN.test(token) && !SUBJECT_PREFIX.test(token)
}
