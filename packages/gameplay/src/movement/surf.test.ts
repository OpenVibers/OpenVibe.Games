import { describe, expect, it } from 'vitest'
import { vec3 } from '@openvibe/shared'
import type { CollisionQueries, SweepHit } from './collision.js'
import { DEFAULT_MOVEMENT } from './params.js'
import {
  Stance,
  createMoveState,
  eyeOffsetFor,
  hullHeightFor,
  stepMovement,
  type PlayerMoveState,
} from './simulate.js'
import { SURF_MOVEMENT } from './styles.js'

/**
 * The feel proof for Ride. A 55° ramp is steeper than cos⁻¹(0.7) = 45.57°, so
 * NEITHER style ever grounds on it; the difference is the air controller.
 * Surf runs at 100 Hz with CS:S's native 0.762 m/s wish cap; the sandbox runs
 * at 30 Hz with its own 0.85 cap and gives the ramp the speed instead. A 40°
 * slope is ground in both styles.
 *
 * The collision world is an analytic half-space rather than Rapier: the test
 * is about the movement rule, and the half-space has no box edges, so the
 * comparison is not polluted by a capsule catching a lip.
 */
const RAD = Math.PI / 180

function planeQueries(angleDeg: number): CollisionQueries {
  const a = angleDeg * RAD
  const n = { x: 0, y: Math.cos(a), z: Math.sin(a) }
  return {
    sweepCapsule(from, to, radius): SweepHit | null {
      const da = from.x * n.x + from.y * n.y + from.z * n.z - radius
      const db = to.x * n.x + to.y * n.y + to.z * n.z - radius
      if (da <= 0) return { fraction: 0, normal: { ...n }, point: { ...from } }
      if (db >= 0) return null
      const f = da / (da - db)
      return {
        fraction: f,
        normal: { ...n },
        point: {
          x: from.x + (to.x - from.x) * f,
          y: from.y + (to.y - from.y) * f,
          z: from.z + (to.z - from.z) * f,
        },
      }
    },
  }
}

/** Open air: no ground, no ramp, so only the air rule changes velocity. */
const FLAT_AIR: CollisionQueries = { sweepCapsule: () => null }

function spawnOnPlane(angleDeg: number, above = 1.2): PlayerMoveState {
  const a = angleDeg * RAD
  const n = { x: 0, y: Math.cos(a), z: Math.sin(a) }
  return createMoveState(vec3(n.x * above, n.y * above, n.z * above))
}

/** 3 s of a strafe whose yaw turns 45°, the surf line, at the room's own rate. */
function runLine(params: typeof DEFAULT_MOVEMENT, angle: number, tickRate: number): number[] {
  const state = spawnOnPlane(angle)
  state.vel.x = 0
  state.vel.y = 0
  state.vel.z = 10
  const speeds: number[] = []
  const ticks = 3 * tickRate
  for (let tick = 0; tick < ticks; tick++) {
    const yaw = (tick / tickRate) * 45 * RAD
    stepMovement(
      state,
      { moveX: 1, moveZ: 0, yaw, pitch: 0, buttons: 0 },
      params,
      planeQueries(angle),
      1 / tickRate,
    )
    if ((tick + 1) % tickRate === 0) speeds.push(Math.hypot(state.vel.x, state.vel.z))
  }
  return speeds
}

/** The horizontal speed a single airborne tick adds toward the wish direction. */
function firstAirTickGain(tickRate: number): number {
  const state = createMoveState(vec3(0, 100, 0))
  stepMovement(
    state,
    { moveX: 1, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 },
    SURF_MOVEMENT,
    FLAT_AIR,
    1 / tickRate,
  )
  return Math.hypot(state.vel.x, state.vel.z)
}

