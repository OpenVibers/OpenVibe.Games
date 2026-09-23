import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * GET /api/ready: whether this process can serve the game, in the shape the
 * other OpenVibe services answer (openvibe-shared/ready): `status`
 * ready/degraded/not_ready, a `checks` object with one entry per named check,
 * and the names of the `failed` (required) and `degraded` (optional) ones.
 * 200 when every required check passes, 503 otherwise; each failed check
 * carries its reason in `error`.
 *
 * Required: `db` (world.db answers a trivial query) and `tick` (the fixed-tick
 * simulation has advanced recently). /healthz stays liveness only.
 */

/**
 * No completed tick for this long means the simulation is stalled. The loop
 * runs at `tickRate` (30/s, one tick every ~33 ms) and resyncs itself after
 * falling more than a second behind, so a healthy server never goes a second
 * without a tick; 5 s leaves room for a GC pause, a persistence flush or a
 * live map rebuild, and still flags a frozen world within one deploy poll.
 */
export const TICK_STALL_MS = 5_000

export interface ReadinessCheck {
  status: 'ok' | 'fail'
  required: boolean
  latency_ms: number
  checked_at: string
  error?: string
  detail?: Record<string, unknown>
}

export interface ReadinessBody {
  ready: boolean
  status: 'ready' | 'degraded' | 'not_ready'
  service: 'games'
  checked_at: string
  failed: string[]
  degraded: string[]
  checks: Record<string, ReadinessCheck>
}

export interface ReadinessDeps {
  /** Runs a trivial query against world.db; throws or returns false when it fails. */
  pingDb: () => boolean
  /** The tick counter and when the last tick completed (epoch ms, 0 = never). */
  metrics: { readonly tick: number; readonly lastTickAt: number }
  tickStallMs?: number
  now?: () => number
}

type Outcome = { ok: boolean; error?: string; detail?: Record<string, unknown> }

/** One line, short: a reason safe to show to whoever can reach the endpoint. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return (text.split('\n')[0] ?? '').slice(0, 200) || 'failed'
}

function run(fn: () => Outcome, required: boolean, now: () => number): ReadinessCheck {
  const t0 = performance.now()
  let out: Outcome
  try {
    out = fn()
  } catch (err) {
    out = { ok: false, error: reason(err) }
  }
  return {
    status: out.ok ? 'ok' : 'fail',
    required,
    ...(out.error !== undefined ? { error: out.error } : {}),
    ...(out.detail !== undefined ? { detail: out.detail } : {}),
    latency_ms: Math.round((performance.now() - t0) * 10) / 10,
    checked_at: new Date(now()).toISOString(),
  }
}

export function createReadiness(deps: ReadinessDeps): {
  check: () => ReadinessBody
  handle: (req: IncomingMessage, res: ServerResponse) => boolean
} {
  const now = deps.now ?? Date.now
  const stallMs = deps.tickStallMs ?? TICK_STALL_MS

  function check(): ReadinessBody {
    const checks: Record<string, ReadinessCheck> = {
      db: run(
        () =>
          deps.pingDb() ? { ok: true } : { ok: false, error: 'world.db query returned nothing' },
        true,
        now,
      ),
      tick: run(
        () => {
          const { tick, lastTickAt } = deps.metrics
          const at = now()
          const ageMs = lastTickAt > 0 ? at - lastTickAt : null
          const detail = { tick, age_ms: ageMs, threshold_ms: stallMs }
          if (ageMs === null) return { ok: false, error: 'simulation has not ticked yet', detail }
          if (ageMs > stallMs) {
            return { ok: false, error: `no simulation tick for ${Math.round(ageMs)} ms`, detail }
          }
          return { ok: true, detail }
        },
        true,
        now,
      ),
    }
    const names = Object.keys(checks)
    const failed = names.filter((n) => checks[n]?.required && checks[n]?.status !== 'ok')
    const degraded = names.filter((n) => !checks[n]?.required && checks[n]?.status !== 'ok')
    const ready = failed.length === 0
    return {
      ready,
      status: !ready ? 'not_ready' : degraded.length ? 'degraded' : 'ready',
      service: 'games',
      checked_at: new Date(now()).toISOString(),
      failed,
      degraded,
      checks,
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if ((req.url ?? '/').split('?')[0] !== '/api/ready') return false
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' })
      res.end('{"error":"method_not_allowed"}')
      return true
    }
    const body = check()
    res.writeHead(body.ready ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body))
    return true
  }

  return { check, handle }
}
