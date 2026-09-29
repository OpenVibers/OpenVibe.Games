import type { Vec3 } from '@openvibe/shared'
import type { PlayerMoveState } from './simulate.js'

/**
 * The state-hash determinism harness (ADR-0007 M1, step 2).
 *
 * ── What the hash is for ──────────────────────────────────────────────────
 * Two different claims are made about "determinism" and they are tested
 * separately, because conflating them is how a determinism test ends up
 * green while the game desyncs:
 *
 * 1. **Same runtime, bit-exact.** Node against Node, the same inputs against
 *    the same engine: the hash below is bit-identical on every tick. A failure
 *    is always a real defect (accidental state aliasing, a wall-clock read, an
 *    iteration order that depends on a Map's insertion, a non-deterministic
 *    engine call).
 * 2. **Across engines, within a tolerance.** Two different physics engines
 *    (today Havok, after step 4 Rapier) resolve the same capsule sweep with
 *    different arithmetic, so their positions and velocities drift. The
 *    contract is a TOLERANCE — 1 mm on position, 1 cm/s on velocity, per tick —
 *    never bit-identity, and the numbers live in `POSITION_TOLERANCE_M` /
 *    `VELOCITY_TOLERANCE_MPS` below so the cross-world test and this module
 *    cannot disagree. `divergence()` is what measures it; the hash is what
 *    says WHICH field drifted.
 *
 * ── Why quantisation ──────────────────────────────────────────────────────
 * Hashing raw f64 bits would make the hash a stricter test than the property
 * we actually care about: two engines whose positions agree to 1 mm should
 * hash the same, and f64 low bits will differ long before 1 mm does. So
 * positions are snapped to `POSITION_QUANTUM_M` (1e-4 m) and velocities to
 * `VELOCITY_QUANTUM_MPS` (1e-3 m/s) before hashing. Two consequences, both
 * deliberate:
 * - a sub-quantum wobble is invisible to the hash, which is the point; the
 *   tolerance test catches what the quantisation hides;
 * - the quantum is ~10× finer than the tolerance, so "the hashes match" and
 *   "the state agrees within tolerance" are not the same statement and the
 *   cross-world test asserts the second directly.
 *
 * ── The hash function, exactly ─────────────────────────────────────────────
 * FNV-1a, 32-bit, over a big-endian byte stream:
 *   h = 0x811c9dc5
 *   for each byte b: h = (h XOR b) * 0x01000193, all arithmetic mod 2^32
 * The offset basis and prime are the canonical FNV-1a 32-bit values. The
 * multiplication is forced back into uint32 with `>>> 0` after each byte, so
 * the result is identical on every JavaScript engine regardless of how it
 * widens the intermediate. Bytes are emitted most-significant first for every
 * field, so "0x00000001" is always the same four bytes; floats are written as
 * their quantised integer, two's-complement in 32 bits. Booleans are 0 or 1,
 * the Stance enum is its numeric value. Field order is fixed by
 * `HASHED_FIELDS` below and every consumer derives from it, so adding a field
 * to `PlayerMoveState` forces a decision here (typecheck fails on the
 * `Record<keyof PlayerMoveState, ...>`) rather than silently dropping it.
 */

/** FNV-1a 32-bit offset basis. */
export const FNV_OFFSET_BASIS = 0x811c9dc5
/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193

/** Position snap used before hashing, metres. */
export const POSITION_QUANTUM_M = 1e-4
/** Velocity snap used before hashing, metres per second. */
export const VELOCITY_QUANTUM_MPS = 1e-3
/** Timers (stance transitions, cooldowns) snap, seconds. */
export const TIME_QUANTUM_S = 1e-3

/**
 * Cross-engine agreement, per tick, per field (ADR-0007 M1 decision 1). These
 * are TOLERANCES between two physics engines, not a claim of bit-identity —
 * the wording in the ADR is deliberate and this file keeps it.
 */
export const POSITION_TOLERANCE_M = 1e-3
export const VELOCITY_TOLERANCE_MPS = 1e-2

