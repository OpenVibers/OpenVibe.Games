/**
 * Who may manage mods: an openvibe.network owner/admin session (the same
 * rank that may edit the map), or a platform principal whose client-
 * credentials token for audience `openvibe.games` carries the
 * `games.mod.manage` capability (verified offline against the Network JWKS).
 * Without a Network configured (local development) the EDITOR_KEY is
 * accepted, exactly as for the map editor.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { verifyUserToken, type UserTokenClaims } from 'openvibe-sdk/auth'
import type { ModActor } from '../mods/registry.js'
import { canEditMap, resolveNetworkUser } from '../net/networkAuth.js'
import { legacyNetworkKey } from './accounts.js'

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
  editorKey: string | null
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

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
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
    const editorKey = req.headers['x-editor-key']
    const token = bearer ?? (typeof editorKey === 'string' ? editorKey : undefined)
    if (!token) return null

    if (bearer && looksLikePrincipal(bearer)) {
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
      const user = await resolveNetworkUser(opts.networkAuthUrl, token)
      if (!user || !canEditMap(user.rank)) return null
      if (user.subjectId?.startsWith('usr_')) {
        return { audit: user.subjectId, subject: { type: 'user', id: user.subjectId } }
      }
      return { audit: legacyNetworkKey(user.id), subject: { type: 'service', id: 'games' } }
    }
    if (opts.editorKey && sameSecret(token, opts.editorKey)) {
      return { audit: 'editor-key', subject: { type: 'service', id: 'games' } }
    }
    return null
  }
}
