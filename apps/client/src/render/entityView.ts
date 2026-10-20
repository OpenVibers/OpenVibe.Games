import '@babylonjs/core/Meshes/instancedMesh.js' // createInstance() needs its side effect (tree instances)
import '@babylonjs/core/Rendering/outlineRenderer.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry, WorldShape } from '@openvibe/content'
import { DEFAULT_MOVEMENT, hullHeightFor } from '@openvibe/gameplay'
import { CollisionLayer, type BodyId, type PhysicsWorld, type ShapeDesc } from '@openvibe/physics'
import type { ServerSnapshot, WireEntity } from '@openvibe/protocol'
import { quat, vec3, wrapAngle } from '@openvibe/shared'
import type { ClientState } from '../state/clientState.js'
import { Avatar } from './avatar/avatar.js'
import { buildCritter, npcAppearance } from './npcLooks.js'
import { materialFor, meshForShape } from './sceneSetup.js'

/**
 * Maintains the renderable + collidable view of replicated entities:
 * prop/resource meshes with mirror physics bodies (so prediction sweeps
 * and aim rays collide with them), full animated avatars for remote
 * players, and interpolation buffers so remote motion renders smoothly
 * between snapshots.
 */

interface InterpSample {
  t: number
  pos: [number, number, number]
  rot: [number, number, number, number]
  /** Player extras (animation inputs). */
  yaw?: number
  pitch?: number
  speed?: number
  grounded?: boolean
  stance?: number
  item?: string | undefined
}

interface EntityVisual {
  entity: WireEntity
  mesh: Mesh | null
  avatar: Avatar | null
  light: PointLight | null
  bodyId: BodyId | null
  buffer: InterpSample[]
  /** Stance the player mirror capsule was last built for (players only). */
  bodyStance: number
  /** Hit-shake time remaining (resources being chopped/mined). */
  shakeT: number
  /** An NPC avatar's feet below its position (half its height); null for players, whose hull sets it. */
  feetOffset: number | null
}

const INTERP_DELAY = 0.13
const _pos = vec3()
const _rot = quat()

export class EntityView {
  private readonly visuals = new Map<string, EntityVisual>()
  private readonly entityByBody = new Map<BodyId, string>()
  /** EMA of (serverTime - localTime) for the interpolation clock. */
  private clockOffset: number | null = null
  private lastUpdateTime = 0

  constructor(
    private readonly scene: Scene,
    private readonly physics: PhysicsWorld,
    private readonly content: ContentRegistry,
    private readonly state: ClientState,
  ) {
    state.events.on('entityAdded', (e) => this.add(e))
    state.events.on('entityRemoved', (id) => this.remove(id))
    state.events.on('entityUpdated', (e) => this.applyAuthoritative(e))
    state.events.on('fx', ({ kind, id }) => {
      const avatar = this.visuals.get(id)?.avatar
      if (!avatar) return
      avatar.triggerFlinch()
      avatar.flashHurt(kind === 'death' ? 0.9 : 0.45)
    })
  }

  entityIdForBody(bodyId: BodyId): string | undefined {
    return this.entityByBody.get(bodyId)
  }

  avatarFor(entityId: string): Avatar | null {
    return this.visuals.get(entityId)?.avatar ?? null
  }

