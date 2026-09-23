/**
 * Mod registry HTTP API (JSON; errors are RFC 9457 problem+json with the
 * legacy `error` field).
 *
 *   GET    /api/v1/mods                         public: installs, status, grants
 *   GET    /api/v1/mods/:id                     public: one install incl. manifest + pack
 *   GET    /api/v1/mods/:id/audit?limit=        staff: install/grant/use/deny/revoke log
 *   POST   /api/v1/mods                         staff: { manifest, pack, approve[], trustTier, enable }
 *   POST   /api/v1/mods/:id/enable|disable      staff
 *   POST   /api/v1/mods/:id/revoke              staff: { reason? } — terminal
 *   POST   /api/v1/mods/:id/grants              staff: { capability }
 *   DELETE /api/v1/mods/:id/grants/:capability  staff
 *
 * Staff = an openvibe.network owner/admin session, or a service principal
 * whose token (audience openvibe.games) carries `games.mod.manage`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Logger } from '@openvibe/shared'
import { ModError, type ModActor, type ModRegistry, type ModView } from './registry.js'

interface ContractsHttp {
  http: {
    sendProblem(
      res: ServerResponse,
      status: number,
      code: string,
      opts?: { detail?: string; extra?: Record<string, unknown> },
    ): unknown
  }
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as ContractsHttp

export const MODS_PREFIX = '/api/v1/mods'
const MAX_BODY_BYTES = 256 * 1024

export interface ModsApi {
  registry: ModRegistry
  /** Resolves the staff actor behind a request, or null. */
  authorize(req: IncomingMessage): Promise<ModActor | null>
  log: Logger
}

export function publicView(v: ModView): Record<string, unknown> {
  return {
    id: v.mod.id,
    name: v.mod.name,
    version: v.mod.version,
    target: v.mod.target,
    runtime: v.mod.runtime,
    trust_tier: v.mod.trustTier,
    status: v.mod.status,
    requested: [...v.manifest.permissions.capabilities].sort(),
    granted: [...v.granted].sort(),
    installed_at: new Date(v.mod.installedAt).toISOString(),
    updated_at: new Date(v.mod.updatedAt).toISOString(),
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function problem(
  res: ServerResponse,
  status: number,
  code: string,
  detail: string,
  errors?: string[],
) {
  contracts.http.sendProblem(res, status, code, {
    detail,
    ...(errors && errors.length > 0 ? { extra: { errors: errors.slice(0, 50) } } : {}),
  })
}

function readJson(
  req: IncomingMessage,
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; code: string }
> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (r: Parameters<typeof resolve>[0]) => {
      if (!done) {
        done = true
        resolve(r)
      }
    }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, code: 'request.too_large' })
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return finish({ ok: true, body: {} })
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, code: 'request.malformed_json' })
        } else finish({ ok: true, body: parsed as Record<string, unknown> })
      } catch {
        finish({ ok: false, status: 400, code: 'request.malformed_json' })
      }
    })
    req.on('error', () => finish({ ok: false, status: 400, code: 'request.aborted' }))
  })
}

/** Returns true when the request was a mods API request (handled or answered). */
export function handleModsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  api: ModsApi,
): boolean {
  const url = new URL(req.url ?? '/', 'http://games.invalid')
  const path = url.pathname
  if (path !== MODS_PREFIX && !path.startsWith(`${MODS_PREFIX}/`)) return false
  let parts: string[]
  try {
    parts = path.slice(MODS_PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    problem(res, 400, 'request.malformed_path', 'bad path encoding')
    return true
  }
  const method = req.method ?? 'GET'

  // Public reads.
  if (method === 'GET' && parts.length === 0) {
    json(res, 200, { mods: api.registry.list().map(publicView) })
    return true
  }
  if (method === 'GET' && parts.length === 1) {
    const view = api.registry.get(parts[0] ?? '')
    if (!view) problem(res, 404, 'mod.not_found', 'no such mod')
    else json(res, 200, { ...publicView(view), manifest: view.manifest, pack: view.pack })
    return true
  }

  void (async () => {
    const actor = await api.authorize(req)
    if (!actor) {
      req.resume()
      problem(res, 403, 'capability.denied', 'games.mod.manage required')
      return
    }
    const id = parts[0] ?? ''
    if (method === 'GET' && parts.length === 2 && parts[1] === 'audit') {
      const limit = Number(url.searchParams.get('limit') ?? 100)
      if (!api.registry.get(id)) return problem(res, 404, 'mod.not_found', 'no such mod')
      json(res, 200, { audit: api.registry.auditLog(id, Number.isFinite(limit) ? limit : 100) })
      return
    }
    if (method === 'DELETE' && parts.length === 3 && parts[1] === 'grants') {
      req.resume()
      json(res, 200, publicView(api.registry.revokeGrant(id, parts[2] ?? '', actor)))
      return
    }
    if (method !== 'POST') return problem(res, 405, 'request.method_not_allowed', method)
    const body = await readJson(req)
    if (!body.ok) return problem(res, body.status, body.code, 'request body must be a JSON object')
    const b = body.body
    if (parts.length === 0) {
      const view = api.registry.install(
        {
          manifest: b.manifest,
          pack: b.pack,
          approve: b.approve,
          trustTier: b.trustTier,
          enable: b.enable,
        },
        actor,
      )
      api.log.info('mod installed', { mod: view.mod.id, by: actor.audit, status: view.mod.status })
      json(res, 201, publicView(view))
      return
    }
    if (parts.length === 2 && (parts[1] === 'enable' || parts[1] === 'disable')) {
      const view =
        parts[1] === 'enable' ? api.registry.enable(id, actor) : api.registry.disable(id, actor)
      api.log.info(`mod ${parts[1]}d`, { mod: id, by: actor.audit })
      json(res, 200, publicView(view))
      return
    }
    if (parts.length === 2 && parts[1] === 'revoke') {
      const reason = typeof b.reason === 'string' ? b.reason.slice(0, 500) : undefined
      const view = api.registry.revoke(id, actor, reason)
      api.log.info('mod revoked', { mod: id, by: actor.audit })
      json(res, 200, publicView(view))
      return
    }
    if (parts.length === 2 && parts[1] === 'grants') {
      if (typeof b.capability !== 'string') {
        return problem(res, 400, 'mod.invalid_request', 'capability is required')
      }
      json(res, 200, publicView(api.registry.grant(id, b.capability, actor)))
      return
    }
    problem(res, 404, 'request.not_found', 'no such mods route')
  })().catch((err: unknown) => {
    if (res.headersSent) return
    if (err instanceof ModError) {
      problem(res, err.status, err.code, err.message, err.errors)
      return
    }
    api.log.warn('mods api failed', { error: String(err) })
    problem(res, 500, 'mod.internal', 'the mod registry failed')
  })
  return true
}
