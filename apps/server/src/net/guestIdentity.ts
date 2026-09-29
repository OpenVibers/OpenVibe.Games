/**
 * Guest identity helpers (ADR-0007 netcode + "Deleted"): a raw guest token
 * is never stored on the server, only the SHA-256 of one. This module is
 * the single place that hashing lives so the value stored in a WS ticket
 * matches the value stored in a guest character's persistence row.
 */
import { createHash } from 'node:crypto'

/** SHA-256 hex of a raw guest token. */
export function hashGuestKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
