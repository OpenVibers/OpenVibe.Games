import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import { bakeUvs, batchMapStatics, unbatchMapStatics } from './staticBatches.js'

let engine: NullEngine
let scene: Scene
let mat: StandardMaterial
beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  mat = new StandardMaterial('m', scene)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

/** A static like renderStaticBody makes: positioned, turned, its world matrix frozen. */
function staticAt(id: string, x: number, y: number, z: number, yaw = 0): Mesh {
  const m = CreateBox(`mapstatic:${id}`, { size: 2 }, scene)
  m.material = mat
  m.position.set(x, y, z)
  m.rotationQuaternion = Quaternion.FromEulerAngles(0, yaw, 0)
  return m
}
const freeze = (m: Mesh) => [m, ...m.getChildMeshes()].forEach((c) => c.freezeWorldMatrix())
const batches = () => scene.meshes.filter((m) => m.name.startsWith('mapstatic:batch:'))
const contains = (m: AbstractMesh, p: Vector3) => {
  m.refreshBoundingInfo(false, false)
  const { minimumWorld: lo, maximumWorld: hi } = m.getBoundingInfo().boundingBox
  return (
    p.x >= lo.x - 0.01 &&
    p.y >= lo.y - 0.01 &&
    p.z >= lo.z - 0.01 &&
    p.x <= hi.x + 0.01 &&
    p.y <= hi.y + 0.01 &&
    p.z <= hi.z + 0.01
  )
}

describe('batchMapStatics', () => {
  it('merges statics where they stand, children of a building turned 180° included', () => {
    const house = staticAt('house', 10, 2, 5, Math.PI)
    const roof = CreateBox('mapstatic:house:roof', { size: 1 }, scene)
    roof.material = mat
    roof.parent = house
    roof.position.y = 3
    freeze(house)
    const wall = staticAt('wall', 12, 1, 6)
    freeze(wall)

    batchMapStatics(scene)
    const [batch, ...rest] = batches()
    expect(rest).toEqual([]) // same material, same 32 m cell: one batch
    expect(batch).toBeDefined()
    expect(contains(batch!, new Vector3(10, 5, 5))).toBe(true) // the roof, on the house
    expect(contains(batch!, new Vector3(0, 7, 0))).toBe(false) // not over the origin
    expect(house.isEnabled()).toBe(false)
    expect(wall.isEnabled()).toBe(false)

    unbatchMapStatics(scene)
    expect(batches()).toEqual([])
    expect(house.isEnabled()).toBe(true)
    expect(roof.isEnabled()).toBe(true)
  })

  it('leaves lamps (a light in the tree) and statics the water reflects as they are', () => {
    const lamp = staticAt('lamp', 0, 2, 0)
    const light = new PointLight('lamp:0', new Vector3(0, 1.9, 0), scene)
    light.parent = lamp
    freeze(lamp)
    const pier = staticAt('pier', 4, 0, 4)
    pier.metadata = { water: true }
    freeze(pier)
    batchMapStatics(scene)
    expect(batches()).toEqual([])
    expect(lamp.isEnabled()).toBe(true)
    expect(pier.isEnabled()).toBe(true)
  })
})

describe('bakeUvs', () => {
  it('applies a texture matrix the way the shader does', () => {
    expect([...bakeUvs([0.25, 0.75], Matrix.Identity())]).toEqual([0.25, 0.75])
    const scale = Matrix.Scaling(2, 3, 1)
    expect([...bakeUvs([1, 1], scale)]).toEqual([2, 3])
  })
})
