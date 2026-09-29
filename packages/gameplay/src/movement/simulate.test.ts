import { afterEach, describe, expect, it } from 'vitest'
import { vec3, type Vec3 } from '@openvibe/shared'
import {
  createMockPhysicsWorld,
  mockCollisionQueries,
  type MockPhysicsWorld,
} from '@openvibe/physics/mock'
import { Buttons } from './buttons.js'
import type { CollisionQueries } from './collision.js'
import { DEFAULT_MOVEMENT } from './params.js'
import {
  Stance,
  clipVelocity,
  createMoveState,
  hullHeightFor,
  stepMovement,
  type MoveInput,
} from './simulate.js'

const P = DEFAULT_MOVEMENT
const DT = 1 / 30

/**
 * The movement tests walk on the physics package's own mock world rather than
 * a hand-rolled analytic stub, so the sweep geometry under test is the one
 * `mockCollisionQueries` binds with the server's mask (apps/server/src/game/
 * systems/movement.ts:58-68). Analytic surfaces stand in for level geometry:
 * `addGroundPlane` is the floor, `addCast` a wall or a ceiling.
 */
/** Worlds created by `makeWorld`, disposed after each case. */
const live: MockPhysicsWorld[] = []

function makeWorld(opts?: { wallX?: number; ceilingY?: number }): CollisionQueries {
  const world = createMockPhysicsWorld()
  world.addGroundPlane(0)
  if (opts?.wallX !== undefined) world.addCast({ normal: vec3(1, 0, 0), offset: opts.wallX })
  if (opts?.ceilingY !== undefined) world.addCast({ normal: vec3(0, 1, 0), offset: opts.ceilingY })
  live.push(world)
  return mockCollisionQueries(world)
}

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

function idle(): MoveInput {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }
}

function forward(buttons = 0): MoveInput {
  return { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons }
}

/**
 * Spawn a hair above the floor: the mock's ground plane rejects a sweep that
 * starts in exact contact (t = 0, like Havok's), so a spawn at exactly
 * capsuleHeight/2 has no ground to find until gravity pulls it down a tick.
 */
function spawnGrounded() {
  return createMoveState(vec3(0, P.capsuleHeight / 2 + 0.01, 0))
}

function horizSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.z)
}

describe('clipVelocity', () => {
  it('removes the into-plane component and keeps tangent motion', () => {
    const v = vec3(3, -4, 0)
    clipVelocity(v, vec3(0, 1, 0), 1.0)
    expect(v.x).toBeCloseTo(3)
    expect(v.y).toBeCloseTo(0)
  })
})

