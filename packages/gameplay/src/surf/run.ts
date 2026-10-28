import type { SurfMapMeta, ZoneDef } from '@openvibe/content'
import type { PlayerMoveState } from '../movement/simulate.js'

/**
 * The authoritative surf run state machine.
 *
 * It is deliberately pure and engine-free: the server feeds it the segment
 * between the previous and current AUTHORITATIVE capsule positions once per
 * simulated input, and it returns what happened. No client time, no client
 * position and no wall clock participate in a run.
 *
 * Timing: the room ticks at its configured rate (100 Hz for surf, 30 Hz for
 * the sandbox), and the run carries that rate. Every crossing is a slab
 * intersection against the zone AABB, giving the fraction of the segment at
 * which it happened:
 *
 *   timeMs = (endTick - startTick + fracEnd - fracStart) * (1000 / tickRate)
 *
 * `startTick` is the tick in which the capsule EXITED the start zone
 * (`fracStart` is that exit fraction, measured from the tick start), so the
 * interval from the crossing to the end of that tick is `1 - fracStart`.
 */

export type SurfVec3 = { x: number; y: number; z: number }
export type SurfZoneKind = 'start' | 'checkpoint' | 'finish' | 'kill'

export interface SurfBox {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}

export interface SurfRunZone extends SurfBox {
  id: string
  kind: SurfZoneKind
  stage: number
  spawn?: SurfVec3
  yaw?: number
}

export interface SurfRunMap {
  id: string
  failY: number
  stages: number
  start: SurfRunZone
  checkpoints: readonly SurfRunZone[]
  finish: SurfRunZone
  kills: readonly SurfRunZone[]
  spawn: SurfVec3
  spawnYaw: number
}

export interface SurfTrackSample {
  tick: number
  x: number
  y: number
  z: number
  yaw: number
}

export interface SurfSplit {
  stage: number
  timeMs: number
}

export interface SurfRunResult {
  mapId: string
  timeMs: number
  splits: number[]
  track: SurfTrackSample[]
  fails: number
  startedTick: number
  finishedTick: number
  startFrac: number
  finishFrac: number
}

export type SurfRunEvent =
  | { type: 'started'; tick: number; frac: number }
  | { type: 'checkpoint'; stage: number; timeMs: number }
  | { type: 'finished'; result: SurfRunResult }
  | { type: 'failed'; to: SurfVec3; yaw: number; fails: number }
  | { type: 'restarted'; to: SurfVec3; yaw: number }

export type SurfRunStatus = 'idle' | 'running' | 'finished'

const EPS = 1e-9

export function insideBox(box: SurfBox, p: SurfVec3): boolean {
  return (
    p.x >= box.min[0] &&
    p.x <= box.max[0] &&
    p.y >= box.min[1] &&
    p.y <= box.max[1] &&
    p.z >= box.min[2] &&
    p.z <= box.max[2]
  )
}

/**
 * Slab intersection. Returns the first fraction in [0,1] at which the segment
 * enters the box, or null when it never does. A point already inside enters at
 * 0; a zero-length segment inside returns 0 and outside returns null.
 */
export function segmentAabbEntry(a: SurfVec3, b: SurfVec3, box: SurfBox): number | null {
  if (insideBox(box, a)) return 0
  let tEnter = 0
  let tExit = 1
  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z']
  for (let i = 0; i < 3; i++) {
    const axis = axes[i]!
    const lo = box.min[i]!
    const hi = box.max[i]!
    const p = a[axis]
    const d = b[axis] - p
    if (Math.abs(d) < EPS) {
      if (p < lo || p > hi) return null
      continue
    }
    let t1 = (lo - p) / d
    let t2 = (hi - p) / d
    if (t1 > t2) [t1, t2] = [t2, t1]
    if (t1 > tEnter) tEnter = t1
    if (t2 < tExit) tExit = t2
    if (tEnter > tExit) return null
  }
  return tEnter >= 0 && tEnter <= 1 ? tEnter : null
}

/**
 * The fraction at which a segment EXITS the box while starting inside, or null
 * when it does not leave this tick. This is the start-line fraction: the run
 * begins as the capsule crosses out of the start volume.
 */
export function segmentAabbExit(a: SurfVec3, b: SurfVec3, box: SurfBox): number | null {
  if (!insideBox(box, a)) return null
  if (insideBox(box, b)) return null
  let tExit = 1
  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z']
  for (let i = 0; i < 3; i++) {
    const axis = axes[i]!
    const lo = box.min[i]!
    const hi = box.max[i]!
    const p = a[axis]
    const d = b[axis] - p
    if (Math.abs(d) < EPS) continue
    const t1 = (lo - p) / d
    const t2 = (hi - p) / d
    const t = d > 0 ? t2 : t1
    if (t < tExit) tExit = t
  }
  return tExit >= 0 && tExit <= 1 ? tExit : null
}

