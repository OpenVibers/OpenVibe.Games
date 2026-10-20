import '@babylonjs/core/Meshes/thinInstanceMesh.js' // thinInstanceSetBuffer() needs its side effect
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { HitMaterial } from '../audio/sfx.js'

/**
 * What flies off a hit: wood chips off a tree, grit off a rock, sparks off
 * scrap, leaves off a bush. A hit used to change nothing on screen until the
 * server's reply moved a count, so a swing felt like it went through.
 *
 * Two thin-instanced meshes (lit chips, unlit sparks) hold every particle:
 * two draw calls however many are flying, nothing allocated per hit.
 */

const MAX = 96
const GRAVITY = 12

interface Particle {
  pos: Vector3
  vel: Vector3
  axis: Vector3
  angle: number
  spin: number
  size: number
  age: number
  life: number
  gravity: number
  color: [number, number, number]
}

interface Kind {
  count: number
  colors: string[]
  spark?: boolean
  speed: number
  size: number
  life: number
  gravity: number
}

const KINDS: Record<Exclude<HitMaterial, 'flesh'>, Kind> = {
  wood: {
    count: 9,
    colors: ['#8a5a2b', '#a87437', '#6d4c2a', '#c49a62'],
    speed: 2,
    size: 0.045,
    life: 0.7,
    gravity: 1,
  },
  stone: {
    count: 8,
    colors: ['#8d8d88', '#a3a39e', '#6f6f6a'],
    speed: 2.3,
    size: 0.035,
    life: 0.55,
    gravity: 1,
  },
  metal: {
    count: 10,
    colors: ['#ffd27a'],
    spark: true,
    speed: 4.5,
    size: 0.025,
    life: 0.35,
    gravity: 0.6,
  },
  plant: {
    count: 6,
    colors: ['#4a7a3a', '#5d8f3f', '#7d9a45'],
    speed: 1.2,
    size: 0.045,
    life: 0.9,
    gravity: 0.3,
  },
}

export class HitChips {
  private readonly chips: Pool
  private readonly sparks: Pool

  constructor(scene: Scene) {
    const chipMat = new StandardMaterial('fx:chips', scene)
    chipMat.diffuseColor = Color3.White()
    chipMat.specularColor = new Color3(0.05, 0.05, 0.05)
    const sparkMat = new StandardMaterial('fx:sparks', scene)
    sparkMat.disableLighting = true
    sparkMat.emissiveColor = new Color3(1, 0.78, 0.35)
    this.chips = new Pool(scene, 'fx:chips', chipMat, true)
    this.sparks = new Pool(scene, 'fx:sparks', sparkMat, false)
  }

  /**
   * Throws a burst off `point`, out to the sides and up from the surface
   * `normal`. Nothing flies toward `eye` (the camera), and a hit right in
   * front of it throws smaller pieces. Hits on people throw nothing.
   */
  burst(point: Vector3Like, normal: Vector3Like, material: HitMaterial, eye?: Vector3Like): void {
    if (material === 'flesh') return
    const kind = KINDS[material]
    const pool = kind.spark ? this.sparks : this.chips
    const n = new Vector3(normal.x, normal.y, normal.z)
    if (n.lengthSquared() < 1e-6) n.set(0, 1, 0)
    n.normalize()
    const toEye = eye ? new Vector3(eye.x - point.x, eye.y - point.y, eye.z - point.z) : null
    const near = toEye ? Math.min(1, toEye.length() / 1.5) : 1
    toEye?.normalize()
    for (let i = 0; i < kind.count; i++) {
      const hex = kind.colors[Math.floor(Math.random() * kind.colors.length)]!
      const c = Color3.FromHexString(hex)
      const spread = new Vector3(
        Math.random() - 0.5,
        Math.random() * 0.8,
        Math.random() - 0.5,
      ).scaleInPlace(2)
      const speed = kind.speed * (0.6 + Math.random() * 0.6)
      const vel = n
        .scale(0.45)
        .addInPlace(spread)
        .normalize()
        .scaleInPlace(speed)
        .addInPlace(new Vector3(0, 1.2, 0))
      if (toEye) {
        const toward = Vector3.Dot(vel, toEye)
        if (toward > 0) vel.subtractInPlace(toEye.scale(toward))
      }
      pool.add({
        pos: new Vector3(point.x, point.y, point.z).addInPlace(n.scale(0.05)),
        vel,
        axis: new Vector3(
          Math.random() - 0.5,
          Math.random() - 0.5,
          Math.random() - 0.5,
        ).normalize(),
        angle: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 18,
        size: kind.size * (0.6 + Math.random() * 0.8) * Math.max(0.35, near),
        age: 0,
        life: kind.life * (0.7 + Math.random() * 0.6),
        gravity: GRAVITY * kind.gravity,
        color: [c.r, c.g, c.b],
      })
    }
  }

  update(dt: number): void {
    this.chips.update(dt)
    this.sparks.update(dt)
  }
}

interface Vector3Like {
  x: number
  y: number
  z: number
}

/** One thin-instanced cube and the particles it draws, the live ones packed at the front. */
class Pool {
  private readonly mesh: Mesh
  private readonly live: Particle[] = []
  private readonly matrices = new Float32Array(MAX * 16)
  private readonly colors: Float32Array | null
  private readonly m = new Matrix()
  private readonly q = new Quaternion()
  private readonly s = new Vector3()

  constructor(scene: Scene, name: string, material: StandardMaterial, colored: boolean) {
    this.mesh = CreateBox(name, { size: 1 }, scene)
    this.mesh.material = material
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true // particles fly outside the unit box's bounds
    this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false)
    this.colors = colored ? new Float32Array(MAX * 4).fill(1) : null
    if (this.colors) this.mesh.thinInstanceSetBuffer('color', this.colors, 4, false)
    this.mesh.thinInstanceCount = 0
    // With no thin instances a mesh draws itself: a metre cube at the origin.
    this.mesh.isVisible = false
  }

  add(p: Particle): void {
    if (this.live.length >= MAX) this.live.shift()
    this.live.push(p)
  }

  update(dt: number): void {
    if (this.live.length === 0 && this.mesh.thinInstanceCount === 0) return
    let w = 0
    for (const p of this.live) {
      p.age += dt
      if (p.age >= p.life) continue
      p.vel.y -= p.gravity * dt
      p.pos.addInPlaceFromFloats(p.vel.x * dt, p.vel.y * dt, p.vel.z * dt)
      p.angle += p.spin * dt
      // Shrink away over the last third of the life.
      const left = 1 - p.age / p.life
      const size = p.size * Math.min(1, left * 3)
      Quaternion.RotationAxisToRef(p.axis, p.angle, this.q)
      this.s.setAll(size)
      Matrix.ComposeToRef(this.s, this.q, p.pos, this.m)
      this.m.copyToArray(this.matrices, w * 16)
      if (this.colors) this.colors.set([p.color[0], p.color[1], p.color[2], 1], w * 4)
      this.live[w++] = p
    }
    this.live.length = w
    this.mesh.thinInstanceCount = w
    this.mesh.isVisible = w > 0
    this.mesh.thinInstanceBufferUpdated('matrix')
    if (this.colors) this.mesh.thinInstanceBufferUpdated('color')
  }
}