  private add(e: WireEntity): void {
    if (e.id === this.state.myEntityId) return // first-person body handles self
    if (this.visuals.has(e.id)) return

    let mesh: Mesh | null = null
    let avatar: Avatar | null = null
    let feetOffset: number | null = null
    let bodyId: BodyId | null = null

    if (e.kind === 'player') {
      avatar = new Avatar(
        this.scene,
        this.content,
        Avatar.appearanceOrDefault(e.appearance),
        `player:${e.id}`,
      )
      // Collision mirror so local prediction blocks on other players the
      // same way the server does (players collide with players).
      bodyId = this.addPlayerBody(vec3(e.pos[0], e.pos[1], e.pos[2]), 0)
    } else if (e.kind === 'prop' && e.def && this.content.item(e.def)) {
      // worldRepOf ALWAYS yields a shape (fallback for defs without a
      // world block) — matching the server exactly. Every prop also gets a
      // collision mirror; without one the aim ray can't hit it and the
      // prop can never be picked up or grabbed.
      const rep = this.content.worldRepOf(e.def)
      mesh =
        buildPropVisual(this.scene, e.id, e.def) ??
        meshForShape(this.scene, `prop:${e.id}`, rep.shape, rep.color)
      bodyId = this.physics.addBody({
        shape: toPhysicsShape(rep.shape),
        motion: 'static',
        pos: vec3(e.pos[0], e.pos[1], e.pos[2]),
        rot: quat(e.rot[0], e.rot[1], e.rot[2], e.rot[3]),
        layer: CollisionLayer.Prop,
        collidesWith: CollisionLayer.Player,
      })
    } else if (e.kind === 'prop') {
      mesh = CreateBox(`prop:${e.id}`, { size: 0.5 }, this.scene)
    } else if (e.kind === 'npc') {
      // People wear the players' avatar, dressed by archetype (npcLooks.ts); animals get a small body. A collision
      // mirror makes either aim-able.
      const arch = this.content.npc(e.def ?? '')
      const height = arch?.heightM ?? 1.7
      const radius = arch?.radius ?? 0.35
      const look = npcAppearance(arch?.id ?? '', e.id)
      if (look) {
        avatar = new Avatar(this.scene, this.content, look, `npc:${e.id}`)
        feetOffset = height / 2
      } else {
        mesh = buildCritter(this.scene, `npc:${e.id}`, arch?.color ?? '#888888', height / 2)
        mesh.rotationQuaternion = new Quaternion(e.rot[0], e.rot[1], e.rot[2], e.rot[3])
      }
      bodyId = this.physics.addBody({
        shape: { type: 'capsule', radius, height },
        motion: 'static',
        pos: vec3(e.pos[0], e.pos[1], e.pos[2]),
        layer: CollisionLayer.Player,
        collidesWith: CollisionLayer.Player,
      })
    } else {
      // Resource node: visual archetype + collision body from the node type.
      const nodeType = this.content.nodeType(e.def ?? '')
      mesh = buildNodeVisual(this.scene, e.id, nodeType?.visual ?? 'scrap')
      bodyId = this.physics.addBody({
        shape: nodeType
          ? toPhysicsShape(nodeType.bodyShape)
          : { type: 'box', size: [0.8, 0.5, 0.8] },
        motion: 'static',
        pos: vec3(e.pos[0], e.pos[1] + (nodeType?.bodyOffsetY ?? 0.4), e.pos[2]),
        layer: CollisionLayer.Prop,
        collidesWith: CollisionLayer.Player,
      })
      setDepletedLook(mesh, (e.remaining ?? 1) <= 0)
    }

    if (mesh) {
      mesh.position.set(e.pos[0], e.pos[1], e.pos[2])
      // Resources keep Euler rotation so the hit-shake wobble can drive it;
      // props are quaternion-driven by replication.
      if (e.kind === 'prop') {
        mesh.rotationQuaternion = new Quaternion(e.rot[0], e.rot[1], e.rot[2], e.rot[3])
      }
    }
    if (bodyId !== null) this.entityByBody.set(bodyId, e.id)
    // Burn barrels cast flickering warm light.
    let light: PointLight | null = null
    if (e.kind === 'prop' && e.def === 'campfire') {
      light = new PointLight(
        `fire:${e.id}`,
        new Vector3(e.pos[0], e.pos[1] + 0.5, e.pos[2]),
        this.scene,
      )
      light.diffuse = new Color3(1, 0.6, 0.25)
      light.intensity = 0.8
      light.range = 10
    }
    this.visuals.set(e.id, {
      entity: e,
      mesh,
      avatar,
      light,
      bodyId,
      buffer: [],
      bodyStance: 0,
      shakeT: 0,
      feetOffset,
    })
  }

