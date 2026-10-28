import { describe, expect, it } from 'vitest'
import { createMoveState } from '../movement/simulate.js'
import { vec3 } from '@openvibe/shared'
import {
  SurfRunState,
  insideBox,
  placeMoveStateAt,
  segmentAabbEntry,
  segmentAabbExit,
  surfRunMapOf,
  type SurfRunMap,
  type SurfRunZone,
} from './run.js'
import type { DecodedGhost } from './ghost.js'
import { decodeSurfTrack, encodeSurfTrack } from './ghost.js'

function zone(
  id: string,
  kind: SurfRunZone['kind'],
  stage: number,
  min: [number, number, number],
  max: [number, number, number],
  spawn?: [number, number, number],
): SurfRunZone {
  return {
    id,
    kind,
    stage,
    min,
    max,
    ...(spawn ? { spawn: { x: spawn[0], y: spawn[1], z: spawn[2] } } : {}),
    ...(kind === 'checkpoint' ? { yaw: 0 } : {}),
  }
}

function map(overrides: Partial<SurfRunMap> = {}): SurfRunMap {
  return {
    id: 'test',
    failY: -10,
    stages: 3,
    start: zone('start', 'start', 0, [-2, -1, 0], [2, 2, 2]),
    checkpoints: [
      zone('cp1', 'checkpoint', 1, [-2, -1, 10], [2, 2, 12], [0, 0, 11]),
      zone('cp2', 'checkpoint', 2, [-2, -1, 20], [2, 2, 22], [0, 0, 21]),
    ],
    finish: zone('finish', 'finish', 3, [-2, -1, 30], [2, 2, 32]),
    kills: [],
    spawn: { x: 0, y: 0, z: 1 },
    spawnYaw: 0,
    ...overrides,
  }
}

const p = (z: number): { x: number; y: number; z: number } => ({ x: 0, y: 0, z })

describe('slab crossing fractions', () => {
  it('computes an entry fraction from the segment and the AABB', () => {
    expect(segmentAabbEntry(p(8), p(12), { min: [-1, -1, 10], max: [1, 1, 12] })).toBeCloseTo(0.5)
    expect(segmentAabbEntry(p(11), p(13), { min: [-1, -1, 10], max: [1, 1, 12] })).toBe(0)
    expect(segmentAabbEntry(p(0), p(5), { min: [-1, -1, 10], max: [1, 1, 12] })).toBeNull()
    expect(segmentAabbEntry(p(0), p(20), { min: [-1, -1, 10], max: [1, 1, 12] })).toBeCloseTo(0.5)
  })

  it('computes the exit fraction only when the segment starts inside', () => {
    expect(segmentAabbExit(p(1), p(3), { min: [-2, -1, 0], max: [2, 2, 2] })).toBeCloseTo(0.5)
    expect(segmentAabbExit(p(3), p(4), { min: [-2, -1, 0], max: [2, 2, 2] })).toBeNull()
    expect(segmentAabbExit(p(1), p(1.5), { min: [-2, -1, 0], max: [2, 2, 2] })).toBeNull()
  })
})

