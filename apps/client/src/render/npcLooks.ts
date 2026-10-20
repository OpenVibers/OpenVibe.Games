import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { HAIR_STYLES, type Appearance } from '@openvibe/protocol'
import { materialFor } from './sceneSetup.js'

/**
 * How NPCs look. People (wardens, townsfolk, Rustjaw) are the players' own
 * low-poly avatar, dressed by their archetype and varied by their id, so they
 * walk, turn and flinch like players; animals get a small faceted body. NPCs
 * used to be a tinted box with a box head.
 */

/** A stable number in [0, 1) from an entity id and a salt. */
function hash01(id: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
const pick = <T>(id: string, salt: number, options: readonly T[]): T =>
  options[Math.floor(hash01(id, salt) * options.length)]!

/** Palette indices (render/avatar/palettes.ts) each archetype dresses in. */
const DRESS: Record<
  string,
  { top: number[]; bottom: number[]; shoes: number[]; build: [number, number] }
> = {
  // Wardens: denim or dark slate over charcoal, a little broader.
  city_warden: { top: [7, 3], bottom: [9], shoes: [9], build: [1.05, 1.15] },
  // Townsfolk: everyday colours.
  townsfolk: { top: [0, 1, 4, 5, 8], bottom: [1, 2, 4, 7], shoes: [2, 4, 9], build: [0.9, 1.05] },
  // Rustjaw: rust and charcoal, scrappy.
  rustjaw_thug: { top: [6], bottom: [3, 9], shoes: [9], build: [1, 1.12] },
}

/** The avatar an NPC of `archetype` wears, or null for an animal. Stable per entity id. */
export function npcAppearance(archetype: string, id: string): Appearance | null {
  const dress = DRESS[archetype]
  if (!dress) return null
  const body = hash01(id, 1) < 0.5 ? 'male' : 'female'
  return {
    body,
    skin: Math.floor(hash01(id, 2) * 8),
    hairStyle:
      archetype === 'rustjaw_thug'
        ? pick(id, 3, ['buzz', 'bald', 'messy'] as const)
        : pick(id, 3, HAIR_STYLES),
    hairColor: Math.floor(hash01(id, 4) * 8),
    facialHair:
      body === 'male'
        ? pick(
            id,
            5,
            archetype === 'rustjaw_thug'
              ? (['full', 'goatee'] as const)
              : (['none', 'none', 'mustache', 'goatee', 'full'] as const),
          )
        : 'none',
    top: pick(id, 6, dress.top),
    bottom: pick(id, 7, dress.bottom),
    shoes: pick(id, 8, dress.shoes),
    height: 0.95 + hash01(id, 9) * 0.1,
    build: dress.build[0] + hash01(id, 10) * (dress.build[1] - dress.build[0]),
  }
}

/**
 * A small faceted animal facing +z, its feet at -halfHeight (the entity's
 * position is its centre): body, head and ears in `color`, a pale tail.
 */
export function buildCritter(scene: Scene, name: string, color: string, halfHeight: number): Mesh {
  const floor = -halfHeight
  const body = CreateIcoSphere(`${name}:body`, { radius: 0.5, subdivisions: 1 }, scene)
  body.scaling.set(0.26, 0.26, 0.42)
  body.position.set(0, floor + 0.14, -0.02)
  const head = CreateIcoSphere(`${name}:head`, { radius: 0.5, subdivisions: 1 }, scene)
  head.scaling.set(0.17, 0.16, 0.2)
  head.position.set(0, floor + 0.26, 0.2)
  const ears = [-1, 1].map((side) => {
    const ear = CreateBox(`${name}:ear`, { width: 0.045, height: 0.17, depth: 0.06 }, scene)
    ear.position.set(side * 0.04, floor + 0.4, 0.15)
    ear.rotation.set(-0.35, 0, side * 0.18)
    return ear
  })
  const merged = Mesh.MergeMeshes([body, head, ...ears], true, true) ?? body
  merged.name = name
  merged.convertToFlatShadedMesh()
  merged.material = materialFor(scene, color)
  const tail = CreateIcoSphere(`${name}:tail`, { radius: 0.05, subdivisions: 1 }, scene)
  tail.position.set(0, floor + 0.17, -0.22)
  tail.material = materialFor(scene, '#ece6da')
  tail.parent = merged
  return merged
}
