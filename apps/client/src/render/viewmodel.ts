import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import '@babylonjs/loaders/OBJ/objFileLoader.js'
import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js'
import type { ContentRegistry } from '@openvibe/content'
import type { Appearance } from '@openvibe/protocol'
import { createHeldItemNode, type HeldItemNode } from './heldItem.js'
import { outfitColor, skinTone } from './avatar/palettes.js'
import { createTaperedBox } from './avatar/taperedBox.js'
import { materialFor } from './sceneSetup.js'

/**
 * First-person viewmodel: the equipped tool rendered at the camera with
 * smooth sway (mouse lag), movement bob, and equip/swing motions. The
 * physgun uses the imported OBJ + texture; other tools use the procedural
 * props. Purely cosmetic — no gameplay reads anything from here.
 */
export class Viewmodel {
  private readonly rig: TransformNode
  private physgunMeshes: AbstractMesh[] = []
  private toolProp: HeldItemNode | null = null
  private currentItem: string | null = null
  private physgunLoaded = false

  // Motion state
  private swayYaw = 0
  private swayPitch = 0
  private bobPhase = 0
  private equipT = 1
  private swingT = 0

  constructor(
    private readonly scene: Scene,
    private readonly content: ContentRegistry,
    camera: UniversalCamera,
    appearance: Appearance,
  ) {
    this.rig = new TransformNode('viewmodel', scene)
    this.rig.parent = camera
    this.rig.position.set(0.28, -0.32, 0.72)
    this.buildHands(appearance)
    this.applyRenderGroup()
    // The imported OBJ is kept behind a debug flag while its orientation and
    // material are tuned; the procedural physgun matches the art style.
    if (new URLSearchParams(location.search).has('vmobj')) void this.loadPhysgun()
  }

  /**
   * First-person hands in the player's own skin tone: a forearm reaching in
   * from the lower right, gripping under the tool. Shown whenever an item
   * is equipped.
   */
  private hands: TransformNode | null = null

  /**
   * One first-person arm, matching the avatar's clean low-poly look: a
   * single straight chain (mitt fist -> skin wrist -> outfit sleeve) that
   * shares ONE rotation, so there are no open seams or stray flaps. `m`
   * mirrors offsets for the left arm (never negative scaling — that flips
   * winding and culls the mesh). Rig is yawed PI: local +x renders LEFT,
   * local -z is world-forward.
   */
  private buildArm(name: string, appearance: Appearance, m: 1 | -1): TransformNode {
    const skin = skinTone(appearance.skin)
    const sleeve = outfitColor(appearance.top)
    const arm = new TransformNode(name, this.scene)
    // The chain grows DOWNWARD from the fist; tilting the arm node makes the
    // sleeve recede toward the bottom of the screen like a raised guard.
    arm.rotation.set(-1.05, 0.28 * m, 0)

    // Fist: one tapered mitt — slightly narrower at the fingers, like the
    // avatar's hands. Knuckle edge faces up-forward.
    const fist = createTaperedBox(
      `${name}:fist`,
      {
        topWidth: 0.082,
        topDepth: 0.085,
        bottomWidth: 0.092,
        bottomDepth: 0.1,
        height: 0.1,
        anchor: 'top',
      },
      this.scene,
    )
    fist.material = this.armMaterial(skin)
    fist.parent = arm
    fist.position.y = 0.1
    // Thumb: small block sunk INTO the mitt's inner side (reads attached).
    const thumb = createTaperedBox(
      `${name}:thumb`,
      {
        topWidth: 0.028,
        topDepth: 0.05,
        bottomWidth: 0.026,
        bottomDepth: 0.046,
        height: 0.055,
        anchor: 'top',
      },
      this.scene,
    )
    thumb.material = this.armMaterial(skin)
    thumb.parent = arm
    thumb.position.set(-0.05 * m, 0.075, -0.01)

    // Wrist (skin) then sleeve (outfit), tucked with overlap — same axis.
    const wrist = createTaperedBox(
      `${name}:wrist`,
      {
        topWidth: 0.08,
        topDepth: 0.084,
        bottomWidth: 0.084,
        bottomDepth: 0.088,
        height: 0.07,
        anchor: 'top',
      },
      this.scene,
    )
    wrist.material = this.armMaterial(skin)
    wrist.parent = arm
    wrist.position.y = 0.015
    const forearm = createTaperedBox(
      `${name}:sleeve`,
      {
        topWidth: 0.1,
        topDepth: 0.104,
        bottomWidth: 0.115,
        bottomDepth: 0.12,
        height: 0.32,
        anchor: 'top',
      },
      this.scene,
    )
    forearm.material = this.armMaterial(sleeve)
    forearm.parent = arm
    forearm.position.y = -0.04
    return arm
  }

