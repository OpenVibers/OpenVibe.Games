import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { Matrix } from '@babylonjs/core/Maths/math.vector.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * The map's statics, merged for drawing. Scrap City is several hundred static meshes (walls, wall plates, buildings,
 * roofs, doors, stalls), each its own draw call, and the sun's shadow pass drew most of them again: 165 draws in view
 * and 298 shadow casters. Each textured static also had a material of its own, because its texture's scale follows
 * its size.
 *
 * So, after the statics are built, every static whose whole tree is plain (ordinary materials, no lights, no glb
 * model, no paint layers, not reflected by water) is copied with its texture transform baked into its UVs and merged
 * with the others that share its texture and tint in the same CELL-metre square. The sources stay, disabled, under
 * their ids: a live map save unbatches, rebuilds what changed and batches again.
 */

/** Batches are this many metres square, so a batch outside the view is still culled. */
const CELL = 32
const BATCH_PREFIX = 'mapstatic:batch:'

interface Batched {
  batches: Mesh[]
  sources: AbstractMesh[]
}
const state = new WeakMap<Scene, Batched>()
const materials = new WeakMap<Scene, Map<string, StandardMaterial>>()

/** Merge the eligible map statics (meshes named `mapstatic:<id>`, with their children). */
export function batchMapStatics(scene: Scene): void {
  unbatchMapStatics(scene)
  const groups = new Map<string, { key: string; material: StandardMaterial; parts: Mesh[] }>()
  const sources: AbstractMesh[] = []
  for (const root of [...scene.meshes]) {
    if (!root.name.startsWith('mapstatic:') || root.name.startsWith(BATCH_PREFIX) || root.parent)
      continue
    const tree = [root, ...root.getChildMeshes(false)]
    if (
      !tree.every(plain) ||
      hasLight(root) ||
      (root.metadata as { water?: boolean } | null)?.water
    )
      continue
    for (const mesh of tree) {
      if (!(mesh instanceof Mesh) || !mesh.getTotalVertices() || !mesh.isVisible) continue
      const material = mesh.material as StandardMaterial
      const key = materialKey(material)
      const centre = mesh.getBoundingInfo().boundingSphere.centerWorld
      const cell = `${Math.floor(centre.x / CELL)},${Math.floor(centre.z / CELL)}`
      const groupKey = `${cell}|${key}`
      let group = groups.get(groupKey)
      if (!group) {
        group = { key, material: batchMaterial(scene, key, material), parts: [] }
        groups.set(groupKey, group)
      }
      group.parts.push(bakedCopy(mesh, material))
    }
    root.setEnabled(false)
    sources.push(root)
  }
  const batches: Mesh[] = []
  let n = 0
  for (const group of groups.values()) {
    const merged = Mesh.MergeMeshes(group.parts, true, true)
    if (!merged) continue
    merged.name = `${BATCH_PREFIX}${n++}`
    merged.material = group.material
    merged.isPickable = false
    merged.receiveShadows = true
    merged.freezeWorldMatrix()
    batches.push(merged)
  }
  state.set(scene, { batches, sources })
}

/** Undo batchMapStatics: drop the batches and show the sources again. */
export function unbatchMapStatics(scene: Scene): void {
  const s = state.get(scene)
  if (!s) return
  for (const b of s.batches) b.dispose(false, false)
  for (const m of s.sources) if (!m.isDisposed()) m.setEnabled(true)
  state.delete(scene)
}

/** A copy of `mesh` in world space, its texture's tiling baked into its UVs, ready to merge. */
function bakedCopy(mesh: Mesh, material: StandardMaterial): Mesh {
  const copy = mesh.clone(`${mesh.name}:baked`, null, true)
  copy.makeGeometryUnique()
  // A clone keeps its source's parent (whatever clone's argument says) and frozen world matrix: either would apply
  // the transform a second time on top of the baked one (a building turned 180° put its roof over the spawn).
  copy.parent = null
  copy.unfreezeWorldMatrix()
  copy.setEnabled(true)
  copy.position.setAll(0)
  copy.rotationQuaternion = null
  copy.rotation.setAll(0)
  copy.scaling.setAll(1)
  copy.bakeTransformIntoVertices(mesh.computeWorldMatrix(true))
  copy.computeWorldMatrix(true)
  const tex = material.diffuseTexture as Texture | null
  if (tex) {
    const uvs = copy.getVerticesData(VertexBuffer.UVKind)
    if (uvs) copy.setVerticesData(VertexBuffer.UVKind, bakeUvs(uvs, tex.getTextureMatrix()))
  }
  // The tint rides on the vertices, so every static with this texture (or none) shares one white material.
  const c = material.diffuseColor
  const colors = new Float32Array(copy.getTotalVertices() * 4)
  for (let i = 0; i < colors.length; i += 4) colors.set([c.r, c.g, c.b, 1], i)
  copy.setVerticesData(VertexBuffer.ColorKind, colors)
  return copy
}

/**
 * Apply a texture matrix to UVs the way the shader does (`textureMatrix * vec4(uv, 1.0, 0.0)`), so the merged mesh
 * can sample an untransformed texture and look the same.
 */
export function bakeUvs(uvs: ArrayLike<number>, m: Matrix): Float32Array {
  const a = m.m
  const out = new Float32Array(uvs.length)
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i]!
    const v = uvs[i + 1]!
    out[i] = a[0]! * u + a[4]! * v + a[8]!
    out[i + 1] = a[1]! * u + a[5]! * v + a[9]!
  }
  return out
}

/** An ordinary material: plain StandardMaterial, at most a diffuse texture (no paint layers, no multi-material). */
function plain(mesh: AbstractMesh): boolean {
  const mat = mesh.material
  if (!mat) return false
  if (mat.getClassName() !== 'StandardMaterial') return false
  const s = mat as StandardMaterial
  return (
    !s.opacityTexture && !s.bumpTexture && !s.emissiveTexture && !s.ambientTexture && s.alpha === 1
  )
}

function hasLight(root: AbstractMesh): boolean {
  return root.getDescendants(false).some((d) => d.getClassName().endsWith('Light'))
}

/** Statics batch by texture alone (their tints are vertex colours): one key per texture, one for plain colour. */
function materialKey(m: StandardMaterial): string {
  const tex = m.diffuseTexture as Texture | null
  return tex ? `${tex.url ?? tex.name}|${tex.hasAlpha ? 1 : 0}` : 'plain'
}

/** One shared white material per key (the vertices carry the tint), with an untransformed copy of the texture. */
function batchMaterial(scene: Scene, key: string, source: StandardMaterial): StandardMaterial {
  const tex = source.diffuseTexture as Texture | null
  let cache = materials.get(scene)
  if (!cache) {
    cache = new Map()
    materials.set(scene, cache)
  }
  let mat = cache.get(key)
  if (!mat) {
    mat = new StandardMaterial(`batch:${cache.size}`, scene)
    mat.maxSimultaneousLights = 8
    mat.diffuseColor = Color3.White()
    mat.specularColor = source.specularColor.clone()
    if (tex) {
      const t = tex.clone()
      t.uScale = 1
      t.vScale = 1
      t.uOffset = 0
      t.vOffset = 0
      t.uAng = 0
      t.vAng = 0
      t.wAng = 0
      mat.diffuseTexture = t
    }
    cache.set(key, mat)
  }
  return mat
}
