import { describe, expect, it } from 'vitest'
import {
  SPAWN_OBJECT_ID,
  compileMapFileV2,
  blankHeights,
  canonicalizeMapFile,
  emptyMapV2,
  parseMapFile,
  validateMapFile,
  type MapFileV2,
  type ParsedMap,
} from './mapFileV2.js'

const SUB = 8

describe('empty map', () => {
  it('a brand-new map has no terrain and no geometry at all', () => {
    const m = emptyMapV2()
    expect(m.terrains).toEqual([])
    expect(m.statics).toEqual([])
    expect(m.nodes).toEqual([])
    expect(m.props).toEqual([])
    // No starter island, no hidden ground plane, no terrain:main.
    expect(JSON.stringify(m)).not.toContain('main')
  })
})

describe('parseMapFile', () => {
  it('accepts a v2 map unchanged', () => {
    const r = parseMapFile(emptyMapV2())
    expect(r.ok).toBe(true)
  })

  it('rejects a v1 map and unknown versions and non-objects', () => {
    expect(parseMapFile({ v: 1, halfExtent: 100, sub: SUB, heights: '', statics: [] }).ok).toBe(
      false,
    )
    expect(parseMapFile({ v: 99 }).ok).toBe(false)
    expect(parseMapFile(null).ok).toBe(false)
    expect(parseMapFile('nope').ok).toBe(false)
  })

  it('rejects a zero scale, which would collapse the body', () => {
    const m = emptyMapV2()
    m.terrains.push({
      id: 't1',
      pos: [0, 0, 0],
      scale: [1, 0, 1],
      halfExtent: 8,
      sub: SUB,
      heights: blankHeights(SUB),
    })
    const r = parseMapFile(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join(' ')).toContain('scale')
  })

  it('rejects non-finite transforms', () => {
    const m = emptyMapV2()
    m.terrains.push({
      id: 't1',
      pos: [Number.NaN, 0, 0],
      halfExtent: 8,
      sub: SUB,
      heights: blankHeights(SUB),
    })
    expect(parseMapFile(m).ok).toBe(false)
  })
})

describe('validateMapFile', () => {
  const withTerrain = (over: Partial<MapFileV2['terrains'][number]> = {}): MapFileV2 => {
    const m = emptyMapV2()
    m.terrains.push({
      id: 't1',
      pos: [0, 0, 0],
      halfExtent: 8,
      sub: SUB,
      heights: blankHeights(SUB),
      ...over,
    })
    return m
  }

  it('accepts a clean map', () => {
    expect(validateMapFile(withTerrain())).toEqual([])
  })

  it('catches a height count that disagrees with the resolution', () => {
    const m = withTerrain({ heights: blankHeights(4) })
    expect(validateMapFile(m).join(' ')).toContain('height samples')
  })

  it('catches duplicate ids across kinds', () => {
    const m = withTerrain()
    m.statics.push({
      id: 't1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [0, 0, 0],
      yaw: 0,
      color: '#ffffff',
    })
    expect(validateMapFile(m).join(' ')).toContain('duplicate id')
  })

  it('catches dangling texture, model and paint references', () => {
    const m = withTerrain({
      surface: {
        base: { tex: 'custom:missing' },
        paint: { mask: 'data:x', layers: [{ id: 'l1', tex: 'custom:alsogone', channel: 'r' }] },
      },
    })
    m.statics.push({
      id: 's1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [0, 0, 0],
      yaw: 0,
      color: '#ffffff',
      model: 'no-such-model',
    })
    const issues = validateMapFile(m).join(' ')
    expect(issues).toContain('missing base texture')
    expect(issues).toContain('missing paint texture')
    expect(issues).toContain('missing model')
  })

  it('accepts stock texture names without a registry entry', () => {
    expect(validateMapFile(withTerrain({ surface: { base: { tex: 'red_brick' } } }))).toEqual([])
  })
})