/**
 * Source surf timer zone aliases. `surf.kind` stays the canonical form; a
 * map authored with the interoperable trigger names (`map_start`, `map_cpN`,
 * `map_end`, `map_kill`) still builds a run without duplicating the kind.
 */
export function surfAliasFor(
  idOrName: string,
): { kind: SurfZoneKind; stage?: number } | null {
  if (idOrName === 'map_start') return { kind: 'start', stage: 0 }
  if (idOrName === 'map_end') return { kind: 'finish' }
  if (idOrName === 'map_kill') return { kind: 'kill', stage: 0 }
  const cp = /^map_cp(\d+)$/.exec(idOrName)
  if (cp) return { kind: 'checkpoint', stage: Number(cp[1]) }
  return null
}

/** Build the run description from a compiled map's surf metadata and zones. */
export function surfRunMapOf(
  meta: SurfMapMeta | undefined,
  zones: readonly ZoneDef[],
  spawn: readonly [number, number, number] = [0, 0, 0],
  spawnYaw = 0,
  id = meta?.title ?? 'surf',
): SurfRunMap {
  const tagged: { zone: ZoneDef; meta: NonNullable<ZoneDef['surf']> }[] = []
  for (const zone of zones) {
    if (zone.surf) {
      tagged.push({ zone, meta: zone.surf })
      continue
    }
    const alias = surfAliasFor(zone.id) ?? surfAliasFor(zone.name)
    if (!alias) continue
    const stage = alias.kind === 'finish'
      ? (meta?.stages ?? 1)
      : alias.kind === 'checkpoint'
        ? (alias.stage ?? 0)
        : 0
    tagged.push({ zone, meta: { kind: alias.kind, stage } })
  }
  const start = tagged.find((t) => t.meta.kind === 'start')
  const finish = tagged.find((t) => t.meta.kind === 'finish')
  if (!start || !finish)
    throw new Error('surf map needs a start zone and a finish zone')
  const toZone = (t: (typeof tagged)[number]): SurfRunZone => ({
    id: t.zone.id,
    kind: t.meta.kind,
    stage: t.meta.stage,
    min: [t.zone.min[0], t.zone.min[1], t.zone.min[2]],
    max: [t.zone.max[0], t.zone.max[1], t.zone.max[2]],
    ...(t.meta.spawn
      ? { spawn: { x: t.meta.spawn[0], y: t.meta.spawn[1], z: t.meta.spawn[2] } }
      : {}),
    ...(t.meta.yaw !== undefined ? { yaw: t.meta.yaw } : {}),
  })
  const checkpoints = tagged
    .filter((t) => t.meta.kind === 'checkpoint')
    .sort((a, b) => a.meta.stage - b.meta.stage)
    .map(toZone)
  return {
    id,
    failY: meta?.failY ?? -25,
    stages: meta?.stages ?? checkpoints.length + 1,
    start: toZone(start),
    checkpoints,
    finish: toZone(finish),
    kills: tagged.filter((t) => t.meta.kind === 'kill').map(toZone),
    spawn: { x: spawn[0], y: spawn[1], z: spawn[2] },
    spawnYaw,
  }
}

/** One session's run. Create per player per surf place. */
export class SurfRunState {
  status: SurfRunStatus = 'idle'
  /** Highest checkpoint stage reached this run (0 = none). */
  reached = 0
  fails = 0
  startTick = 0
  startFrac = 0
  lastTick = 0
  splits: SurfSplit[] = []
  private track: SurfTrackSample[] = []
  private result: SurfRunResult | null = null
  private lastPos: SurfVec3 | null = null

  constructor(
    readonly map: SurfRunMap,
    readonly tickRate: number,
  ) {}

  get elapsedMs(): number {
    if (this.status !== 'running') return this.result?.timeMs ?? 0
    return Math.max(
      0,
      Math.round((this.lastTick + 1 - this.startTick - this.startFrac) * (1000 / this.tickRate)),
    )
  }

  get finishResult(): SurfRunResult | null {
    return this.result
  }

  get splitTimes(): number[] {
    return this.splits.map((s) => s.timeMs)
  }

  /** The PB-format tracks use integer milliseconds; so does the wire. */
  private timeAt(tick: number, frac: number): number {
    return Math.max(
      0,
      Math.round((tick + frac - this.startTick - this.startFrac) * (1000 / this.tickRate)),
    )
  }

