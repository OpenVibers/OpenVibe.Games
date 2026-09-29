import {
  quat,
  vec3,
  v3copy,
  v3dot,
  v3lengthSq,
  v3scale,
  v3set,
  type Quat,
  type Vec3,
} from '@openvibe/shared'
import {
  CollisionLayer,
  type BodyDesc,
  type BodyId,
  type ConstraintDesc,
  type ConstraintId,
  type ConstraintMotor,
  type MotionType,
  type PhysicsWorld,
  type RayHit,
  type SweepHit,
} from './types.js'

/**
 * Deterministic, wasm-free PhysicsWorld for tests and for any consumer that
 * needs a collision oracle without an engine (ADR-0007 decision 2: the seam
 * must be testable without wasm, and the engine swap must be "tested, not
 * assumed").
 *
 * It is deliberately NOT a miniature physics engine:
 *
 * - **Analytic ground plane.** `addGroundPlane()` installs an infinite plane
 *   y = 0 — the terrain the server builds — and capsule sweeps and rays resolve
 *   against it exactly. `addCast()` adds further analytic surfaces (a wall, a
 *   ceiling, a step) that only casts see; that is the scripted cast table.
 * - **Boxes, not rigid bodies.** Every shape is reduced to a world-axis-aligned
 *   bounding box that never rotates, and nothing stacks. A body falls, lands and
 *   rests; it does not push, roll, bounce off or topple anything.
 * - **Weld is real**, because it is the one constraint the prop-island and
 *   settle bookkeeping depend on: members of a weld group move as one.
 *   Rope, hinge, slider and spring keep live handles but exert no force.
 *
 * Everything is f64, iterated in insertion order, with no wall-clock time and
 * no hashing, so two runs of the same script are bit-identical. That is what
 * makes the mock usable as the movement determinism oracle.
 *
 * See conformance.test.ts ("what the mock deliberately does not model") for the
 * full list of gaps a real adapter must close.
 */

/** 30 Hz — the tick rate both the server and client prediction run at. */
export const MOCK_TICK = 1 / 30

export const MOCK_GRAVITY = -16.5
/** Must match the Havok adapter's settle thresholds (havokWorld.ts:72-73). */
export const MOCK_SETTLE_LINEAR = 0.05
export const MOCK_SETTLE_ANGULAR = 0.15
export const MOCK_DEFAULT_MASS_KG = 10
export const MOCK_MATERIAL = { friction: 0.75, staticFriction: 0.85, restitution: 0.05 } as const
export const MOCK_LINEAR_DAMPING = 0.05
export const MOCK_ANGULAR_DAMPING = 0.6

interface MockBody {
  id: BodyId
  desc: BodyDesc
  motion: MotionType
  pos: Vec3
  rot: Quat
  linVel: Vec3
  angVel: Vec3
  /** Forces accumulated since the last step (seam semantics: applyForce is a force, not an impulse). */
  force: Vec3
  torque: Vec3
  massKg: number
  /** Axis-aligned half extents; a capsule is bounded by radius in x/z and height/2 in y. */
  half: Vec3
  /** Weld bookkeeping: the rigid group this body follows, if any. */
  weld: WeldGroup | null
}

/** A rigid group of bodies linked by welds, with A as the driver. */
interface WeldGroup {
  driver: MockBody
  members: { body: MockBody; offset: Vec3 }[]
}

interface MockConstraint {
  id: ConstraintId
  desc: ConstraintDesc
  motor: ConstraintMotor | null
}

/** A castable analytic surface: { p : dot(n, p) = offset } clipped by an AABB patch. */
interface CastPlane {
  normal: Vec3
  offset: number
  patchMin: Vec3 | null
  patchMax: Vec3 | null
  /** Ground casts also stop bodies; a wall cast only stops casts. */
  isGround: boolean
}

function setQuat(out: Quat, q: Quat | undefined): void {
  if (q) {
    out.x = q.x
    out.y = q.y
    out.z = q.z
    out.w = q.w
  } else {
    out.x = 0
    out.y = 0
    out.z = 0
    out.w = 1
  }
}