  /** Static capsule matching the server's player body (short + lifted). */
  private addPlayerBody(pos: { x: number; y: number; z: number }, stance: number): BodyId {
    const hull = hullHeightFor(stance as 0 | 1 | 2)
    return this.physics.addBody({
      shape: {
        type: 'capsule',
        radius: DEFAULT_MOVEMENT.capsuleRadius,
        height: Math.max(hull - 0.3, 0.4),
      },
      motion: 'static',
      pos: vec3(pos.x, pos.y + 0.15, pos.z),
      layer: CollisionLayer.Player,
      collidesWith: CollisionLayer.Player,
    })
  }

  private remove(id: string): void {
    const v = this.visuals.get(id)
    if (!v) return
    v.light?.dispose()
    if (v.mesh) {
      for (const child of v.mesh.getChildMeshes()) child.dispose()
      v.mesh.dispose()
    }
    v.avatar?.dispose()
    if (v.bodyId !== null) {
      this.physics.removeBody(v.bodyId)
      this.entityByBody.delete(v.bodyId)
    }
    this.visuals.delete(id)
  }

  /** Authoritative pin: freeze/settle transforms, resource depletion state. */
  private applyAuthoritative(e: WireEntity): void {
    const v = this.visuals.get(e.id)
    if (!v) return
    if (e.kind === 'resource') {
      if (v.mesh) {
        setDepletedLook(v.mesh, (e.remaining ?? 0) <= 0)
        // Resource updates only happen on hits — kick the shake animation.
        if ((e.remaining ?? 0) > 0) v.shakeT = 0.3
      }
      return
    }
    if (!v.mesh) return
    v.buffer.length = 0
    v.mesh.position.set(e.pos[0], e.pos[1], e.pos[2])
    v.mesh.rotationQuaternion?.set(e.rot[0], e.rot[1], e.rot[2], e.rot[3])
    if (v.bodyId !== null) {
      this.physics.setTransform(
        v.bodyId,
        vec3(e.pos[0], e.pos[1], e.pos[2]),
        quat(e.rot[0], e.rot[1], e.rot[2], e.rot[3]),
      )
    }
  }

  /** Feed a snapshot into interpolation buffers. */
  onSnapshot(snap: ServerSnapshot, localTime: number): void {
    const serverTime = snap.tick / this.state.tickRate
    const offset = serverTime - localTime
    this.clockOffset =
      this.clockOffset === null ? offset : this.clockOffset + (offset - this.clockOffset) * 0.1

    for (const p of snap.players) {
      if (p.id === this.state.myEntityId) continue
      const v = this.visuals.get(p.id)
      if (!v) continue
      pushSample(v.buffer, {
        t: serverTime,
        pos: p.pos,
        rot: [0, 0, 0, 1],
        yaw: p.yaw,
        pitch: p.pitch,
        speed: Math.hypot(p.vel[0], p.vel[2]),
        grounded: p.grounded,
        stance: p.stance,
        item: p.item,
      })
    }
    for (const b of snap.bodies) {
      const v = this.visuals.get(b.id)
      if (!v) continue
      if (v.avatar) {
        // An NPC avatar: facing from its rotation, walking speed from how far it went since the last sample.
        const prev = v.buffer[v.buffer.length - 1]
        const dt = prev ? serverTime - prev.t : 0
        pushSample(v.buffer, {
          t: serverTime,
          pos: b.pos,
          rot: b.rot,
          yaw: 2 * Math.atan2(b.rot[1], b.rot[3]),
          speed:
            prev && dt > 0 ? Math.hypot(b.pos[0] - prev.pos[0], b.pos[2] - prev.pos[2]) / dt : 0,
          grounded: true,
        })
      } else pushSample(v.buffer, { t: serverTime, pos: b.pos, rot: b.rot })
      v.entity.pos = b.pos
      v.entity.rot = b.rot
      if (v.bodyId !== null) {
        this.physics.setTransform(
          v.bodyId,
          vec3(b.pos[0], b.pos[1], b.pos[2]),
          quat(b.rot[0], b.rot[1], b.rot[2], b.rot[3]),
        )
      }
    }
  }

