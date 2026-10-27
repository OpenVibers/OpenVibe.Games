import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { hullHeightFor } from '@openvibe/gameplay'
import type { LocalPlayer } from '../game/localPlayer.js'
import type { ClientState } from '../state/clientState.js'
import type { EntityView } from './entityView.js'

/** Your marker, and everyone else's. */
const SELF = new Color3(0.31, 0.66, 1)
const OTHER = new Color3(0.94, 0.94, 0.9)
const RADIUS = 0.62
/** Just above the feet, so the ground never covers it and the body stands on it. */
const LIFT = 0.04

/**
 * Seen from above (a creator world's top-down view), a person is a few pixels of hair and shoulders. Each player gets a
 * flat ring at their feet with a notch on the side they face: yours in blue, everyone else's in white, so you find
 * yourself and the others at a glance and see which way each one looks. Drawn only in a top-down world, unlit, never
 * picked by the aim ray.
 */
export class TopDownMarkers {
  private readonly markers = new Map<string, TransformNode>()
  private readonly selfMat: StandardMaterial
  private readonly otherMat: StandardMaterial

  constructor(
    private readonly scene: Scene,
    private readonly state: ClientState,
    private readonly view: EntityView,
    private readonly player: LocalPlayer,
  ) {
    this.selfMat = this.material('top-down-self', SELF)
    this.otherMat = this.material('top-down-other', OTHER)
  }

  private material(name: string, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene)
    m.disableLighting = true
    m.emissiveColor = color
    m.diffuseColor = color
    m.specularColor = Color3.Black()
    return m
  }

  /** A ring and, at its front (+Z, the way the owner faces), a notch. */
  private make(id: string, mat: StandardMaterial): TransformNode {
    const root = new TransformNode(`top-down:${id}`, this.scene)
    const path: Vector3[] = []
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2
      path.push(new Vector3(Math.sin(a) * RADIUS, 0, Math.cos(a) * RADIUS))
    }
    const ring = CreateTube(
      `top-down:${id}:ring`,
      { path, radius: 0.06, tessellation: 6 },
      this.scene,
    )
    // A three-sided cylinder lying flat is a triangle seen from above: the notch, pointing forward.
    const notch = CreateCylinder(
      `top-down:${id}:notch`,
      { height: 0.04, diameter: 0.42, tessellation: 3 },
      this.scene,
    )
    notch.position.z = RADIUS + 0.16
    notch.rotation.y = Math.PI / 2
    for (const mesh of [ring, notch]) {
      mesh.material = mat
      mesh.isPickable = false
      mesh.parent = root
    }
    return root
  }

  private markerFor(id: string, mat: StandardMaterial): TransformNode {
    let m = this.markers.get(id)
    if (!m) {
      m = this.make(id, mat)
      this.markers.set(id, m)
    }
    return m
  }

  /** Per frame, after the entity view and the local player moved. */
  update(): void {
    const me = this.markerFor('self', this.selfMat)
    const pos = this.player.renderPos
    me.position.set(pos.x, pos.y - hullHeightFor(this.player.move.stance) / 2 + LIFT, pos.z)
    me.rotation.y = this.player.viewYaw
    for (const [id, e] of this.state.entities) {
      if (e.kind !== 'player' || id === this.state.myEntityId) continue
      const avatar = this.view.avatarFor(id)
      if (!avatar) continue
      const m = this.markerFor(id, this.otherMat)
      const feet = avatar.rootPosition
      m.position.set(feet.x, feet.y + LIFT, feet.z)
      m.rotation.y = avatar.yaw
    }
    for (const [id, m] of this.markers)
      if (id !== 'self' && !this.state.entities.has(id)) {
        m.dispose()
        this.markers.delete(id)
      }
  }
}
