import { describe, expect, it } from 'vitest'
import {
  ANGLE_Q_MAX,
  ANGLE_Q_MIN,
  ANGLE_STEP,
  PITCH_Q_MAX,
  dequantiseAngle,
  quantiseAngle,
  wrapAngle,
} from './scalar.js'

describe('angle quantisation', () => {
  it('round-trips within half a step', () => {
    const angles = [
      0,
      0.1,
      -0.1,
      Math.PI / 2,
      -Math.PI / 2,
      3.0,
      -3.0,
      Math.PI,
      -Math.PI + 1e-6,
      100,
      -100,
    ]
    for (const a of angles) {
      const q = quantiseAngle(a)
      expect(Number.isInteger(q)).toBe(true)
      expect(q).toBeGreaterThanOrEqual(ANGLE_Q_MIN)
      expect(q).toBeLessThanOrEqual(ANGLE_Q_MAX)
      // Measured on the circle: the extremes -PI and PI-step are adjacent.
      const error = Math.abs(wrapAngle(dequantiseAngle(q) - a))
      expect(error).toBeLessThanOrEqual(ANGLE_STEP / 2 + 1e-12)
    }
  })

  it('keeps every angle inside the int16 range and pitch inside a quarter turn', () => {
    for (const a of [Math.PI, -Math.PI, 1e6, -1e6, 0.5]) {
      const q = quantiseAngle(a)
      expect(q).toBeGreaterThanOrEqual(ANGLE_Q_MIN)
      expect(q).toBeLessThanOrEqual(ANGLE_Q_MAX)
    }
    expect(quantiseAngle(Math.PI / 2)).toBe(PITCH_Q_MAX)
    expect(quantiseAngle(-Math.PI / 2)).toBe(-PITCH_Q_MAX)
  })
})