  /** Per-frame: interpolate meshes/avatars toward buffered samples. */
  update(localTime: number): void {
    const dt = this.lastUpdateTime > 0 ? Math.min(localTime - this.lastUpdateTime, 0.1) : 0.016
    this.lastUpdateTime = localTime
    if (this.clockOffset === null) return
    const renderTime = localTime + this.clockOffset - INTERP_DELAY

    for (const v of this.visuals.values()) {
      // Growing crops: a sprout scales with server-reported progress
      // (refreshed by the plant sweep; between refreshes it holds still).
      if (v.entity.kind === 'prop' && v.mesh) {
        const plant = v.entity.plant
        let crop = v.mesh.getChildMeshes().find((m) => m.name.endsWith(':crop')) as Mesh | undefined
        if (plant) {
          if (!crop) {
            crop = CreateBox(`${v.mesh.name}:crop`, { size: 1 }, this.scene)
            crop.parent = v.mesh
            crop.position.y = 0.3
            crop.material = materialFor(this.scene, '#3f7a34')
          }
          const t = Math.min(1, plant.t)
          const h = 0.1 + t * 0.75
          crop.scaling.set(0.16 + t * 0.5, h, 0.16 + t * 0.5)
          crop.position.y = 0.15 + h / 2
          const cropDef = this.content.crop(plant.crop)
          // Mature = the crop's own color; growing = green, thirsty = dun.
          const color =
            t >= 1 ? (cropDef?.color ?? '#6a2a5a') : plant.water <= 0 ? '#8a7a4a' : '#3f7a34'
          crop.material = materialFor(this.scene, color)
        } else if (crop) {
          crop.dispose()
        }
      }
      // Burn-barrel flicker follows the (possibly carried) prop.
      if (v.light && v.mesh) {
        v.light.position.set(v.mesh.position.x, v.mesh.position.y + 0.5, v.mesh.position.z)
        v.light.intensity = 0.75 + Math.sin(localTime * 11) * 0.12 + Math.sin(localTime * 23) * 0.06
      }
      // Chop/mine feedback: brief wobble on the hit node.
      if (v.shakeT > 0 && v.mesh) {
        v.shakeT = Math.max(0, v.shakeT - dt)
        const k = v.shakeT / 0.3
        v.mesh.rotation.z = Math.sin(localTime * 55) * 0.045 * k
        v.mesh.rotation.x = Math.sin(localTime * 47 + 1.3) * 0.03 * k
      }
      if (v.buffer.length === 0) continue
      const bracket = findBracket(v.buffer, renderTime)
      const { a, b, alpha } = bracket
      _pos.x = a.pos[0] + (b.pos[0] - a.pos[0]) * alpha
      _pos.y = a.pos[1] + (b.pos[1] - a.pos[1]) * alpha
      _pos.z = a.pos[2] + (b.pos[2] - a.pos[2]) * alpha

      if (v.avatar) {
        const yaw = lerpAngle(a.yaw ?? 0, b.yaw ?? a.yaw ?? 0, alpha)
        const latest = v.buffer[v.buffer.length - 1] as InterpSample
        // Blend FEET height, not capsule-center height: the center jumps
        // when the hull shrinks (crouch/prone) and blending centers sinks
        // the avatar through the floor mid-transition.
        const feetA = a.pos[1] - (v.feetOffset ?? hullHeightFor((a.stance ?? 0) as 0 | 1 | 2) / 2)
        const feetB = b.pos[1] - (v.feetOffset ?? hullHeightFor((b.stance ?? 0) as 0 | 1 | 2) / 2)
        const feetY = feetA + (feetB - feetA) * alpha
        // Keep the player collision mirror on the smooth pose; swap the hull
        // when their stance changes so crouched players are shorter to walk on.
        // (An NPC's mirror follows its snapshots, in onSnapshot.)
        if (v.bodyId !== null && v.feetOffset === null) {
          const stance = latest.stance ?? 0
          if (stance !== v.bodyStance) {
            this.entityByBody.delete(v.bodyId)
            this.physics.removeBody(v.bodyId)
            v.bodyId = this.addPlayerBody(_pos, stance)
            v.bodyStance = stance
            this.entityByBody.set(v.bodyId, v.entity.id)
          } else {
            this.physics.setTransform(v.bodyId, vec3(_pos.x, _pos.y + 0.15, _pos.z))
          }
        }
        const beamActive = [...this.state.heldBy.values()].includes(v.entity.id)
        v.avatar.update({
          dt,
          time: localTime,
          x: _pos.x,
          y: feetY,
          z: _pos.z,
          yaw,
          pitch: lerpAngle(a.pitch ?? 0, b.pitch ?? a.pitch ?? 0, alpha),
          speed: latest.speed ?? 0,
          grounded: latest.grounded ?? true,
          stance: latest.stance ?? 0,
          itemDef: latest.item,
          beamActive,
        })
        continue
      }

      if (!v.mesh) continue
      nlerpQuat(a.rot, b.rot, alpha, _rot)
      v.mesh.position.set(_pos.x, _pos.y, _pos.z)
      v.mesh.rotationQuaternion?.set(_rot.x, _rot.y, _rot.z, _rot.w)
      // NOTE: the prop's collision mirror is synced at snapshot time (latest
      // authoritative pose), NOT here — prediction must compare against the
      // freshest server state, not the ~130ms-delayed visual interpolation.
      // Interpolated mirrors made standing on props mispredict every tick.
    }

    // Held/selection highlight: a temporary OUTLINE — cleared the moment
    // it's released/frozen/deselected, even if the prop has settled out of
    // snapshots (the old overlay could stick because settled visuals skip
    // the interpolation loop above). Rigging selection (green) wins over
    // the physgun-held blue.
    for (const v of this.visuals.values()) {
      if (!v.mesh || v.entity.kind !== 'prop') continue
      const selected = v.entity.id === this.selectedId
      const held = this.state.heldBy.has(v.entity.id)
      const want = held || selected
      const color = selected ? SELECT_OVERLAY : HELD_OVERLAY
      if (v.mesh.renderOutline !== want || (want && v.mesh.outlineColor !== color)) {
        v.mesh.renderOutline = want
        v.mesh.outlineColor = color
        v.mesh.outlineWidth = 0.03
        for (const child of v.mesh.getChildMeshes()) {
          const c = child as Mesh
          c.renderOutline = want
          c.outlineColor = color
          c.outlineWidth = 0.03
        }
      }
    }
  }

