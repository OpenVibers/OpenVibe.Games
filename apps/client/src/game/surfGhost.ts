import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { DecodedGhost } from '@openvibe/gameplay'

/**
 * A translucent capsule replaying an authoritative ghost track. The track is
 * a recording of server positions/yaw (1 cm, 1/256 turn), so playback is an
 * interpolation, never a re-simulation: no collision and no drift.
 */
export class SurfGhost {
  private readonly mesh: Mesh
  private track: DecodedGhost | null = null
  private visible = true

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateCapsule(
      'surf-ghost',
      { height: 1.8, radius: 0.4, tessellation: 12 },
      scene,
    )
    const material = new StandardMaterial('surf-ghost-material', scene)
    material.diffuseColor = new Color3(0.45, 0.85, 1)
    material.emissiveColor = new Color3(0.15, 0.45, 0.7)
    material.alpha = 0.35
    this.mesh.material = material
    this.mesh.isPickable = false
    this.mesh.setEnabled(false)
  }

  get hasTrack(): boolean {
    return this.track !== null
  }

  setTrack(track: DecodedGhost): void {
    this.track = track
    this.mesh.setEnabled(this.visible)
  }

  clear(): void {
    this.track = null
    this.mesh.setEnabled(false)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.mesh.setEnabled(visible && this.track !== null)
  }

  toggle(): boolean {
    this.setVisible(!this.visible)
    return this.visible
  }

  /** Place the capsule at `elapsedMs` into the recorded run. */
  update(elapsedMs: number): void {
    const track = this.track
    if (!track || !this.visible || track.samples.length === 0) return
    const pos = (elapsedMs / 1000) * track.tickRate
    const i = Math.min(Math.max(Math.floor(pos), 0), track.samples.length - 1)
    const j = Math.min(i + 1, track.samples.length - 1)
    const f = Math.min(Math.max(pos - i, 0), 1)
    const a = track.samples[i]!
    const b = track.samples[j]!
    this.mesh.position.set(
      a.x + (b.x - a.x) * f,
      a.y + (b.y - a.y) * f,
      a.z + (b.z - a.z) * f,
    )
    let dy = b.yaw - a.yaw
    if (dy > Math.PI) dy -= Math.PI * 2
    if (dy < -Math.PI) dy += Math.PI * 2
    this.mesh.rotation.y = a.yaw + dy * f
  }
}
