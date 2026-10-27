import { describe, expect, it } from 'vitest'
import { createContent } from '../index.js'
import { emptyMapV2, type MapFileV2 } from '../mapFileV2.js'
import {
  CREATOR_MAP_LIMITS,
  CREATOR_SCRIPT_LIMITS,
  creatorMapIssues,
  creatorScriptsOf,
  creatorPlaceId,
  creatorWorldOf,
  creatorWorldPack,
  starterCreatorMap,
  STARTER_GROUND_ID,
} from './creatorWorld.js'
import { parseMapFile } from '../mapFileV2.js'

describe('creator worlds', () => {
  it('maps world ids to places and back, refusing anything else', () => {
    expect(creatorPlaceId('wabc123def0')).toBe('world:wabc123def0')
    expect(creatorWorldOf('world:wabc123def0')).toBe('wabc123def0')
    expect(creatorWorldOf('world:WABC123DEF0')).toBeNull()
    expect(creatorWorldOf('world:wabc')).toBeNull()
    expect(creatorWorldOf('scraplandia')).toBeNull()
    expect(creatorWorldOf(undefined)).toBeNull()
    expect(() => creatorWorldPack('../etc')).toThrow(/creator world id/)
  })

  it('builds the same def set on server and client, one per world, never Scraplandia’s', () => {
    const a = createContent([], creatorWorldPack('w0000000001'))
    expect(createContent([], creatorWorldPack('w0000000001')).digest).toBe(a.digest)
    expect(createContent([], creatorWorldPack('w0000000002')).digest).not.toBe(a.digest)
    expect(createContent().digest).not.toBe(a.digest)
    expect(a.world.id).toBe('creator_w0000000001')
    expect(a.world.zones).toEqual([])
  })

  it('starts a new world on flat ground over the whole play area, inside the creator limits', () => {
    const map = starterCreatorMap()
    const parsed = parseMapFile(JSON.parse(JSON.stringify(map)))
    expect(parsed.ok).toBe(true)
    const bytes = new TextEncoder().encode(JSON.stringify(map)).length
    expect(creatorMapIssues(map, bytes)).toEqual([])
    expect(bytes).toBeLessThan(64 * 1024)
    const ground = map.terrains[0]
    expect(map.terrains).toHaveLength(1)
    expect(ground).toMatchObject({ id: STARTER_GROUND_ID, pos: [0, 0, 0], halfExtent: 80, sub: 80 })
    // Every sample at height 0: the ground the spawn point (y 1.2) falls onto, above the sea.
    const heights = new Float32Array(
      Uint8Array.from(atob(ground?.heights ?? ''), (c) => c.charCodeAt(0)).buffer,
    )
    expect(heights.length).toBe(81 * 81)
    expect(heights.every((h) => h === 0)).toBe(true)
    expect(creatorWorldPack('w0000000001').map.groundHalfExtent).toBe(ground?.halfExtent)
  })

  it('takes a plain map and refuses uploads, paint and oversized maps', () => {
    const plain: MapFileV2 = emptyMapV2()
    expect(creatorMapIssues(plain, 200)).toEqual([])
    const uploads: MapFileV2 = {
      ...plain,
      textures: [{ name: 'photo', url: '/map-assets/abc.png' }],
      models: [{ id: 'm', name: 'm', glb: '/map-assets/m.glb', bounds: [1, 1, 1] }],
    }
    const issues = creatorMapIssues(uploads, CREATOR_MAP_LIMITS.bytes + 1)
    expect(issues.some((i) => i.startsWith('bytes:'))).toBe(true)
    expect(issues.some((i) => i.startsWith('textures:'))).toBe(true)
    expect(issues.some((i) => i.startsWith('models:'))).toBe(true)
    const lights = Array.from({ length: CREATOR_MAP_LIMITS.lights + 1 }, (_, n) => ({
      ...(plain.lights[0] ?? {}),
      id: `l${n}`,
    })) as MapFileV2['lights']
    expect(creatorMapIssues({ ...plain, lights }, 10).some((i) => i.startsWith('lights:'))).toBe(
      true,
    )
    const painted = {
      ...plain,
      statics: [
        {
          id: 's',
          surface: {
            base: {},
            paint: {
              layers: [{ id: 'l', tex: 'none', color: '#ffffff', channel: 'r' }],
              mask: 'm',
            },
          },
        },
      ],
    } as unknown as MapFileV2
    expect(creatorMapIssues(painted, 10).some((i) => i.startsWith('statics:'))).toBe(true)
  })

  it("checks a world's scripts like an installed pack's, within the creator limits, and grants what each asks", () => {
    const mod = {
      format: 'games-quickjs@1',
      id: 'hello',
      version: '1.0.0',
      entry: 'main.js',
      source: 'export function onTick() {}',
      hooks: ['onTick'],
    }
    expect(creatorScriptsOf([])).toEqual({ scripts: [], issues: [] })
    expect(creatorScriptsOf('nope').issues).toEqual(['scripts: a list of games-quickjs@1 mods'])
    const one = creatorScriptsOf([
      { ...mod, capabilities: ['storage.kv'], granted: ['player.message'] },
    ])
    expect(one.issues).toEqual([])
    expect(one.scripts[0]?.granted).toEqual(['storage.kv'])
    expect(creatorScriptsOf([mod]).scripts[0]?.granted).toEqual(['players.read', 'world.emit'])
    expect(creatorScriptsOf([{ ...mod, budgets: { cpuMs: 9999 } }]).issues[0]).toMatch(
      /^scripts\[0\]\.budgets\.cpuMs/,
    )
    expect(creatorScriptsOf([{ ...mod, extra: 1 }]).issues.length).toBeGreaterThan(0)
    expect(
      creatorScriptsOf([
        { ...mod, source: undefined, files: { 'main.js': "import x from 'fs'" } },
      ]).issues.some((i) => i.includes('fs')),
    ).toBe(true)
    const many = Array.from({ length: CREATOR_SCRIPT_LIMITS.mods + 1 }, (_, i) => ({
      ...mod,
      id: `m${i}`,
    }))
    expect(creatorScriptsOf(many).issues[0]).toMatch(/more than the 4/)
    expect(creatorScriptsOf(many).scripts).toEqual([])
    // A world with scripts is a def set with them, on both sides.
    const content = createContent([{ mods: one.scripts }], creatorWorldPack('wk3j9x0a2bq'))
    expect(content.allMods().map((m) => m.id)).toEqual(['hello'])
    expect(content.digest).not.toBe(createContent([], creatorWorldPack('wk3j9x0a2bq')).digest)
  })
})
