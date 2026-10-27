import { describe, expect, it } from 'vitest'
import {
  CREATOR_ASSET_ID,
  CREATOR_ASSET_LIMITS,
  creatorAssetOf,
  creatorPrefabOf,
  creatorScriptAssetOf,
  placePrefab,
  prefabCounts,
  prefabFromObjects,
  type PrefabBody,
} from './creatorAsset.js'

const box = (id: string, pos: [number, number, number]) => ({
  id,
  shape: { type: 'box' as const, size: [2, 2, 2] as [number, number, number] },
  pos,
  yaw: 0,
  color: '#8a8d90',
})

const script = {
  format: 'games-quickjs@1',
  id: 'welcome',
  version: '1.0.0',
  entry: 'welcome.js',
  source: "function onPlayerJoin(e) { game.message(e.player.id, 'hi') }",
  hooks: ['onPlayerJoin'],
  capabilities: ['players.read', 'player.message'],
}

describe('creator assets', () => {
  it('names assets like worlds, with an a', () => {
    expect(CREATOR_ASSET_ID.test('a0123456789')).toBe(true)
    expect(CREATOR_ASSET_ID.test('w0123456789')).toBe(false)
    expect(CREATOR_ASSET_ID.test('A0123456789')).toBe(false)
  })

  it('makes a build from chosen pieces around the middle of their footprint, on its lowest point', () => {
    const body = prefabFromObjects({
      statics: [box('st-1', [10, 2, 20]), box('st-2', [14, 5, 24])],
      lights: [{ id: 'li-1', type: 'point', pos: [12, 8, 22] }],
    })
    expect(body.statics.map((s) => s.pos)).toEqual([
      [-2, 0, -2],
      [2, 3, 2],
    ])
    expect(body.lights[0]?.pos).toEqual([0, 6, 0])
    expect(body.statics[0]?.id).toBe('st-1')
    expect(prefabCounts(body)).toEqual({ statics: 2, nodes: 0, props: 0, lights: 1, pieces: 3 })
  })

  it('checks a build as a creator world map: built-in pieces pass, uploads, paint and NPC-free rules hold', () => {
    const ok = creatorPrefabOf(prefabFromObjects({ statics: [box('st-1', [0, 0, 0])] }))
    expect(ok.issues).toEqual([])
    expect(ok.body?.v).toBe(1)
    const model = creatorPrefabOf({ statics: [{ ...box('st-1', [0, 0, 0]), model: 'm1' }] })
    expect(model.body).toBeNull()
    const painted = creatorPrefabOf({
      statics: [
        {
          ...box('st-1', [0, 0, 0]),
          surface: { base: {}, paint: { layers: [{ id: 'l', tex: 'red_brick', channel: 'r' }] } },
        },
      ],
    })
    expect(painted.body).toBeNull()
    expect(painted.issues.join(' ')).toMatch(/paint/)
    expect(creatorPrefabOf({}).issues).toEqual(['body: a build has at least one piece'])
    expect(creatorPrefabOf([]).issues[0]).toMatch(/an object/)
  })

  it('refuses a build past its limits or reaching too far from its origin', () => {
    const many = Array.from({ length: CREATOR_ASSET_LIMITS.statics + 1 }, (_, i) =>
      box(`st-${i}`, [0, 0, 0]),
    )
    expect(creatorPrefabOf({ statics: many }).issues.join(' ')).toMatch(/statics: 401 is more/)
    const far = creatorPrefabOf({
      statics: [box('st-far', [CREATOR_ASSET_LIMITS.reach + 1, 0, 0])],
    })
    expect(far.issues.join(' ')).toMatch(/st-far: more than 256 m/)
  })

  it('checks a script asset as a world script, and keeps it as written', () => {
    const ok = creatorScriptAssetOf(script)
    expect(ok.issues).toEqual([])
    expect(ok.body).toMatchObject({ id: 'welcome', hooks: ['onPlayerJoin'] })
    expect(ok.body && 'granted' in ok.body).toBe(false)
    expect(creatorScriptAssetOf({ ...script, hooks: ['onEverything'] }).body).toBeNull()
    expect(creatorAssetOf('script', script).kind).toBe('script')
    expect(creatorAssetOf('sound', {}).issues).toEqual(['kind: prefab or script'])
  })

  it('places a build with new ids where it is put down', () => {
    const body: PrefabBody = prefabFromObjects({
      statics: [box('st-1', [0, 0, 0])],
      nodes: [{ id: 'no-1', node: 'oak_tree', pos: [3, 0, 0] }],
      props: [{ id: 'pr-1', item: 'wooden_crate', pos: [0, 0, 3] }],
    })
    let n = 0
    const placed = placePrefab(body, [100, 1, -50], (prefix) => `${prefix}-new-${n++}`)
    expect(placed.map((p) => p.kind)).toEqual(['static', 'node', 'prop'])
    expect(placed.map((p) => p.object.id)).toEqual(['st-new-0', 'no-new-1', 'pr-new-2'])
    expect(placed[1]?.object.pos).toEqual([101.5, 1, -51.5])
    expect(body.statics[0]?.id).toBe('st-1')
  })
})
