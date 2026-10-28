import { describe, expect, it } from 'vitest'
import { vec3 } from '@openvibe/shared'
import type { CollisionQueries, SweepHit } from './collision.js'
import { DEFAULT_MOVEMENT } from './params.js'
import { createMoveState, stepMovement, type PlayerMoveState } from './simulate.js'
import { SURF_MOVEMENT } from './styles.js'

/**
 * The feel proof for Ride. A 55° ramp is steeper than cos⁻¹(0.7) = 45.57°, so
 * NEITHER style ever grounds on it; the difference is the air controller.
 * Surf's CS:S cap (scaled to 30 Hz) lets a strafe + turn keep or gain
 * horizontal speed; the sandbox default's 0.85 m/s cap gives the ramp the
 * speed instead. A 40° slope is ground in both styles.
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
      if (da <= 0)
        return { fraction: 0, normal: { ...n }, point: { ...from } }
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

function spawnOnPlane(angleDeg: number, above = 1.2): PlayerMoveState {
  const a = angleDeg * RAD
  const n = { x: 0, y: Math.cos(a), z: Math.sin(a) }
  return createMoveState(vec3(n.x * above, n.y * above, n.z * above))
}

/** 3 s of a strafe whose yaw turns 45°, the surf line. */
function runLine(params: typeof DEFAULT_MOVEMENT, angle: number): number[] {
  const state = spawnOnPlane(angle)
  state.vel.x = 0
  state.vel.y = 0
  state.vel.z = 10
  const speeds: number[] = []
  for (let tick = 0; tick < 90; tick++) {
    const yaw = (tick / 30) * 45 * RAD
    stepMovement(
      state,
      { moveX: 1, moveZ: 0, yaw, pitch: 0, buttons: 0 },
      params,
      planeQueries(angle),
      1 / 30,
    )
    if (tick % 30 === 29) speeds.push(Math.hypot(state.vel.x, state.vel.z))
  }
  return speeds
}

describe('surf feel on a steep ramp', () => {
  it('keeps or gains horizontal speed over 3 s in the surf style', () => {
    const speeds = runLine(SURF_MOVEMENT, 55)
    expect(speeds[0]).toBeGreaterThan(9)
    expect(speeds[2]).toBeGreaterThanOrEqual(10 * 0.99)
  })

  it('loses horizontal speed in the default style on the same ramp and line', () => {
    const speeds = runLine(DEFAULT_MOVEMENT, 55)
    expect(speeds[2]).toBeLessThan(9)
    expect(speeds[2]).toBeLessThan(runLine(SURF_MOVEMENT, 55)[2]! * 0.75)
  })

  it('a 40° slope is ground in both styles', () => {
    for (const params of [SURF_MOVEMENT, DEFAULT_MOVEMENT]) {
      const state = spawnOnPlane(40, 0.1)
      stepMovement(
        state,
        { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 },
        params,
        planeQueries(40),
        1 / 30,
      )
      expect(state.grounded).toBe(true)
    }
  })

  it('CS:S constants are the converted Source values, scaled at 30 Hz', () => {
    expect(SURF_MOVEMENT.groundNormalY).toBe(0.7)
    expect(SURF_MOVEMENT.gravity).toBeCloseTo(800 * 0.0254)
    expect(SURF_MOVEMENT.maxHorizontalSpeed).toBeCloseTo(3500 * 0.0254)
    expect(SURF_MOVEMENT.airSpeedCap).toBeCloseTo(30 * 0.0254 * (64 / 30))
    expect(SURF_MOVEMENT.airAccel).toBe(150)
    expect(SURF_MOVEMENT.autoBhop).toBe(false)
    expect(SURF_MOVEMENT.maxSprintSpeed).toBe(SURF_MOVEMENT.maxGroundSpeed)
  })
})