  /** Rigging tool first-pick highlight (null = nothing selected). */
  selectedId: string | null = null

  /**
   * World position of a grab point given in an entity's local space (beam
   * endpoints stick to the touched spot, not the prop center).
   */
  grabPointOf(id: string, local: [number, number, number] | undefined): Vector3 | null {
    const v = this.visuals.get(id)
    if (!v?.mesh) return this.positionOf(id)
    if (!local) return v.mesh.position
    _grabLocal.set(local[0], local[1], local[2])
    const rot = v.mesh.rotationQuaternion ?? Quaternion.Identity()
    _grabLocal.rotateByQuaternionToRef(rot, _grabWorld)
    return _grabWorld.addInPlace(v.mesh.position)
  }

  positionOf(id: string): Vector3 | null {
    const v = this.visuals.get(id)
    if (!v) return null
    if (v.mesh) return v.mesh.position
    if (v.avatar) return v.avatar.rootPosition
    return null
  }
}

const HELD_OVERLAY = new Color3(0.35, 0.65, 1)
const SELECT_OVERLAY = new Color3(0.4, 0.95, 0.5)
const _grabLocal = new Vector3()
const _grabWorld = new Vector3()

function pushSample(buffer: InterpSample[], sample: InterpSample): void {
  buffer.push(sample)
  while (buffer.length > 12) buffer.shift()
}

