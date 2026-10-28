import { describe, expect, it } from 'vitest'
import { movementCvarValues, movementParamsWithCvars, SURF_MOVEMENT } from './styles.js'

describe('Source cvars over movement params', () => {
  it('reads the surf preset back in Source units without float noise', () => {
    const values = movementCvarValues(SURF_MOVEMENT)
    expect(values.sv_gravity).toBe(800)
    expect(values.sv_airaccelerate).toBe(150)
    expect(values.sv_friction).toBe(4)
    expect(values.sv_jump_impulse).toBeCloseTo(301.992, 3)
    expect(values.sv_air_max_wishspeed).toBe(64)
  })

  it('applies only the supplied cvars and converts units exactly like Source', () => {
    const params = movementParamsWithCvars(SURF_MOVEMENT, {
      sv_gravity: 900,
      sv_airaccelerate: 100,
      sv_maxspeed: 500,
    })
    expect(params.gravity).toBeCloseTo(22.86, 9)
    expect(params.airAccel).toBe(100)
    expect(params.maxGroundSpeed).toBeCloseTo(12.7, 9)
    // CS has no sprint: raising the run cap raises the sprint cap too.
    expect(params.maxSprintSpeed).toBeCloseTo(12.7, 9)
    expect(params.friction).toBe(SURF_MOVEMENT.friction)
  })

  it('round-trips every movement cvar', () => {
    const values = movementCvarValues(SURF_MOVEMENT)
    const params = movementParamsWithCvars(SURF_MOVEMENT, values)
    for (const key of Object.keys(SURF_MOVEMENT) as (keyof typeof SURF_MOVEMENT)[]) {
      const value = SURF_MOVEMENT[key]
      if (typeof value === 'boolean') expect(params[key]).toBe(value)
      else expect(params[key] as number).toBeCloseTo(value, 6)
    }
  })
})
