/**
 * Mod grants in OpenVibe.Network (roadmap WS-M task 3, ADR-013; Contracts 0.72.0 mods.grant.manage). Every mod
 * install is the principal mod:<mod_id> in Network, registered by Games (its owner). The mods API asks Network
 * first and applies only what Network answered, so Network holds the grants and the registry keeps the hot path's
 * copy; a change staff make in Network arrives as network.mod.grants_changed (ModRegistry.applyNetwork).
 *
 * Network answering 4xx is the answer (a ModError with its code); Network unreachable is 503
 * mod.grants_unavailable, and nothing changes here.
 */
import { ModError } from './registry.js'

export interface ModPrincipal {
  mod_id: string
  owner: string
  status: 'active' | 'revoked'
  requested: string[]
  approved: string[]
  pending: string[]
  revoked: string[]
  revision: number
}

export interface ModGrantAuthority {
  register(manifest: unknown, approve: readonly string[], actor: string): Promise<ModPrincipal>
  change(
    modId: string,
    capability: string,
    action: 'approve' | 'revoke',
    actor: string,
  ): Promise<ModPrincipal>
  revoke(modId: string, actor: string, reason?: string): Promise<ModPrincipal>
  list(): Promise<ModPrincipal[]>
}

export function createNetworkModGrants(opts: {
  networkUrl: string
  tokens: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> }
  fetchImpl?: typeof fetch
}): ModGrantAuthority {
  const f = opts.fetchImpl ?? fetch
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      const token = await opts.tokens.getToken({
        audience: 'openvibe.network',
        scope: 'mods.grant.manage',
      })
      res = await f(`${opts.networkUrl}/internal/mods${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      throw new ModError(
        'mod.grants_unavailable',
        `OpenVibe.Network could not be asked: ${String((err as Error)?.message ?? err)}`,
        503,
      )
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const code =
        typeof data.error === 'string'
          ? data.error
          : typeof data.code === 'string'
            ? data.code
            : 'mod.grants_refused'
      const status =
        res.status >= 500 ? 503 : res.status === 401 || res.status === 403 ? 503 : res.status
      throw new ModError(
        code,
        `OpenVibe.Network: ${typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`}`,
        status,
      )
    }
    return data as T
  }
  return {
    register: (manifest, approve, actor) =>
      call<ModPrincipal>('POST', '', { manifest, approve: [...approve], actor }),
    change: (modId, capability, action, actor) =>
      call<ModPrincipal>('POST', `/${encodeURIComponent(modId)}/grants`, {
        capability,
        action,
        actor,
      }),
    revoke: (modId, actor, reason) =>
      call<ModPrincipal>('POST', `/${encodeURIComponent(modId)}/revoke`, {
        actor,
        ...(reason ? { reason } : {}),
      }),
    list: async () => (await call<{ mods: ModPrincipal[] }>('GET', '')).mods ?? [],
  }
}