describe('surf timer', () => {
  it('uses sub-tick fractions at both ends', () => {
    const run = new SurfRunState(
      map({ checkpoints: [], stages: 1, finish: zone('finish', 'finish', 1, [-2, -1, 30], [2, 2, 32]) }),
      30,
    )
    // Exit the start at 0.25 of tick 10: from z=1.5 to z=2.5, box ends at 2.
    run.observe(10, p(1.5), p(2.5), 0)
    expect(run.status).toBe('running')
    expect(run.startTick).toBe(10)
    expect(run.startFrac).toBeCloseTo(0.5)
    expect(run.elapsedMs).toBe(17) // (11 - 10 - 0.5) * 33.333, rounded

    // Finish at 0.75 of tick 20: z 28 → 32 crosses z=30 at 0.5, but use cp
    // zones first (they are not on this line), then the finish.
    run.observe(20, p(28), p(32), 0)
    // fracEnd = 0.5, startFrac = 0.5 → (20-10+0.5-0.5)*33.333 = 333ms
    expect(run.finishResult?.timeMs).toBe(333)
    expect(run.finishResult?.timeMs).toBe(
      Math.round((20 - 10 + 0.5 - 0.5) * (1000 / 30)),
    )
  })

  it('crosses mid-tick at both ends and matches the formula exactly', () => {
    const m = map({
      start: zone('start', 'start', 0, [-2, -1, 0], [2, 2, 2]),
      checkpoints: [],
      finish: zone('finish', 'finish', 1, [-2, -1, 10], [2, 2, 12]),
      stages: 1,
    })
    const run = new SurfRunState(m, 30)
    run.observe(5, p(1.2), p(2.8), 0) // exit at (2-1.2)/1.6 = 0.5
    expect(run.startFrac).toBeCloseTo(0.5)
    run.observe(9, p(8), p(12), 0) // enter at (10-8)/4 = 0.5
    const expected = Math.round((9 - 5 + 0.5 - 0.5) * (1000 / 30))
    expect(run.finishResult?.timeMs).toBe(expected)
  })
})

describe('surf zones', () => {
  it('records ordered checkpoints and ignores a skipped one', () => {
    const run = new SurfRunState(map(), 30)
    run.observe(1, p(1), p(3), 0) // start
    // Jump straight into checkpoint 2's volume: stage 1 is skipped, so nothing.
    run.observe(2, p(18), p(21), 0)
    expect(run.reached).toBe(0)
    expect(run.splits).toEqual([])
    run.observe(3, p(9), p(11), 0)
    expect(run.reached).toBe(1)
    expect(run.splits.map((s) => s.stage)).toEqual([1])
    run.observe(4, p(19), p(21), 0)
    expect(run.reached).toBe(2)
    run.observe(5, p(29), p(31), 0)
    expect(run.status).toBe('finished')
    expect(run.finishResult?.splits).toHaveLength(3)
  })

  it('fails below failY to the last checkpoint with velocity zeroed, and the clock still runs', () => {
    const run = new SurfRunState(map(), 30)
    run.observe(10, p(1), p(3), 0)
    run.observe(11, p(9), p(11), 0) // cp1
    const before = run.elapsedMs
    const events = run.observe(12, { x: 0, y: -11, z: 12 }, { x: 0, y: -12, z: 13 }, 0)
    const failed = events.find((e) => e.type === 'failed')
    expect(failed).toMatchObject({ type: 'failed', to: { x: 0, y: 0, z: 11 } })
    expect(run.fails).toBe(1)
    expect(run.status).toBe('running')
    expect(run.elapsedMs).toBeGreaterThan(before)
    const move = createMoveState(vec3(0, 0, 12))
    move.vel.x = 9
    move.vel.y = -4
    placeMoveStateAt(move, (failed as Extract<typeof failed, { type: 'failed' }>).to)
    expect(move.vel).toEqual(vec3(0, 0, 0))
    expect(move.pos).toEqual(vec3(0, 0, 11))
  })

  it('fails inside a kill volume, even above failY', () => {
    const kill = zone('kill', 'kill', 0, [-2, -1, 14], [2, 3, 18])
    const run = new SurfRunState(map({ kills: [kill] }), 30)
    run.observe(10, p(1), p(3), 0)
    const events = run.observe(11, p(13), p(15), 0)
    expect(events.some((e) => e.type === 'failed')).toBe(true)
    expect(run.fails).toBe(1)
    expect(run.status).toBe('running')
  })

  it('re-entering the start after a finish arms a fresh run', () => {
    const run = new SurfRunState(map({ checkpoints: [], stages: 1 }), 30)
    run.observe(1, p(1), p(3), 0)
    run.observe(2, p(29), p(31), 0)
    expect(run.status).toBe('finished')
    const events = run.observe(3, p(3), p(1), 0)
    expect(events.some((e) => e.type === 'restarted')).toBe(true)
    expect(run.status).toBe('idle')
  })

  it('a fail before the first checkpoint respawns at the start without resetting the clock', () => {
    const run = new SurfRunState(map(), 30)
    run.observe(10, p(1), p(3), 0)
    const startTick = run.startTick
    const failed = run.observe(12, { x: 0, y: -11, z: 3 }, { x: 0, y: -12, z: 3 }, 0)
    expect(failed.some((e) => e.type === 'failed')).toBe(true)
    // Next tick starts at the start spawn (inside the start zone) and runs
    // out again; that is not a fresh entry.
    run.observe(13, p(1), p(3), 0)
    expect(run.status).toBe('running')
    expect(run.startTick).toBe(startTick)
  })

  it('resets to idle and can start again', () => {
    const run = new SurfRunState(map(), 30)
    run.observe(10, p(1), p(3), 0)
    run.observe(11, p(9), p(11), 0)
    run.restart(20)
    expect(run.status).toBe('idle')
    expect(run.reached).toBe(0)
    expect(run.splits).toEqual([])
    expect(run.restart(20)).toMatchObject({ type: 'restarted', to: { z: 1 } })
    run.observe(21, p(1), p(3), 0)
    expect(run.status).toBe('running')
    expect(run.startTick).toBe(21)
  })

  it('builds the run from tagged zones and requires one ordered set', () => {
    const zones = [
      { id: 's', name: 'S', min: [0, 0, 0] as [number, number, number], max: [2, 2, 2] as [number, number, number], rules: { pvp: false, build: false, physgun: false }, surf: { kind: 'start' as const, stage: 0 } },
      { id: 'f', name: 'F', min: [0, 0, 10] as [number, number, number], max: [2, 2, 12] as [number, number, number], rules: { pvp: false, build: false, physgun: false }, surf: { kind: 'finish' as const, stage: 1 } },
    ]
    const runMap = surfRunMapOf({ title: 'T', author: 'A', tier: 1, stages: 1, failY: -5 }, zones)
    expect(runMap.finish.id).toBe('f')
    expect(insideBox(runMap.start, { x: 1, y: 1, z: 1 })).toBe(true)
    expect(insideBox(runMap.start, { x: 3, y: 1, z: 1 })).toBe(false)
  })
})