/**
 * Half extents of a shape, axis-aligned about its centre. A capsule's radius
 * inflates x/z only; a trimesh collapses to its local bounds (the mock has no
 * triangle queries).
 */
function halfExtents(desc: BodyDesc): Vec3 {
  switch (desc.shape.type) {
    case 'box':
      return vec3(desc.shape.size[0] / 2, desc.shape.size[1] / 2, desc.shape.size[2] / 2)
    case 'sphere':
      return vec3(desc.shape.radius, desc.shape.radius, desc.shape.radius)
    case 'cylinder':
    case 'capsule':
      return vec3(desc.shape.radius, desc.shape.height / 2, desc.shape.radius)
    case 'trimesh': {
      const { positions } = desc.shape
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      for (let i = 0; i + 2 < positions.length; i += 3) {
        if (positions[i]! < minX) minX = positions[i]!
        if (positions[i]! > maxX) maxX = positions[i]!
        if (positions[i + 1]! < minY) minY = positions[i + 1]!
        if (positions[i + 1]! > maxY) maxY = positions[i + 1]!
        if (positions[i + 2]! < minZ) minZ = positions[i + 2]!
        if (positions[i + 2]! > maxZ) maxZ = positions[i + 2]!
      }
      if (!Number.isFinite(minX)) return vec3()
      return vec3((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2)
    }
  }
}

export class MockPhysicsWorld implements PhysicsWorld {
  private nextId: BodyId = 1
  private nextConstraintId: ConstraintId = 1
  /** Insertion-ordered on purpose: determinism, not lookup speed. */
  private readonly bodies = new Map<BodyId, MockBody>()
  private readonly constraints = new Map<ConstraintId, MockConstraint>()
  private readonly casts: CastPlane[] = []
  private disposed = false

  step(dt: number): void {
    this.assertLive()
    for (const body of this.bodies.values()) {
      if (body.motion !== 'dynamic') continue
      const invMass = 1 / Math.max(body.massKg, 1e-6)
      body.linVel.x += body.force.x * invMass * dt
      body.linVel.y += MOCK_GRAVITY * dt + body.force.y * invMass * dt
      body.linVel.z += body.force.z * invMass * dt
      v3set(body.force, 0, 0, 0)
      body.angVel.x += body.torque.x * invMass * dt
      body.angVel.y += body.torque.y * invMass * dt
      body.angVel.z += body.torque.z * invMass * dt
      v3set(body.torque, 0, 0, 0)
      v3scale(body.linVel, body.linVel, Math.max(0, 1 - MOCK_LINEAR_DAMPING * dt))
      v3scale(body.angVel, body.angVel, Math.max(0, 1 - MOCK_ANGULAR_DAMPING * dt))
      body.pos.x += body.linVel.x * dt
      body.pos.y += body.linVel.y * dt
      body.pos.z += body.linVel.z * dt
    }
    this.resolveContacts()
    this.poseWeldGroups()
  }

  addBody(desc: BodyDesc): BodyId {
    this.assertLive()
    const id = this.nextId++
    const body: MockBody = {
      id,
      desc,
      motion: desc.motion,
      pos: vec3(desc.pos.x, desc.pos.y, desc.pos.z),
      rot: quat(),
      linVel: vec3(),
      angVel: vec3(),
      force: vec3(),
      torque: vec3(),
      massKg: desc.massKg ?? MOCK_DEFAULT_MASS_KG,
      half: halfExtents(desc),
      weld: null,
    }
    setQuat(body.rot, desc.rot)
    this.bodies.set(id, body)
    return id
  }

  removeBody(id: BodyId): void {
    const body = this.bodies.get(id)
    if (!body) return
    this.bodies.delete(id)
    // Any group this body belonged to loses it; a group left with no members is
    // dropped, so the survivors become independent again.
    for (const other of this.bodies.values()) {
      const group = other.weld
      if (!group) continue
      if (group.driver === body) other.weld = null
      else group.members = group.members.filter((m) => m.body !== body)
    }
  }

  getTransform(id: BodyId, outPos: Vec3, outRot: Quat): void {
    const body = this.mustGet(id)
    v3copy(outPos, body.pos)
    setQuat(outRot, body.rot)
  }

  setTransform(id: BodyId, pos: Vec3, rot?: Quat): void {
    const body = this.mustGet(id)
    const group = body.weld
    if (group) {
      // Moving any member moves the whole island rigidly, exactly as a weld does.
      const dx = pos.x - body.pos.x
      const dy = pos.y - body.pos.y
      const dz = pos.z - body.pos.z
      v3set(
        group.driver.pos,
        group.driver.pos.x + dx,
        group.driver.pos.y + dy,
        group.driver.pos.z + dz,
      )
      this.poseWeldGroups()
    }
    if (!group) v3copy(body.pos, pos)
    if (rot) setQuat(body.rot, rot)
  }

  setMotionType(id: BodyId, motion: MotionType): void {
    const body = this.mustGet(id)
    if (body.motion === motion) return
    body.motion = motion
    if (motion !== 'dynamic') {
      // Matches the Havok adapter: freezing a body drops its motion.
      v3set(body.linVel, 0, 0, 0)
      v3set(body.angVel, 0, 0, 0)
      v3set(body.force, 0, 0, 0)
      v3set(body.torque, 0, 0, 0)
    }
  }

  getLinearVelocity(id: BodyId, out: Vec3): void {
    v3copy(out, this.mustGet(id).linVel)
  }

  setLinearVelocity(id: BodyId, v: Vec3): void {
    v3copy(this.mustGet(id).linVel, v)
  }

  getAngularVelocity(id: BodyId, out: Vec3): void {
    v3copy(out, this.mustGet(id).angVel)
  }

  setAngularVelocity(id: BodyId, v: Vec3): void {
    v3copy(this.mustGet(id).angVel, v)
  }

  isSettled(id: BodyId): boolean {
    const body = this.mustGet(id)
    if (body.motion !== 'dynamic') return true
    if (v3lengthSq(body.linVel) > MOCK_SETTLE_LINEAR * MOCK_SETTLE_LINEAR) return false
    return v3lengthSq(body.angVel) <= MOCK_SETTLE_ANGULAR * MOCK_SETTLE_ANGULAR
  }

  wake(id: BodyId): void {
    // Dynamic-only, exactly like the Havok adapter. Waking is not an impulse,
    // so there is deliberately nothing to do.
    const body = this.mustGet(id)
    if (body.motion !== 'dynamic') return
  }

  addConstraint(desc: ConstraintDesc): ConstraintId {
    this.assertLive()
    const a = this.mustGet(desc.bodyA)
    const b = this.mustGet(desc.bodyB)
    const id = this.nextConstraintId++
    const motor = desc.type === 'hinge' || desc.type === 'slider' ? (desc.motor ?? null) : null
    this.constraints.set(id, { id, desc, motor })
    if (desc.type === 'weld') {
      // Weld preserves the creation-time relative pose: every member becomes a
      // rigid follower of A at the offset it had when the joint was made.
      const group: WeldGroup = {
        driver: a,
        members: [
          { body: b, offset: vec3(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z) },
        ],
      }
      b.weld = group
    }
    return id
  }

  removeConstraint(id: ConstraintId): void {
    const rec = this.constraints.get(id)
    if (!rec) return
    this.constraints.delete(id)
    if (rec.desc.type === 'weld') {
      const body = this.bodies.get(rec.desc.bodyB)
      if (body?.weld) body.weld = null
    }
  }

  setConstraintMotor(id: ConstraintId, motor: ConstraintMotor): void {
    const rec = this.constraints.get(id)
    if (!rec) return
    if (rec.desc.type !== 'hinge' && rec.desc.type !== 'slider') return
    rec.motor = { targetVelocity: motor.targetVelocity, maxForce: motor.maxForce }
  }

  /** The motor currently configured on a hinge/slider, or null. Test introspection. */
  getConstraintMotor(id: ConstraintId): ConstraintMotor | null {
    return this.constraints.get(id)?.motor ?? null
  }

  applyForce(id: BodyId, force: Vec3): void {
    const body = this.mustGet(id)
    if (body.motion !== 'dynamic') return
    body.force.x += force.x
    body.force.y += force.y
    body.force.z += force.z
  }

  raycast(from: Vec3, to: Vec3, collidesWith: number): RayHit | null {
    this.assertLive()
    const d = vec3(to.x - from.x, to.y - from.y, to.z - from.z)
    const length = Math.sqrt(v3lengthSq(d))
    let best: RayHit | null = null
    for (const body of this.bodies.values()) {
      if (!(body.desc.layer & collidesWith)) continue
      const hit = rayAabb(from, d, length, body.pos, body.half)
      if (!hit) continue
      if (!best || hit.fraction < best.fraction) {
        best = { bodyId: body.id, point: hit.point, normal: hit.normal, fraction: hit.fraction }
      }
    }
    for (const plane of this.casts) {
      const hit = rayPlane(from, d, length, plane)
      if (!hit) continue
      if (best && best.fraction <= hit.fraction) continue
      best = {
        bodyId: MOCK_CAST_BODY_ID,
        point: hit.point,
        normal: hit.normal,
        fraction: hit.fraction,
      }
    }
    return best
  }

  sweepCapsule(
    from: Vec3,
    to: Vec3,
    radius: number,
    height: number,
    collidesWith: number,
    exclude?: BodyId,
  ): SweepHit | null {
    this.assertLive()
    const d = vec3(to.x - from.x, to.y - from.y, to.z - from.z)
    // `height` is the capsule's TOTAL height including both caps (types.ts:170),
    // so the cylindrical segment runs height/2 - radius either side of centre —
    // the same conversion HavokWorld.getSweepShape makes (havokWorld.ts:533).
    const half = Math.max(height / 2 - radius, 0.01)
    let best: SweepHit | null = null
    const consider = (fraction: number, normal: Vec3, point: Vec3): void => {
      if (fraction < -1e-9 || fraction > 1 + 1e-9) return
      const f = Math.min(Math.max(fraction, 0), 1)
      if (best && f >= best.fraction) return
      best = { fraction: f, normal: vec3(normal.x, normal.y, normal.z), point }
    }
    for (const body of this.bodies.values()) {
      if (body.id === exclude) continue
      if (!(body.desc.layer & collidesWith)) continue
      const hit = sweepCapsuleAabb(from, d, radius, half, body.pos, body.half)
      if (hit) consider(hit.fraction, hit.normal, hit.point)
    }
    for (const plane of this.casts) {
      const hit = sweepCapsulePlane(from, d, radius, half, plane)
      if (hit) consider(hit.fraction, hit.normal, hit.point)
    }
    return best
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bodies.clear()
    this.constraints.clear()
    this.casts.length = 0
  }

  // ── mock-only construction ──────────────────────────────────────────────

  /**
   * Infinite analytic ground plane with its top face at `y`. Capsule sweeps
   * and rays resolve against it exactly, and dynamic bodies rest on it. This
   * is the surface the movement tests walk on.
   */
  addGroundPlane(y = 0): void {
    this.addCast({ normal: vec3(0, 1, 0), offset: y })
  }

  /**
   * Marks the most recent cast as ground: casts so marked also stop bodies
   * (`groundHeightAt`) instead of only stopping casts.
   */
  markLastCastAsGround(): void {
    const plane = this.casts[this.casts.length - 1]
    if (plane) plane.isGround = true
  }

  /**
   * An analytic surface only rays and capsule sweeps see: an infinite plane,
   * unit normal `normal`, at signed distance `offset`, clipped to an optional
   * axis-aligned patch. This is how a test declares a wall, a ceiling or a step
   * without inventing geometry the mock would then have to simulate.
   */
  addCast(plane: {
    normal: Vec3
    offset: number
    minX?: number
    maxX?: number
    minY?: number
    maxY?: number
    minZ?: number
    maxZ?: number
  }): void {
    const len = Math.sqrt(v3lengthSq(plane.normal))
    const normal = vec3(plane.normal.x, plane.normal.y, plane.normal.z)
    if (len > 1e-9) v3scale(normal, normal, 1 / len)
    const patched =
      plane.minX !== undefined ||
      plane.maxX !== undefined ||
      plane.minY !== undefined ||
      plane.maxY !== undefined ||
      plane.minZ !== undefined ||
      plane.maxZ !== undefined
    this.casts.push({
      normal,
      offset: plane.offset / (len > 1e-9 ? len : 1),
      patchMin: patched
        ? vec3(plane.minX ?? -Infinity, plane.minY ?? -Infinity, plane.minZ ?? -Infinity)
        : null,
      patchMax: patched
        ? vec3(plane.maxX ?? Infinity, plane.maxY ?? Infinity, plane.maxZ ?? Infinity)
        : null,
      isGround: false,
    })
  }

  /** Number of cast surfaces currently installed. Test introspection. */
  castCount(): number {
    return this.casts.length
  }

  /**
   * The highest non-dynamic surface under (x, z): any analytic up-facing cast
   * plane whose patch covers the column, else the top face of the tallest
   * static/kinematic body whose footprint covers it, else -Infinity.
   */
  groundHeightAt(x: number, z: number): number {
    let floor = -Infinity
    for (const plane of this.casts) {
      if (!plane.isGround) continue
      if (Math.abs(plane.normal.y - 1) > 1e-6) continue
      const { patchMin: lo, patchMax: hi } = plane
      if (lo && hi && (x < lo.x || x > hi.x || z < lo.z || z > hi.z)) continue
      if (plane.offset > floor) floor = plane.offset
    }
    for (const other of this.bodies.values()) {
      if (other.motion === 'dynamic') continue
      if (Math.abs(other.pos.x - x) > other.half.x) continue
      if (Math.abs(other.pos.z - z) > other.half.z) continue
      const top = other.pos.y + other.half.y
      if (top > floor) floor = top
    }
    return floor
  }

  // ── internals ───────────────────────────────────────────────────────────

  private assertLive(): void {
    if (this.disposed) throw new Error('physics world disposed')
  }

  private mustGet(id: BodyId): MockBody {
    const body = this.bodies.get(id)
    if (!body) throw new Error(`unknown physics body ${id}`)
    return body
  }

  /** Places every welded follower at its group's driver pose plus its offset. */
  private poseWeldGroups(): void {
    const seen = new Set<WeldGroup>()
    for (const body of this.bodies.values()) {
      const group = body.weld
      if (!group || seen.has(group)) continue
      seen.add(group)
      for (const member of group.members) {
        member.body.pos.x = group.driver.pos.x + member.offset.x
        member.body.pos.y = group.driver.pos.y + member.offset.y
        member.body.pos.z = group.driver.pos.z + member.offset.z
      }
    }
  }

  /**
   * Resting contact against the analytic ground plane and the top face of any
   * non-dynamic body. The mock has no contact solver: friction is modelled as
   * "stop" and restitution (0.05) as "no bounce", which is all a body resting
   * on a plane can observably do here.
   */
  private resolveContacts(): void {
    for (const body of this.bodies.values()) {
      if (body.motion !== 'dynamic') continue
      const floor = this.groundHeightAt(body.pos.x, body.pos.z)
      if (!Number.isFinite(floor)) continue
      const bottom = body.pos.y - body.half.y
      if (bottom >= floor - 1e-9) continue
      body.pos.y = floor + body.half.y
      v3set(body.linVel, 0, 0, 0)
      v3set(body.angVel, 0, 0, 0)
    }
    this.poseWeldGroups()
  }
}

/**
 * `BodyId` reported for a hit on the analytic cast table. Cast surfaces are not
 * bodies, so they share one reserved id; tests that care which surface was hit
 * should use a box instead.
 */
export const MOCK_CAST_BODY_ID: BodyId = 0

/** A fresh, empty mock world. */
export function createMockPhysicsWorld(): MockPhysicsWorld {
  return new MockPhysicsWorld()
}

/**
 * Binds a mock world to the movement module's `CollisionQueries` with the same
 * fixed mask and self-exclusion the server uses
 * (apps/server/src/game/systems/movement.ts:58-68).
 */
export function mockCollisionQueries(
  world: MockPhysicsWorld,
  collidesWith: number = CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
  exclude?: () => number | undefined,
): { sweepCapsule(from: Vec3, to: Vec3, radius: number, height: number): SweepHit | null } {
  return {
    sweepCapsule: (from, to, radius, height) =>
      world.sweepCapsule(from, to, radius, height, collidesWith, exclude?.()),
  }
}

// ── analytic primitives ──────────────────────────────────────────────────

/**
 * Slab test of a ray against an AABB. `d` is the whole segment, so the
 * parameter is already the 0..1 fraction the seam wants.
 */
function rayAabb(
  from: Vec3,
  d: Vec3,
  _length: number,
  center: Vec3,
  half: Vec3,
): { point: Vec3; normal: Vec3; fraction: number } | null {
  const o = [from.x, from.y, from.z]
  const dd = [d.x, d.y, d.z]
  const c = [center.x, center.y, center.z]
  const h = [half.x, half.y, half.z]
  let tMin = -Infinity
  let tMax = Infinity
  let axis = 0
  let sign = -1
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dd[a]!) < 1e-12) {
      if (o[a]! < c[a]! - h[a]! || o[a]! > c[a]! + h[a]!) return null
      continue
    }
    const inv = 1 / dd[a]!
    let t1 = (c[a]! - h[a]! - o[a]!) * inv
    let t2 = (c[a]! + h[a]! - o[a]!) * inv
    let s = -1
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
      s = 1
    }
    if (t1 > tMin) {
      tMin = t1
      axis = a
      sign = s
    }
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return null
  }
  // The origin is already inside the box: nothing to report as a surface hit.
  if (tMin <= 0 || tMin > 1) return null
  const normal = vec3(0, 0, 0)
  if (axis === 0) normal.x = sign
  else if (axis === 1) normal.y = sign
  else normal.z = sign
  return {
    point: vec3(from.x + d.x * tMin, from.y + d.y * tMin, from.z + d.z * tMin),
    normal,
    fraction: tMin,
  }
}