describe('stepMovement', () => {
  it('detects ground at spawn', () => {
    const s = spawnGrounded()
    stepMovement(s, idle(), P, makeWorld(), DT)
    expect(s.grounded).toBe(true)
    expect(s.pos.y).toBeCloseTo(P.capsuleHeight / 2, 1)
  })

  it('accelerates to max ground speed and no further', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 90; i++) stepMovement(s, forward(), P, makeWorld(), DT)
    expect(horizSpeed(s.vel)).toBeGreaterThan(P.maxGroundSpeed * 0.95)
    expect(horizSpeed(s.vel)).toBeLessThan(P.maxGroundSpeed * 1.05)
    // moves in +Z with yaw 0
    expect(s.pos.z).toBeGreaterThan(5)
    expect(Math.abs(s.pos.x)).toBeLessThan(0.01)
  })

  it('sprint raises the speed cap', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 90; i++) stepMovement(s, forward(Buttons.Sprint), P, makeWorld(), DT)
    expect(horizSpeed(s.vel)).toBeGreaterThan(P.maxGroundSpeed)
  })

  it('friction stops the player quickly', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 60; i++) stepMovement(s, forward(), P, makeWorld(), DT)
    for (let i = 0; i < 30; i++) stepMovement(s, idle(), P, makeWorld(), DT)
    expect(horizSpeed(s.vel)).toBeLessThan(0.2)
  })

  it('jumps to roughly v^2/2g and lands grounded', () => {
    const s = spawnGrounded()
    stepMovement(s, idle(), P, makeWorld(), DT) // settle grounded flag
    let apex = 0
    let landedTick = -1
    for (let i = 0; i < 90; i++) {
      const input = i === 0 ? { ...idle(), buttons: Buttons.Jump } : idle()
      stepMovement(s, input, P, makeWorld(), DT)
      apex = Math.max(apex, s.pos.y - P.capsuleHeight / 2)
      if (i > 5 && s.grounded && landedTick < 0) landedTick = i
    }
    const expected = (P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity)
    expect(apex).toBeGreaterThan(expected * 0.85)
    expect(apex).toBeLessThan(expected * 1.25)
    expect(landedTick).toBeGreaterThan(0)
    expect(s.grounded).toBe(true)
    expect(s.pos.y).toBeCloseTo(P.capsuleHeight / 2, 1)
  })

  it('caps forward air acceleration at airSpeedCap', () => {
    const s = spawnGrounded()
    stepMovement(s, idle(), P, makeWorld(), DT)
    stepMovement(s, { ...idle(), buttons: Buttons.Jump }, P, makeWorld(), DT)
    let maxAirSpeed = 0
    for (let i = 0; i < 30; i++) {
      stepMovement(s, forward(), P, makeWorld(), DT)
      if (s.grounded) break
      maxAirSpeed = Math.max(maxAirSpeed, horizSpeed(s.vel))
    }
    expect(maxAirSpeed).toBeGreaterThan(0)
    expect(maxAirSpeed).toBeLessThanOrEqual(P.airSpeedCap * 1.05)
  })

  it('slides along walls instead of stopping', () => {
    const s = spawnGrounded()
    const world = makeWorld({ wallX: 2 })
    // Move diagonally (+X into wall, +Z along it)
    const input: MoveInput = { moveX: 1, moveZ: 1, yaw: 0, pitch: 0, buttons: 0 }
    for (let i = 0; i < 120; i++) stepMovement(s, input, P, world, DT)
    expect(s.pos.x).toBeLessThanOrEqual(2 - P.capsuleRadius + 0.01)
    expect(s.pos.z).toBeGreaterThan(4)
  })

  it('is deterministic for identical input streams', () => {
    const run = () => {
      const s = spawnGrounded()
      const world = makeWorld({ wallX: 3 })
      for (let i = 0; i < 200; i++) {
        const input: MoveInput = {
          moveX: Math.sin(i * 0.1),
          moveZ: 1,
          yaw: i * 0.01,
          pitch: 0,
          buttons: i % 40 === 0 ? Buttons.Jump : 0,
        }
        stepMovement(s, input, P, world, DT)
      }
      return s
    }
    const a = run()
    const b = run()
    expect(a.pos).toEqual(b.pos)
    expect(a.vel).toEqual(b.vel)
  })
})