describe('ghost track', () => {
  it('round-trips positions at 1 cm and yaw at 1/256 turn', () => {
    const samples = [
      { tick: 100, x: 1.23, y: 4.56, z: -7.89, yaw: Math.PI / 4 },
      { tick: 101, x: -10.01, y: 0.02, z: 300.4, yaw: -Math.PI / 2 },
    ]
    const bytes = encodeSurfTrack(samples, 30, 100)
    const decoded: DecodedGhost = decodeSurfTrack(bytes)
    expect(decoded.tickRate).toBe(30)
    expect(decoded.startTick).toBe(100)
    expect(decoded.samples[0]!.x).toBeCloseTo(1.23)
    expect(decoded.samples[0]!.y).toBeCloseTo(4.56)
    expect(decoded.samples[0]!.z).toBeCloseTo(-7.89)
    expect(decoded.samples[0]!.yaw).toBeCloseTo(Math.PI / 4, 2)
    expect(decoded.samples[1]!.x).toBeCloseTo(-10.01)
  })

  it('refuses a corrupt or truncated track', () => {
    const bytes = encodeSurfTrack([{ tick: 0, x: 0, y: 0, z: 0, yaw: 0 }], 30, 0)
    expect(() => decodeSurfTrack(bytes.subarray(0, 20))).toThrow()
    const bad = bytes.slice()
    bad[0] = 0
    expect(() => decodeSurfTrack(bad)).toThrow()
  })
})