  private readonly armMaterials = new Map<string, StandardMaterial>()
  /**
   * The arm's copy of a world colour, lit a little from within like the tool
   * props, so it reads in shade and at night instead of going brown-black.
   */
  private armMaterial(hex: string): StandardMaterial {
    let mat = this.armMaterials.get(hex)
    if (!mat) {
      const base = materialFor(this.scene, hex)
      mat = base.clone(`${base.name}:vm`)
      mat.emissiveColor = base.diffuseColor.scale(0.3)
      this.armMaterials.set(hex, mat)
    }
    return mat
  }

  private leftFist: TransformNode | null = null
  private rightArm: TransformNode | null = null
  /** Alternating punch: which fist jabs next, and the live thrust node. */
  private punchLeft = false
  private punchingFist: TransformNode | null = null

  private buildHands(appearance: Appearance): void {
    const hands = new TransformNode('vm-hands', this.scene)
    hands.parent = this.rig
    // Local +x renders LEFT on screen (PI-yaw rig): right arm at -x.
    const right = this.buildArm('vm-arm-r', appearance, 1)
    right.parent = hands
    const left = this.buildArm('vm-arm-l', appearance, -1)
    left.parent = hands
    this.rightArm = right
    this.leftFist = left
    this.hands = hands
    this.layoutHands(null)
  }

  /** Armed: the right hand grips the tool (gripTool). Unarmed: boxer guard. */
  private layoutHands(itemDef: string | null): void {
    if (!this.hands || !this.rightArm || !this.leftFist) return
    if (itemDef === null) {
      // Center the guard on screen (cancel the rig's +0.26 offset; local x
      // is mirrored, so PLUS moves left... i.e. toward screen center).
      this.hands.position.set(0.26, 0.05, 0.08)
      this.rightArm.rotationQuaternion = null
      this.rightArm.position.set(-0.24, 0, 0)
      this.rightArm.rotation.set(-1.05, -0.28, 0)
      this.leftFist.position.set(0.24, 0, 0)
      this.leftFist.rotation.set(-1.05, 0.28, 0)
      this.leftFist.setEnabled(true)
    } else {
      this.leftFist.setEnabled(false)
    }
  }

  /**
   * Holds the tool by its grip at HAND_SPOT, the right fist closed around it
   * and the forearm running back out of the lower-right corner of the screen.
   * The fist used to stand upright in front of the tool, a flat skin-coloured
   * block covering the corner, and a gun's grip sat below the screen's edge.
   */
  private gripTool(root: TransformNode, grip: Grip): void {
    if (!this.hands || !this.rightArm) return
    const turn = Matrix.Compose(
      root.scaling,
      Quaternion.FromEulerVector(root.rotation),
      Vector3.Zero(),
    )
    root.position
      .copyFrom(HAND_SPOT)
      .subtractInPlace(Vector3.TransformCoordinates(new Vector3(...grip.at), turn))
    const q = Quaternion.FromUnitVectorsToRef(ARM_DOWN, FOREARM, new Quaternion())
    this.hands.position.setAll(0)
    this.rightArm.rotationQuaternion = q
    // The fist's centre (arm-local y = FIST_CENTRE) sits on the grip.
    const centre = new Vector3(0, FIST_CENTRE, 0).rotateByQuaternionToRef(q, new Vector3())
    this.rightArm.position.copyFrom(HAND_SPOT).subtractInPlace(centre)
  }

  private async loadPhysgun(): Promise<void> {
    try {
      const result = await SceneLoader.ImportMeshAsync('', '/assets/', 'physgun.obj', this.scene)
      const mat = new StandardMaterial('physgun-vm', this.scene)
      mat.diffuseTexture = new Texture('/assets/physgun_tex.jpg', this.scene)
      mat.specularColor = new Color3(0.15, 0.15, 0.15)
      mat.emissiveColor = new Color3(0.25, 0.28, 0.32)
      mat.backFaceCulling = false

      // Normalize: the source model is offset and ~3.7 units long.
      const holder = new TransformNode('physgun-holder', this.scene)
      holder.parent = this.rig
      let min = new Vector3(Infinity, Infinity, Infinity)
      let max = new Vector3(-Infinity, -Infinity, -Infinity)
      for (const m of result.meshes) {
        // World matrices are not up to date right after import — force them,
        // or the bounding box (and thus the normalization scale) is garbage.
        m.computeWorldMatrix(true)
        const b = m.getBoundingInfo()
        b.update(m.getWorldMatrix())
        min = Vector3.Minimize(min, b.boundingBox.minimumWorld)
        max = Vector3.Maximize(max, b.boundingBox.maximumWorld)
      }
      const size = max.subtract(min)
      const scale = 0.3 / Math.max(size.x, size.y, size.z)
      const center = min.add(max).scale(0.5)
      for (const m of result.meshes) {
        m.material = mat
        m.parent = holder
        m.isPickable = false
        this.physgunMeshes.push(m)
      }
      console.log(
        `[vm] physgun size=${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)} scale=${scale.toFixed(4)} center=${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)}`,
      )
      holder.scaling.setAll(scale)
      holder.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
      // Long axis (z) points forward; nudge grip downward into frame.
      // Orientation is empirically tuned (see ?vmrot= debug param).
      const vmrot = Number(new URLSearchParams(location.search).get('vmrot') ?? '180')
      holder.rotation.y = (vmrot * Math.PI) / 180
      this.physgunLoaded = true
      this.setPhysgunVisible(this.currentItem === 'physgun')
      this.applyRenderGroup()
    } catch (err) {
      console.warn('physgun viewmodel failed to load, using fallback', err)
      this.physgunLoaded = false
    }
  }