describe('surf feel on a steep ramp', () => {
  it('keeps or gains horizontal speed over 3 s in the surf style at 100 Hz', () => {
    const speeds = runLine(SURF_MOVEMENT, 55, 100)
    expect(speeds[0]).toBeGreaterThan(9)
    expect(speeds[2]).toBeGreaterThanOrEqual(10 * 0.99)
  })

  it('loses horizontal speed in the default style on the same ramp and line at 30 Hz', () => {
    const speeds = runLine(DEFAULT_MOVEMENT, 55, 30)
    expect(speeds[2]).toBeLessThan(9)
    expect(speeds[2]).toBeLessThan(runLine(SURF_MOVEMENT, 55, 100)[2]! * 0.75)
  })

  it('a 40° slope is ground in both styles at their native rates', () => {
    for (const [params, tickRate] of [
      [SURF_MOVEMENT, 100],
      [DEFAULT_MOVEMENT, 30],
    ] as const) {
      const state = spawnOnPlane(40, 0.1)
      stepMovement(
        state,
        { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 },
        params,
        planeQueries(40),
        1 / tickRate,
      )
      expect(state.grounded).toBe(true)
    }
  })
})

describe('source air cap', () => {
  it('adds the same 0.762 m/s per airborne tick at 64 and 100 Hz', () => {
    const at64 = firstAirTickGain(64)
    const at100 = firstAirTickGain(100)
    expect(at64).toBeCloseTo(30 * 0.0254, 10)
    expect(at100).toBeCloseTo(at64, 10)
  })

  it('is 48.768 m/s² at 64 Hz and 76.20 m/s² at 100 Hz — the rate difference is intentional', () => {
    expect(firstAirTickGain(64) * 64).toBeCloseTo(48.768, 8)
    expect(firstAirTickGain(100) * 100).toBeCloseTo(76.2, 8)
  })
})

describe('CS:S constants', () => {
  it('uses the converted Source values and the native 100 Hz cap', () => {
    expect(SURF_MOVEMENT.groundNormalY).toBe(0.7)
    expect(SURF_MOVEMENT.gravity).toBeCloseTo(800 * 0.0254)
    expect(SURF_MOVEMENT.maxHorizontalSpeed).toBeCloseTo(3500 * 0.0254)
    expect(SURF_MOVEMENT.airSpeedCap).toBeCloseTo(30 * 0.0254)
    expect(SURF_MOVEMENT.airAccel).toBe(150)
    expect(SURF_MOVEMENT.maxGroundSpeed).toBeCloseTo(250 * 0.0254)
    expect(SURF_MOVEMENT.jumpSpeed).toBeCloseTo(301.993 * 0.0254)
    expect(SURF_MOVEMENT.stopSpeed).toBeCloseTo(75 * 0.0254)
    expect(SURF_MOVEMENT.autoBhop).toBe(false)
    expect(SURF_MOVEMENT.maxSprintSpeed).toBe(SURF_MOVEMENT.maxGroundSpeed)
  })

  it('uses the exact hull, crouch, eye and step heights without changing the sandbox', () => {
    expect(SURF_MOVEMENT.capsuleHeight).toBeCloseTo(72 * 0.0254)
    expect(SURF_MOVEMENT.capsuleRadius).toBeCloseTo(16 * 0.0254)
    expect(SURF_MOVEMENT.eyeOffset).toBeCloseTo(64 * 0.0254 - 36 * 0.0254)
    expect(SURF_MOVEMENT.stepHeight).toBeCloseTo(18 * 0.0254)
    expect(hullHeightFor(Stance.Stand, SURF_MOVEMENT)).toBeCloseTo(1.8288)
    expect(hullHeightFor(Stance.Crouch, SURF_MOVEMENT)).toBeCloseTo(36 * 0.0254)
    expect(eyeOffsetFor(Stance.Stand, SURF_MOVEMENT)).toBeCloseTo(64 * 0.0254 - 36 * 0.0254)
    expect(eyeOffsetFor(Stance.Crouch, SURF_MOVEMENT)).toBeCloseTo(28 * 0.0254 - 18 * 0.0254)

    // Source values are opt-in by style: the sandbox keeps its current hull.
    expect(DEFAULT_MOVEMENT.stanceHull).toEqual([1.8, 1.2, 0.7])
    expect(DEFAULT_MOVEMENT.stanceEye).toEqual([0.65, 0.38, 0.14])
  })
})
