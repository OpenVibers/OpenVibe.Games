export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export const DEG2RAD = Math.PI / 180
export const RAD2DEG = 180 / Math.PI

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  if (a <= -Math.PI) a += Math.PI * 2
  return a
}

/**
 * Absolute-angle quantisation for the wire: a signed 16-bit step per
 * 1/65536 of a turn. Both sides of the protocol share these so the client's
 * prediction and the server's simulation integrate the identical angles.
 */
export const ANGLE_STEPS_PER_TURN = 65536
export const ANGLE_STEP = (Math.PI * 2) / ANGLE_STEPS_PER_TURN
export const ANGLE_Q_MIN = -32768
export const ANGLE_Q_MAX = 32767
/** ±90° (a quarter turn) in quantised units — the pitch clamp. */
export const PITCH_Q_MAX = ANGLE_STEPS_PER_TURN / 4

/** Absolute angle -> nearest signed 16-bit step (wrapped to one turn). */
export function quantiseAngle(angle: number): number {
  const q = Math.round(wrapAngle(angle) / ANGLE_STEP)
  // Wrap the step into the int16 range: -PI and PI-step are the same circle,
  // so the nearest step to PI is -32768, not an out-of-range 32768.
  const half = ANGLE_STEPS_PER_TURN / 2
  return ((q + half) % ANGLE_STEPS_PER_TURN) - half
}

/** Signed 16-bit step -> absolute angle; error is at most half a step. */
export function dequantiseAngle(q: number): number {
  return q * ANGLE_STEP
}