function rayPlane(
  from: Vec3,
  d: Vec3,
  _length: number,
  plane: CastPlane,
): { point: Vec3; normal: Vec3; fraction: number } | null {
  const denom = v3dot(plane.normal, d)
  if (Math.abs(denom) < 1e-12) return null
  const t = (plane.offset - v3dot(plane.normal, from)) / denom
  if (t <= 0 || t > 1) return null
  const point = vec3(from.x + d.x * t, from.y + d.y * t, from.z + d.z * t)
  if (!inPatch(plane, point)) return null
  // Surface normal always opposes the ray.
  const n = vec3(plane.normal.x, plane.normal.y, plane.normal.z)
  if (denom > 0) v3scale(n, n, -1)
  return { point, normal: n, fraction: t }
}

/**
 * Sweeps a vertical capsule (centre segment of half-length `half`, radius
 * `radius`) against an AABB. The Minkowski sum of a vertical capsule and an
 * AABB is not an AABB, so this inflates the box by `radius` in x/z and by
 * `half + radius` in y: conservative at the corners, exact on every face. For
 * an axis-aligned world — all the mock models — that is the whole story.
 *
 * Havok reports the contact point on the *surface*, not at the capsule centre
 * (measured: a sweep onto ground at y = 0 returns y = 0 exactly), so the point
 * is walked back onto the inflated face along −normal.
 */