describe('paint layer tint survives the canonical wire', () => {
  // Regression: PaintLayerSchemaV2 once omitted `color`, so Zod stripped the
  // tint on parse. Painting "red brick tinted blue" saved as untinted brick,
  // and a plain-colour layer lost the only property that made it visible.
  const mapWithLayers = (layers: unknown[]): unknown => ({
    ...emptyMapV2(),
    terrains: [
      {
        id: 't1',
        pos: [0, 0, 0],
        halfExtent: 8,
        sub: SUB,
        heights: blankHeights(SUB),
        surface: { base: { tex: 'red_brick' }, paint: { mask: 'data:x', layers } },
      },
    ],
  })

  const parsedLayers = (layers: unknown[]): { tex: string; color?: string | undefined }[] => {
    const r = parseMapFile(mapWithLayers(layers))
    expect(r.ok, r.ok ? '' : r.issues.join(', ')).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    return r.map.terrains[0]!.surface!.paint!.layers
  }

  it('keeps the tint on a textured layer', () => {
    const [l] = parsedLayers([{ id: 'l1', tex: 'red_brick', color: '#3366cc', channel: 'r' }])
    expect(l!.tex).toBe('red_brick')
    expect(l!.color).toBe('#3366cc')
  })

  it('keeps the colour of a plain-colour (tex: none) layer', () => {
    const [l] = parsedLayers([{ id: 'l1', tex: 'none', color: '#00ff00', channel: 'g' }])
    expect(l!.color).toBe('#00ff00')
  })

  it('survives canonicalisation and a second parse', () => {
    const first = parseMapFile(
      mapWithLayers([
        { id: 'l1', tex: 'red_brick', color: '#3366cc', channel: 'r' },
        { id: 'l2', tex: 'none', color: '#00ff00', channel: 'g' },
      ]),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const wire = canonicalizeMapFile(first.map)
    expect(wire).toContain('#3366cc')
    const second = parseMapFile(JSON.parse(wire))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.map.terrains[0]!.surface!.paint!.layers.map((l) => l.color)).toEqual([
      '#3366cc',
      '#00ff00',
    ])
  })

  it('leaves an untinted layer untinted rather than inventing white', () => {
    const [l] = parsedLayers([{ id: 'l1', tex: 'red_brick', channel: 'r' }])
    expect(l!.color).toBeUndefined()
  })

  it('rejects a malformed colour instead of dropping it', () => {
    for (const bad of ['#FFF', '#GGGGGG', 'red', '#3366CC', '#3366cc7f', '']) {
      const r = parseMapFile(
        mapWithLayers([{ id: 'l1', tex: 'red_brick', color: bad, channel: 'r' }]),
      )
      expect(r.ok, `expected "${bad}" to be rejected`).toBe(false)
    }
  })
})

describe('canonicalisation', () => {
  it('is key-order independent, so the revision hash is stable', () => {
    const a = { ...emptyMapV2(), spawn: [1, 2, 3] as [number, number, number] }
    const b = { spawn: [1, 2, 3] as [number, number, number], ...emptyMapV2() }
    expect(canonicalizeMapFile(a)).toBe(canonicalizeMapFile(b))
  })

  it('drops undefined members instead of emitting them', () => {
    const m = emptyMapV2()
    ;(m as unknown as Record<string, unknown>)['spawnYaw'] = undefined
    expect(canonicalizeMapFile(m)).not.toContain('spawnYaw')
  })
})

