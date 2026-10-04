import { describe, expect, it } from 'vitest'
import {
  contentDigest,
  createContent,
  mergePackDefs,
  CROPS,
  FACTIONS,
  ITEMS,
  JOBS,
  MARKETS,
  MAX_PACK_DEFS,
  NPC_ARCHETYPES,
  RECIPES,
  RESOURCE_NODES,
  SCRAP_CITY,
  SCRAPLANDIA_PACK,
  SKILLS,
  type ContentDefs,
  type ContentPackV2,
} from './index.js'

const base: ContentDefs = {
  items: ITEMS,
  recipes: RECIPES,
  skills: SKILLS,
  nodeTypes: RESOURCE_NODES,
  crops: CROPS,
  npcs: NPC_ARCHETYPES,
  factions: FACTIONS,
  markets: MARKETS,
  jobs: JOBS,
  world: SCRAP_CITY,
}

const plainItem = ITEMS.find(
  (i) => !i.health && !i.container && !i.machine && !i.shop && !i.seed && !i.blueprint,
)!
const anItem = (id: string): unknown => ({ ...plainItem, id })
const aRecipe = (id: string, item: string): unknown => ({
  ...RECIPES.find((r) => !r.machine && !r.requiredSkill && !r.blueprint)!,
  id,
  inputs: [{ item, count: 1 }],
  outputs: [{ item, count: 1 }],
})
const aCrop = (id: string, item: string): unknown => ({
  ...CROPS[0]!,
  id,
  yield: [{ item, count: 1 }],
})
const anNpc = (id: string): unknown => ({ ...NPC_ARCHETYPES[0]!, id })

