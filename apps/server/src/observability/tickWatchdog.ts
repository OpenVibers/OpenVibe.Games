import type { Logger } from '@openvibe/shared'
import { TICK_STALL_MS } from './readiness.js'

/**
 * How long the simulation may stay stalled before the process exits so systemd restarts it.
 * /api/ready already fails its required `tick` check after TICK_STALL_MS (5 s); that can be a single
 * long GC pause or a map rebuild. Thirty more seconds is long enough for such a pass to finish, and
 * for a room whose lease is in doubt (LEASE_RECOVERY_GRACE_MS, 60 s) to be handled by the places that
 * still tick, but short enough that a dead tick loop never stays up for hours with /api/ready failing.
 */
export const TICK_WATCHDOG_GRACE_MS = 30_000

/** How often the watchdog looks at the tick timestamp. */
export const TICK_WATCHDOG_INTERVAL_MS = 5_000

export interface TickWatchdogDeps {
  /** The tick counter and when the last completed simulation tick happened (epoch ms; 0 = none). */
  metrics: { readonly tick: number; readonly lastTickAt: number }
  log: Logger
  /** The clock at construction: before the first tick, the stall is measured from here. */
  startedAt?: number
  stallMs?: number
  graceMs?: number
  intervalMs?: number
  now?: () => number
  /** `process.exit` in production; injected so a test never kills its own runner. */
  exit?: (code: number) => void
}

export interface TickWatchdog {
  start(): void
  stop(): void
  /** Check once; true once the watchdog has asked the process to exit. */
  check(): boolean
}

/**
 * Watch the completed-tick timestamp and exit non-zero when it stops advancing while the process is
 * alive. A tick loop that died (or never got scheduled again) leaves the process answering HTTP and
 * /healthz but serving nothing; systemd only restarts it if the process exits. The watchdog waits for
 * the readiness threshold plus its grace, logs why, and exits 1.
 */
export function createTickWatchdog(deps: TickWatchdogDeps): TickWatchdog {
  const now = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? now()
  const lastAllowedGapMs =
    (deps.stallMs ?? TICK_STALL_MS) + (deps.graceMs ?? TICK_WATCHDOG_GRACE_MS)
  const intervalMs = deps.intervalMs ?? TICK_WATCHDOG_INTERVAL_MS
  const exit = deps.exit ?? ((code: number): never => process.exit(code))
  let timer: ReturnType<typeof setInterval> | null = null
  let tripped = false
  let stopped = false

  function stop(): void {
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function check(): boolean {
    if (tripped) return true
    if (stopped) return false
    const at = now()
    const last = deps.metrics.lastTickAt
    // Before the first tick the clock starts at construction, so a boot that never starts looping is
    // caught too (readiness reports "simulation has not ticked yet" from the first probe on).
    const since = last > 0 ? last : startedAt
    const ageMs = at - since
    if (ageMs <= lastAllowedGapMs) return false
    tripped = true
    stop()
    deps.log.error('simulation tick stalled: exiting 1 so the service restarts', {
      ageMs,
      thresholdMs: lastAllowedGapMs,
      tick: deps.metrics.tick,
    })
    exit(1)
    return true
  }

  return {
    start(): void {
      if (timer || tripped || stopped) return
      timer = setInterval(check, intervalMs)
      timer.unref()
    },
    stop,
    check,
  }
}
