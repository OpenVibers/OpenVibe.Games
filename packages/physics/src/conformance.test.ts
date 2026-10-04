import { readFile } from 'node:fs/promises'
import { quat, vec3, type Quat, type Vec3 } from '@openvibe/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  MOCK_GRAVITY,
  MOCK_SETTLE_ANGULAR,
  MOCK_SETTLE_LINEAR,
  MOCK_TICK,
  createMockPhysicsWorld,
} from './mock.js'
import { createRapierWorld, loadRapier, type RapierModule } from './rapier/index.js'
import { CollisionLayer, type BodyDesc, type PhysicsWorld } from './types.js'

/**
 * Seam conformance.
 *
 * Every case runs against whatever PhysicsWorld factory is handed to
 * `conformance()`. The real engine is Rapier (ADR-0007 decision 2); the mock is
 * the wasm-free oracle. Nothing in this file may reach around the seam: no
 * engine type, no assumption about internals beyond what `PhysicsWorld`
 * promises.
 *
 * ── Constants the adapters are built from ────────────────────────────────
 * - gravity (0, -16.5, 0)                  rapierWorld.ts RAPIER_GRAVITY
 * - material friction 0.75, restitution 0.05  rapierWorld.ts
 * - linear damping 0.05, angular 0.6          rapierWorld.ts
 * - default mass 10 kg                        rapierWorld.ts
 * - settle thresholds 0.05 m/s, 0.15 rad/s    (squared compare, angular `<=`)
 *
 * ── Behaviour asserted here that is NOT in the seam doc comment ──────────
 * The Rapier adapter sets these explicitly and this suite holds it to them:
 *
 * 1. **`step(dt)` honours its argument.** Rapier's integration parameters take
 *    the dt directly, so 30 steps of 1/30 and 60 steps of 1/60 are the same
 *    simulated second (the mock agrees; Havok did not, which is why the adapter
 *    exposes `stepSeconds` and the gravity cases convert through it).
 * 2. **Waking or settling a body at the exact threshold.** The code compares
 *    `len² > threshold²` for linear and `<=` for angular; this suite probes just
 *    under and just over each threshold and does not pin exact-boundary float
 *    behaviour.
 * 3. **Raycast filtering is by the target's own `layer`.** The query's
 *    membership is all-on and the filter is the caller's mask, so a body is hit
 *    exactly when `rayMask & body.layer`. The mock filters the same way.
 * 4. **A welded body resists velocity changes for a few steps.** `setLinearVelocity`
 *    on one half of a weld writes the velocity, but the joint's relative-pose
 *    preservation pulls the pair back over the next couple of steps. Asserted
 *    here as "the pair stays together", not as free sliding.
 * 5. **`isSettled`, `wake` and `applyForce` ignore non-dynamic bodies**, and
 *    `removeBody` / `removeConstraint` on an unknown id are silent no-ops while
 *    every other body accessor throws `unknown physics body <id>`.
 */

const DT = 1 / 30

interface Adapter {
  /** Name used in the describe block. */
  name: string
  /** Fresh world per case; the case disposes it. */
  create: () => PhysicsWorld
  /**
   * Cases the mock deliberately does not model. Listing a case here keeps it in
   * the file (visible, not forgotten) while marking it as Havok-only.
   */
  skip?: (title: string) => boolean
  /**
   * Real simulated seconds one `step()` advances. The mock honours the dt it is
   * given; the Havok plugin resolves a fixed 1/60 s of its own (see the header
   * note), so a case that wants "N seconds of gravity" must ask each adapter for
   * its own tick count rather than sharing one number.
   */
  stepSeconds: number
}

/** RapierWorld over the deterministic wasm build — the exact headless server code path. */
let rapier: RapierModule
beforeAll(async () => {
  rapier = await loadRapier()
}, 60_000)

const rapierAdapter: Adapter = {
  name: 'RapierWorld',
  create: () => createRapierWorld(rapier),
  // Rapier honours the dt passed to step(); 30 Hz is the tick the game runs at.
  stepSeconds: DT,
}

/**
 * Case titles the mock cannot model, as prefixes. Kept as data (not baked into
 * a lambda) so `it('every case the mock skips still runs somewhere')` can check
 * each one against the titles this file actually defines: an entry left behind
 * after a case is renamed or deleted silently skips nothing, which is how the
 * mock came to run a case its own header said it could not model.
 */
const MOCK_SKIP_PREFIXES: readonly string[] = [
  'step advances',
  'a welded island',
  'a welded pair resists',
  'a spring',
  'a rope',
  'a hinge',
  'a motorized hinge',
  'a slider',
  'angular damping is strong',
  'surface friction is high',
  'a body knocked off',
  'sweepCapsule offsetting',
]

/**
 * The mock world, with the same analytic surfaces the Havok cases build out of
 * static boxes. No ambient ground plane: several cases deliberately sweep a ray
 * or capsule through empty space or sideways past a wall, and a global plane
 * would hit first.
 */
const mockAdapter: Adapter = {
  name: 'MockPhysicsWorld',
  // No ambient ground plane: several cases deliberately sweep a ray or capsule
  // through empty space or sideways past a wall, and a global plane would hit
  // first. Cases that need ground add `groundDesc()` like the Havok ones.
  create: () => createMockPhysicsWorld(),
  // Semi-implicit Euler at the 30 Hz tick the game actually runs at.
  stepSeconds: MOCK_TICK,
  skip: (title) => MOCK_SKIP_PREFIXES.some((prefix) => title.startsWith(prefix)),
}

const pos = (): Vec3 => vec3()
const rot = (): Quat => quat()