  /** Put the run back at the start line; the caller teleports the capsule. */
  restart(tick: number): SurfRunEvent {
    this.status = 'idle'
    this.reached = 0
    this.fails = 0
    this.startTick = tick
    this.startFrac = 0
    this.lastTick = tick
    this.splits = []
    this.track = []
    this.result = null
    this.lastPos = null
    return { type: 'restarted', to: this.map.spawn, yaw: this.map.spawnYaw }
  }

  /** The server moved the capsule outside movement (fail/reset/join): do not treat it as a crossing. */
  teleport(pos: SurfVec3): void {
    this.lastPos = { ...pos }
  }

  /**
   * Feed one authoritative movement segment. Returns events in order; the
   * caller applies `failed`/`restarted` teleports after this call.
   */
  observe(tick: number, from: SurfVec3, to: SurfVec3, yaw: number): SurfRunEvent[] {
    const events: SurfRunEvent[] = []
    this.lastTick = tick
    if (this.status === 'finished') {
      // Re-entering the start after a finish arms a fresh run, like CS surf's
      // start zone. A respawn already inside it is not an entry.
      if (!insideBox(this.map.start, from) && insideBox(this.map.start, to)) {
        this.lastPos = { ...to }
        return [this.restart(tick)]
      }
      this.lastPos = { ...to }
      return events
    }

    if (this.status === 'idle') {
      // Leaving the start volume starts the clock. Re-entering it while idle
      // simply keeps the player at the line.
      const exitFrac = segmentAabbExit(from, to, this.map.start)
      if (exitFrac !== null && !insideBox(this.map.start, to)) {
        this.status = 'running'
        this.startTick = tick
        this.startFrac = exitFrac
        this.reached = 0
        this.fails = 0
        this.splits = []
        this.track = [{ tick: tick + exitFrac, x: to.x, y: to.y, z: to.z, yaw }]
        events.push({ type: 'started', tick, frac: exitFrac })
      }
      this.lastPos = { ...to }
      return events
    }

    // Running. Only an actual entry restarts: a fail can respawn the player
    // at the start while the clock keeps running (brief decision 4).
    const enteredStart = !insideBox(this.map.start, from) && insideBox(this.map.start, to)
    if (enteredStart) {
      events.push(this.restart(tick) as SurfRunEvent)
      this.lastPos = { ...to }
      return events
    }

    this.track.push({ tick: tick + 1, x: to.x, y: to.y, z: to.z, yaw })

    // Only the NEXT checkpoint counts: skipping one records nothing.
    while (this.reached < this.map.checkpoints.length) {
      const next = this.map.checkpoints[this.reached]!
      const frac = segmentAabbEntry(from, to, next)
      if (frac === null) break
      this.reached++
      const timeMs = this.timeAt(tick, frac)
      this.splits.push({ stage: next.stage, timeMs })
      events.push({ type: 'checkpoint', stage: next.stage, timeMs })
    }

    // Finish only after every checkpoint is in order.
    if (this.reached === this.map.checkpoints.length) {
      const fracEnd = segmentAabbEntry(from, to, this.map.finish)
      if (fracEnd !== null) {
        const timeMs = this.timeAt(tick, fracEnd)
        this.status = 'finished'
        this.result = {
          mapId: this.map.id,
          timeMs,
          splits: [...this.splits.map((s) => s.timeMs), timeMs],
          track: this.track,
          fails: this.fails,
          startedTick: this.startTick,
          finishedTick: tick,
          startFrac: this.startFrac,
          finishFrac: fracEnd,
        }
        events.push({ type: 'finished', result: this.result })
        this.lastPos = { ...to }
        return events
      }
    }

    // A fall or a kill volume puts the player back at the last checkpoint;
    // the clock keeps running, as in CS surf's stage behaviour.
    const kill = this.map.kills.some((k) => insideBox(k, to))
    if (kill || to.y < this.map.failY) {
      this.fails++
      const last = this.map.checkpoints[this.reached - 1]
      const respawn = last?.spawn ?? this.map.spawn
      const respawnYaw = last?.yaw ?? this.map.spawnYaw
      events.push({ type: 'failed', to: { ...respawn }, yaw: respawnYaw, fails: this.fails })
      this.teleport(respawn)
    } else {
      this.lastPos = { ...to }
    }
    return events
  }
}


/**
 * Move a capsule to a respawn point with zero velocity. Shared by the server's
 * checkpoint/fall teleport and the tests that prove a fail does not stop the
 * clock.
 */
export function placeMoveStateAt(
  state: PlayerMoveState,
  to: SurfVec3,
  yaw?: number,
): void {
  state.pos.x = to.x
  state.pos.y = to.y
  state.pos.z = to.z
  state.vel.x = 0
  state.vel.y = 0
  state.vel.z = 0
  state.grounded = false
  if (yaw !== undefined) {
    // The move state has no yaw; callers that own a session set its view.
  }
}
