import { describe, expect, it } from 'vitest'
import {
  ITEMS,
  NPC_SPAWNS,
  RESOURCE_NODES,
  WATER_LEVEL,
  decodeHeights,
  parseMapFile,
} from '@openvibe/content'
import { ISLAND, generateScrapIsland, makeHeight } from './scrapIsland.js'

const map = generateScrapIsland()

describe('Scrap Island', () => {
  it('is a valid v2 map document, the same thing the editor saves', () => {
    const parsed = parseMapFile(JSON.parse(JSON.stringify(map)))
    expect(parsed.ok ? [] : parsed.issues).toEqual([])
    expect(JSON.stringify(generateScrapIsland())).toBe(JSON.stringify(map))
  })

  it('names only resource nodes and items the content knows, with unique ids', () => {
    const nodeKinds = new Set(RESOURCE_NODES.map((n) => n.id))
    const items = new Set(ITEMS.map((i) => i.id))
    expect(map.nodes.filter((n) => !nodeKinds.has(n.node))).toEqual([])
    expect(map.props.filter((p) => !items.has(p.item))).toEqual([])
    const ids = [...map.statics, ...map.nodes, ...map.props, ...map.lights].map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a world to play in: trees, stone, scrap, food and loot', () => {
    const count = (kind: string): number => map.nodes.filter((n) => n.node === kind).length
    expect(count('oak_tree')).toBeGreaterThan(150)
    expect(count('stone_deposit')).toBeGreaterThan(15)
    expect(count('scrap_pile')).toBeGreaterThan(15)
    expect(count('berry_bush')).toBeGreaterThan(20)
    expect(map.props.filter((p) => p.item === 'merchant_stall')).toHaveLength(4)
    expect(map.statics.length).toBeGreaterThan(300)
    expect(map.lights.length).toBeLessThanOrEqual(8)
    expect(map.statics.filter((s) => s.decor === 'lamp').length).toBeLessThanOrEqual(12)
  })

  it('puts branches and loose stones (no tool needed) inside every gate, in the safe zone', () => {
    const city = map.zones.find((zone) => zone.id === 'scrap-city')!
    for (const [gx, gz] of [
      [0, ISLAND.wall],
      [0, -ISLAND.wall],
      [ISLAND.wall, 0],
      [-ISLAND.wall, 0],
    ] as const) {
      const near = map.nodes.filter((n) => Math.hypot(n.pos[0] - gx, n.pos[2] - gz) < 10)
      expect(near.filter((n) => n.node === 'branch_pile').length).toBeGreaterThanOrEqual(2)
      expect(near.filter((n) => n.node === 'loose_stones').length).toBeGreaterThanOrEqual(2)
      for (const n of near)
        expect(Math.max(Math.abs(n.pos[0]), Math.abs(n.pos[2]))).toBeLessThan(city.max[0])
    }
  })

  it('is an island: land in the middle, sea at the edges, the city flat', () => {
    const t = map.terrains[0]!
    const h = decodeHeights(t.heights)
    const n = t.sub + 1
    const at = (x: number, z: number): number =>
      h[
        Math.round((z + t.halfExtent) / ((2 * t.halfExtent) / t.sub)) * n +
          Math.round((x + t.halfExtent) / ((2 * t.halfExtent) / t.sub))
      ]!
    for (const [x, z] of [
      [-200, -200],
      [200, 200],
      [-200, 200],
      [200, -200],
      [0, 200],
      [0, -200],
    ] as const)
      expect(at(x, z)).toBeLessThan(WATER_LEVEL)
    for (const [x, z] of [
      [0, 0],
      [10, -10],
      [-20, 20],
      [30, 30],
    ] as const)
      expect(at(x, z)).toBeCloseTo(ISLAND.cityGround, 1)
    expect(Math.max(...h)).toBeGreaterThan(18) // Rust Ridge
  })

  it('spawns a new player on dry land inside the safe city, facing the fountain', () => {
    const [x, y, z] = map.spawn!
    expect(y).toBeGreaterThan(WATER_LEVEL + 2)
    const city = map.zones.find((zone) => zone.id === 'scrap-city')!
    expect(city.rules.pvp).toBe(false)
    expect(x > city.min[0] && x < city.max[0] && z > city.min[2] && z < city.max[2]).toBe(true)
    expect(map.spawnYaw).toBe(0) // +z, toward the plaza at the origin
    // Nothing solid at the spawn point.
    const inside = map.statics.filter(
      (s) =>
        s.shape.type === 'box' &&
        Math.abs(s.pos[0] - x) < s.shape.size[0] / 2 &&
        Math.abs(s.pos[2] - z) < s.shape.size[2] / 2 &&
        s.shape.size[1] > 0.5,
    )
    expect(inside).toEqual([])
  })

  it("keeps the content's NPC homes on land and outside the walls, except the town's own", () => {
    const height = makeHeight(20261019)
    for (const s of NPC_SPAWNS) {
      expect(height(s.pos[0], s.pos[2])).toBeGreaterThan(WATER_LEVEL + 0.5)
      const outside = Math.max(Math.abs(s.pos[0]), Math.abs(s.pos[2])) > ISLAND.wall
      expect(outside).toBe(s.archetype !== 'city_warden' && s.archetype !== 'townsfolk')
    }
  })
})