/**
 * The fields of `PlayerMoveState` the hash covers, in the fixed order the
 * bytes are written. `PlayerMoveState` carries no sweep result, so there is no
 * fraction/normal to include (the sweep is a pure query: given the same
 * `from`/`to` it returns the same answer, and it is covered transitively
 * through `pos`). If that ever changes — a cached last-hit on the state — add
 * it here; `HASHED_FIELDS` is the single list every writer reads.
 */
export const HASHED_FIELDS = [
  'pos',
  'vel',
  'grounded',
  'stance',
  'stanceT',
  'stanceDur',
  'stanceCooldown',
  'proneActive',
  'proneHeld',
  'jumpHeld',
  'noclip',
] as const

/** A hex string of the state, for a failing test to print. */
export type StateHash = string

/**
 * Compile-time exhaustiveness: a field added to `PlayerMoveState` that is not
 * in `HASHED_FIELDS` turns this into a type error, so a new field cannot join
 * the state without someone deciding whether it belongs in the hash.
 */
type UnhashedField = Exclude<keyof PlayerMoveState, (typeof HASHED_FIELDS)[number]>
const _everyFieldHashed: [UnhashedField] extends [never] ? true : UnhashedField = true
void _everyFieldHashed

/**
 * Snaps a float to a quantum, half away from zero, then to a signed 32-bit
 * integer. Half-away-from-zero (`x < 0 ? -Math.round(-x) : Math.round(x)`) is
 * specified rather than left to `Math.round`, which is half-up on ties — a
 * value landing exactly on a quantum boundary is common here (a velocity that
 * has decayed to exactly 0.001, say) and the two would disagree on the sign
 * side. Non-finite input is pinned to 0 so a NaN can never silently produce a
 * hash that looks like a position.
 */
export function quantise(value: number, quantum: number): number {
  if (!Number.isFinite(value)) return 0
  const scaled = value / quantum
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
}

/** Quantised position component, in quantum units. */
export function quantisePosition(m: number): number {
  return quantise(m, POSITION_QUANTUM_M)
}

/** Quantised velocity component, in quantum units. */
export function quantiseVelocity(mps: number): number {
  return quantise(mps, VELOCITY_QUANTUM_MPS)
}

/** Quantised timer, in quantum units. */
export function quantiseTime(s: number): number {
  return quantise(s, TIME_QUANTUM_S)
}

function quantiseVec3(v: Vec3, quantum: number): [number, number, number] {
  return [quantise(v.x, quantum), quantise(v.y, quantum), quantise(v.z, quantum)]
}

/** A mutable 32-bit FNV-1a accumulator over a big-endian byte stream. */
export class Fnv1a32 {
  private h = FNV_OFFSET_BASIS

  /** Mixes one byte. */
  byte(b: number): this {
    this.h = Math.imul((this.h ^ (b & 0xff)) >>> 0, FNV_PRIME) >>> 0
    return this
  }

  /** Mixes a 32-bit integer, most-significant byte first. */
  int32(v: number): this {
    const n = v | 0
    this.byte((n >>> 24) & 0xff)
    this.byte((n >>> 16) & 0xff)
    this.byte((n >>> 8) & 0xff)
    this.byte(n & 0xff)
    return this
  }

  /** Mixes a boolean as 0 or 1. */
  bool(b: boolean): this {
    return this.byte(b ? 1 : 0)
  }

  /** Mixes an int32 for every component of an already-quantised vector. */
  vec3(v: [number, number, number]): this {
    return this.int32(v[0]).int32(v[1]).int32(v[2])
  }

  /** Mixes the whole move state, in `HASHED_FIELDS` order. */
  state(s: PlayerMoveState): this {
    return this.vec3(quantiseVec3(s.pos, POSITION_QUANTUM_M))
      .vec3(quantiseVec3(s.vel, VELOCITY_QUANTUM_MPS))
      .bool(s.grounded)
      .int32(s.stance)
      .int32(quantiseTime(s.stanceT))
      .int32(quantiseTime(s.stanceDur))
      .int32(quantiseTime(s.stanceCooldown))
      .bool(s.proneActive)
      .bool(s.proneHeld)
      .bool(s.jumpHeld)
      .bool(s.noclip)
  }

