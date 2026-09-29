/**
 * Who may manage mods: an openvibe.network owner/admin session (the same
 * rank that may edit the map), or a platform principal whose client-
 * credentials token for audience `openvibe.games` carries the
 * `games.mod.manage` capability (verified offline against the Network JWKS).
 *
 * The editor (HTTP map save, asset upload, WS presence) authorizes through
 * the same Network staff check; there is no longer a shared-secret
 * legacy shared-secret fallback (ADR-0007 "Deleted").
 */
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { verifyUserToken, type UserTokenClaims } from 'openvibe-sdk/auth'
import type { ModActor } from '../mods/registry.js'
import { canEditMap, resolveNetworkUser } from '../net/networkAuth.js'

export const CAP_MOD_MANAGE = 'games.mod.manage'
export const GAMES_AUDIENCE = 'openvibe.games'

interface ContractsCaps {
  capabilities: { grants(granted: unknown, capability: string): boolean }
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as ContractsCaps

export interface StaffAuthOptions {
  /** openvibe.network /api/auth/me, or null in local development. */
  networkAuthUrl: string | null
  /** Network base for the JWKS (`/api/.well-known/jwks`). */
  networkUrl: string
  /** Test seam: verifies a principal token. */
  verifyPrincipal?: (token: string) => Promise<UserTokenClaims>
}

/** Reads a JWT payload without trusting it — only to pick the verification path. */
function looksLikePrincipal(token: string): boolean {
  const part = token.split('.')[1]
  if (!part) return false
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      sub?: unknown
      actor_type?: unknown
    }
    return (
      ['service', 'app', 'mod'].includes(String(claims.actor_type)) ||
      /^(svc|app|mod):/.test(String(claims.sub ?? ''))
    )
  } catch {
    return false
  }
}

export function createStaffAuthorizer(
  opts: StaffAuthOptions,
): (req: IncomingMessage) => Promise<ModActor | null> {
  const verifyPrincipal =
    opts.verifyPrincipal ??
    ((token: string) =>
      verifyUserToken(token, {
        jwks: `${opts.networkUrl}/api/.well-known/jwks`,
        audience: GAMES_AUDIENCE,
        allowServiceTokens: true,
      }))

  return async (req) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
    if (!bearer) return null

    if (looksLikePrincipal(bearer)) {
      try {
        const claims = await verifyPrincipal(bearer)
        if (!contracts.capabilities.grants(claims.cap, CAP_MOD_MANAGE)) return null
        const sub = String(claims.sub)
        const slug = /^svc:([a-z][a-z0-9-]{1,39})$/.exec(sub)?.[1]
        return {
          audit: sub,
          subject: slug ? { type: 'service', id: slug } : { type: 'service', id: 'games' },
        }
      } catch {
        return null
      }
    }

    if (opts.networkAuthUrl) {
      const user = await resolveNetworkUser(opts.networkAuthUrl, bearer)
      if (!user || !canEditMap(user.rank)) return null
      if (user.subjectId?.startsWith('usr_')) {
        return { audit: user.subjectId, subject: { type: 'user', id: user.subjectId } }
      }
      // A staff session with no canonical user subject (a Network guest, or a
      // token older than subjects) acts as the games service.
      return {
        audit: user.subjectId ?? `network-user:${user.id}`,
        subject: { type: 'service', id: 'games' },
      }
    }
    // Without Network configured (local development) no Authorization
    // header gets a result. the legacy editor key is gone — there is no shared-secret
    // fallback for the mods API either.
    return null
  }
}
