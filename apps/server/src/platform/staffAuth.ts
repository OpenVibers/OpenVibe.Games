/**
 * Who may manage mods: an openvibe.network owner/admin session (the same
 * rank that may edit the map), or a platform principal whose client-
 * credentials token for audience `openvibe.games` carries the
 * `games.mod.manage` capability (verified offline against the Network JWKS).
 *
 * The principal branch takes ONLY the key from the Network: openvibe-sdk/auth's
 * process-wide JWKS client (jwksClient) serves fresh keys, the last good keys
 * through a Network outage, and a rotation honoured on an unknown kid. Every
 * claim rule is openvibe-contracts' serviceAuth.verifyServiceToken — the claim
 * schema (identity.service-token-claims@1), the issuer, the audience and the
 * `env: sandbox` refusal — so no rule is skipped for a service or app token.
 * Nothing the SDK reports (its errors name the internal JWKS URL) is ever
 * answered to a caller: a failure is a null, with the reason logged.
 *
 * The editor (HTTP map save, asset upload, WS presence) authorizes through
 * the same Network staff check; there is no longer a shared-secret
 * legacy shared-secret fallback (ADR-0007 "Deleted").
 */
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import type { KeyObject } from 'node:crypto'
import { jwksClient, verifyUserToken, type UserTokenClaims } from 'openvibe-sdk/auth'
import type { Logger } from '@openvibe/shared'
import type { ModActor } from '../mods/registry.js'
import { canEditMap, resolveNetworkUser } from '../net/networkAuth.js'

export const CAP_MOD_MANAGE = 'games.mod.manage'
export const GAMES_AUDIENCE = 'openvibe.games'
/** The `iss` claim of a Network service token (the public Network, not its host-internal mirror). */
export const NETWORK_ISSUER = 'https://openvibe.network'

type ServiceClaims = Record<string, unknown>

interface ContractsAuth {
  serviceAuth: {
    verifyServiceToken(
      token: string,
      opts: { publicKey: KeyObject | string; issuer?: string; audience?: string },
    ): { ok: true; claims: ServiceClaims } | { ok: false; code: string; reason: string }
  }
  capabilities: { grants(granted: unknown, capability: string): boolean }
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as ContractsAuth

export interface StaffAuthOptions {
  /** openvibe.network /api/auth/me, or null in local development. */
  networkAuthUrl: string | null
  /** Network base for the JWKS (`/api/.well-known/jwks`). */
  networkUrl: string
  /** `iss` every Network token carries; the public Network URL unless overridden. */
  issuer?: string
  /** Receives the JWKS client's state changes and refusals; nothing is answered to callers. */
  log?: Logger
  /** Test seam: verifies a principal token. */
  verifyPrincipal?: (token: string) => Promise<UserTokenClaims | ServiceClaims>
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

/** The `kid` a token's header names (null when absent or undecodable). */
function headerKid(token: string): string | null {
  try {
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { kid?: unknown }
    return typeof header.kid === 'string' ? header.kid : null
  } catch {
    return null
  }
}

export function createStaffAuthorizer(
  opts: StaffAuthOptions,
): (req: IncomingMessage) => Promise<ModActor | null> {
  const issuer = opts.issuer ?? NETWORK_ISSUER
  const log = opts.log

  /**
   * A Network service/app token: the key from the SDK's JWKS client, every rule from
   * openvibe-contracts' verifyServiceToken. Tries the key the `kid` names, else every key, and
   * stops at the first result that is not merely a bad signature (a rule failure is final).
   */
  const verifyWithKeys = async (token: string): Promise<ServiceClaims> => {
    const check = (publicKey: KeyObject) =>
      contracts.serviceAuth.verifyServiceToken(token, {
        publicKey,
        issuer,
        audience: GAMES_AUDIENCE,
      })
    const kid = headerKid(token)
    let keys: { kid: string | null; key: KeyObject }[]
    try {
      keys = await jwksClient(
        `${opts.networkUrl}/api/.well-known/jwks`,
        log ? { log } : {},
      ).keysForKid(kid)
    } catch (err) {
      // token.no_key (no keys loaded yet) and every other client failure: nothing to verify with.
      // The SDK's message names the internal JWKS URL and the fetch error — logged, never answered.
      log?.warn('principal token refused: signing key unavailable', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw new Error('token.unavailable')
    }
    const byKid = kid ? keys.filter((k) => k.kid === kid) : []
    let last = { ok: false as const, code: 'token.unavailable', reason: 'no signing key' }
    for (const k of byKid.length > 0 ? byKid : keys) {
      const r = check(k.key)
      if (r.ok) return r.claims
      if (r.code !== 'token.bad_signature') {
        log?.warn('principal token refused', { code: r.code, reason: r.reason })
        throw new Error(r.code)
      }
      last = r
    }
    log?.warn('principal token refused', { code: last.code, reason: last.reason })
    throw new Error(last.code)
  }

  // Default verification for the principal branch. A token whose claims pass
  // identity.service-token-claims@1 is a principal and verified here; anything else is a Network
  // sign-in session, which only the SDK's own user verification accepts.
  const verifyPrincipal =
    opts.verifyPrincipal ??
    (async (token: string): Promise<UserTokenClaims | ServiceClaims> => {
      if (looksLikePrincipal(token)) return await verifyWithKeys(token)
      return await verifyUserToken(token, {
        jwks: `${opts.networkUrl}/api/.well-known/jwks`,
        audience: GAMES_AUDIENCE,
      })
    })

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
