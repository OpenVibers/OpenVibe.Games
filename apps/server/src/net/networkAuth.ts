/**
 * openvibe.network SSO adapter. Access tokens are JWTs issued by the openvibe.network
 * OAuth server; we validate by calling its /api/auth/me endpoint (which
 * verifies signature + ban state) rather than trusting the JWT locally.
 * The response nests the account under `user`. Rank comes from the contracts staff map
 * (ADR-022) applied to the claims of the token the Network just accepted: 'owner' for the
 * owner, 'admin' for staff.games.manage (map editor, mod administration), 'moderator' for
 * staff.moderation.chat; never from a role name or a username.
 */
import { createRequire } from 'node:module'

interface StaffMap {
  can(claims: Record<string, unknown>, capability: string): boolean
  effectiveRole(claims: Record<string, unknown>): string
}
const staffMap = (createRequire(import.meta.url)('openvibe-contracts') as { staff: StaffMap }).staff

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
 * The claims of a JWT the Network has ALREADY accepted (via /api/auth/me).
 * Never used to trust a token on its own.
 */
function acceptedClaims(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The rank the staff map gives these (accepted) claims. */
export function rankOf(claims: Record<string, unknown>): OpenVibeRank {
  if (staffMap.effectiveRole(claims) === 'owner') return 'owner'
  if (staffMap.can(claims, 'staff.games.manage')) return 'admin'
  if (staffMap.can(claims, 'staff.moderation.chat')) return 'moderator'
  return null
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
  // Staff claims come from the token; the account's role is fresher, and when the two differ
  // (a role change since the token was minted) the account's role alone decides.
  const claims = auth ? acceptedClaims(auth) : {}
  const role = typeof u.role === 'string' ? u.role : claims.role
  const rank = rankOf(role === claims.role ? claims : { role, is_owner: claims.is_owner })
  const subjectId = isCanonicalSubject(u.subject_id)
    ? u.subject_id
    : auth
      ? subjectClaim(auth)
      : null
  return { id: String(id), name: username, rank, subjectId }
}

/** The map editor and mod administration: staff.games.manage (rank owner or admin). */
export function canEditMap(rank: OpenVibeRank): boolean {
  return rank === 'owner' || rank === 'admin'
}
