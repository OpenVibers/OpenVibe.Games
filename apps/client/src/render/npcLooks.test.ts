import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { AppearanceSchema } from '@openvibe/protocol'
import { NPC_ARCHETYPES } from '@openvibe/content'
import { buildCritter, npcAppearance } from './npcLooks.js'

describe('npcAppearance', () => {
  it('dresses every person archetype in a valid avatar, the same one for the same NPC', () => {
    for (const arch of ['city_warden', 'townsfolk', 'rustjaw_thug']) {
      for (const id of ['e1', 'e2', 'npc-7f3a']) {
        const look = npcAppearance(arch, id)
        expect(AppearanceSchema.safeParse(look).success).toBe(true)
        expect(npcAppearance(arch, id)).toEqual(look)
      }
    }
  })

  it('keeps wardens in denim or slate and Rustjaw in rust', () => {
    expect([7, 3]).toContain(npcAppearance('city_warden', 'a')!.top)
    expect(npcAppearance('rustjaw_thug', 'b')!.top).toBe(6)
  })

  it('gives animals no avatar, and covers every archetype the content has', () => {
    expect(npcAppearance('dust_hare', 'h')).toBeNull()
    for (const a of NPC_ARCHETYPES) {
      const person = npcAppearance(a.id, 'x') !== null
      expect(person).toBe(a.id !== 'dust_hare')
    }
  })
})

describe('buildCritter', () => {
  it('stands on the ground below its centre', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const hare = buildCritter(scene, 'npc:h', '#9a8a6a', 0.25)
    hare.computeWorldMatrix(true)
    hare.refreshBoundingInfo()
    const { minimum, maximum } = hare.getBoundingInfo().boundingBox
    expect(minimum.y).toBeCloseTo(-0.25, 1)
    expect(maximum.z).toBeGreaterThan(0.2) // the head leads, toward +z
    scene.dispose()
    engine.dispose()
  })
})