describe('mergePackDefs', () => {
  it('appends a pack item, recipe, crop and npc', () => {
    const pack: ContentPackV2 = {
      defs: {
        items: [anItem('pack_widget')],
        recipes: [aRecipe('pack_recipe', 'pack_widget')],
        crops: [aCrop('pack_crop', 'pack_widget')],
        npcs: [anNpc('pack_npc')],
      },
    }
    const { defs, errors } = mergePackDefs(base, [pack])
    expect(errors).toEqual([])
    expect(defs.items.at(-1)!.id).toBe('pack_widget')
    expect(defs.recipes.at(-1)!.id).toBe('pack_recipe')
    expect(defs.crops.at(-1)!.id).toBe('pack_crop')
    expect(defs.npcs.at(-1)!.id).toBe('pack_npc')
    expect(base.items.some((i) => i.id === 'pack_widget')).toBe(false)
    const content = createContent([pack])
    expect(content.item('pack_widget')).toBeDefined()
    expect(content.recipe('pack_recipe')).toBeDefined()
    expect(content.crop('pack_crop')).toBeDefined()
    expect(content.npc('pack_npc')).toBeDefined()
  })

  it('refuses an id that already exists unless override is allowed', () => {
    const clash = { ...(anItem(plainItem.id) as object), name: 'Replaced' }
    const pack: ContentPackV2 = { defs: { items: [clash] } }
    const refused = mergePackDefs(base, [pack])
    expect(refused.errors).toEqual([
      `item '${plainItem.id}' already exists and a pack may not override it`,
    ])
    expect(refused.defs.items.find((i) => i.id === plainItem.id)!.name).toBe(plainItem.name)

    const allowed = mergePackDefs(base, [pack], { allowOverride: true })
    expect(allowed.errors).toEqual([])
    expect(allowed.defs.items).toHaveLength(base.items.length)
    expect(allowed.defs.items.find((i) => i.id === plainItem.id)!.name).toBe('Replaced')
    expect(() => createContent([pack])).toThrow(/may not override/)
  })

  it('applies a later pack over an earlier one only when override is allowed', () => {
    const a: ContentPackV2 = { defs: { items: [{ ...(anItem('shared') as object), name: 'A' }] } }
    const b: ContentPackV2 = { defs: { items: [{ ...(anItem('shared') as object), name: 'B' }] } }
    expect(mergePackDefs(base, [a, b]).errors[0]).toMatch(/pack 1: item 'shared' already exists/)
    const merged = mergePackDefs(base, [a, b], { allowOverride: true })
    expect(merged.errors).toEqual([])
    expect(merged.defs.items.filter((i) => i.id === 'shared').map((i) => i.name)).toEqual(['B'])
  })

  it('refuses an id defined twice in one pack', () => {
    const { errors } = mergePackDefs(base, [{ defs: { items: [anItem('dup'), anItem('dup')] } }], {
      allowOverride: true,
    })
    expect(errors).toEqual(["item 'dup' is defined twice in one pack"])
  })

  it('reports a malformed def by index and keeps it out of the set', () => {
    const { defs, errors } = mergePackDefs(base, [
      { defs: { items: [anItem('ok_item'), { id: 'Bad Id' }] } },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^items\[1\]: /)
    expect(defs.items.some((i) => i.id === 'Bad Id')).toBe(false)
    expect(defs.items.some((i) => i.id === 'ok_item')).toBe(true)
  })

  it('reports dangling references, and one pack cannot reference another pack', () => {
    const dangling = mergePackDefs(base, [{ defs: { recipes: [aRecipe('r1', 'no_such_item')] } }])
    // one error each for the input and the output
    expect(dangling.errors).toEqual(
      Array(2).fill("recipe 'r1' references unknown item 'no_such_item'"),
    )
    const npc = { ...(anNpc('n1') as object), faction: 'no_such_faction' }
    expect(mergePackDefs(base, [{ defs: { npcs: [npc] } }]).errors).toEqual([
      "npc 'n1' references unknown faction 'no_such_faction'",
    ])
    const owner: ContentPackV2 = { defs: { items: [anItem('only_in_a')] } }
    const user: ContentPackV2 = { defs: { recipes: [aRecipe('r2', 'only_in_a')] } }
    expect(mergePackDefs(base, [owner, user]).errors).toEqual(
      Array(2).fill("pack 1: recipe 'r2' references unknown item 'only_in_a'"),
    )
    expect(() => createContent([{ defs: { recipes: [aRecipe('r1', 'no_such_item')] } }])).toThrow(
      /unknown item 'no_such_item'/,
    )
  })

  it('refuses a section over its bound or not an array', () => {
    const many = Array.from({ length: MAX_PACK_DEFS.crops + 1 }, (_, i) =>
      aCrop(`c${i}`, plainItem.id),
    )
    expect(mergePackDefs(base, [{ defs: { crops: many } }]).errors).toEqual([
      `crops: ${many.length} defs exceeds the limit of ${MAX_PACK_DEFS.crops}`,
    ])
    const bad = { defs: { items: 'nope' } } as unknown as ContentPackV2
    expect(mergePackDefs(base, [bad]).errors).toEqual(['items: must be an array'])
    const atLimit = Array.from({ length: MAX_PACK_DEFS.items }, (_, i) => anItem(`bulk_${i}`))
    expect(mergePackDefs(base, [{ defs: { items: atLimit } }]).errors).toEqual([])
  })
})

describe('contentDigest', () => {
  const pack = (...ids: string[]): ContentPackV2 => ({ defs: { items: ids.map(anItem) } })

  it('is stable and has the v2 prefix', () => {
    expect(contentDigest(base)).toBe(contentDigest(base))
    expect(contentDigest(base)).toMatch(/^v2-[0-9a-f]{8}$/)
  })

  it('does not depend on key order or on pack order', () => {
    const forward = mergePackDefs(base, [pack('d_a'), pack('d_b')]).defs
    const backward = mergePackDefs(base, [pack('d_b'), pack('d_a')]).defs
    expect(forward.items.map((i) => i.id)).not.toEqual(backward.items.map((i) => i.id))
    expect(contentDigest(forward)).toBe(contentDigest(backward))
    const reordered = {
      ...forward,
      items: forward.items.map((i) => Object.fromEntries(Object.entries(i).reverse()) as typeof i),
    }
    expect(contentDigest(reordered)).toBe(contentDigest(forward))
  })

  it('changes when a def is added or edited', () => {
    const plain = contentDigest(base)
    const added = mergePackDefs(base, [pack('d_a')]).defs
    expect(contentDigest(added)).not.toBe(plain)
    const edited = {
      ...added,
      items: added.items.map((i) => (i.id === 'd_a' ? { ...i, name: 'Changed' } : i)),
    }
    expect(contentDigest(edited)).not.toBe(contentDigest(added))
  })

  it('matches the merged set on both sides and changes with a pack def', () => {
    const client = createContent()
    const server = createContent([])
    expect(client.digest).toBe(server.digest)
    expect(createContent([pack('extra')]).digest).not.toBe(client.digest)
  })

  it('changes when the pack map changes', () => {
    const changed = {
      ...base,
      world: { ...base.world, spawnPoint: [1, 1.2, 4] as [number, number, number] },
    }
    expect(contentDigest(changed)).not.toBe(contentDigest(base))
  })
})

describe('Scraplandia default pack', () => {
  it('loads the exact world and boot entity positions from main', () => {
    // Recorded from main 545f6c1, packages/content/src/defs/scrapcity.ts.
    // The released city is an editor-built blank slate: no seeded entity ids.
    const expected = {
      id: 'openvibeville_v2',
      name: 'Scrap City',
      flatTerrain: true,
      groundHalfExtent: 80,
      spawnPoint: [0, 1.2, 4],
      spawnYaw: 0,
      statics: [],
      resourceNodes: [],
      initialProps: [],
      zones: [
        {
          id: 'city',
          name: 'Scrap City',
          min: [-20.5, -1, -20.5],
          max: [20.5, 8, 20.5],
          rules: { pvp: false, build: false, physgun: true },
        },
      ],
    }
    expect(SCRAPLANDIA_PACK.map).toEqual(expected)
    expect(createContent().world).toEqual(expected)
    expect(createContent().world.initialProps.map((p) => [p.item, p.pos])).toEqual([])
    expect(createContent().world.resourceNodes.map((n) => [n.node, n.pos])).toEqual([])
  })
})
