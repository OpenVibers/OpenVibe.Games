import { getMapOverride, type MovementStyle, type WorldDef } from '@openvibe/content'
import { SOURCE_MOVEMENT_CVARS, type CvarValue } from '@openvibe/shared'
import { DEFAULT_MOVEMENT, type MovementParams } from './params.js'

/**
 * CS:S surf tuning, converted from Source units into this engine's metres.
 *
 * Unit scale: Source is authored in hammer units where **1 unit = 1 inch =
 * 0.0254 m** (a 72-unit player is 1.8288 m, the same 1.8 m capsule this engine
 * uses). Converting every velocity/length by 0.0254 keeps the map and the
 * player the same physical size as CS.
 *
 *   sv_gravity       800 u/s² × 0.0254 = 20.32 m/s²
 *   sv_maxvelocity  3500 u/s  × 0.0254 = 88.9 m/s
 *   air wish cap      30 u/s  × 0.0254 = 0.762 m/s
 *   walk speed       250 u/s  × 0.0254 = 6.35 m/s
 *   jump             301.993 u/s × 0.0254 = 7.6706 m/s
 *   stop speed        80 u/s  × 0.0254 = 2.032 m/s
 *
 * The cap is applied PER TICK, so the per-second gain is `cap × tickRate`.
 * CS:S surf is played at 64 tick; this server keeps 30 Hz, so the cap is
 * scaled by 64/30 to preserve the per-second acceleration:
 *
 *   0.762 × 64 / 30 = 1.6256 m/s at 30 Hz
 *   1.6256 × 30      = 48.768 m/s²  (same as 0.762 × 64)
 *
 * `airAccel` is `sv_airaccelerate 150` unchanged: it is already a per-second
 * rate (the kernel multiplies it by dt), so it does not need a tick-rate
 * scale. At 30 Hz its term is 150 × 6.35 × (1/30) = 31.75 m/s per tick,
 * well above the 1.6256 cap — the cap is what limits surf, exactly as in CS.
 * `sv_airaccelerate` only becomes visible when a very small wish speed makes
 * the rate term smaller than the cap.
 *
 * `groundNormalY` stays at 0.7 (cos 45.57°), CS's standable plane. Ride ramps
 * are authored at 50–60°, so cos(50°)=0.643 < 0.7 and the controller never
 * treats them as ground; the 45° edge stays exactly where CS puts it.
 */
export const SURF_MOVEMENT: MovementParams = {
  maxGroundSpeed: 6.35,
  // CS has no sprint; equalling the two makes Shift harmless.
  maxSprintSpeed: 6.35,
  groundAccel: 10,
  airAccel: 150,
  airSpeedCap: 1.6256,
  friction: 4,
  stopSpeed: 2.032,
  gravity: 20.32,
  jumpSpeed: 7.6706,
  groundNormalY: 0.7,
  stepHeight: 0.45,
  capsuleHeight: 1.8,
  capsuleRadius: 0.4,
  eyeOffset: 0.65,
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

/**
 * The Source-unit values of a movement preset: what the console shows for
 * `sv_gravity`, `sv_airaccelerate` and friends. Integers are rounded so the
 * default 20.32 m/s² reads as 800, not 800.0000000000001.
 */
export function movementCvarValues(params: MovementParams): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  for (const spec of SOURCE_MOVEMENT_CVARS) {
    if (!spec.target) continue
    const value = params[spec.target as keyof MovementParams]
    if (typeof value === 'boolean') {
      out[spec.name] = value
    } else if (typeof value === 'number') {
      const converted = value / (spec.scale ?? 1)
      out[spec.name] =
        spec.type === 'integer' ? Math.round(converted) : Number(converted.toFixed(6))
    }
  }
  return out
}

/**
 * Overlay authoritative Source-unit cvars onto a movement preset. Both the
 * server simulation and the client's prediction call this with the same
 * values, so a cvar change cannot desynchronise them.
 */
export function movementParamsWithCvars(
  base: MovementParams,
  values: Readonly<Record<string, CvarValue>>,
): MovementParams {
  const next: { -readonly [K in keyof MovementParams]: MovementParams[K] } = { ...base }
  for (const spec of SOURCE_MOVEMENT_CVARS) {
    if (!spec.target) continue
    const value = values[spec.name]
    if (value === undefined) continue
    const target = spec.target as keyof MovementParams
    if (typeof value === 'boolean') {
      next[target] = value as never
      continue
    }
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) continue
    const converted = numeric * (spec.scale ?? 1)
    next[target] = converted as never
    // CS has no sprint key: sv_maxspeed is the one run speed, so Shift must
    // not clamp a raised limit back down on surf maps.
    if (spec.target === 'maxGroundSpeed') next.maxSprintSpeed = converted
  }
  return next
}
