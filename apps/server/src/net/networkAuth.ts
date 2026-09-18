/**
 * openvibe.network SSO adapter. Access tokens are JWTs issued by the openvibe.network
 * OAuth server; we validate by calling its /api/auth/me endpoint (which
 * verifies signature + ban state) rather than trusting the JWT locally.
 * The response nests the account under `user`; rank maps the network RBAC:
 * the configured owner account, then role admin / moderator (global_mod).
 */
export type OpenVibeRank = 'owner' | 'admin' | 'moderator' | null

export interface NetworkUser {
  id: string
  name: string
  rank: OpenVibeRank
}

const OWNER_USERNAME = (process.env.OWNER_USERNAME ?? 'goosely').toLowerCase()

/** The account record as openvibe.network's /api/auth/me returns it. */
export interface NetworkAccount {
  id?: string | number
  username?: string
  role?: string
  is_banned?: number
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
  return { id: String(id), name: username, rank }
}

export function canEditMap(rank: OpenVibeRank): boolean {
  return rank === 'owner' || rank === 'admin'
}
