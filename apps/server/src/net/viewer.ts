/**
 * Who is asking (the viewer), read the way every OpenVibe site reads a person: a signed-in player
 * presents the Network token the browser keeps in `ovg_sso`, a guest presents the guest token the
 * browser keeps in `openvibe.token` (or sends in the X-Guest-Token header). What comes back is the
 * account key the rows in the database are stored under, never a raw token.
 *
 * The same helper serves the API reads and the pages, so a page and its API agree on who the viewer is.
 */
import type { IncomingMessage } from 'node:http'
import { isGuestToken } from '../platform/accounts.js'
import { hashGuestKey } from './guestIdentity.js'
import { resolveNetworkUser } from './networkAuth.js'
import { parseCookies } from './sso.js'

/** The cookie the browser keeps its guest token in (client/net/identity.ts). */
export const GUEST_TOKEN_COOKIE = 'openvibe.token'
/** The cookie the sign-in leaves the Network token in (client/net/identity.ts). */
export const SESSION_COOKIE_NAME = 'ovg_sso'

export interface ViewerOptions {
  /** The Network's auth address, when the site is signed in to it. */
  networkAuthUrl: string | null
}

/** The account key of the guest who owns a raw guest token. */
export function guestAccountKey(rawToken: string): string | null {
  if (!isGuestToken(rawToken)) return null
  return `guest:${hashGuestKey(rawToken)}`
}

/**
 * The viewer's account key, or null when the request names nobody. Signed in first (the Network token
 * wins), then the guest token from the header, then the guest token from the cookie.
 */
export async function viewerAccountKey(
  req: IncomingMessage,
  opts: ViewerOptions,
): Promise<string | null> {
  const cookies = parseCookies(req.headers.cookie)
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  const session = bearer ?? cookies[SESSION_COOKIE_NAME]
  if (session && opts.networkAuthUrl) {
    const user = await resolveNetworkUser(opts.networkAuthUrl, session).catch(() => null)
    if (user?.subjectId) return user.subjectId
  }
  const guestHeader = req.headers['x-guest-token']
  const guest = typeof guestHeader === 'string' ? guestHeader : cookies[GUEST_TOKEN_COOKIE]
  return guest ? guestAccountKey(guest) : null
}
