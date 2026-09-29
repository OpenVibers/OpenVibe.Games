import type * as Rapier from '@dimforge/rapier3d-deterministic-compat'
import type { Quat, Vec3 } from '@openvibe/shared'
import type {
  BodyDesc,
  BodyId,
  ConstraintDesc,
  ConstraintId,
  ConstraintMotor,
  MotionType,
  PhysicsWorld,
  RayHit,
  ShapeDesc,
  SweepHit,
} from '../types.js'
import { CollisionLayer } from '../types.js'

/**
 * Rapier implementation of PhysicsWorld (ADR-0007 decision 2).
 *
 * The same adapter runs headless on the server and inside the client's rendered
 * scene — Rapier has no scene or engine indirection, so the two Havok factories
 * (a NullEngine scene and a scene-sharing world) collapse to one. Stepping is
 * manual and honours the dt it is given; there is no render-driven coupling.
 *
 * The module is injected rather than imported at runtime: the physics package
 * declares the deterministic `-compat` build, but the seam stays free of it in
 * type position only, so no wasm or engine code is reached through this file.
 */

/** The Rapier module surface the adapter drives. */
export type RapierModule = typeof Rapier

interface BodyRecord {
  body: Rapier.RigidBody
  collider: Rapier.Collider
  motion: MotionType
}

interface ConstraintRecord {
  joint: Rapier.ImpulseJoint
  type: ConstraintDesc['type']
}

/**
 * The unit-joint surface (revolute/prismatic) used to drive motors and limits.
 * Declared structurally so the adapter never has to name a class that differs
 * between the compat and non-compat builds.
 */
interface MotorJoint {
  setLimits(min: number, max: number): void
  configureMotorModel(model: number): void
  setMotorMaxForce(maxForce: number): void
  configureMotorVelocity(targetVelocity: number, factor: number): void
}

/** Grippy, dead-on-impact surfaces — the same material Havok used. */
export const RAPIER_FRICTION = 0.75
export const RAPIER_RESTITUTION = 0.05
export const RAPIER_LINEAR_DAMPING = 0.05
export const RAPIER_ANGULAR_DAMPING = 0.6
export const RAPIER_DEFAULT_MASS_KG = 10
export const RAPIER_GRAVITY = -16.5

const SETTLE_LIN_SQ = 0.05 * 0.05
const SETTLE_ANG_SQ = 0.15 * 0.15

const IDENTITY: Rapier.Rotation = { x: 0, y: 0, z: 0, w: 1 }

/** Rapier interaction groups: membership in the high 16 bits, filter in the low. */
function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff)
}

function motionType(R: RapierModule, motion: MotionType): Rapier.RigidBodyType {
  switch (motion) {
    case 'dynamic':
      return R.RigidBodyType.Dynamic
    case 'static':
      return R.RigidBodyType.Fixed
    case 'kinematic':
      return R.RigidBodyType.KinematicPositionBased
  }
}

function bodyDesc(R: RapierModule, desc: BodyDesc): Rapier.RigidBodyDesc {
  const rb =
    desc.motion === 'dynamic'
      ? R.RigidBodyDesc.dynamic()
      : desc.motion === 'static'
        ? R.RigidBodyDesc.fixed()
        : R.RigidBodyDesc.kinematicPositionBased()
  rb.setTranslation(desc.pos.x, desc.pos.y, desc.pos.z)
  if (desc.rot) rb.setRotation(desc.rot)
  if (desc.motion === 'dynamic') {
    rb.setLinearDamping(RAPIER_LINEAR_DAMPING)
    rb.setAngularDamping(RAPIER_ANGULAR_DAMPING)
  }
  return rb
}

function colliderDesc(R: RapierModule, shape: ShapeDesc): Rapier.ColliderDesc {
  switch (shape.type) {
    case 'box':
      return R.ColliderDesc.cuboid(shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2)
    case 'cylinder':
      return R.ColliderDesc.cylinder(shape.height / 2, shape.radius)
    case 'sphere':
      return R.ColliderDesc.ball(shape.radius)
    case 'capsule':
      // A Rapier capsule's local axis is +Y, as Havok's is; `height` is the
      // total height including caps, so the cylindrical segment is height/2 -
      // radius either side of centre.
      return R.ColliderDesc.capsule(Math.max(shape.height / 2 - shape.radius, 0.01), shape.radius)
    case 'trimesh':
      return R.ColliderDesc.trimesh(shape.positions, shape.indices)
  }
}