describe('stances', () => {
  it('crouch slows movement and prone slows it further', () => {
    const measure = (buttons: number) => {
      const s = spawnGrounded()
      for (let i = 0; i < 120; i++) stepMovement(s, { ...forward(), buttons }, P, makeWorld(), DT)
      return horizSpeed(s.vel)
    }
    const standSpeed = measure(0)
    const crouchSpeed = measure(Buttons.Crouch)
    const proneSpeed = measure(Buttons.Prone)
    expect(crouchSpeed).toBeLessThan(standSpeed * 0.6)
    expect(proneSpeed).toBeLessThan(crouchSpeed)
  })

  it('transitions take time and lock out spam', () => {
    const s = spawnGrounded()
    stepMovement(s, { ...idle(), buttons: Buttons.Crouch }, P, makeWorld(), DT)
    expect(s.stance).toBe(Stance.Crouch)
    expect(s.stanceT).toBeGreaterThan(0)
    // Releasing crouch immediately must NOT stand back up mid-lockout.
    for (let i = 0; i < 3; i++) stepMovement(s, idle(), P, makeWorld(), DT)
    expect(s.stance).toBe(Stance.Crouch)
    // After the transition + cooldown it recovers.
    for (let i = 0; i < 30; i++) stepMovement(s, idle(), P, makeWorld(), DT)
    expect(s.stance).toBe(Stance.Stand)
  })

  it('prone is a toggle on the key edge', () => {
    const s = spawnGrounded()
    stepMovement(s, { ...idle(), buttons: Buttons.Prone }, P, makeWorld(), DT)
    expect(s.stance).toBe(Stance.Prone)
    // Holding the key does not un-prone (edge, not level).
    for (let i = 0; i < 60; i++)
      stepMovement(s, { ...idle(), buttons: Buttons.Prone }, P, makeWorld(), DT)
    expect(s.stance).toBe(Stance.Prone)
    // Release, wait out cooldown, press again -> stands.
    for (let i = 0; i < 60; i++) stepMovement(s, idle(), P, makeWorld(), DT)
    stepMovement(s, { ...idle(), buttons: Buttons.Prone }, P, makeWorld(), DT)
    for (let i = 0; i < 60; i++) stepMovement(s, idle(), P, makeWorld(), DT)
    expect(s.stance).toBe(Stance.Stand)
  })

  it('cannot jump while crouched or prone', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 30; i++) {
      stepMovement(s, { ...idle(), buttons: Buttons.Crouch | Buttons.Jump }, P, makeWorld(), DT)
    }
    expect(s.pos.y).toBeLessThan(1) // never left the ground
  })

  it('standing up is blocked by a ceiling', () => {
    // Upward-facing analytic plane at y=1.4: crouch fits (hull 1.2), standing
    // does not, so the up-sweep inside updateStance must hit it.
    const world = makeWorld({ ceilingY: 1.4 })
    const s = spawnGrounded()
    stepMovement(s, { ...idle(), buttons: Buttons.Crouch }, P, world, DT)
    for (let i = 0; i < 30; i++)
      stepMovement(s, { ...idle(), buttons: Buttons.Crouch }, P, world, DT)
    expect(s.stance).toBe(Stance.Crouch)
    // Release crouch under the ceiling: must STAY crouched (no headroom).
    for (let i = 0; i < 60; i++) stepMovement(s, idle(), P, world, DT)
    expect(s.stance).toBe(Stance.Crouch)
    expect(hullHeightFor(s.stance)).toBe(1.2)
  })
})

describe('noclip', () => {
  const fly = (input: Partial<MoveInput>, ticks = 60) => {
    const state = createMoveState(vec3(0, 5, 0))
    state.noclip = true
    const world = makeWorld()
    const full: MoveInput = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...input }
    for (let i = 0; i < ticks; i++) stepMovement(state, full, P, world, DT)
    return state
  }

  it('flies where you look: pitch UP + forward gains height', () => {
    const s = fly({ moveZ: 1, pitch: 0.8 })
    expect(s.pos.y).toBeGreaterThan(6)
    expect(s.pos.z).toBeGreaterThan(1)
  })

  it('flies where you look: pitch DOWN + forward loses height', () => {
    const s = fly({ moveZ: 1, pitch: -0.8 })
    expect(s.pos.y).toBeLessThan(4)
  })

  it('jump rises, crouch sinks, no gravity when idle', () => {
    expect(fly({ buttons: Buttons.Jump }).pos.y).toBeGreaterThan(6)
    expect(fly({ buttons: Buttons.Crouch }).pos.y).toBeLessThan(4)
    expect(Math.abs(fly({}).pos.y - 5)).toBeLessThan(0.01)
  })

  it('passes through walls', () => {
    const state = createMoveState(vec3(0, 1, 0))
    state.noclip = true
    const world = makeWorld({ wallX: 2 }) // wall at x=2
    for (let i = 0; i < 90; i++)
      stepMovement(state, { moveX: 1, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }, P, world, DT)
    expect(state.pos.x).toBeGreaterThan(3)
  })
})