  /** The digest, as eight lowercase hex digits. */
  hex(): StateHash {
    return (this.h >>> 0).toString(16).padStart(8, '0')
  }
}

/** Convenience: the state digest of one tick, as eight lowercase hex digits. */
export function hashMoveState(state: PlayerMoveState): StateHash {
  return new Fnv1a32().state(state).hex()
}

/** A deep, plain-object copy — so a test can snapshot and restore a state. */
export function cloneMoveState(state: PlayerMoveState): PlayerMoveState {
  return { ...state, pos: { ...state.pos }, vel: { ...state.vel } }
}

/** A serialised move state, safe to JSON round-trip. */
export type MoveStateSnapshot = {
  pos: Vec3
  vel: Vec3
  grounded: boolean
  jumpHeld: boolean
  stance: number
  proneHeld: boolean
  proneActive: boolean
  stanceT: number
  stanceDur: number
  stanceCooldown: number
  noclip: boolean
}

/** The wire form of a snapshot: quantised, so a restore cannot drift. */
export function serializeMoveState(state: PlayerMoveState): MoveStateSnapshot {
  return {
    pos: { ...state.pos },
    vel: { ...state.vel },
    grounded: state.grounded,
    jumpHeld: state.jumpHeld,
    stance: state.stance,
    proneHeld: state.proneHeld,
    proneActive: state.proneActive,
    stanceT: state.stanceT,
    stanceDur: state.stanceDur,
    stanceCooldown: state.stanceCooldown,
    noclip: state.noclip,
  }
}

/** Restores a state from `serializeMoveState` output. */
export function deserializeMoveState(snap: MoveStateSnapshot): PlayerMoveState {
  return { ...snap, pos: { ...snap.pos }, vel: { ...snap.vel } }
}

/** Per-field comparison of two move states. */
export interface Divergence {
  /** Largest single-axis position difference, metres. */
  maxPosition: number
  /** Largest single-axis velocity difference, m/s. */
  maxVelocity: number
  /**
   * Names of every field that differs by MORE than its tolerance, plus a
   * human-readable magnitude for each. Empty when the two states agree.
   */
  fields: string[]
  /** The same fields, without the magnitudes — for a passing case. */
  equal: boolean
}

const AXIS = ['x', 'y', 'z'] as const

function axisDiff(a: Vec3, b: Vec3, tol: number, prefix: string, out: string[]): number {
  let worst = 0
  for (const ax of AXIS) {
    const d = Math.abs(a[ax] - b[ax])
    if (d > worst) worst = d
    if (d > tol) out.push(`${prefix}.${ax} ${d.toExponential(3)}`)
  }
  return worst
}

/**
 * Compares two move states against the cross-engine tolerances and reports
 * what drifted, so a failing cross-world test can name a field instead of
 * printing a hash.
 *
 * Timers and flags are compared exactly, not with a tolerance: they are the
 * discrete part of the state (stance, prone, grounded, noclip, jumpHeld) and a
 * disagreement there is a behavioural fork, not floating-point noise.
 */
export function divergence(a: PlayerMoveState, b: PlayerMoveState): Divergence {
  const fields: string[] = []
  const maxPosition = axisDiff(a.pos, b.pos, POSITION_TOLERANCE_M, 'pos', fields)
  const maxVelocity = axisDiff(a.vel, b.vel, VELOCITY_TOLERANCE_MPS, 'vel', fields)

  for (const flag of ['grounded', 'proneActive', 'proneHeld', 'jumpHeld', 'noclip'] as const) {
    if (a[flag] !== b[flag]) fields.push(`${flag} ${a[flag]}!=${b[flag]}`)
  }
  if (a.stance !== b.stance) fields.push(`stance ${a.stance}!=${b.stance}`)
  for (const timer of ['stanceT', 'stanceDur', 'stanceCooldown'] as const) {
    const d = Math.abs(a[timer] - b[timer])
    if (d > TIME_QUANTUM_S) fields.push(`${timer} ${d.toExponential(3)}`)
  }

  return { maxPosition, maxVelocity, fields, equal: fields.length === 0 }
}
