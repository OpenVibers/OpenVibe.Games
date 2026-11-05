import type { LogFields, Logger } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import { createTickWatchdog, TICK_WATCHDOG_GRACE_MS } from './tickWatchdog.js'

interface Entry {
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  fields?: LogFields
}

function recordingLogger(): { log: Logger; entries: Entry[] } {
  const entries: Entry[] = []
  const log: Logger = {
    debug: (msg, fields) => entries.push({ level: 'debug', msg, ...(fields ? { fields } : {}) }),
    info: (msg, fields) => entries.push({ level: 'info', msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => entries.push({ level: 'error', msg, ...(fields ? { fields } : {}) }),
    child: () => log,
  }
  return { log, entries }
}

function setup(overrides: Partial<Parameters<typeof createTickWatchdog>[0]> = {}) {
  const { log, entries } = recordingLogger()
  let clock = 1_000_000
  const exits: number[] = []
  const metrics = { tick: 0, lastTickAt: 0 }
  const watchdog = createTickWatchdog({
    metrics,
    log,
    startedAt: clock,
    stallMs: 5_000,
    graceMs: 20_000,
    now: () => clock,
    exit: (code) => exits.push(code),
    ...overrides,
  })
  return {
    watchdog,
    entries,
    exits,
    metrics,
    advance: (ms: number) => {
      clock += ms
    },
    at: () => clock,
  }
}

describe('simulation tick watchdog', () => {
  it('does not exit before the stall threshold plus grace', () => {
    const { watchdog, exits, advance } = setup()
    advance(24_999)
    expect(watchdog.check()).toBe(false)
    expect(exits).toEqual([])
  })

  it('exits 1 with the reason once the simulation has not ticked for the grace', () => {
    const { watchdog, exits, entries, advance } = setup()
    advance(25_001)
    expect(watchdog.check()).toBe(true)
    expect(exits).toEqual([1])
    const error = entries.find((e) => e.level === 'error')
    expect(error?.msg).toMatch(/simulation tick stalled/)
    expect(error?.fields?.ageMs).toBe(25_001)
    expect(error?.fields?.tick).toBe(0)
    // It trips once, not on every later interval.
    expect(watchdog.check()).toBe(true)
    expect(exits).toEqual([1])
  })

  it('follows a tick timestamp that advances', () => {
    const { watchdog, exits, metrics, advance } = setup()
    advance(20_000)
    metrics.lastTickAt = 1_020_000
    metrics.tick = 700
    advance(20_000)
    expect(watchdog.check()).toBe(false)
    expect(exits).toEqual([])
    // Still 20 s after the last tick: inside the threshold.
    advance(5_002)
    expect(watchdog.check()).toBe(true)
    expect(exits).toEqual([1])
  })

  it('stops checking after stop() (shutdown must not exit the process)', () => {
    const { watchdog, exits, advance } = setup()
    watchdog.start()
    watchdog.stop()
    advance(TICK_WATCHDOG_GRACE_MS * 2)
    expect(watchdog.check()).toBe(false)
    expect(exits).toEqual([])
  })
})