// ── small quaternion helpers for the joint frames ────────────────────────

function qConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

function qRotate(q: Quat, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y
  const iy = q.w * v.y + q.z * v.x - q.x * v.z
  const iz = q.w * v.z + q.x * v.y - q.y * v.x
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  }
}

export class RapierWorld implements PhysicsWorld {
  private nextId: BodyId = 1
  private nextConstraintId: ConstraintId = 1
  private readonly bodies = new Map<BodyId, BodyRecord>()
  private readonly constraints = new Map<ConstraintId, ConstraintRecord>()
  /** Rigid-body handle → seam id, for raycast hits. */
  private readonly bodyIds = new Map<number, BodyId>()
  private readonly sweepShapes = new Map<string, Rapier.Capsule>()
  private readonly forced = new Set<BodyId>()
  /**
   * Rapier builds its broad phase (which every scene query reads) inside
   * `World.step`; a collider added or moved since the last step is invisible to
   * `castRay`/`castShape` until then. The seam (and Havok) allowed querying a
   * freshly built world, so a stale query is served by one zero-dt step, which
   * updates the broad phase without advancing the simulation.
   */
  private broadPhaseStale = false
  private disposed = false

  private readonly world: Rapier.World

  constructor(private readonly R: RapierModule) {
    this.world = new R.World({ x: 0, y: RAPIER_GRAVITY, z: 0 })
  }

  step(dt: number): void {
    this.world.integrationParameters.dt = dt
    this.world.step()
    this.broadPhaseStale = false
    // Havok applied a force for exactly the step that followed it; Rapier keeps
    // user forces until they are reset, so clear the ones applied this tick.
    if (this.forced.size > 0) {
      for (const id of this.forced) this.bodies.get(id)?.body.resetForces(false)
      this.forced.clear()
    }
  }

  addBody(desc: BodyDesc): BodyId {
    const id = this.nextId++
    const body = this.world.createRigidBody(bodyDesc(this.R, desc))
    const cd = colliderDesc(this.R, desc.shape)
    cd.setCollisionGroups(groups(desc.layer, desc.collidesWith))
    cd.setFriction(RAPIER_FRICTION)
    cd.setRestitution(RAPIER_RESTITUTION)
    if (desc.motion === 'dynamic') cd.setMass(desc.massKg ?? RAPIER_DEFAULT_MASS_KG)
    const collider = this.world.createCollider(cd, body)

    this.bodies.set(id, { body, collider, motion: desc.motion })
    this.bodyIds.set(body.handle, id)
    this.broadPhaseStale = true
    return id
  }

  removeBody(id: BodyId): void {
    const rec = this.bodies.get(id)
    if (!rec) return
    this.bodyIds.delete(rec.body.handle)
    // Removes the body and its colliders and joints.
    this.world.removeRigidBody(rec.body)
    this.bodies.delete(id)
    this.forced.delete(id)
    this.broadPhaseStale = true
    for (const [cid, c] of this.constraints) {
      if (!c.joint.isValid()) this.constraints.delete(cid)
    }
  }

  getTransform(id: BodyId, outPos: Vec3, outRot: Quat): void {
    const p = this.mustGet(id).body.translation()
    outPos.x = p.x
    outPos.y = p.y
    outPos.z = p.z
    const q = this.mustGet(id).body.rotation()
    outRot.x = q.x
    outRot.y = q.y
    outRot.z = q.z
    outRot.w = q.w
  }