  private setPhysgunVisible(visible: boolean): void {
    for (const m of this.physgunMeshes) m.isVisible = visible
  }

  triggerSwing(): void {
    this.swingT = 0.32
    if (this.currentItem === null) {
      this.punchLeft = !this.punchLeft
      this.punchingFist = this.punchLeft ? this.leftFist : this.rightArm
    } else {
      this.punchingFist = null
    }
  }

  /** Per-frame update. mouseDx/Dy are this frame's look deltas (radians). */
  update(dt: number, speed: number, grounded: boolean, mouseDx: number, mouseDy: number): void {
    // Equip transition + swing timers
    this.equipT = Math.min(1, this.equipT + dt * 3.1)
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt)

    // Sway: lag behind the view with exponential decay.
    this.swayYaw += (mouseDx * 0.6 - this.swayYaw) * Math.min(1, dt * 10)
    this.swayPitch += (mouseDy * 0.6 - this.swayPitch) * Math.min(1, dt * 10)

    // Bob while moving on the ground.
    if (grounded && speed > 0.3) this.bobPhase += dt * Math.min(speed, 8) * 1.6
    const bobAmp = grounded ? Math.min(speed / 7.2, 1) * 0.012 : 0
    const bobY = Math.abs(Math.sin(this.bobPhase)) * -bobAmp
    const bobX = Math.sin(this.bobPhase * 0.5) * bobAmp * 0.6

    const equipDip = (1 - this.equipT) * -0.5
    const swing = this.swingT > 0 ? Math.sin((this.swingT / 0.32) * Math.PI) : 0

    // Unarmed jab: the active fist snaps straight out (local -z = forward)
    // and recoils; the layout pose is restored as the thrust decays.
    if (this.punchingFist) {
      const thrust = this.currentItem === null ? swing : 0
      this.punchingFist.position.z = -thrust * 0.45
      this.punchingFist.position.y = thrust * 0.04
      // Base guard tilt is -1.05; the jab levels the fist toward the target.
      this.punchingFist.rotation.x = -1.05 + thrust * 0.55
      if (this.swingT <= 0) {
        this.punchingFist.position.z = 0
        this.punchingFist.position.y = 0
        this.punchingFist = null
        this.layoutHands(this.currentItem)
      }
    }

