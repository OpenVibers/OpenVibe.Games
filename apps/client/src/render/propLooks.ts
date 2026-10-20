import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { materialFor } from './sceneSetup.js'

/**
 * What the town's props look like. Every prop used to be its collision shape
 * in one flat colour: the plaza's merchant stalls were purple boxes, crates
 * and barrels plain blocks and cylinders. Each look here is built from a few
 * parts, coloured per vertex and merged into ONE mesh, so a prop is still one
 * draw call. Physics keeps the item's simple shape; this is dressing.
 *
 * Looks are centred on the prop's position (the middle of its shape), like
 * the shape mesh they replace. Returns null for items without one.
 */
export function buildPropLook(scene: Scene, id: string, def: string, color: string): Mesh | null {
  const build = LOOKS[def]
  if (!build) return null
  const parts: Mesh[] = []
  const add = (mesh: Mesh, hex: string, x = 0, y = 0, z = 0): Mesh => {
    mesh.position.set(x, y, z)
    tint(mesh, hex)
    parts.push(mesh)
    return mesh
  }
  const box = (w: number, h: number, d: number, hex: string, x = 0, y = 0, z = 0): Mesh =>
    add(CreateBox('part', { width: w, height: h, depth: d }, scene), hex, x, y, z)
  const cyl = (r: number, h: number, hex: string, x = 0, y = 0, z = 0, tessellation = 12): Mesh =>
    add(CreateCylinder('part', { diameter: r * 2, height: h, tessellation }, scene), hex, x, y, z)
  const glow = build({ box, cyl, add, scene, color })
  const mesh = Mesh.MergeMeshes(parts, true, true)
  if (!mesh) return null
  mesh.name = `prop:${id}`
  mesh.material = materialFor(scene, '#ffffff')
  mesh.rotationQuaternion = new Quaternion()
  if (glow) {
    glow.name = `prop:${id}:glow`
    glow.parent = mesh
  }
  return mesh
}

interface Kit {
  box: (w: number, h: number, d: number, hex: string, x?: number, y?: number, z?: number) => Mesh
  cyl: (
    r: number,
    h: number,
    hex: string,
    x?: number,
    y?: number,
    z?: number,
    tessellation?: number,
  ) => Mesh
  add: (mesh: Mesh, hex: string, x?: number, y?: number, z?: number) => Mesh
  scene: Scene
  color: string
}

