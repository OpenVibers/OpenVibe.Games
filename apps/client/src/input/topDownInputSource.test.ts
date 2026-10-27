import { describe, expect, it } from 'vitest'
import type { InputSample, InputSource } from './inputSource.js'
import { TOP_DOWN_AIM_PITCH, TopDownInputSource } from './topDownInputSource.js'

/** The simulation's wish direction (gameplay simulate.ts) for a sample: where the server moves the player. */
function wish(s: InputSample): { x: number; z: number } {
  const sy = Math.sin(s.yaw)
  const cy = Math.cos(s.yaw)
  return { x: cy * s.moveX + sy * s.moveZ, z: -sy * s.moveX + cy * s.moveZ }
}

class Keys implements InputSource {
  moveX = 0
  moveZ = 0
  intents = 0
  readonly yaw = 1.234
  readonly pitch = 0.4
  sample(): InputSample {
    return {
      moveX: this.moveX,
      moveZ: this.moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      intents: this.intents,
    }
  }
}

const close = (a: { x: number; z: number }, b: { x: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.z).toBeCloseTo(b.z, 6)
}

describe('top-down controls', () => {
  it('moves along the screen whichever way the character faces the mouse', () => {
    const keys = new Keys()
    let pointer: { x: number; y: number } | null = { x: 100, y: 0 } // to the right of the player
    const source = new TopDownInputSource(keys, () => pointer)
    keys.moveZ = 1 // W: up the screen, north (+Z)
    let s = source.sample()
    expect(s.yaw).toBeCloseTo(Math.PI / 2, 6) // facing right (+X)
    close(wish(s), { x: 0, z: 1 })
    keys.moveZ = 0
    keys.moveX = -1 // A: left of the screen (-X)
    pointer = { x: 0, y: 80 } // below the player: facing south
    s = source.sample()
    expect(s.yaw).toBeCloseTo(Math.PI, 6)
    close(wish(s), { x: -1, z: 0 })
    expect(s.pitch).toBe(TOP_DOWN_AIM_PITCH)
  })

  it('faces the way it walks without a pointer, keeps facing when still, and passes intents through', () => {
    const keys = new Keys()
    const source = new TopDownInputSource(keys, () => null)
    keys.moveX = 1
    keys.intents = 5
    let s = source.sample()
    expect(s.yaw).toBeCloseTo(Math.PI / 2, 6)
    close(wish(s), { x: 1, z: 0 })
    expect(s.intents).toBe(5)
    keys.moveX = 0
    s = source.sample()
    expect(s.yaw).toBeCloseTo(Math.PI / 2, 6)
    expect(source.yaw).toBeCloseTo(Math.PI / 2, 6)
    expect(source.pitch).toBe(TOP_DOWN_AIM_PITCH)
  })

  it('ignores a pointer sitting on the player itself', () => {
    const keys = new Keys()
    const source = new TopDownInputSource(keys, () => ({ x: 2, y: -3 }))
    expect(source.sample().yaw).toBe(0)
  })
})
