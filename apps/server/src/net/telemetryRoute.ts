import type { IncomingMessage, ServerResponse } from 'node:http'
import { telemetry } from 'openvibe-sdk/service'

/**
 * Request telemetry (openvibe-sdk/service, plan T1): the HTTP server has no route table, so a request's label is a
 * bounded template built from its path, never the raw URL. The API's first three segments name the resource
 * (api, v1, games), /auth's first two, any other path's first one; every later segment (a game, a map, a player, a
 * room) is `:param`, and so is any kept segment that is not a plain slug. A 404 is labelled `unmatched` when it
 * finishes, so a scanner's paths never become labels. Static files, /shared, health, readiness, metrics and the
 * release manifest carry no product signal and are not counted (null).
 */
const STATIC = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|glb|gltf|ktx2|wasm|json|txt|xml|webmanifest|woff2?|ttf|mp3|ogg|wav)$/i
const SKIP = new Set(['/api/health', '/api/ready', '/metrics', '/release.json'])
const SLUG = /^[a-z0-9_-]{1,40}$/i

export function telemetryRoute(path: string): string | null {
  if (SKIP.has(path) || path.startsWith('/shared/') || path.startsWith('/assets/') || STATIC.test(path)) return null
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const keep = parts[0] === 'api' ? 3 : parts[0] === 'auth' ? 2 : 1
  return `/${parts.map((p, i) => (i < keep && SLUG.test(p) ? p : ':param')).join('/')}`
}

/** Count one request through the process-wide collector (a no-op until main.ts calls telemetry.init()). */
export function observeRequest(req: IncomingMessage, res: ServerResponse, path: string): void {
  const route = telemetryRoute(path)
  if (!route) return
  try {
    telemetry.requestStarted()
    const t0 = process.hrtime.bigint()
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      const httpStatus = res.writableFinished ? res.statusCode : 0
      telemetry.requestFinished({
        route: httpStatus === 404 ? 'unmatched' : route,
        method: req.method ?? 'GET',
        httpStatus,
        latencyMs: Number(process.hrtime.bigint() - t0) / 1e6,
      })
    }
    res.once('finish', finish)
    res.once('close', finish)
  } catch {
    /* telemetry never breaks a request */
  }
}