function findBracket(
  buffer: InterpSample[],
  t: number,
): { a: InterpSample; b: InterpSample; alpha: number } {
  const newest = buffer[buffer.length - 1] as InterpSample
  const oldest = buffer[0] as InterpSample
  let a = oldest
  let b = newest
  if (t <= oldest.t) b = oldest
  else if (t >= newest.t) a = newest
  else {
    for (let i = buffer.length - 2; i >= 0; i--) {
      const s = buffer[i] as InterpSample
      if (s.t <= t) {
        a = s
        b = buffer[i + 1] as InterpSample
        break
      }
    }
  }
  const span = b.t - a.t
  return { a, b, alpha: span > 1e-6 ? (t - a.t) / span : 1 }
}

function lerpAngle(a: number, b: number, alpha: number): number {
  return a + wrapAngle(b - a) * alpha
}

function nlerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  alpha: number,
  out: { x: number; y: number; z: number; w: number },
): void {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const sign = dot < 0 ? -1 : 1
  out.x = a[0] + (b[0] * sign - a[0]) * alpha
  out.y = a[1] + (b[1] * sign - a[1]) * alpha
  out.z = a[2] + (b[2] * sign - a[2]) * alpha
  out.w = a[3] + (b[3] * sign - a[3]) * alpha
  const len = Math.hypot(out.x, out.y, out.z, out.w)
  if (len > 1e-6) {
    out.x /= len
    out.y /= len
    out.z /= len
    out.w /= len
  }
}

/**
 * Hand-tuned composite visuals for common ground drops — physics still uses
 * the simple worldRepOf shape; these are pure dressing. Returns null for
 * items without an override (they use the plain shape mesh).
 */
function buildPropVisual(scene: Scene, id: string, def: string): Mesh | null {
  if (def === 'stone') {
    // Irregular rock: three intersecting flattened chunks.
    const root = CreateSphere(`prop:${id}`, { diameter: 0.32, segments: 5 }, scene)
    root.scaling.set(1, 0.72, 0.88)
    root.material = materialFor(scene, '#83878b')
    const chunkA = CreateSphere(`prop:${id}:a`, { diameter: 0.22, segments: 4 }, scene)
    chunkA.parent = root
    chunkA.position.set(0.1, 0.05, 0.06)
    chunkA.rotation.set(0.5, 0.9, 0.2)
    chunkA.scaling.set(1, 0.8, 0.9)
    chunkA.material = materialFor(scene, '#8f9296')
    const chunkB = CreateSphere(`prop:${id}:b`, { diameter: 0.18, segments: 4 }, scene)
    chunkB.parent = root
    chunkB.position.set(-0.09, -0.02, -0.05)
    chunkB.rotation.set(1.1, 0.3, 0.7)
    chunkB.material = materialFor(scene, '#767a7e')
    root.rotationQuaternion = new Quaternion()
    return root
  }
  if (def === 'wood_log') {
    // Log lying on its side: bark cylinder + lighter end caps + a knot.
    const root = CreateCylinder(
      `prop:${id}`,
      { diameter: 0.28, height: 0.6, tessellation: 9 },
      scene,
    )
    root.material = materialFor(scene, '#6b4a2b')
    for (const end of [-1, 1]) {
      const cap = CreateCylinder(
        `prop:${id}:cap${end}`,
        { diameter: 0.24, height: 0.02, tessellation: 9 },
        scene,
      )
      cap.parent = root
      cap.position.y = end * 0.3
      cap.material = materialFor(scene, '#c8a878')
    }
    const knot = CreateCylinder(
      `prop:${id}:knot`,
      { diameter: 0.07, height: 0.06, tessellation: 6 },
      scene,
    )
    knot.parent = root
    knot.position.set(0.13, 0.1, 0)
    knot.rotation.z = Math.PI / 2
    knot.material = materialFor(scene, '#584022')
    root.rotationQuaternion = new Quaternion()
    return root
  }
  return null
}

