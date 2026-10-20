import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { ITEMS } from '@openvibe/content'
import { buildPropLook } from './propLooks.js'

let engine: NullEngine
let scene: Scene
beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

const DRESSED = [
  'metal_barrel',
  'wooden_crate',
  'supply_crate',
  'storage_box',
  'planter_box',
  'merchant_stall',
  'workbench',
  'copper_still',
  'campfire',
]

describe('buildPropLook', () => {
  it('dresses the town props, each as one vertex-coloured mesh (one draw call)', () => {
    for (const def of DRESSED) {
      expect(ITEMS.some((i) => i.id === def)).toBe(true)
      const look = buildPropLook(scene, 'p1', def, '#7a5a9a')
      expect(look, def).not.toBeNull()
      expect(look!.name).toBe('prop:p1')
      expect(look!.isVerticesDataPresent(VertexBuffer.ColorKind)).toBe(true)
      // Only the campfire keeps a separate (unlit) flame.
      expect(look!.getChildMeshes().length).toBe(def === 'campfire' ? 1 : 0)
      look!.dispose(false, true)
    }
    // The parts were merged away: nothing is left over in the scene.
    expect(scene.meshes.length).toBe(0)
  })

  it('stays near its item shape, centred on the prop', () => {
    for (const def of DRESSED) {
      const item = ITEMS.find((i) => i.id === def)!
      const shape = item.world!.shape
      const half =
        shape.type === 'box'
          ? Math.max(...shape.size) / 2
          : shape.type === 'cylinder'
            ? Math.max(shape.radius, shape.height / 2)
            : shape.radius
      const look = buildPropLook(scene, 'p2', def, '#888888')!
      look.refreshBoundingInfo()
      const { minimum, maximum } = look.getBoundingInfo().boundingBox
      // The stall's posts and awning stand over head height; everything else fits about its shape.
      const reach = def === 'merchant_stall' ? 2 : half * 1.3
      expect(
        Math.max(...maximum.asArray().map(Math.abs), ...minimum.asArray().map(Math.abs)),
        def,
      ).toBeLessThan(reach)
      look.dispose(false, true)
    }
  })

  it('leaves other items to their plain shape', () => {
    expect(buildPropLook(scene, 'p3', 'salvaged_motor', '#888888')).toBeNull()
  })
})