    this.rig.position.set(
      0.26 + bobX - this.swayYaw * 0.15,
      -0.26 + bobY + equipDip - swing * 0.06,
      0.55 + swing * 0.2, // lunge INTO the swing, away from the camera
    )
    // NOTE: under the PI-yaw rig, POSITIVE X rotation tips toward the
    // camera — swings and draw-tilts must pitch NEGATIVE (down-range).
    this.rig.rotation.set(
      -this.swayPitch * 0.8 - swing * 0.8 - (1 - this.equipT) * 0.55,
      Math.PI + this.swayYaw * 0.8 + (1 - this.equipT) * 0.3,
      (1 - this.equipT) * 0.2,
    )
  }

  /** Switch displayed tool when the equipped item changes. */
  setItem(itemDef: string | null): void {
    if (itemDef === this.currentItem) return
    this.currentItem = itemDef
    this.equipT = 0
    // A jab still in flight would reset the arm's pose on top of the grip.
    if (this.punchingFist) {
      this.punchingFist.position.set(this.punchingFist === this.rightArm ? -0.24 : 0.24, 0, 0)
      this.punchingFist = null
    }
    // Hands always show — empty hands are FISTS (you can punch, Minecraft-
    // style). The left guard fist appears only when unarmed.
    if (this.hands) this.hands.setEnabled(true)
    this.layoutHands(itemDef)

    this.toolProp?.dispose()
    this.toolProp = null
    const def = itemDef ? this.content.item(itemDef) : undefined
    const isPhysgun = def?.tool?.kind === 'physgun'
    this.setPhysgunVisible(isPhysgun && this.physgunLoaded)

    if ((!isPhysgun || !this.physgunLoaded) && itemDef) {
      // Viewmodel grip is much smaller than the third-person hand — a
      // crate at 0.34m half a meter from the lens fills the screen.
      this.toolProp = createHeldItemNode(this.scene, this.content, itemDef, 'vm', 0.17)
      if (this.toolProp) {
        this.toolProp.root.parent = this.rig
        const isTool = def?.tool !== undefined
        const grip = GRIPS[isTool ? toolGripKind(def?.tool?.kind) : 'item']
        // The rig is yawed PI (see update()); cancel it on the prop so its
        // +z (muzzle) points AWAY from the camera. Without this the muzzle
        // sat BETWEEN gun and camera and the beam projected wildly off-tip.
        this.toolProp.root.rotation.set(grip.tilt, Math.PI, 0)
        this.toolProp.root.scaling.scaleInPlace(isTool ? 1.05 : 1)
        this.gripTool(this.toolProp.root, grip)
        // Viewmodels sit in the scene's shadow side; self-illuminate them a
        // touch so their shapes read instead of silhouetting to black.
        for (const child of this.toolProp.root.getChildMeshes()) {
          const mesh = child as Mesh
          const mat = mesh.material
          if (mat && 'diffuseColor' in mat && 'emissiveColor' in mat) {
            const clone = (mat as StandardMaterial).clone(`${mat.name}:vm`)
            clone.emissiveColor = (mat as StandardMaterial).diffuseColor.scale(0.45)
            mesh.material = clone
          }
        }
      }
    }
    this.applyRenderGroup()
  }

  /**
   * The whole viewmodel renders in group 1: drawn AFTER world geometry and
   * beams (group 0), so the gun never clips into walls and beams never
   * overlap the gun — they visually emerge from behind its tip.
   */
  private applyRenderGroup(): void {
    for (const m of this.physgunMeshes) m.renderingGroupId = VIEWMODEL_RENDER_GROUP
    // Everything under the rig (tool, both arms) draws in the viewmodel pass.
    for (const child of this.rig.getChildMeshes()) {
      child.renderingGroupId = VIEWMODEL_RENDER_GROUP
    }
  }

  /** World-space beam origin (the tool's muzzle tip). */
  beamOrigin(): Vector3 {
    const node = this.toolProp?.muzzle ?? this.rig
    // The rig hangs off the camera and moves every frame; without a forced
    // world-matrix refresh the cached absolute position lags a frame and the
    // beam visibly detaches from the muzzle.
    node.computeWorldMatrix(true)
    return node.getAbsolutePosition()
  }
}

const VIEWMODEL_RENDER_GROUP = 1

/** Where the right fist closes on a held thing, in its own frame (+z muzzle or head side, +y up), and how far it tips. */
interface Grip {
  at: [number, number, number]
  /** Rotation about the tool's x axis, radians: an axe leans its head away from the camera. */
  tilt: number
}
type GripKind = 'physgun' | 'axe' | 'pickaxe' | 'generic' | 'item'
const GRIPS: Record<GripKind, Grip> = {
  physgun: { at: [0, -0.075, -0.012], tilt: 0 },
  axe: { at: [0, -0.15, 0], tilt: 0.6 },
  pickaxe: { at: [0, -0.15, 0], tilt: 0.6 },
  generic: { at: [0, -0.07, 0.04], tilt: 0 },
  item: { at: [0, -0.07, 0], tilt: 0 },
}
function toolGripKind(kind: string | undefined): GripKind {
  return kind === 'physgun' || kind === 'axe' || kind === 'pickaxe' ? kind : 'generic'
}
/** Where the right fist holds things, in the rig's frame: low in the lower-right of the view, where it shows. */
const HAND_SPOT = new Vector3(0, -0.05, -0.1)
/**
 * The forearm runs from the fist back toward the camera, down and out to the right, whatever the tool's tilt. Rig
 * frame: +z is toward the camera and +x is screen-left.
 */
const FOREARM = new Vector3(-0.32, -0.5, 0.8).normalize()
/** An arm is built fist up, the sleeve hanging below it. */
const ARM_DOWN = new Vector3(0, -1, 0)
/** Arm-local height of the fist's centre (buildArm: the fist spans y 0 to 0.1). */
const FIST_CENTRE = 0.05