/**
 * Resource node visuals (root mesh at ground pos): faceted low-poly shapes, each node a little different (size, turn,
 * shade) from a hash of its id. They were a cylinder under a round sphere and plain boxes.
 */
function buildNodeVisual(
  scene: Scene,
  id: string,
  visual: 'tree' | 'rock' | 'scrap' | 'branches' | 'stones',
): Mesh {
  const root = CreateBox(`res:${id}:root`, { size: 0.01 }, scene)
  root.isVisible = false
  const r = (salt: number): number => hash01(id, salt)
  switch (visual) {
    case 'tree': {
      // Instances of one trunk, canopy and stump per scene: the island's ~200 trees draw in one call per part.
      const parts = treeParts(scene)
      const trunk = parts.trunk.createInstance(`res:${id}`)
      trunk.position.y = 1.6
      trunk.rotation.y = r(1) * Math.PI * 2
      trunk.scaling.setAll(0.85 + 0.4 * r(2))
      trunk.parent = root
      const shade = TREE_SHADES[Math.floor(r(3) * TREE_SHADES.length)]!
      const canopy = parts.canopy.createInstance(`res:${id}:canopy`)
      canopy.parent = trunk
      canopy.position.y = 1.85
      canopy.scaling.set(1, 0.8 + 0.3 * r(4), 1)
      canopy.instancedBuffers.color = shade
      const tuft = parts.canopy.createInstance(`res:${id}:canopy2`)
      tuft.parent = trunk
      tuft.position.set((r(5) - 0.5) * 1.4, 1.15 + 0.4 * r(6), (r(7) - 0.5) * 1.4)
      tuft.scaling.setAll(0.55 + 0.2 * r(8))
      tuft.instancedBuffers.color = shade
      // Chopped-down state: the standing tree is replaced by a stump (the
      // trunk itself falls as a physical prop spawned by the server).
      const stump = parts.stump.createInstance(`res:${id}:stump`)
      stump.position.y = 0.22
      stump.parent = root
      stump.setEnabled(false)
      break
    }
    case 'rock': {
      const rock = CreateIcoSphere(`res:${id}`, { radius: 0.8, subdivisions: 1 }, scene)
      rock.scaling.set(1 + 0.3 * r(1), 0.7 + 0.2 * r(2), 0.9 + 0.3 * r(3))
      rock.position.y = 0.42
      rock.rotation.y = hashAngle(id)
      rock.material = materialFor(scene, '#7b7f83')
      rock.parent = root
      break
    }
    case 'scrap':
      cluster(
        scene,
        id,
        root,
        '#5e6a70',
        3,
        (k) => CreateBox(`res:${id}:${k}`, { width: 0.55, height: 0.32, depth: 0.4 }, scene),
        0.3,
      )
      break
    case 'branches':
      cluster(
        scene,
        id,
        root,
        '#7a5a34',
        4,
        (k) => {
          const b = CreateCylinder(
            `res:${id}:${k}`,
            { diameter: 0.1, height: 1.1, tessellation: 5 },
            scene,
          )
          b.rotation.z = Math.PI / 2
          return b
        },
        0.1,
      )
      break
    case 'stones':
      cluster(
        scene,
        id,
        root,
        '#8a8d90',
        4,
        (k) => CreateIcoSphere(`res:${id}:${k}`, { radius: 0.17, subdivisions: 1 }, scene),
        0.12,
      )
      break
  }
  return root
}