/** Ground: a 200 m static box with its top face at y = 0. */
function groundDesc(size = 200): BodyDesc {
  return {
    shape: { type: 'box', size: [size, 1, size] },
    motion: 'static',
    pos: vec3(0, -0.5, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  }
}

function dynamicBoxDesc(at: Vec3, size = 0.7, massKg?: number): BodyDesc {
  return {
    shape: { type: 'box', size: [size, size, size] },
    motion: 'dynamic',
    pos: at,
    ...(massKg === undefined ? {} : { massKg }),
    layer: CollisionLayer.Prop,
    collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
  }
}

function stepFor(w: PhysicsWorld, ticks: number, dt = DT): void {
  for (let i = 0; i < ticks; i++) w.step(dt)
}

/**
 * Steps `seconds` worth of SIMULATED time. The two engines do not agree on how
 * long one step() is (header note 1), so a case that means "two seconds of
 * gravity" must convert through the adapter rather than share a tick count.
 */
function stepSecondsFor(a: Adapter, w: PhysicsWorld, seconds: number): void {
  stepFor(w, Math.round(seconds / a.stepSeconds))
}

/** A body at rest: dynamic, but its gravity contribution is neutralised. */
function addParkedBody(w: PhysicsWorld, at: Vec3, massKg = 10): number {
  const id = w.addBody(dynamicBoxDesc(at, 0.5, massKg))
  // Park it by freezing and unfreezing: the seam's documented freeze path.
  w.setMotionType(id, 'static')
  w.setMotionType(id, 'dynamic')
  return id
}

function conformance(a: Adapter): void {
  describe(`PhysicsWorld conformance: ${a.name}`, () => {
    const maybe = a.skip ?? (() => false)

    /** The world for one case; `close()` disposes it. */
    let world: PhysicsWorld | null = null
    const open = (): PhysicsWorld => {
      world = a.create()
      return world
    }
    const close = (): void => {
      world?.dispose()
      world = null
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    it('adds a body and returns a live id', () => {
      const w = open()
      const ground = w.addBody(groundDesc())
      const p = pos()
      w.getTransform(ground, p, rot())
      expect(p.y).toBeCloseTo(-0.5, 3)
      close()
    })

    it('hands out distinct ids for distinct bodies', () => {
      const w = open()
      expect(w.addBody(groundDesc())).not.toBe(w.addBody(dynamicBoxDesc(vec3(5, 10, 5))))
      close()
    })

    it('removeBody drops the body; removing it again is a silent no-op', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 5, 0)))
      w.removeBody(box)
      expect(() => w.removeBody(box)).not.toThrow()
      expect(() => w.getTransform(box, pos(), rot())).toThrow(/unknown physics body/)
      close()
    })

    it('every other body accessor throws on an unknown id', () => {
      const w = open()
      const ghost = 987_654
      expect(() => w.setTransform(ghost, vec3())).toThrow(/unknown physics body/)
      expect(() => w.setMotionType(ghost, 'static')).toThrow(/unknown physics body/)
      expect(() => w.getLinearVelocity(ghost, pos())).toThrow(/unknown physics body/)
      expect(() => w.setLinearVelocity(ghost, vec3())).toThrow(/unknown physics body/)
      expect(() => w.getAngularVelocity(ghost, pos())).toThrow(/unknown physics body/)
      expect(() => w.setAngularVelocity(ghost, vec3())).toThrow(/unknown physics body/)
      expect(() => w.isSettled(ghost)).toThrow(/unknown physics body/)
      expect(() => w.wake(ghost)).toThrow(/unknown physics body/)
      expect(() => w.applyForce(ghost, vec3(1, 0, 0))).toThrow(/unknown physics body/)
      close()
    })

    // ── transforms ──────────────────────────────────────────────────────────

    it('getTransform reports the transform the body was added with', () => {
      const w = open()
      const b = w.addBody({
        shape: { type: 'box', size: [1, 1, 1] },
        motion: 'static',
        pos: vec3(3, 2, -7),
        rot: quat(0, 1, 0, 0),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop,
      })
      const p = pos()
      const q = rot()
      w.getTransform(b, p, q)
      expect(p.x).toBeCloseTo(3, 5)
      expect(p.y).toBeCloseTo(2, 5)
      expect(p.z).toBeCloseTo(-7, 5)
      expect(q.y).toBeCloseTo(1, 5)
      expect(q.w).toBeCloseTo(0, 5)
      close()
    })

    it('a body added without a rotation reads back as identity', () => {
      const w = open()
      const q = rot()
      w.getTransform(w.addBody(groundDesc()), pos(), q)
      expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 })
      close()
    })

    it('setTransform teleports a STATIC body (remote-player mirror regression)', () => {
      const w = open()
      const mirror = w.addBody({
        shape: { type: 'capsule', radius: 0.4, height: 1.8 },
        motion: 'static',
        pos: vec3(0, 1, 0),
        layer: CollisionLayer.Player,
        collidesWith: CollisionLayer.Static | CollisionLayer.Prop,
      })
      // Havok needs the explicit TELEPORT prestep dance for this to land at
      // all (havokWorld.ts:179-185, marked CRITICAL); a regression here means
      // remote players silently stop being collidable.
      w.setTransform(mirror, vec3(9, 1, 4))
      const p = pos()
      w.getTransform(mirror, p, rot())
      expect(p.x).toBeCloseTo(9, 3)
      expect(p.y).toBeCloseTo(1, 3)
      expect(p.z).toBeCloseTo(4, 3)
      close()
    })

    it('setTransform teleports a DYNAMIC body', () => {
      const w = open()
      w.addBody(groundDesc())
      const box = w.addBody(dynamicBoxDesc(vec3(0, 10, 0)))
      w.setTransform(box, vec3(-5, 4, 0))
      const p = pos()
      w.getTransform(box, p, rot())
      expect(p.x).toBeCloseTo(-5, 3)
      expect(p.y).toBeCloseTo(4, 3)
      close()
    })

    it('setTransform on a kinematic body is adopted on the next step', () => {
      const w = open()
      const k = w.addBody({
        shape: { type: 'capsule', radius: 0.4, height: 1.8 },
        motion: 'kinematic',
        pos: vec3(0, 1, 0),
        layer: CollisionLayer.Player,
        collidesWith: 0,
      })
      w.setTransform(k, vec3(12, 1, 0))
      w.step(DT)
      const p = pos()
      w.getTransform(k, p, rot())
      expect(p.x).toBeGreaterThan(0.5)
      expect(p.x).toBeLessThanOrEqual(12.001)
      close()
    })

    it('setTransform also writes the rotation when one is given', () => {
      const w = open()
      const b = w.addBody(dynamicBoxDesc(vec3(0, 900, 0)))
      w.setTransform(b, vec3(0, 900, 0), quat(0, 0, 1, 0))
      const q = rot()
      w.getTransform(b, pos(), q)
      expect(q.z).toBeCloseTo(1, 3)
      expect(q.w).toBeCloseTo(0, 3)
      close()
    })

    // ── motion types ────────────────────────────────────────────────────────

    it('setMotionType freezes a dynamic body where it stands', () => {
      const w = open()
      w.addBody(groundDesc())
      const box = w.addBody(dynamicBoxDesc(vec3(0, 10, 0)))
      stepFor(w, 30)
      w.setMotionType(box, 'static')
      const frozen = pos()
      w.getTransform(box, frozen, rot())
      stepFor(w, 60)
      const after = pos()
      w.getTransform(box, after, rot())
      expect(after.y).toBeCloseTo(frozen.y, 1)
      close()
    })

    it('a body made dynamic again falls under gravity', () => {
      const w = open()
      w.addBody(groundDesc())
      const box = w.addBody(dynamicBoxDesc(vec3(0, 10, 0)))
      stepFor(w, 30)
      w.setMotionType(box, 'static')
      w.setMotionType(box, 'dynamic')
      const before = pos()
      w.getTransform(box, before, rot())
      stepFor(w, 20)
      const after = pos()
      w.getTransform(box, after, rot())
      expect(after.y).toBeLessThan(before.y - 0.5)
      close()
    })

    it('setMotionType to the type it already has is a no-op', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0)))
      w.setLinearVelocity(box, vec3(2, 0, 0))
      w.setMotionType(box, 'dynamic')
      const v = pos()
      w.getLinearVelocity(box, v)
      expect(v.x).toBeCloseTo(2, 3)
      close()
    })

    // ── velocities ──────────────────────────────────────────────────────────

    it('linear velocity round-trips', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0)))
      w.setLinearVelocity(box, vec3(6, 0, 0))
      const v = pos()
      w.getLinearVelocity(box, v)
      expect(v.x).toBeCloseTo(6, 5)
      expect(v.y).toBeCloseTo(0, 5)
      expect(v.z).toBeCloseTo(0, 5)
      close()
    })

    it('a body given a linear velocity travels that way when stepped', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0)))
      w.setLinearVelocity(box, vec3(6, 0, 0))
      stepFor(w, 10)
      const p = pos()
      w.getTransform(box, p, rot())
      expect(p.x).toBeGreaterThan(0.5)
      close()
    })

    it('angular velocity round-trips', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0)))
      w.setAngularVelocity(box, vec3(0, 2, 0))
      const v = pos()
      w.getAngularVelocity(box, v)
      expect(v.y).toBeCloseTo(2, 5)
      close()
    })

    it('writing zeros through the setters stops the body', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0)))
      w.setLinearVelocity(box, vec3(5, 0, 0))
      w.setAngularVelocity(box, vec3(1, 0, 0))
      w.setLinearVelocity(box, vec3(0, 0, 0))
      w.setAngularVelocity(box, vec3(0, 0, 0))
      const lv = pos()
      const av = pos()
      w.getLinearVelocity(box, lv)
      w.getAngularVelocity(box, av)
      expect(Math.hypot(lv.x, lv.y, lv.z)).toBeLessThan(0.01)
      expect(Math.hypot(av.x, av.y, av.z)).toBeLessThan(0.01)
      close()
    })

    // ── settle / wake ───────────────────────────────────────────────────────

    it('static and kinematic bodies are settled by definition', () => {
      const w = open()
      expect(w.isSettled(w.addBody(groundDesc()))).toBe(true)
      expect(
        w.isSettled(
          w.addBody({
            shape: { type: 'capsule', radius: 0.4, height: 1.8 },
            motion: 'kinematic',
            pos: vec3(0, 1, 0),
            layer: CollisionLayer.Player,
            collidesWith: 0,
          }),
        ),
      ).toBe(true)
      close()
    })

    it('wake does not change a parked body velocity', () => {
      const w = open()
      const box = addParkedBody(w, vec3(0, 900, 0))
      // Half the linear settle threshold: comfortably settled before and after,
      // so the assertion reads the adapter's threshold rather than a literal.
      // `toBeLessThanOrEqual` carries 1e-6 of slack because Havok stores velocity
      // in f32 and 0.025 does not round-trip exactly.
      const subThreshold = 0.025
      w.setLinearVelocity(box, vec3(subThreshold, 0, 0))
      expect(w.isSettled(box)).toBe(true)
      w.wake(box)
      const v = pos()
      w.getLinearVelocity(box, v)
      expect(Math.hypot(v.x, v.y, v.z)).toBeLessThanOrEqual(subThreshold + 1e-6)
      close()
    })

    it('wake on a non-dynamic body is a no-op, not a throw', () => {
      const w = open()
      const g = w.addBody(groundDesc())
      expect(() => w.wake(g)).not.toThrow()
      const p = pos()
      w.getTransform(g, p, rot())
      expect(p.y).toBeCloseTo(-0.5, 3)
      close()
    })

    // ── raycast ─────────────────────────────────────────────────────────────

    it('raycast returns the body, point, normal and a 0..1 fraction', () => {
      const w = open()
      const box = w.addBody(dynamicBoxDesc(vec3(0, 1, 0), 2, 10))
      w.addBody(groundDesc())
      stepFor(w, 30)
      const hit = w.raycast(vec3(5, 1, 0), vec3(-5, 1, 0), CollisionLayer.Prop)
      expect(hit).not.toBeNull()
      expect(hit?.bodyId).toBe(box)
      // The segment is 10 long and the near face is at x = 1 → 4 m travelled.
      expect(hit?.fraction).toBeCloseTo(0.4, 3)
      expect(hit?.point.x).toBeCloseTo(1, 2)
      expect(hit?.normal.x).toBeCloseTo(1, 2)
      close()
    })

    it('raycast filters by the body layer the mask names', () => {
      const w = open()
      w.addBody(dynamicBoxDesc(vec3(0, 1, 0), 2, 10))
      const along = (mask: number): number | null =>
        w.raycast(vec3(5, 1, 0), vec3(-5, 1, 0), mask)?.fraction ?? null
      expect(along(CollisionLayer.Prop)).not.toBeNull()
      expect(along(CollisionLayer.Static)).toBeNull()
      expect(along(CollisionLayer.Static | CollisionLayer.Prop)).not.toBeNull()
      close()
    })

    it('raycast misses cleanly when nothing is in the way', () => {
      const w = open()
      w.addBody(groundDesc())
      expect(w.raycast(vec3(0, 50, 0), vec3(0, 40, 0), CollisionLayer.Static)).toBeNull()
      close()
    })

    it('raycast takes the first hit along the segment', () => {
      const w = open()
      w.addBody(groundDesc())
      const near = w.addBody(dynamicBoxDesc(vec3(3, 1, 0), 1, 10))
      w.addBody(dynamicBoxDesc(vec3(-3, 1, 0), 1, 10))
      const hit = w.raycast(vec3(5, 1, 0), vec3(-5, 1, 0), CollisionLayer.Prop)
      expect(hit?.bodyId).toBe(near)
      close()
    })

    it.skipIf(maybe('raycast reports'))(
      'raycast reports the surface point, not the travelled point',
      () => {
        // Measured on Havok: a ray 10 long hitting a box whose near face is at
        // x = 1 reports fraction 0.4 with the point on that face. The mock's
        // slab test reports the same, so this is pinned on both.
        const w = open()
        w.addBody(groundDesc())
        w.addBody(dynamicBoxDesc(vec3(0, 1, 0), 2, 10))
        const hit = w.raycast(vec3(5, 1, 0), vec3(-5, 1, 0), CollisionLayer.Prop)
        expect(hit?.fraction).toBeCloseTo(0.4, 3)
        expect(hit?.point.x).toBeCloseTo(1, 3)
        expect(hit?.point.y).toBeCloseTo(1, 3)
        close()
      },
    )

    // ── capsule sweep ───────────────────────────────────────────────────────

    it('sweepCapsule returns an upward normal when landing on ground', () => {
      const w = open()
      w.addBody(groundDesc())
      const hit = w.sweepCapsule(
        vec3(0, 5, 0),
        vec3(0, -1, 0),
        0.4,
        1.8,
        CollisionLayer.Static | CollisionLayer.Prop,
      )
      expect(hit).not.toBeNull()
      expect(hit?.normal.y).toBeGreaterThan(0.9)
      // The capsule bottom starts at 4.1 and lands at 0: 4.1 of a 6 m sweep.
      expect(hit?.fraction).toBeGreaterThan(0.5)
      expect(hit?.fraction).toBeLessThan(1)
      expect(hit?.point.y).toBeCloseTo(0, 1)
      close()
    })

    it('sweepCapsule returns null when the path is clear', () => {
      const w = open()
      w.addBody(groundDesc())
      expect(
        w.sweepCapsule(vec3(0, 5, 0), vec3(0, 4, 0), 0.4, 1.8, CollisionLayer.Static),
      ).toBeNull()
      close()
    })

    it('sweepCapsule filters by the collision mask', () => {
      const w = open()
      w.addBody(dynamicBoxDesc(vec3(0, 1, 0), 2, 10))
      const sweep = (mask: number) => w.sweepCapsule(vec3(0, 5, 0), vec3(0, -1, 0), 0.4, 1.8, mask)
      expect(sweep(CollisionLayer.Static)).toBeNull()
      expect(sweep(CollisionLayer.Static | CollisionLayer.Prop)).not.toBeNull()
      close()
    })

    it('sweepCapsule skips the excluded body and hits another one', () => {
      const w = open()
      const self = w.addBody({
        shape: { type: 'capsule', radius: 0.4, height: 1.8 },
        motion: 'kinematic',
        pos: vec3(0, 1, 0),
        layer: CollisionLayer.Player,
        collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
      })
      w.addBody(dynamicBoxDesc(vec3(0, 1, 0), 2, 10))
      const mask = CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player
      expect(w.sweepCapsule(vec3(0, 5, 0), vec3(0, -1, 0), 0.4, 1.8, mask)).not.toBeNull()
      // The player's own kinematic capsule is on the Player layer and collides
      // with Player, so without the exclusion it would be the first hit.
      expect(w.sweepCapsule(vec3(0, 5, 0), vec3(0, -1, 0), 0.4, 1.8, mask, self)).not.toBeNull()
      close()
    })

    it('sweepCapsule fraction grows with the distance to the obstacle', () => {
      const w = open()
      w.addBody(groundDesc())
      const near = w.sweepCapsule(vec3(0, 3, 0), vec3(0, -1, 0), 0.4, 1.8, CollisionLayer.Static)
      const far = w.sweepCapsule(vec3(0, 5, 0), vec3(0, -1, 0), 0.4, 1.8, CollisionLayer.Static)
      expect(near).not.toBeNull()
      expect(far!.fraction).toBeGreaterThan(near!.fraction)
      close()
    })

    it('sweepCapsule reports a horizontal normal against a wall', () => {
      const w = open()
      w.addBody({
        shape: { type: 'box', size: [1, 4, 10] },
        motion: 'static',
        pos: vec3(2, 2, 0),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Player | CollisionLayer.Prop,
      })
      const hit = w.sweepCapsule(vec3(-3, 1, 0), vec3(3, 1, 0), 0.4, 1.8, CollisionLayer.Static)
      expect(hit).not.toBeNull()
      expect(Math.abs(hit!.normal.x)).toBeGreaterThan(0.9)
      expect(Math.abs(hit!.normal.y)).toBeLessThan(0.2)
      close()
    })

    it.skipIf(maybe('sweepCapsule offsetting'))(
      'sweepCapsule offsetting by the radius keeps a capsule out of a wall',
      () => {
        // Measured on Havok: a fat capsule and a thin one both report the
        // surface point x = 1.5 (the wall face), but the fat one stops 0.35 m
        // earlier along the sweep, because its centre is further from the face.
        const w = open()
        w.addBody({
          shape: { type: 'box', size: [1, 4, 10] },
          motion: 'static',
          pos: vec3(2, 2, 0),
          layer: CollisionLayer.Static,
          collidesWith: CollisionLayer.Player | CollisionLayer.Prop,
        })
        const fat = w.sweepCapsule(vec3(-3, 1, 0), vec3(3, 1, 0), 0.4, 1.8, CollisionLayer.Static)
        const thin = w.sweepCapsule(vec3(-3, 1, 0), vec3(3, 1, 0), 0.05, 1.8, CollisionLayer.Static)
        expect(fat).not.toBeNull()
        expect(thin).not.toBeNull()
        expect(fat!.point.x).toBeCloseTo(1.5, 2)
        expect(thin!.point.x).toBeCloseTo(1.5, 2)
        expect(fat!.fraction).toBeLessThan(thin!.fraction)
        close()
      },
    )

    // ── constraints ─────────────────────────────────────────────────────────

    it.skipIf(maybe('a weld holds'))(
      'a weld holds its pair in the creation-time relative pose',
      () => {
        const w = open()
        w.addBody(groundDesc())
        const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
        const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
        // Weld BEFORE the fall. Both boxes are the same size on the same floor,
        // so once they settle they sit side by side at the same height and the
        // creation-time offset would be zero — the mock has no contact solver
        // to stack them, and a fixture that depends on stacking only works on
        // an engine that has one. Welding while B is genuinely above A pins the
        // offset (0.5) that the rest of the case is about.
        const weld = w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
        stepFor(w, 30)
        const pa = pos()
        const pb = pos()
        const q = rot()
        w.getTransform(a, pa, q)
        w.getTransform(b, pb, q)
        const dy0 = pb.y - pa.y
        expect(dy0).toBeGreaterThan(0.3)
        expect(dy0).toBeLessThan(0.75)
        // Give the pair a shove and let it settle again: the offset must hold.
        w.setLinearVelocity(a, vec3(4, 0, 0))
        stepFor(w, 90)
        w.getTransform(a, pa, rot())
        w.getTransform(b, pb, rot())
        expect(Math.abs(pb.x - pa.x)).toBeLessThan(0.25)
        expect(pb.y - pa.y).toBeGreaterThan(0.3)
        expect(pb.y - pa.y).toBeLessThan(0.75)
        w.removeConstraint(weld)
        close()
      },
    )

    it.skipIf(maybe('a welded pair resists'))(
      'a welded pair resists a velocity change on one member',
      () => {
        // Havok pulls a welded pair back over a couple of steps rather than
        // letting one half run away: a 6 m/s kick on the upper box decays to
        // 1.6 m/s within five steps and the pair is back at its offset by 60.
        const w = open()
        w.addBody(groundDesc())
        const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
        const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
        w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
        stepFor(w, 60)
        const pb = pos()
        w.setLinearVelocity(b, vec3(0, 6, 0))
        stepFor(w, 5)
        w.getTransform(b, pb, rot())
        expect(pb.y).toBeLessThan(1.2)
        stepFor(w, 55)
        w.getTransform(b, pb, rot())
        expect(pb.y).toBeCloseTo(0.75, 1)
        close()
      },
    )

    it.skipIf(maybe('removing a weld'))('removing a weld is a live handle, not a throw', () => {
      // Havok: the two joints stay rigidly posed after removal, because a
      // weld adds no energy and a stacked pair is already at rest. Asserted as
      // "the pair is unchanged and nothing throws" — what the pair does next is
      // Havok's business, not the seam's.
      const w = open()
      w.addBody(groundDesc())
      const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
      const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
      const weld = w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
      stepFor(w, 60)
      const pa = pos()
      const pb = pos()
      w.getTransform(a, pa, rot())
      w.getTransform(b, pb, rot())
      expect(pa.y).toBeCloseTo(0.25, 2)
      expect(pb.y).toBeCloseTo(0.75, 2)
      w.removeConstraint(weld)
      expect(() => w.removeConstraint(weld)).not.toThrow()
      stepFor(w, 180)
      const p2 = pos()
      w.getTransform(a, p2, rot())
      expect(p2.y).toBeCloseTo(0.25, 2)
      close()
    })

    it.skipIf(maybe('a welded island'))(
      'a welded island stays rigid when a member is displaced',
      () => {
        // Measured on Havok: teleporting the follower of a weld drags the
        // island along it over the following steps rather than instantly.
        const w = open()
        w.addBody(groundDesc())
        const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
        const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
        w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
        stepFor(w, 60)
        const pa = pos()
        const pb = pos()
        // A purely lateral nudge: same height, so it neither buries the pair in
        // the ground nor drives the solver a huge positional error in one step.
        // Teleporting B far away (e.g. to x = 6, y = 2) drags the whole island
        // through the ground, and what comes back out is the solver untangling
        // that error, not the weld.
        w.setTransform(b, vec3(0, 0.75, 0.5))
        w.step(DT)
        w.getTransform(a, pa, rot())
        w.getTransform(b, pb, rot())
        // The weld pulled B back toward A's pose rather than leaving it where it
        // was dropped, and A began to follow B instead of staying put.
        expect(pb.z).toBeLessThan(0.5)
        expect(pa.z).toBeGreaterThan(0)
        // "Stays rigid" is the claim worth pinning. Measured on Havok, the
        // island does not snap back within one step — it keeps sliding for a
        // while — but it never tears: after settling the vertical offset it was
        // welded with is intact and the lateral displacement has closed, so
        // the nudge was absorbed by the island rather than by the joint
        // stretching.
        stepFor(w, 60)
        w.getTransform(a, pa, rot())
        w.getTransform(b, pb, rot())
        // "Stays rigid" is the claim worth pinning: the weld keeps the pair's
        // separation at the creation-time offset. (A Rapier fixed joint also
        // allows the island to rotate, so the offset need not stay vertical.)
        expect(Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)).toBeCloseTo(0.5, 1)
        expect(pb.z - pa.z).toBeCloseTo(0, 1)
        close()
      },
    )

    it('removing a weld frees the follower', () => {
      // What "freed" means at the seam: once the joint is gone the two bodies
      // are independent, so a velocity change on the follower moves the
      // follower and leaves the driver exactly where it was. The follower is
      // kicked HORIZONTALLY so the claim does not depend on either engine's
      // contact solver: under a weld it could not move without dragging the
      // driver, and the mock's missing body-body contacts cannot mask it.
      const w = open()
      w.addBody(groundDesc())
      const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
      const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
      const weld = w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
      stepFor(w, 60)
      w.removeConstraint(weld)
      const pa = pos()
      w.getTransform(a, pa, rot())
      expect(pa.y).toBeCloseTo(0.25, 2)
      w.setLinearVelocity(b, vec3(0, 0, 6))
      stepFor(w, 30)
      const pa2 = pos()
      const pb = pos()
      w.getTransform(a, pa2, rot())
      w.getTransform(b, pb, rot())
      // The driver did not move, and the follower slid away — a still-welded
      // follower could not do either.
      expect(pa2.y).toBeCloseTo(0.25, 2)
      expect(pa2.z).toBeCloseTo(0, 2)
      expect(Math.abs(pb.z)).toBeGreaterThan(0.1)
      close()
    })

    // Mock-only, so gated on the adapter itself rather than through `maybe`:
    // `skip` lists what the MOCK cannot do, not what this case is good for.
    it.skipIf(a.name !== 'MockPhysicsWorld')(
      'a freed follower lands on the floor once it has arced up (mock only)',
      () => {
        // The mock half of the case above, pinned on its own number. With no
        // body-body contacts the follower falls straight through the driver and
        // is caught by the ground plane, so it settles beside it rather than on
        // top of it. Havok's solver stacks them, so this cannot be shared.
        const w = open()
        w.addBody(groundDesc())
        const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
        const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
        const weld = w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
        stepFor(w, 60)
        w.removeConstraint(weld)
        w.setLinearVelocity(b, vec3(0, 6, 0))
        // Enough steps to arc up and come back down: 6 m/s against -16.5 m/s² is
        // ~1.1 s of flight, which is 33 steps at the 30 Hz tick.
        stepFor(w, 90)
        const pb = pos()
        w.getTransform(b, pb, rot())
        expect(pb.y).toBeCloseTo(0.25, 2)
        expect(w.isSettled(b)).toBe(true)
        close()
      },
    )

    it('setConstraintMotor on a weld, or on an unknown id, is a silent no-op', () => {
      const w = open()
      w.addBody(groundDesc())
      const a = w.addBody(dynamicBoxDesc(vec3(0, 0.26, 0), 0.5, 10))
      const b = w.addBody(dynamicBoxDesc(vec3(0, 0.78, 0), 0.5, 10))
      const weld = w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
      expect(() => w.setConstraintMotor(weld, { targetVelocity: 9, maxForce: 100 })).not.toThrow()
      expect(() =>
        w.setConstraintMotor(999_999, { targetVelocity: 9, maxForce: 100 }),
      ).not.toThrow()
      stepFor(w, 60)
      close()
    })

    it.skipIf(maybe('a rope'))('a rope is slack below its length and taut at it', () => {
      const w = open()
      w.addBody(groundDesc())
      const anchor = w.addBody({
        shape: { type: 'box', size: [0.4, 0.4, 0.4] },
        motion: 'static',
        pos: vec3(0, 6, 0),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
      })
      const bob = w.addBody(dynamicBoxDesc(vec3(1.5, 6, 0), 0.4, 10))
      const rope = w.addConstraint({
        type: 'rope',
        bodyA: anchor,
        bodyB: bob,
        anchorA: vec3(),
        anchorB: vec3(),
        length: 2,
      })
      let maxDist = 0
      let minY = Infinity
      const p = pos()
      for (let i = 0; i < 300; i++) {
        w.step(DT)
        w.getTransform(bob, p, rot())
        maxDist = Math.max(maxDist, Math.hypot(p.x, p.y - 6, p.z))
        minY = Math.min(minY, p.y)
      }
      expect(maxDist).toBeLessThanOrEqual(2.3)
      // A taut 2 m pendulum swings through ~4 m below a 6 m anchor.
      expect(minY).toBeLessThanOrEqual(4.6)
      w.removeConstraint(rope)
      close()
    })

    it.skipIf(maybe('a hinge'))('a hinge with limits caps the swing and holds the door up', () => {
      const w = open()
      w.addBody(groundDesc())
      const post = w.addBody({
        shape: { type: 'box', size: [0.4, 0.4, 0.4] },
        motion: 'static',
        pos: vec3(10, 2, 0),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
      })
      const door = w.addBody(dynamicBoxDesc(vec3(10.9, 2, 0), 0.4, 10))
      w.addConstraint({
        type: 'hinge',
        bodyA: post,
        bodyB: door,
        anchorA: vec3(0.45, 0, 0),
        anchorB: vec3(-0.45, 0, 0),
        axisA: vec3(0, 1, 0),
        axisB: vec3(0, 1, 0),
        limits: { min: -Math.PI / 4, max: Math.PI / 4 },
      })
      w.setLinearVelocity(door, vec3(0, 0, 8))
      const p = pos()
      let maxAngle = 0
      for (let i = 0; i < 90; i++) {
        w.step(DT)
        w.getTransform(door, p, rot())
        maxAngle = Math.max(maxAngle, Math.abs(Math.atan2(p.z, p.x - 10)))
      }
      expect(maxAngle).toBeGreaterThan(0.2)
      expect(maxAngle).toBeLessThanOrEqual(Math.PI / 4 + 0.25)
      w.getTransform(door, p, rot())
      expect(Math.abs(p.y - 2)).toBeLessThan(0.25)
      close()
    })

    it.skipIf(maybe('a motorized hinge'))(
      'a motorized hinge spins a wheel up and retunes to brake it',
      () => {
        const w = open()
        const mount = w.addBody({
          shape: { type: 'box', size: [0.4, 0.4, 0.4] },
          motion: 'static',
          pos: vec3(20, 3, 0),
          layer: CollisionLayer.Static,
          collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
        })
        const wheel = w.addBody({
          shape: { type: 'cylinder', radius: 0.6, height: 0.2 },
          motion: 'dynamic',
          pos: vec3(20, 3, 0.4),
          massKg: 8,
          layer: CollisionLayer.Prop,
          collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
        })
        const motorId = w.addConstraint({
          type: 'hinge',
          bodyA: mount,
          bodyB: wheel,
          anchorA: vec3(0, 0, 0.4),
          anchorB: vec3(0, 0, 0),
          axisA: vec3(0, 0, 1),
          axisB: vec3(0, 1, 0), // a Babylon cylinder's own axis is +Y
          motor: { targetVelocity: 6, maxForce: 500 },
        })
        stepFor(w, 90)
        const av = pos()
        w.getAngularVelocity(wheel, av)
        expect(Math.hypot(av.x, av.y, av.z)).toBeGreaterThan(4)
        w.setConstraintMotor(motorId, { targetVelocity: 0, maxForce: 500 })
        stepFor(w, 60)
        w.getAngularVelocity(wheel, av)
        expect(Math.hypot(av.x, av.y, av.z)).toBeLessThan(0.5)
        close()
      },
    )

    it.skipIf(maybe('a slider'))(
      'a slider travels along its rail, respects its limits and stays on it',
      () => {
        const w = open()
        w.addBody(groundDesc())
        const rail = w.addBody({
          shape: { type: 'box', size: [0.4, 0.4, 0.4] },
          motion: 'static',
          pos: vec3(30, 2, 0),
          layer: CollisionLayer.Static,
          collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
        })
        const drawer = w.addBody(dynamicBoxDesc(vec3(30, 2, 0.6), 0.4, 10))
        w.addConstraint({
          type: 'slider',
          bodyA: rail,
          bodyB: drawer,
          anchorA: vec3(0, 0, 0.6),
          anchorB: vec3(0, 0, 0),
          axisA: vec3(0, 0, 1),
          axisB: vec3(0, 0, 1),
          limits: { min: -0.5, max: 1.0 },
        })
        w.setLinearVelocity(drawer, vec3(0, 0, 5))
        const p = pos()
        let maxZ = -Infinity
        let minZ = Infinity
        let maxOffAxis = 0
        for (let i = 0; i < 120; i++) {
          w.step(DT)
          w.getTransform(drawer, p, rot())
          maxZ = Math.max(maxZ, p.z)
          minZ = Math.min(minZ, p.z)
          maxOffAxis = Math.max(maxOffAxis, Math.abs(p.x - 30), Math.abs(p.y - 2))
          if (i === 60) w.setLinearVelocity(drawer, vec3(0, 0, -5))
        }
        expect(maxZ).toBeGreaterThan(1.3)
        expect(maxZ).toBeLessThanOrEqual(1.85)
        expect(minZ).toBeGreaterThanOrEqual(-0.15)
        expect(maxOffAxis).toBeLessThanOrEqual(0.15)
        close()
      },
    )

    it.skipIf(maybe('a spring'))('a spring settles at roughly its rest length', () => {
      const w = open()
      w.addBody(groundDesc())
      const mount = w.addBody({
        shape: { type: 'box', size: [0.4, 0.4, 0.4] },
        motion: 'static',
        pos: vec3(40, 6, 0),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
      })
      const bob = w.addBody(dynamicBoxDesc(vec3(40, 5.5, 0), 0.4, 10))
      w.addConstraint({
        type: 'spring',
        bodyA: mount,
        bodyB: bob,
        anchorA: vec3(),
        anchorB: vec3(),
        restLength: 1.5,
        stiffness: 400,
        damping: 15,
      })
      stepFor(w, 300)
      const p = pos()
      w.getTransform(bob, p, rot())
      const dist = Math.hypot(p.x - 40, p.y - 6, p.z)
      expect(dist).toBeGreaterThan(1.2)
      expect(dist).toBeLessThan(2.2)
      close()
    })

    it('every constraint variant is accepted and keeps a live handle', () => {
      const w = open()
      w.addBody(groundDesc())
      const mk = (y: number) => w.addBody(dynamicBoxDesc(vec3(100, y, 0), 0.4, 10))
      const a = mk(1)
      const b = mk(2)
      const ids = [
        w.addConstraint({ type: 'weld', bodyA: a, bodyB: b }),
        w.addConstraint({
          type: 'rope',
          bodyA: a,
          bodyB: b,
          anchorA: vec3(),
          anchorB: vec3(),
          length: 2,
          collision: false,
        }),
        w.addConstraint({
          type: 'hinge',
          bodyA: a,
          bodyB: b,
          anchorA: vec3(),
          anchorB: vec3(),
          axisA: vec3(0, 1, 0),
          axisB: vec3(0, 1, 0),
          limits: { min: -1, max: 1 },
          friction: 0.1,
          motor: { targetVelocity: 1, maxForce: 10 },
        }),
        w.addConstraint({
          type: 'slider',
          bodyA: a,
          bodyB: b,
          anchorA: vec3(),
          anchorB: vec3(),
          axisA: vec3(0, 0, 1),
          axisB: vec3(0, 0, 1),
          motor: { targetVelocity: 1, maxForce: 10 },
        }),
        w.addConstraint({
          type: 'spring',
          bodyA: a,
          bodyB: b,
          anchorA: vec3(),
          anchorB: vec3(),
          restLength: 1,
          stiffness: 100,
          damping: 5,
        }),
      ]
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) {
        expect(() => w.setConstraintMotor(id, { targetVelocity: 0, maxForce: 1 })).not.toThrow()
        expect(() => w.removeConstraint(id)).not.toThrow()
      }
      close()
    })

    // ── disposal ────────────────────────────────────────────────────────────

    it('dispose is safe after bodies have already been removed', () => {
      const w = open()
      w.addBody(groundDesc())
      const box = w.addBody(dynamicBoxDesc(vec3(0, 2, 0)))
      const other = w.addBody(dynamicBoxDesc(vec3(2, 2, 0)))
      w.addConstraint({ type: 'weld', bodyA: box, bodyB: other })
      w.removeBody(box)
      expect(() => w.dispose()).not.toThrow()
      expect(() => w.dispose()).not.toThrow()
      world = null
    })

    // ── engine-independent constants ─────────────────────────────────────────
    // These must hold for every adapter, so they run for both worlds. The
    // acceleration-shaped ones are additionally pinned in the engine describe
    // below, where the numbers have been measured.

    describe('seam constants', () => {
      it('settle thresholds sit between 0.01 and 0.1 m/s, and 0.1 and 0.2 rad/s', () => {
        // The thresholds are read back through the adapter under test, not off
        // a literal: this case is about WHERE the seam's threshold lies, which
        // is what the game is tuned against. Exactly-at-the-boundary behaviour
        // is deliberately not pinned (header note 2: Havok compares len² >
        // threshold² against an f32, so a body at exactly 0.05 is reported
        // unsettled there and settled on the mock).
        const w = open()
        // Just inside both thresholds: settled.
        const inside = addParkedBody(w, vec3(0, 900, 0))
        w.setLinearVelocity(inside, vec3(0.01, 0, 0))
        w.setAngularVelocity(inside, vec3(0, 0.1, 0))
        expect(w.isSettled(inside)).toBe(true)
        // Comfortably above either one: not settled.
        const fast = addParkedBody(w, vec3(50, 900, 0))
        w.setLinearVelocity(fast, vec3(1, 0, 0))
        expect(w.isSettled(fast)).toBe(false)
        const spinning = addParkedBody(w, vec3(100, 900, 0))
        w.setAngularVelocity(spinning, vec3(0, 1, 0))
        expect(w.isSettled(spinning)).toBe(false)
        // Just over each threshold: not settled. 0.06 and 0.16 sit a clear
        // f32 step above 0.05 and 0.15 without landing on the boundary.
        const justOverLinear = addParkedBody(w, vec3(150, 900, 0))
        w.setLinearVelocity(justOverLinear, vec3(0.06, 0, 0))
        expect(w.isSettled(justOverLinear)).toBe(false)
        const justOverAngular = addParkedBody(w, vec3(200, 900, 0))
        w.setAngularVelocity(justOverAngular, vec3(0, 0.16, 0))
        expect(w.isSettled(justOverAngular)).toBe(false)
        close()
      })

      it('gravity is (0, -16.5, 0) m/s^2', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 10))
        w.setLinearVelocity(box, vec3(0, 0, 0))
        // Two seconds of free fall, asked for in simulated seconds because the
        // two engines advance by different amounts per step(): the mock reaches
        // -29.9 m/s in 60 steps of 1/30 s, the Havok plugin -31.4 m/s in 120
        // steps of its fixed 1/60 s. Either way it is nowhere near a 9.81 m/s²
        // world, which would be -19.
        stepSecondsFor(a, w, 2)
        const v = pos()
        w.getLinearVelocity(box, v)
        // The window is the two-second band both engines land inside; it would
        // not survive a 9.81 m/s² world, which would be -19.
        expect(v.y).toBeLessThan(-29)
        expect(v.y).toBeGreaterThan(-34)
        close()
      })

      it('restitution is near zero: a dropped box does not bounce', () => {
        const w = open()
        w.addBody(groundDesc())
        const box = w.addBody(dynamicBoxDesc(vec3(0, 8, 0), 0.7, 25))
        let landedAt = -Infinity
        for (let i = 0; i < 300; i++) {
          w.step(DT)
          const p = pos()
          w.getTransform(box, p, rot())
          if (p.y < 0.36) {
            landedAt = p.y
            break
          }
        }
        expect(landedAt).not.toBe(-Infinity)
        stepFor(w, 30)
        const p = pos()
        w.getTransform(box, p, rot())
        // A restitution of 0.05 cannot lift a 25 kg box more than a whisker.
        expect(p.y).toBeLessThan(landedAt + 0.35)
        expect(p.y).toBeLessThan(0.5)
        close()
      })
    })

    // ── engine-specific dynamics ────────────────────────────────────────────
    // These assert the numeric feel the game is tuned against. The mock's
    // values are exact by construction, so they are marked separately from the
    // Havok numbers where the two genuinely differ.

    if (a.name === 'MockPhysicsWorld') {
      it('exposes the same seam constants the Havok adapter is built from', () => {
        // The shared cases above read gravity and the settle thresholds back
        // through the adapter, so they cannot see a literal drift in either
        // one. This pins the mock's own values against the numbers measured off
        // havokWorld.ts (the header block's list), so the two adapters stay
        // declared to the same constants and the shared cases mean something.
        expect(MOCK_GRAVITY).toBe(-16.5)
        expect(MOCK_SETTLE_LINEAR).toBe(0.05)
        expect(MOCK_SETTLE_ANGULAR).toBe(0.15)
      })

      it('applies its own gravity, damping and mass, exactly', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 10))
        // Semi-implicit Euler at 30 Hz: v += g·dt, then v *= (1 - 0.05·dt).
        // Two seconds is -16.5 × 2 = -33 before the damping losses.
        for (let i = 0; i < 60; i++) w.step(MOCK_TICK)
        const v = pos()
        w.getLinearVelocity(box, v)
        expect(v.y).toBeLessThan(-29)
        expect(v.y).toBeGreaterThan(-33)
        close()
      })

      it('a body rests on the analytic ground plane and settles', () => {
        const w = open()
        w.addBody(groundDesc())
        const box = w.addBody(dynamicBoxDesc(vec3(0, 5, 0), 0.7, 25))
        stepFor(w, 240)
        const p = pos()
        w.getTransform(box, p, rot())
        expect(p.y).toBeCloseTo(0.35, 3)
        expect(w.isSettled(box)).toBe(true)
        close()
      })

      it('a body in free fall is never settled', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 500, 0)))
        stepFor(w, 30)
        expect(w.isSettled(box)).toBe(false)
        close()
      })

      it('a resting body carries no angular velocity once the ground stops it', () => {
        const w = open()
        w.addBody(groundDesc())
        const box = w.addBody(dynamicBoxDesc(vec3(0, 5, 0), 0.7, 25))
        w.setAngularVelocity(box, vec3(0, 5, 0))
        stepFor(w, 240)
        const v = pos()
        w.getAngularVelocity(box, v)
        expect(Math.hypot(v.x, v.y, v.z)).toBe(0)
        close()
      })

      it('applyForce accelerates in the force direction and ignores non-dynamic bodies', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 10))
        const ground = w.addBody(groundDesc())
        for (let i = 0; i < 10; i++) {
          w.applyForce(box, vec3(10, 0, 0))
          w.step(DT)
        }
        const v = pos()
        w.getLinearVelocity(box, v)
        // a = F/m = 1 m/s^2 for 10 kg, so about 0.33 m/s after a third second.
        expect(v.x).toBeCloseTo(1 / 3, 1)
        w.applyForce(ground, vec3(1000, 0, 0))
        stepFor(w, 10)
        const p = pos()
        w.getTransform(ground, p, rot())
        expect(p.x).toBeCloseTo(0, 3)
        close()
      })

      it('an analytic cast plane stops casts but not bodies', () => {
        const w = createMockPhysicsWorld()
        w.addCast({ normal: vec3(-1, 0, 0), offset: 2, minY: -1, maxY: 3 })
        expect(w.castCount()).toBe(1)
        expect(
          w.sweepCapsule(vec3(-3, 1, 0), vec3(3, 1, 0), 0.4, 1.8, CollisionLayer.Static),
        ).not.toBeNull()
        // No ground plane at all, so a body just keeps falling.
        const box = w.addBody(dynamicBoxDesc(vec3(-3, 10, 0), 0.5, 10))
        stepFor(w, 60)
        const p = pos()
        w.getTransform(box, p, rot())
        expect(p.y).toBeLessThan(0)
        close()
      })

      it('a patched cast plane only hits inside its patch', () => {
        const w = createMockPhysicsWorld()
        w.addCast({ normal: vec3(-1, 0, 0), offset: 2, minY: -1, maxY: 3, minZ: -1, maxZ: 1 })
        expect(
          w.sweepCapsule(vec3(-3, 1, 0), vec3(3, 1, 0), 0.4, 1.8, CollisionLayer.Static),
        ).not.toBeNull()
        expect(
          w.sweepCapsule(vec3(-3, 1, 8), vec3(3, 1, 8), 0.4, 1.8, CollisionLayer.Static),
        ).toBeNull()
        expect(
          w.sweepCapsule(vec3(-3, 9, 0), vec3(3, 9, 0), 0.4, 1.8, CollisionLayer.Static),
        ).toBeNull()
        close()
      })

      it('groundHeightAt reports the analytic plane, not a wall cast', () => {
        const w = createMockPhysicsWorld()
        w.addGroundPlane(0)
        w.markLastCastAsGround()
        w.addCast({ normal: vec3(-1, 0, 0), offset: 2 })
        expect(w.groundHeightAt(0, 0)).toBe(0)
        expect(
          w.sweepCapsule(vec3(-3, 1, 0), vec3(3, 1, 0), 0.4, 1.8, CollisionLayer.Static),
        ).not.toBeNull()
        close()
      })

      it('is bit-identical across runs', () => {
        const run = (): number[] => {
          const w = createMockPhysicsWorld()
          w.addCast({ normal: vec3(0, 1, 0), offset: 0 })
          w.markLastCastAsGround()
          w.addCast({ normal: vec3(-1, 0, 0), offset: 2 })
          const box = w.addBody(dynamicBoxDesc(vec3(0, 5, 0), 0.7, 25))
          const out: number[] = []
          for (let i = 0; i < 200; i++) {
            w.setLinearVelocity(box, vec3(3 + Math.sin(i * 0.1), 0, 0))
            w.step(DT)
            const p = pos()
            w.getTransform(box, p, rot())
            out.push(p.x, p.y, p.z)
          }
          close()
          return out
        }
        expect(run()).toEqual(run())
      })

      it('every case the mock skips still runs somewhere', async () => {
        // A `skip` entry naming a title that no longer exists silently skips
        // nothing, which is how the mock ended up running a case its header
        // claimed it could not model. Each prefix below must be a prefix of a
        // title this file actually defines; read them out of the source so the
        // check cannot go stale when a case is renamed or removed.
        const source = await readFile(new URL(import.meta.url), 'utf8')
        const titles = [
          ...source.matchAll(/\bit(?:\.skipIf\([\s\S]*?\)\s*)?\(\s*\n?\s*'([^']+)'/g),
        ].map((m) => m[1]!)
        expect(titles.length).toBeGreaterThan(40)
        const dead = MOCK_SKIP_PREFIXES.filter((p) => !titles.some((t) => t.startsWith(p)))
        expect(dead).toEqual([])
      })
    } else {
      it('a freed follower lands back on the driver via the contact solver', () => {
        // Rapier, like Havok, has a contact solver: after the follower is kicked
        // vertically off a freed weld it lands back on top of the lower box
        // (measured ~0.75), rather than falling through as the mock does.
        const w = open()
        w.addBody(groundDesc())
        const a = w.addBody(dynamicBoxDesc(vec3(0, 0.25, 0), 0.5, 10))
        const b = w.addBody(dynamicBoxDesc(vec3(0, 0.75, 0), 0.5, 10))
        const weld = w.addConstraint({ type: 'weld', bodyA: a, bodyB: b })
        stepFor(w, 60)
        w.removeConstraint(weld)
        w.setLinearVelocity(b, vec3(0, 6, 0))
        // 30 steps at 30 Hz is one second: the follower arcs up ~1 m and lands.
        stepFor(w, 30)
        const pb = pos()
        w.getTransform(b, pb, rot())
        expect(pb.y).toBeGreaterThan(0.5)
        expect(pb.y).toBeLessThan(1.2)
        close()
      })

      it.skipIf(maybe('step advances'))('step advances exactly the dt it is given', () => {
        const probe = (dt: number, ticks: number) => {
          const w = open()
          const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 10))
          stepFor(w, ticks, dt)
          const v = pos()
          w.getLinearVelocity(box, v)
          close()
          return v.y
        }
        // Rapier honours the dt it is given: 30 steps of 1/30 s and 60 steps
        // of 1/60 s are the same simulated second (the damping is applied per
        // step, so they agree to within a few mm/s, not bit-exactly).
        expect(probe(1 / 30, 30)).toBeCloseTo(probe(1 / 60, 60), 1)
        // An extra simulated second is very nearly twice the velocity.
        expect(probe(1 / 30, 60) / probe(1 / 30, 30)).toBeGreaterThan(1.9)
        expect(probe(1 / 30, 60) / probe(1 / 30, 30)).toBeLessThan(2.1)
        // One simulated second of this gravity: about -16.5 m/s.
        expect(probe(1 / 30, 30)).toBeLessThan(-15)
        expect(probe(1 / 30, 30)).toBeGreaterThan(-17)
      })

      it('a resting dynamic body on the ground settles', () => {
        const w = open()
        w.addBody(groundDesc())
        const box = w.addBody(dynamicBoxDesc(vec3(0, 3, 0), 0.7, 25))
        stepFor(w, 240)
        expect(w.isSettled(box)).toBe(true)
        close()
      })

      it('a body in free fall is never settled', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 500, 0)))
        stepFor(w, 30)
        expect(w.isSettled(box)).toBe(false)
        close()
      })

      it('applyForce accelerates a dynamic body; static and kinematic are ignored', () => {
        const w = open()
        w.addBody(groundDesc())
        const box = w.addBody(dynamicBoxDesc(vec3(0, 1, 0), 0.5, 10))
        w.setLinearVelocity(box, vec3(0, 0, 0))
        for (let i = 0; i < 60; i++) {
          w.applyForce(box, vec3(100, 0, 0))
          w.step(DT)
        }
        const p = pos()
        w.getTransform(box, p, rot())
        expect(p.x).toBeGreaterThan(0.3)
        const k = w.addBody({
          shape: { type: 'sphere', radius: 0.5 },
          motion: 'kinematic',
          pos: vec3(20, 5, 0),
          layer: CollisionLayer.Player,
          collidesWith: 0,
        })
        w.applyForce(k, vec3(500, 0, 0))
        stepFor(w, 30)
        const kp = pos()
        w.getTransform(k, kp, rot())
        expect(kp.x).toBeCloseTo(20, 3)
        close()
      })

      it('mass scales the response to an equal force', () => {
        const w = open()
        const heavy = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 40))
        const light = w.addBody(dynamicBoxDesc(vec3(50, 900, 0), 0.5, 10))
        for (let i = 0; i < 20; i++) {
          w.applyForce(heavy, vec3(400, 0, 0))
          w.applyForce(light, vec3(400, 0, 0))
          w.step(DT)
        }
        const hv = pos()
        const lv = pos()
        w.getLinearVelocity(heavy, hv)
        w.getLinearVelocity(light, lv)
        expect(lv.x / Math.max(hv.x, 1e-9)).toBeGreaterThan(3)
        expect(lv.x / Math.max(hv.x, 1e-9)).toBeLessThan(5)
        close()
      })

      it('linear damping is light (0.05): a coasting body keeps its speed', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 10))
        w.setLinearVelocity(box, vec3(10, 0, 0))
        stepFor(w, 30)
        const v = pos()
        w.getLinearVelocity(box, v)
        expect(v.x).toBeGreaterThan(9.5)
        expect(v.x).toBeLessThan(10)
        close()
      })

      it('angular damping is strong (0.6): a free spin decays within seconds', () => {
        const w = open()
        const box = w.addBody(dynamicBoxDesc(vec3(0, 900, 0), 0.5, 10))
        w.setAngularVelocity(box, vec3(0, 10, 0))
        stepFor(w, 60)
        const v = pos()
        w.getAngularVelocity(box, v)
        expect(v.y).toBeLessThan(6)
        expect(v.y).toBeGreaterThan(0)
        close()
      })

      it('surface friction is high enough that a sliding box stops quickly', () => {
        const w = open()
        w.addBody(groundDesc())
        const box = w.addBody(dynamicBoxDesc(vec3(0, 0.36, 0), 0.7, 25))
        w.setLinearVelocity(box, vec3(10, 0, 0))
        stepFor(w, 180)
        const v = pos()
        w.getLinearVelocity(box, v)
        expect(Math.abs(v.x)).toBeLessThan(1.5)
        close()
      })

      it('a body knocked off a ledge falls; the ledge does not move it sideways', () => {
        const w = open()
        w.addBody({
          shape: { type: 'box', size: [4, 1, 10] },
          motion: 'static',
          pos: vec3(0, 0.5, 0),
          layer: CollisionLayer.Static,
          collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
        })
        const box = w.addBody(dynamicBoxDesc(vec3(0, 2, 0), 0.7, 25))
        stepFor(w, 60)
        const resting = pos()
        w.getTransform(box, resting, rot())
        expect(resting.y).toBeCloseTo(1.35, 2)
        w.setLinearVelocity(box, vec3(8, 0, 0))
        stepFor(w, 90)
        const gone = pos()
        w.getTransform(box, gone, rot())
        expect(gone.y).toBeLessThan(0)
        close()
      })
    }
  })
}

conformance(rapierAdapter)
conformance(mockAdapter)
