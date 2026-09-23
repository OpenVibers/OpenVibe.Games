/**
 * openvibe.network SSO adapter. Access tokens are JWTs issued by the openvibe.network
 * OAuth server; we validate by calling its /api/auth/me endpoint (which
 * verifies signature + ban state) rather than trusting the JWT locally.
 * The response nests the account under `user`; rank maps the network RBAC:
 * the configured owner account, then role admin / moderator (global_mod).
 */
export type OpenVibeRank = 'owner' | 'admin' | 'moderator' | null

export interface NetworkUser {
  /** The Network's own account id (legacy; integer today). */
  id: string
  name: string
  rank: OpenVibeRank
  /**
   * Canonical subject (`usr_…`, or `gst_…` for a Network guest) from the
   * token's `subject_id` claim; null only for tokens older than subjects.
   */
  subjectId: string | null
}

/** A canonical openvibe.network subject id a Games account may be keyed by. */
const SUBJECT_ID = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/

export function isCanonicalSubject(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_ID.test(value)
}

/**
 * Reads the `subject_id` claim of a JWT the Network has ALREADY accepted
 * (via /api/auth/me). Never used to trust a token on its own.
 */
function subjectClaim(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      subject_id?: unknown
    }
    return isCanonicalSubject(claims.subject_id) ? claims.subject_id : null
  } catch {
    return null
  }
}

const OWNER_USERNAME = (process.env.OWNER_USERNAME ?? 'goosely').toLowerCase()

/** The account record as openvibe.network's /api/auth/me returns it. */
export interface NetworkAccount {
  id?: string | number
  username?: string
  role?: string
  is_banned?: number
  /** Canonical subject (Wave 1); mirrors the token's `subject_id` claim. */
  subject_id?: string
  [key: string]: unknown
}

/**
 * Fetches the raw account behind a bearer token from openvibe.network, or
 * null when the token is missing, rejected or the Network is unreachable.
 * The same-origin /auth/me endpoint hands this object to the shared navbar.
 */
export async function fetchNetworkAccount(
  url: string | null,
  auth: string | undefined,
): Promise<NetworkAccount | null> {
  if (!url || !auth) return null
  try {
    const resp = await fetch(url, { headers: { authorization: `Bearer ${auth}` } })
    if (!resp.ok) return null
    const body = (await resp.json()) as { user?: NetworkAccount } & NetworkAccount
    const u = body.user ?? body
    const id = u.id ?? u.username
    if (id === undefined || id === null || String(id).length === 0) return null
    return u
  } catch {
    return null
  }
}

export async function resolveNetworkUser(
  url: string | null,
  auth: string | undefined,
): Promise<NetworkUser | null> {
  const u = await fetchNetworkAccount(url, auth)
  if (!u) return null
  const id = u.id ?? u.username
  const username = String(u.username ?? id)
  let rank: OpenVibeRank = null
  if (username.toLowerCase() === OWNER_USERNAME) rank = 'owner'
  else if (u.role === 'admin') rank = 'admin'
  else if (u.role === 'moderator' || u.role === 'global_mod') rank = 'moderator'
  const subjectId = isCanonicalSubject(u.subject_id)
    ? u.subject_id
    : auth
      ? subjectClaim(auth)
      : null
  return { id: String(id), name: username, rank, subjectId }
}

export function canEditMap(rank: OpenVibeRank): boolean {
  return rank === 'owner' || rank === 'admin'
}