/** A small pile: `count` pieces scattered and turned by the node's hash, merged into one mesh (one draw call). */
function cluster(
  scene: Scene,
  id: string,
  root: Mesh,
  color: string,
  count: number,
  piece: (k: number) => Mesh,
  y: number,
): void {
  const pieces: Mesh[] = []
  for (let k = 0; k < count; k++) {
    const m = piece(k)
    const a = hash01(id, 10 + k) * Math.PI * 2
    const d = 0.12 + 0.2 * hash01(id, 20 + k)
    m.position.set(Math.cos(a) * d, y + 0.08 * k, Math.sin(a) * d)
    m.rotation.y = hash01(id, 30 + k) * Math.PI * 2
    pieces.push(m)
  }
  const merged = Mesh.MergeMeshes(pieces, true) ?? pieces[0]!
  merged.name = `res:${id}`
  merged.material = materialFor(scene, color)
  merged.parent = root
}

/** Canopy greens (a late-summer one now and then), one per tree. */
const TREE_SHADES = ['#3e6b34', '#4a7a3a', '#365e2e', '#557f3a', '#44703a', '#7d7a35'].map(
  (hex) => {
    const c = Color3.FromHexString(hex)
    return new Color4(c.r, c.g, c.b, 1)
  },
)

/** A stable number in [0, 1) from a node id and a salt. */
function hash01(id: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** The source meshes every tree instances (hidden themselves; one set per scene). */
const treePartSets = new WeakMap<Scene, { trunk: Mesh; canopy: Mesh; stump: Mesh }>()
function treeParts(scene: Scene): { trunk: Mesh; canopy: Mesh; stump: Mesh } {
  let set = treePartSets.get(scene)
  if (set) return set
  const trunk = CreateCylinder(
    'tree:trunk',
    { diameterTop: 0.34, diameterBottom: 0.62, height: 3.2, tessellation: 7 },
    scene,
  )
  trunk.convertToFlatShadedMesh()
  trunk.material = materialFor(scene, '#6d4c2a')
  // The canopy is white; each instance's colour buffer tints it.
  const canopy = CreateIcoSphere('tree:canopy', { radius: 1.45, subdivisions: 1 }, scene)
  canopy.material = materialFor(scene, '#ffffff')
  canopy.registerInstancedBuffer('color', 4)
  canopy.instancedBuffers.color = TREE_SHADES[0]!
  const stump = CreateCylinder(
    'tree:stump',
    { diameter: 0.7, height: 0.45, tessellation: 7 },
    scene,
  )
  stump.material = materialFor(scene, '#5c3f24')
  for (const m of [trunk, canopy, stump]) {
    m.isVisible = false // a source draws nothing itself; its instances do
    m.isPickable = false
  }
  set = { trunk, canopy, stump }
  treePartSets.set(scene, set)
  return set
}

/** Deterministic pseudo-random yaw so identical piles don't look cloned. */
function hashAngle(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (h % 628) / 100
}

function setDepletedLook(root: Mesh, depleted: boolean): void {
  const stump = root.getChildMeshes().find((m) => m.name.endsWith(':stump'))
  if (stump) {
    // Tree: felled -> stump only; regrown -> full tree back.
    for (const child of root.getChildMeshes()) {
      if (child === stump) child.setEnabled(depleted)
      else child.setEnabled(!depleted)
    }
    return
  }
  const value = depleted ? 0.3 : 1
  for (const child of root.getChildMeshes()) {
    ;(child as Mesh).visibility = value
  }
}

function toPhysicsShape(shape: WorldShape): ShapeDesc {
  switch (shape.type) {
    case 'box':
      return { type: 'box', size: shape.size }
    case 'cylinder':
      return { type: 'cylinder', radius: shape.radius, height: shape.height }
    case 'sphere':
      return { type: 'sphere', radius: shape.radius }
  }
}
