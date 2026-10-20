/**
 * Hit particles live in two thin-instanced meshes. What must hold: a hit
 * throws its burst, the burst falls and is gone within a second, an empty
 * pool draws nothing (a mesh with no thin instances would draw itself, a
 * metre cube at the origin), and a hit on a person throws nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { HitChips } from './hitChips.js'

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
const mesh = (name: string) => scene.getMeshByName(name) as Mesh
const step = (chips: HitChips, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) chips.update(1 / 60)
}

describe('HitChips', () => {
  it('draws nothing until something is hit', () => {
    const chips = new HitChips(scene)
    chips.update(1 / 60)
    for (const name of ['fx:chips', 'fx:sparks']) {
      expect(mesh(name).thinInstanceCount).toBe(0)
      expect(mesh(name).isVisible).toBe(false)
    }
  })

  it('throws wood chips off a tree that fall and are gone within a second', () => {
    const chips = new HitChips(scene)
    chips.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 'wood')
    chips.update(1 / 60)
    const m = mesh('fx:chips')
    expect(m.thinInstanceCount).toBe(9)
    expect(m.isVisible).toBe(true)
    step(chips, 1.2)
    expect(m.thinInstanceCount).toBe(0)
    expect(m.isVisible).toBe(false)
  })

  it('throws sparks, not chips, off scrap', () => {
    const chips = new HitChips(scene)
    chips.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'metal')
    chips.update(1 / 60)
    expect(mesh('fx:sparks').thinInstanceCount).toBe(10)
    expect(mesh('fx:chips').thinInstanceCount).toBe(0)
  })

  it('throws nothing off a person', () => {
    const chips = new HitChips(scene)
    chips.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'flesh')
    chips.update(1 / 60)
    expect(mesh('fx:chips').thinInstanceCount).toBe(0)
    expect(mesh('fx:sparks').thinInstanceCount).toBe(0)
  })

  it('keeps at most 96 in flight, dropping the oldest', () => {
    const chips = new HitChips(scene)
    for (let i = 0; i < 20; i++) chips.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'wood')
    chips.update(1 / 60)
    expect(mesh('fx:chips').thinInstanceCount).toBe(96)
  })
})