/** Each look adds its parts through the kit; one may return an unlit child (a flame) kept out of the merge. */
const LOOKS: Record<string, (k: Kit) => Mesh | void> = {
  metal_barrel: ({ cyl, color }) => {
    cyl(0.3, 0.9, color)
    for (const y of [-0.27, 0.27]) cyl(0.312, 0.05, shade(color, 0.7), 0, y)
    cyl(0.31, 0.03, shade(color, 0.6), 0, 0.44)
    cyl(0.05, 0.02, '#2a2f33', 0.15, 0.455, 0.05, 8) // the bung
  },
  wooden_crate: ({ box, color }) => crate(box, 0.7, 0.7, 0.7, color),
  supply_crate: ({ box, color }) => {
    crate(box, 1, 0.9, 1, '#6a6a48')
    // A painted band and a stencil block on two faces.
    box(1.005, 0.14, 1.005, color, 0, 0.12)
    box(0.3, 0.12, 0.02, '#e8e2d0', 0, -0.12, 0.5)
  },
  storage_box: ({ box, color }) => {
    box(0.86, 0.66, 0.56, color, 0, -0.06)
    box(0.9, 0.12, 0.6, shade(color, 0.8), 0, 0.34) // the lid
    box(0.1, 0.12, 0.03, '#b9a26a', 0, 0.22, 0.3) // the latch
    for (const x of [-0.3, 0.3]) box(0.06, 0.66, 0.58, shade(color, 0.7), x, -0.06)
  },
  planter_box: ({ box, add, scene, color }) => {
    box(1.1, 0.35, 1.1, color)
    box(1, 0.04, 1, '#3e2c1e', 0, 0.16) // soil
    for (const [x, z, r] of [
      [-0.3, -0.25, 0.16],
      [0.25, -0.3, 0.13],
      [-0.2, 0.28, 0.14],
      [0.3, 0.22, 0.17],
      [0.02, 0.02, 0.12],
    ] as const) {
      const leaf = CreateIcoSphere('part', { radius: r, subdivisions: 1 }, scene)
      leaf.scaling.y = 0.8
      add(leaf, r > 0.15 ? '#4f7f3a' : '#5f8f42', x, 0.18 + r * 0.6, z)
    }
  },
  merchant_stall: ({ box, add, scene, color }) => {
    // The counter, its top, four posts and a striped awning in the stall's colour.
    box(1.8, 0.95, 0.9, '#7a5a3a', 0, -0.075)
    box(1.9, 0.06, 1, '#a07a52', 0, 0.43)
    for (const x of [-0.88, 0.88])
      for (const z of [-0.42, 0.42]) box(0.07, 2.1, 0.07, '#5a4028', x, 0.5, z)
    for (let i = 0; i < 6; i++) {
      const strip = box(0.34, 0.05, 1.25, i % 2 ? '#efe6d2' : color, -0.85 + i * 0.34, 1.57, 0.08)
      strip.rotation.x = 0.22
    }
    // Goods on the counter.
    for (const [x, hex] of [
      [-0.55, '#c8402f'],
      [-0.15, '#d9a43a'],
      [0.3, '#5f8f42'],
    ] as const) {
      const pile = CreateIcoSphere('part', { radius: 0.13, subdivisions: 1 }, scene)
      pile.scaling.y = 0.7
      add(pile, hex, x, 0.53, -0.1)
    }
    box(0.3, 0.16, 0.24, '#8a6a42', 0.65, 0.54, 0.1)
  },
  workbench: ({ box, color }) => {
    box(1.2, 0.08, 0.7, shade(color, 1.15), 0, 0.41) // the top
    for (const x of [-0.52, 0.52])
      for (const z of [-0.28, 0.28]) box(0.08, 0.82, 0.08, color, x, -0.04, z)
    box(1.04, 0.05, 0.56, shade(color, 0.85), 0, -0.25) // the shelf
    box(0.16, 0.12, 0.14, '#5b6b73', -0.42, 0.51, 0.22) // a vise
    box(0.42, 0.015, 0.1, '#b8b4ac', 0.2, 0.46, -0.1) // a saw blade
    box(0.12, 0.05, 0.05, '#6d4c2a', -0.03, 0.47, -0.1) // its handle
  },
  copper_still: ({ cyl, add, scene, color }) => {
    cyl(0.4, 0.75, color, 0, -0.17, 0, 14)
    const dome = CreateIcoSphere('part', { radius: 0.38, subdivisions: 2 }, scene)
    dome.scaling.y = 0.55
    add(dome, shade(color, 1.15), 0, 0.2)
    cyl(0.05, 0.3, shade(color, 0.9), 0, 0.45, 0, 8)
    const pipe = cyl(0.035, 0.6, shade(color, 0.85), 0.28, 0.42, 0, 8)
    pipe.rotation.z = -1.1
    for (const y of [-0.45, 0.05]) cyl(0.41, 0.04, shade(color, 0.7), 0, y, 0, 14)
  },
  campfire: ({ cyl, add, scene }) => {
    // Stones in a ring and logs leaning in; the flame is unlit, kept out of the merge.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const stone = CreateIcoSphere('part', { radius: 0.08, subdivisions: 1 }, scene)
      add(stone, i % 2 ? '#7b7f83' : '#8d9195', Math.cos(a) * 0.36, -0.1, Math.sin(a) * 0.36)
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4
      const log = cyl(0.045, 0.5, '#5c3f24', Math.cos(a) * 0.12, -0.04, Math.sin(a) * 0.12, 7)
      log.rotation.set(Math.sin(a) * 1.1, 0, -Math.cos(a) * 1.1)
    }
    cyl(0.16, 0.03, '#2a2220', 0, -0.13, 0, 10) // embers' bed
    const flame = CreateCylinder(
      'flame',
      { diameterTop: 0, diameterBottom: 0.26, height: 0.42, tessellation: 7 },
      scene,
    )
    flame.position.y = 0.1
    const mat = new StandardMaterial('fx:flame', scene)
    mat.disableLighting = true
    mat.emissiveColor = new Color3(1, 0.55, 0.15)
    mat.alpha = 0.9
    flame.material = mat
    flame.isPickable = false
    return flame
  },
}

/** A crate: a slightly inset body with darker edge boards on all twelve edges. */
function crate(box: Kit['box'], w: number, h: number, d: number, hex: string): void {
  const t = Math.min(w, h, d) * 0.1
  box(w - t * 0.6, h - t * 0.6, d - t * 0.6, hex)
  const edge = shade(hex, 0.72)
  for (const sy of [-1, 1])
    for (const sz of [-1, 1]) box(w, t, t, edge, 0, (sy * (h - t)) / 2, (sz * (d - t)) / 2)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) box(t, h, t, edge, (sx * (w - t)) / 2, 0, (sz * (d - t)) / 2)
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) box(t, t, d, edge, (sx * (w - t)) / 2, (sy * (h - t)) / 2, 0)
}

/** Paint every vertex of `mesh` one colour, so merged parts keep theirs under a white material. */
function tint(mesh: Mesh, hex: string): void {
  const c = Color3.FromHexString(hex)
  const n = mesh.getTotalVertices()
  const colors = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b, 1], i * 4)
  mesh.setVerticesData(VertexBuffer.ColorKind, colors)
}

/** A colour scaled brighter (>1) or darker (<1). */
function shade(hex: string, k: number): string {
  const c = Color3.FromHexString(hex)
  return new Color3(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k)).toHexString()
}
