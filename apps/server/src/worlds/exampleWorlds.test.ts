import { creatorMapIssues, parseMapFile } from '@openvibe/content'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_WORLDS } from './exampleWorlds.js'

/**
 * The two official example worlds must be documents the editor would save and the creator-world gate
 * would accept: valid v2 maps, under the creator limits, using only the built-in materials, with a spawn
 * on the map and the editor's own toolbox represented (terrain, statics, props, nodes, lights, zones).
 */
describe('the official example creator worlds', () => {
  it('are two worlds with distinct titles and summaries', () => {
    expect(EXAMPLE_WORLDS.map((w) => w.title)).toEqual(['Beacon Hill', 'The Workshop'])
    expect(new Set(EXAMPLE_WORLDS.map((w) => w.title)).size).toBe(2)
    for (const w of EXAMPLE_WORLDS) expect(w.summary.length).toBeGreaterThan(40)
  })

  for (const world of EXAMPLE_WORLDS) {
    it(`"${world.title}" is a map the creator-world gate accepts`, () => {
      const bytes = Buffer.byteLength(JSON.stringify(world.map))
      const parsed = parseMapFile(world.map)
      expect(parsed.ok, parsed.ok ? '' : (parsed as { issues: string[] }).issues.join('; ')).toBe(true)
      if (!parsed.ok) return
      expect(creatorMapIssues(parsed.map, bytes)).toEqual([])
      expect(parsed.map.spawn).toBeTruthy()
      expect(parsed.map.v).toBe(2)
    })

    it(`"${world.title}" shows the editor's toolbox`, () => {
      const map = world.map
      expect(map.terrains.length).toBeGreaterThan(0)
      expect(map.statics.length).toBeGreaterThan(8)
      expect(map.props.length).toBeGreaterThan(2)
      expect(map.nodes.length).toBeGreaterThan(1)
      expect(map.lights.length).toBeGreaterThan(1)
      expect(map.zones.length).toBeGreaterThan(0)
      expect(map.npcs).toEqual([])
      expect(map.models).toEqual([])
      expect(map.textures).toEqual([])
    })

    it(`"${world.title}" has an id for every editable object, and no duplicates`, () => {
      const ids = [
        ...world.map.terrains.map((t) => t.id),
        ...world.map.statics.map((s) => s.id),
        ...world.map.props.map((p) => p.id),
        ...world.map.nodes.map((n) => n.id),
        ...world.map.lights.map((l) => l.id),
        ...world.map.zones.map((z) => z.id),
      ]
      expect(new Set(ids).size).toBe(ids.length)
    })
  }
})