  setTransform(id: BodyId, pos: Vec3, rot?: Quat): void {
    const rec = this.mustGet(id)
    this.broadPhaseStale = true
    if (rec.motion === 'kinematic') {
      // A kinematic body chases the target with a computed velocity, so it
      // pushes dynamic bodies convincingly (Havok: setTargetTransform).
      rec.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z })
      if (rot) rec.body.setNextKinematicRotation(rot)
      return
    }
    rec.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true)
    if (rot) rec.body.setRotation(rot, true)
    rec.body.wakeUp()
  }

  setMotionType(id: BodyId, motion: MotionType): void {
    const rec = this.mustGet(id)
    if (rec.motion === motion) return
    rec.body.setBodyType(motionType(this.R, motion), true)
    rec.motion = motion
    this.broadPhaseStale = true
  }

  getLinearVelocity(id: BodyId, out: Vec3): void {
    const v = this.mustGet(id).body.linvel()
    out.x = v.x
    out.y = v.y
    out.z = v.z
  }

  setLinearVelocity(id: BodyId, v: Vec3): void {
    this.mustGet(id).body.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
  }

  getAngularVelocity(id: BodyId, out: Vec3): void {
    const v = this.mustGet(id).body.angvel()
    out.x = v.x
    out.y = v.y
    out.z = v.z
  }

  setAngularVelocity(id: BodyId, v: Vec3): void {
    this.mustGet(id).body.setAngvel({ x: v.x, y: v.y, z: v.z }, true)
  }

  isSettled(id: BodyId): boolean {
    const rec = this.mustGet(id)
    if (rec.motion !== 'dynamic') return true
    const v = rec.body.linvel()
    if (v.x * v.x + v.y * v.y + v.z * v.z > SETTLE_LIN_SQ) return false
    const w = rec.body.angvel()
    return w.x * w.x + w.y * w.y + w.z * w.z <= SETTLE_ANG_SQ
  }

  wake(id: BodyId): void {
    const rec = this.mustGet(id)
    if (rec.motion !== 'dynamic') return
    rec.body.wakeUp()
  }

  addConstraint(desc: ConstraintDesc): ConstraintId {
    const recA = this.mustGet(desc.bodyA)
    const recB = this.mustGet(desc.bodyB)
    const data = this.buildConstraint(desc, recA, recB)
    const joint = this.world.createImpulseJoint(data, recA.body, recB.body, true)
    if (desc.type === 'rope' || desc.type === 'spring') {
      joint.setContactsEnabled(desc.collision ?? true)
    } else {
      joint.setContactsEnabled(false)
    }
    if (desc.type === 'hinge' || desc.type === 'slider') {
      if (desc.limits) (joint as unknown as MotorJoint).setLimits(desc.limits.min, desc.limits.max)
      if (desc.motor) this.applyMotor(joint, desc.motor)
    }
    const id = this.nextConstraintId++
    this.constraints.set(id, { joint, type: desc.type })
    return id
  }

  private buildConstraint(
    desc: ConstraintDesc,
    recA: BodyRecord,
    recB: BodyRecord,
  ): Rapier.JointData {
    const R = this.R
    switch (desc.type) {
      case 'weld': {
        const pA = recA.body.translation()
        const pB = recB.body.translation()
        const rA = recA.body.rotation()
        const rB = recB.body.rotation()
        // Preserve the CURRENT relative pose: pivotA = B's origin in A's local
        // space; frameA = the rotation taking A's basis to B's.
        const rel = qMul(qConj(rA), rB)
        const pivot = qRotate(qConj(rA), { x: pB.x - pA.x, y: pB.y - pA.y, z: pB.z - pA.z })
        return R.JointData.fixed(pivot, rel, { x: 0, y: 0, z: 0 }, IDENTITY)
      }
      case 'rope':
        return R.JointData.rope(desc.length, desc.anchorA, desc.anchorB)
      case 'spring':
        return R.JointData.spring(
          desc.restLength,
          desc.stiffness,
          desc.damping,
          desc.anchorA,
          desc.anchorB,
        )
      case 'hinge':
        return R.JointData.revolute(desc.anchorA, desc.anchorB, normalize(desc.axisA))
      case 'slider':
        return R.JointData.prismatic(desc.anchorA, desc.anchorB, normalize(desc.axisA))
    }
  }

  /** Drives a revolute (hinge) or prismatic (slider) joint's motor along its free axis. */
  private applyMotor(joint: Rapier.ImpulseJoint, motor: ConstraintMotor): void {
    const j = joint as unknown as MotorJoint
    j.configureMotorModel(this.R.MotorModel.ForceBased)
    j.setMotorMaxForce(motor.maxForce)
    // A velocity target with a strong damping factor, capped by maxForce above.
    j.configureMotorVelocity(motor.targetVelocity, Math.max(motor.maxForce, 1))
  }

  setConstraintMotor(id: ConstraintId, motor: ConstraintMotor): void {
    const rec = this.constraints.get(id)
    if (!rec || (rec.type !== 'hinge' && rec.type !== 'slider')) return
    this.applyMotor(rec.joint, motor)
  }

  removeConstraint(id: ConstraintId): void {
    const rec = this.constraints.get(id)
    if (!rec) return
    this.world.removeImpulseJoint(rec.joint, false)
    this.constraints.delete(id)
  }

  applyForce(id: BodyId, force: Vec3): void {
    const rec = this.mustGet(id)
    if (rec.motion !== 'dynamic') return
    rec.body.addForce({ x: force.x, y: force.y, z: force.z }, true)
    this.forced.add(id)
  }

  raycast(from: Vec3, to: Vec3, collidesWith: number): RayHit | null {
    this.ensureQueriesCurrent()
    const origin = { x: from.x, y: from.y, z: from.z }
    const dir = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
    const ray = new this.R.Ray(origin, dir)
    // The query's own membership is all-on; the filter is the caller's mask, so
    // a collider is hit exactly when its layer intersects the mask.
    const hit = this.world.castRayAndGetNormal(
      ray,
      1,
      true,
      undefined,
      groups(0xffff, collidesWith),
    )
    if (!hit) return null
    const parent = hit.collider.parent()
    if (!parent) return null
    const bodyId = this.bodyIds.get(parent.handle)
    if (bodyId === undefined) return null
    return {
      bodyId,
      point: {
        x: origin.x + dir.x * hit.timeOfImpact,
        y: origin.y + dir.y * hit.timeOfImpact,
        z: origin.z + dir.z * hit.timeOfImpact,
      },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      fraction: hit.timeOfImpact,
    }
  }

  sweepCapsule(
    from: Vec3,
    to: Vec3,
    radius: number,
    height: number,
    collidesWith: number,
    exclude?: BodyId,
  ): SweepHit | null {
    this.ensureQueriesCurrent()
    const shape = this.getSweepShape(radius, height)
    // A vertical capsule cast at a constant velocity, capped at one segment.
    const hit = this.world.castShape(
      { x: from.x, y: from.y, z: from.z },
      IDENTITY,
      { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z },
      shape,
      0,
      1,
      false,
      undefined,
      groups(CollisionLayer.Player, collidesWith),
      undefined,
      exclude === undefined ? undefined : this.bodies.get(exclude)?.body,
    )
    if (!hit) return null
    return {
      fraction: hit.time_of_impact,
      normal: { x: hit.normal1.x, y: hit.normal1.y, z: hit.normal1.z },
      point: { x: hit.witness1.x, y: hit.witness1.y, z: hit.witness1.z },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.constraints.clear()
    this.bodies.clear()
    this.bodyIds.clear()
    this.sweepShapes.clear()
    this.forced.clear()
    this.world.free()
  }

  private mustGet(id: BodyId): BodyRecord {
    const rec = this.bodies.get(id)
    if (!rec) throw new Error(`unknown physics body ${id}`)
    return rec
  }

  /** One zero-dt step to rebuild the broad phase when a query precedes a step. */
  private ensureQueriesCurrent(): void {
    if (!this.broadPhaseStale) return
    const dt = this.world.integrationParameters.dt
    this.world.integrationParameters.dt = 0
    this.world.step()
    this.world.integrationParameters.dt = dt
    this.broadPhaseStale = false
  }

  private getSweepShape(radius: number, height: number): Rapier.Capsule {
    const key = `${radius}:${height}`
    let shape = this.sweepShapes.get(key)
    if (!shape) {
      shape = new this.R.Capsule(Math.max(height / 2 - radius, 0.01), radius)
      this.sweepShapes.set(key, shape)
    }
    return shape
  }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (len < 1e-9) return { x: 1, y: 0, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** A fresh Rapier world. No scene, no engine: the same call on server and client. */
export function createRapierWorld(R: RapierModule): RapierWorld {
  return new RapierWorld(R)
}