describe('stable document ids', () => {
  // Array position is not identity: delete the object ahead of you and every
  // index behind it means something else. Selection, history, collaboration
  // locks and live reconciliation all key on ids, so v2 requires them and
  // anything that predates the rule gets one on the way in.
  it('assigns ids to v2 objects that never had one', () => {
    const r = parseMapFile({
      v: 2,
      terrains: [],
      statics: [
        { shape: { type: 'box', size: [1, 1, 1] }, pos: [0, 0, 0], yaw: 0, color: '#ffffff' },
      ],
      nodes: [{ node: 'oak_tree', pos: [1, 0, 1] }],
      props: [{ item: 'crate', pos: [2, 0, 2] }],
    })
    expect(r.ok, r.ok ? '' : r.issues.join(', ')).toBe(true)
    if (!r.ok) return
    expect(r.map.statics[0]!.id).toBe('s-0')
    expect(r.map.nodes[0]!.id).toBe('n-0')
    expect(r.map.props[0]!.id).toBe('pr-0')
  })

  it('is deterministic — the same input yields the same ids', () => {
    const raw = {
      v: 2,
      terrains: [],
      statics: [
        { shape: { type: 'box', size: [1, 1, 1] }, pos: [0, 0, 0], yaw: 0, color: '#ffffff' },
        { shape: { type: 'box', size: [1, 1, 1] }, pos: [1, 0, 0], yaw: 0, color: '#ffffff' },
      ],
    }
    const a = parseMapFile(structuredClone(raw))
    const b = parseMapFile(structuredClone(raw))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(canonicalizeMapFile(a.map)).toBe(canonicalizeMapFile(b.map))
  })

  it('never reuses an id an authored object already claimed', () => {
    const r = parseMapFile({
      v: 2,
      terrains: [],
      statics: [
        {
          id: 's-0',
          shape: { type: 'box', size: [1, 1, 1] },
          pos: [0, 0, 0],
          yaw: 0,
          color: '#ffffff',
        },
        { shape: { type: 'box', size: [1, 1, 1] }, pos: [1, 0, 0], yaw: 0, color: '#ffffff' },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.map.statics.map((s) => s.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe('s-0')
  })

  it('preserves assigned ids across a save/reload round trip', () => {
    const first = parseMapFile({
      v: 2,
      terrains: [],
      statics: [],
      nodes: [{ node: 'oak_tree', pos: [1, 0, 1] }],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = parseMapFile(JSON.parse(canonicalizeMapFile(first.map)))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.map.nodes[0]!.id).toBe(first.map.nodes[0]!.id)
  })

  it('rejects a map that reuses one id across two kinds', () => {
    const r = parseMapFile({
      v: 2,
      terrains: [],
      statics: [
        {
          id: 'dup',
          shape: { type: 'box', size: [1, 1, 1] },
          pos: [0, 0, 0],
          yaw: 0,
          color: '#ffffff',
        },
      ],
      nodes: [{ id: 'dup', node: 'oak_tree', pos: [0, 0, 0] }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join(' ')).toContain('duplicate id')
  })

  it('reserves the synthetic spawn id', () => {
    const r = parseMapFile({
      v: 2,
      terrains: [],
      statics: [
        {
          id: SPAWN_OBJECT_ID,
          shape: { type: 'box', size: [1, 1, 1] },
          pos: [0, 0, 0],
          yaw: 0,
          color: '#ffffff',
        },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join(' ')).toContain('reserved')
  })
})

describe('typed lights', () => {
  const withLight = (light: unknown): ParsedMap =>
    parseMapFile({ v: 2, terrains: [], statics: [], lights: [light] })

  it('accepts a fully specified spot light', () => {
    const r = withLight({
      id: 'l1',
      type: 'spot',
      pos: [0, 5, 0],
      dir: [0, -1, 0],
      color: '#ffddaa',
      intensity: 4,
      range: 30,
      angle: 0.8,
      exponent: 2,
      shadows: true,
    })
    expect(r.ok, r.ok ? '' : r.issues.join(', ')).toBe(true)
    if (r.ok) expect(r.map.lights[0]!.angle).toBe(0.8)
  })

  it('rejects an unknown light type', () => {
    expect(withLight({ id: 'l1', type: 'laser', pos: [0, 1, 0] }).ok).toBe(false)
  })

  it('rejects a non-finite position', () => {
    expect(withLight({ id: 'l1', type: 'point', pos: [0, Number.POSITIVE_INFINITY, 0] }).ok).toBe(
      false,
    )
  })

  it('rejects a negative intensity and a malformed colour', () => {
    expect(withLight({ id: 'l1', type: 'point', pos: [0, 1, 0], intensity: -3 }).ok).toBe(false)
    expect(withLight({ id: 'l1', type: 'point', pos: [0, 1, 0], color: 'red' }).ok).toBe(false)
  })

  it('rejects a zero-area rect light', () => {
    expect(withLight({ id: 'l1', type: 'rect', pos: [0, 1, 0], size: [0, 2] }).ok).toBe(false)
  })

  it('keeps old valid v2 lights loading', () => {
    const r = withLight({ id: 'l1', type: 'point', pos: [0, 3, 0] })
    expect(r.ok).toBe(true)
  })
})

describe('map-authored zones', () => {
  const withZone = (zone: unknown): ParsedMap =>
    parseMapFile({ v: 2, terrains: [], statics: [], zones: [zone] })

  const zone = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'zone-0',
    name: 'Safe',
    min: [-10, -1, -10],
    max: [10, 5, 10],
    rules: { pvp: false, build: true, physgun: true },
    ...over,
  })

  it('defaults to none, so every existing v2 map still loads', () => {
    const r = parseMapFile({ v: 2, terrains: [], statics: [] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.map.zones).toEqual([])
  })

  it('accepts a well-formed zone and keeps its rules', () => {
    const r = withZone(zone())
    expect(r.ok, r.ok ? '' : r.issues.join(', ')).toBe(true)
    if (r.ok) expect(r.map.zones[0]!.rules).toEqual({ pvp: false, build: true, physgun: true })
  })

  it('rejects an inverted volume', () => {
    const r = withZone(zone({ min: [10, 0, 0], max: [-10, 1, 1] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join(' ')).toContain('min exceeds max')
  })

  it('rejects non-finite and absurd bounds', () => {
    expect(withZone(zone({ min: [Number.NaN, 0, 0] })).ok).toBe(false)
    expect(withZone(zone({ max: [1e9, 1, 1] })).ok).toBe(false)
  })

  it('rejects an empty name and a duplicate id', () => {
    expect(withZone(zone({ name: '' })).ok).toBe(false)
    const dup = parseMapFile({
      v: 2,
      terrains: [],
      statics: [],
      zones: [zone(), zone({ name: 'Other' })],
    })
    expect(dup.ok).toBe(false)
  })

  it('compiles zones through to the runtime override', () => {
    const r = withZone(zone())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(compileMapFileV2(r.map).zones).toEqual([
      {
        id: 'zone-0',
        name: 'Safe',
        min: [-10, -1, -10],
        max: [10, 5, 10],
        rules: { pvp: false, build: true, physgun: true },
      },
    ])
  })

  it('survives a save/reload round trip', () => {
    const r = withZone(zone())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const again = parseMapFile(JSON.parse(canonicalizeMapFile(r.map)))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.map.zones[0]).toEqual(r.map.zones[0])
  })
})
