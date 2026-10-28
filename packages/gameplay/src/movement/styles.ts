import { getMapOverride, type MovementStyle, type WorldDef } from '@openvibe/content'
import { DEFAULT_MOVEMENT, type MovementParams } from './params.js'

/**
 * CS:S surf tuning, converted from Source units into this engine's metres.
 *
 * Unit scale: Source is authored in hammer units where **1 unit = 1 inch =
 * 0.0254 m** (a 72-unit player is 1.8288 m tall). Converting every
 * velocity/length by 0.0254 keeps the map and the player the same physical
 * size as CS.
 *
 *   sv_gravity       800 u/s² × 0.0254 = 20.32 m/s²
 *   sv_maxvelocity  3500 u/s  × 0.0254 = 88.9 m/s
 *   air wish cap      30 u/s  × 0.0254 = 0.762 m/s
 *   walk speed       250 u/s  × 0.0254 = 6.35 m/s
 *   jump             301.993 u/s × 0.0254 = 7.6706 m/s
 *   stop speed        75 u/s  × 0.0254 = 1.905 m/s
 *   step height       18 u     × 0.0254 = 0.4572 m
 *   stand hull        72 u     × 0.0254 = 1.8288 m, radius 16 u = 0.4064 m
 *   duck hull         36 u     × 0.0254 = 0.9144 m
 *   eye (stand)       64 u     × 0.0254 = 1.6256 m above feet
 *   eye (duck)        28 u     × 0.0254 = 0.7112 m above feet
 *
 * The air cap is applied PER TICK, so the per-second gain is `cap × tickRate`
 * and that difference is intentional:
 *
 *   0.762 × 64  = 48.768 m/s² cap equivalent at 64 Hz
 *   0.762 × 100 = 76.20 m/s² cap equivalent at 100 Hz (native CS:S surf)
 *
 * There is no 64/30 scaling here: surf rooms simulate at 100 Hz, so the cap
 * is Source's own 0.762. A 30 Hz room would need 1.6256 to preserve the
 * per-second rate, which is exactly why the old value was wrong once surf
 * moved off 30 Hz.
 *
 * `airAccel` is `sv_airaccelerate 150` unchanged: it is already a per-second
 * rate (the kernel multiplies it by dt), so it does not need a tick-rate
 * scale. At 100 Hz its term is 150 × 6.35 × (1/100) = 9.525 m/s per tick,
 * well above the 0.762 cap — the cap is what limits surf, exactly as in CS.
 * `sv_airaccelerate` only becomes visible when a very small wish speed makes
 * the rate term smaller than the cap.
 *
 * `groundNormalY` stays at 0.7 (cos 45.57°), CS's standable plane. Ride ramps
 * are authored at 50–60°, so cos(50°)=0.643 < 0.7 and the controller never
 * treats them as ground; the 45° edge stays exactly where CS puts it.
 *
 * Eye offsets are above the capsule CENTER: standing (1.6256 − 0.9144) = 0.7112,
 * ducking (0.7112 − 0.4572) = 0.254. Prone is not a Source stance; keep the
 * engine's existing low profile.
 */
export const SURF_MOVEMENT: MovementParams = {
  maxGroundSpeed: 6.35,
  // CS has no sprint; equalling the two makes Shift harmless.
  maxSprintSpeed: 6.35,
  groundAccel: 10,
  airAccel: 150,
  airSpeedCap: 0.762,
  friction: 4,
  stopSpeed: 1.905,
  gravity: 20.32,
  jumpSpeed: 7.6706,
  groundNormalY: 0.7,
  stepHeight: 0.4572,
  capsuleHeight: 1.8288,
  capsuleRadius: 0.4064,
  eyeOffset: 0.7112,
  stanceHull: [1.8288, 0.9144, 0.7],
  stanceEye: [0.7112, 0.254, 0.14],
  skin: 0.02,
  maxHorizontalSpeed: 88.9,
  autoBhop: false,
}

/** The one table both server and client resolve a content style through. */
export const MOVEMENT_STYLES: Readonly<Record<MovementStyle, MovementParams>> = {
  default: DEFAULT_MOVEMENT,
  surf: SURF_MOVEMENT,
}

/** Resolve a content style id; unknown ids are a content bug, so fail loudly. */
export function movementParamsFor(style: MovementStyle): MovementParams {
  const params = MOVEMENT_STYLES[style]
  if (!params) throw new Error(`unknown movement style: ${String(style)}`)
  return params
}

/**
 * The movement style in force for a world: the loaded map's choice overrides
 * the content world's. Both sides call this with their own (identical) map
 * override, so server simulation and client prediction resolve the same
 * params; the world's field is part of the content digest, so a client with a
 * different default is refused at the handshake.
 */
export function movementStyleFor(world: WorldDef): MovementStyle {
  return getMapOverride(world)?.movement ?? world.movement ?? 'default'
}