function sweepCapsuleAabb(
  from: Vec3,
  d: Vec3,
  radius: number,
  half: number,
  center: Vec3,
  boxHalf: Vec3,
): SweepHit | null {
  const lo = [
    center.x - boxHalf.x - radius,
    center.y - boxHalf.y - half - radius,
    center.z - boxHalf.z - radius,
  ]
  const hi = [
    center.x + boxHalf.x + radius,
    center.y + boxHalf.y + half + radius,
    center.z + boxHalf.z + radius,
  ]
  const o = [from.x, from.y, from.z]
  const dd = [d.x, d.y, d.z]
  let tMin = -Infinity
  let tMax = Infinity
  let axis = 0
  let sign = -1
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dd[a]!) < 1e-12) {
      if (o[a]! < lo[a]! || o[a]! > hi[a]!) return null
      continue
    }
    const inv = 1 / dd[a]!
    let t1 = (lo[a]! - o[a]!) * inv
    let t2 = (hi[a]! - o[a]!) * inv
    let s = -1
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
      s = 1
    }
    if (t1 > tMin) {
      tMin = t1
      axis = a
      sign = s
    }
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return null
  }
  // Already overlapping at t = 0: the capsule starts inside, which is not a
  // contact the caller can act on.
  if (tMin <= 0 || tMin > 1) return null
  const normal = vec3(0, 0, 0)
  if (axis === 0) normal.x = sign
  else if (axis === 1) normal.y = sign
  else normal.z = sign
  // Walk the centre back onto the true surface: distance is the capsule's
  // support along the normal, `radius` on the sides and `half + radius` on
  // the caps.
  const support = axis === 1 ? half + radius : radius
  const centre = vec3(from.x + d.x * tMin, from.y + d.y * tMin, from.z + d.z * tMin)
  const point = vec3(
    centre.x - normal.x * support,
    centre.y - normal.y * support,
    centre.z - normal.z * support,
  )
  return { fraction: tMin, normal, point }
}

