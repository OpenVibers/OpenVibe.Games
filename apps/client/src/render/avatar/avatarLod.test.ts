import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { createContent } from '@openvibe/content'
import { defaultAppearance } from '@openvibe/protocol'
import { Avatar, type AvatarUpdate } from './avatar.js'

let engine: NullEngine
let scene: Scene
let camera: FreeCamera
beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  camera = new FreeCamera('cam', new Vector3(0, 1.6, 0), scene)
  scene.activeCamera = camera
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

const at = (z: number): AvatarUpdate => ({
  dt: 0.016,
  time: 1,
  x: 0,
  y: 0,
  z,
  yaw: 0,
  pitch: 0,
  speed: 2,
  grounded: true,
})
const lodOf = () => scene.getMeshByName('npc:a:lod')
const rigShown = () =>
  scene.meshes.some((m) => m.name.startsWith('npc:a:') && m.name !== 'npc:a:lod' && m.isEnabled())

describe('avatar level of detail', () => {
  it('draws a far avatar as one merged, vertex-coloured mesh and the full rig up close', () => {
    const avatar = new Avatar(scene, createContent(), defaultAppearance(), 'npc:a', true)
    const lod = lodOf()!
    expect(lod).not.toBeNull()
    expect(lod.isVerticesDataPresent(VertexBuffer.ColorKind)).toBe(true)

    avatar.update(at(5))
    expect(lod.isEnabled()).toBe(false)
    expect(rigShown()).toBe(true)

    avatar.update(at(30))
    expect(lod.isEnabled()).toBe(true)
    expect(rigShown()).toBe(false)
    expect(lod.position.z).toBe(30)

    // Hysteresis: between the two distances it stays as it is.
    avatar.update(at(17))
    expect(lod.isEnabled()).toBe(true)
    avatar.update(at(10))
    expect(lod.isEnabled()).toBe(false)
    expect(rigShown()).toBe(true)

    avatar.dispose()
    expect(lodOf()).toBeNull()
  })

  it('builds nothing extra unless asked (the local body and the preview)', () => {
    new Avatar(scene, createContent(), defaultAppearance(), 'npc:a')
    expect(lodOf()).toBeNull()
  })
})