/**
 * Sweeps a vertical capsule against an analytic plane. The support function of
 * a Y-axis capsule of half-length `half` and radius `radius` along a unit normal
 * n is `half·|n.y| + radius`, which is exact, so the contact is a single
 * closed-form division per side.
 *
 * The capsule is a closed convex set centred on the sweep line, so it can touch
 * the plane from either side: the earliest contact is min over s of
 * (s·support − signed) / (n·d). The ground plane is the common case (capsule
 * above it, s = +1); a wall or a ceiling declared with an outward normal is
 * approached from the opposite side, s = −1. Taking only one of the two misses
 * every wall and lets the sweep continue through it.
 *
 * A sweep that *starts* already overlapping the slab has no first contact to
 * report, exactly as in the AABB path above (tMin <= 0). This matters for a
 * short hull on a thick radius: STANCE_HULL[Prone] = 0.7 with a 0.4 radius
 * clamps the cylindrical segment to 0.02, so a prone capsule is 0.82 tall and
 * rests 0.06 into the floor. Reporting a hit there would block every upward
 * sweep, i.e. the player could never stand up.
 */
function sweepCapsulePlane(
  from: Vec3,
  d: Vec3,
  radius: number,
  half: number,
  plane: CastPlane,
): SweepHit | null {
  const denom = v3dot(plane.normal, d)
  if (Math.abs(denom) < 1e-12) return null
  const support = half * Math.abs(plane.normal.y) + radius
  const signed = v3dot(plane.normal, from) - plane.offset
  if (signed < support && signed > -support) return null
  let best = Infinity
  for (const side of [support, -support]) {
    const t = (side - signed) / denom
    if (t >= 0 && t <= 1 && t < best) best = t
  }
  if (best === Infinity) return null
  const centre = vec3(from.x + d.x * best, from.y + d.y * best, from.z + d.z * best)
  if (!inPatch(plane, centre)) return null
  // Surface normal always opposes the sweep.
  const normal = vec3(plane.normal.x, plane.normal.y, plane.normal.z)
  if (denom > 0) v3scale(normal, normal, -1)
  const point = vec3(
    centre.x - normal.x * support,
    centre.y - normal.y * support,
    centre.z - normal.z * support,
  )
  return { fraction: best, normal, point }
}

function inPatch(plane: CastPlane, point: Vec3): boolean {
  const { patchMin: lo, patchMax: hi } = plane
  if (!lo || !hi) return true
  return (
    point.x >= lo.x &&
    point.x <= hi.x &&
    point.y >= lo.y &&
    point.y <= hi.y &&
    point.z >= lo.z &&
    point.z <= hi.z
  )
}
