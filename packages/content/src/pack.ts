/**
 * `games-content@2` pack definitions: a pack adds DEFINITIONS (items, recipes,
 * crops, npc archetypes), not only placements. Every def is parsed by the same
 * schema the base content uses and merged onto the base before the registry is
 * built, so the registry's own checks (duplicates, dangling references) still
 * run over the merged set.
 *
 * Rules, in pack order:
 *  - an id may be defined once per pack;
 *  - an id that already exists (base or an earlier pack) is refused, unless the
 *    caller opts into `allowOverride`, in which case the later def replaces it
 *    in place;
 *  - a pack's defs may reference only base ids and the pack's own ids, never
 *    another pack's, so a pack never depends on install order.
 *
 * Client- and server-safe: no node built-ins.
 */
import type { z } from 'zod'
import { CropDefSchema, type CropDef } from './schema/crop.js'
import { NpcArchetypeSchema, type NpcArchetype } from './schema/npc.js'
import { ItemDefSchema, type ItemDef } from './schema/item.js'
import { RecipeSchema, type Recipe } from './schema/recipe.js'
import type { ContentDefs } from './registry.js'
import { WorldDefSchema, type WorldDef } from './schema/world.js'
import { ScriptModSchema, type ScriptMod } from './schema/scriptMod.js'

/** The pack format version both sides must agree on. */
export const CONTENT_PACK_VERSION = 2

/** Most defs of each kind one pack may carry (the manifest schema uses the same bounds). */
export const MAX_PACK_DEFS = { items: 200, recipes: 200, crops: 100, npcs: 100 } as const

/** Most `games-quickjs@1` script mods one pack may carry. */
export const MAX_PACK_MODS = 8

/** The def sections a pack may carry. */
export type PackDefKind = keyof typeof MAX_PACK_DEFS

export interface ContentPackV2 {
  defs?: { [K in PackDefKind]?: unknown[] }
  /** One authored map; the built-in Scraplandia pack supplies the default. */
  map?: WorldDef
  announcements?: { text: string; everySeconds: number }[]
  props?: { key: string; item: string; pos: [number, number, number]; yaw?: number }[]
  /** `games-quickjs@1` server script mods (schema/scriptMod.ts); they are part of the def set. */
  mods?: unknown[]
}

/** What a merge reads from the base: the four def lists a pack extends and the factions npcs may join. */
export type PackBase = Pick<ContentDefs, 'items' | 'recipes' | 'crops' | 'npcs' | 'factions'> &
  Pick<Partial<ContentDefs>, 'mods'>

export interface MergeOptions {
  /** Let a pack def replace a base or earlier-pack def with the same id (default: refused). */
  allowOverride?: boolean
}

interface Parsed<T> {
  out: T[]
  errors: string[]
}

/** Parse one def array with the base schema; report the bad index otherwise. */
function parseDefs<T>(
  kind: PackDefKind,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): Parsed<T> {
  const out: T[] = []
  const errors: string[] = []
  if (raw === undefined) return { out, errors }
  if (!Array.isArray(raw)) return { out, errors: [`${kind}: must be an array`] }
  if (raw.length > MAX_PACK_DEFS[kind]) {
    return {
      out,
      errors: [`${kind}: ${raw.length} defs exceeds the limit of ${MAX_PACK_DEFS[kind]}`],
    }
  }
  raw.forEach((v, i) => {
    const r = schema.safeParse(v)
    if (!r.success) errors.push(`${kind}[${i}]: ${r.error.message}`)
    else out.push(r.data)
  })
  return { out, errors }
}

/** Add `defs` to `list`, applying the duplicate / override rule; returns the ids this pack defined. */
function addDefs<T extends { id: string }>(
  kind: string,
  list: T[],
  defs: T[],
  allowOverride: boolean,
  errors: string[],
): Set<string> {
  const own = new Set<string>()
  for (const def of defs) {
    if (own.has(def.id)) {
      errors.push(`${kind} '${def.id}' is defined twice in one pack`)
      continue
    }
    own.add(def.id)
    const at = list.findIndex((d) => d.id === def.id)
    if (at < 0) list.push(def)
    else if (allowOverride) list[at] = def
    else errors.push(`${kind} '${def.id}' already exists and a pack may not override it`)
  }
  return own
}

/** Merge packs onto `base`. Errors are fatal for the boot; defs are appended in pack order. */
export function mergePackDefs<B extends PackBase>(
  base: B,
  packs: ContentPackV2[],
  options: MergeOptions = {},
): { defs: B; errors: string[] } {
  const allowOverride = options.allowOverride ?? false
  const items = [...base.items]
  const recipes = [...base.recipes]
  const crops = [...base.crops]
  const npcs = [...base.npcs]
  const mods: ScriptMod[] = [...(base.mods ?? [])]
  const errors: string[] = []
  let map = 'world' in base ? (base as B & { world: WorldDef }).world : undefined
  let mapSeen = false
  const baseItems = new Set(base.items.map((d) => d.id))
  const baseRecipes = new Set(base.recipes.map((d) => d.id))
  const baseCrops = new Set(base.crops.map((d) => d.id))
  const factions = new Set(base.factions.map((d) => d.id))

  packs.forEach((p, n) => {
    const where = packs.length > 1 ? `pack ${n}: ` : ''
    const mine: string[] = []
    if (p.map !== undefined) {
      const parsed = WorldDefSchema.safeParse(p.map)
      if (!parsed.success) mine.push(`map: ${parsed.error.message}`)
      else if (mapSeen) mine.push('map is defined by more than one pack')
      else {
        map = parsed.data
        mapSeen = true
      }
    }
    const i = parseDefs<ItemDef>('items', ItemDefSchema, p.defs?.items)
    const r = parseDefs<Recipe>('recipes', RecipeSchema, p.defs?.recipes)
    const c = parseDefs<CropDef>('crops', CropDefSchema, p.defs?.crops)
    const v = parseDefs<NpcArchetype>('npcs', NpcArchetypeSchema, p.defs?.npcs)
    mine.push(...i.errors, ...r.errors, ...c.errors, ...v.errors)
    // A mod id is its identity in logs and budgets: never overridden, whatever `allowOverride` says.
    if (p.mods !== undefined && (!Array.isArray(p.mods) || p.mods.length > MAX_PACK_MODS)) {
      mine.push(`mods: must be an array of at most ${MAX_PACK_MODS}`)
    } else {
      ;(p.mods ?? []).forEach((raw, k) => {
        const m = ScriptModSchema.safeParse(raw)
        if (!m.success) mine.push(`mods[${k}]: ${m.error.message}`)
        else if (mods.some((d) => d.id === m.data.id))
          mine.push(`mod '${m.data.id}' already exists`)
        else mods.push(m.data)
      })
    }

    const ownItems = addDefs('item', items, i.out, allowOverride, mine)
    const ownRecipes = addDefs('recipe', recipes, r.out, allowOverride, mine)
    const ownCrops = addDefs('crop', crops, c.out, allowOverride, mine)
    addDefs('npc', npcs, v.out, allowOverride, mine)

    // References may reach base ids and this pack's own ids only.
    const hasItem = (id: string): boolean => baseItems.has(id) || ownItems.has(id)
    const hasRecipe = (id: string): boolean => baseRecipes.has(id) || ownRecipes.has(id)
    const hasCrop = (id: string): boolean => baseCrops.has(id) || ownCrops.has(id)
    const needItem = (from: string, id: string): void => {
      if (!hasItem(id)) mine.push(`${from} references unknown item '${id}'`)
    }
    for (const d of i.out) {
      if (d.health?.repair) needItem(`item '${d.id}'`, d.health.repair.item)
      for (const loot of d.health?.destroyLoot ?? []) needItem(`item '${d.id}'`, loot.item)
      if (d.seed && !hasCrop(d.seed.crop))
        mine.push(`item '${d.id}' references unknown crop '${d.seed.crop}'`)
      if (d.blueprint && !hasRecipe(d.blueprint.recipe)) {
        mine.push(`item '${d.id}' references unknown recipe '${d.blueprint.recipe}'`)
      }
    }
    for (const d of r.out)
      for (const ref of [...d.inputs, ...d.outputs]) needItem(`recipe '${d.id}'`, ref.item)
    for (const d of c.out) for (const y of d.yield) needItem(`crop '${d.id}'`, y.item)
    for (const d of v.out) {
      if (!factions.has(d.faction))
        mine.push(`npc '${d.id}' references unknown faction '${d.faction}'`)
      for (const loot of d.loot) needItem(`npc '${d.id}'`, loot.item)
    }
    errors.push(...mine.map((e) => where + e))
  })
  return {
    defs: {
      ...base,
      items,
      recipes,
      crops,
      npcs,
      ...(map ? { world: map } : {}),
      // Absent rather than empty, so a def set without mods keeps the digest it always had.
      ...(mods.length > 0 ? { mods } : {}),
    },
    errors,
  }
}

/** 32-bit FNV-1a over a string; plain integer maths, identical in every JS runtime. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** JSON with object keys sorted and `undefined` members dropped, so key order never matters. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** The def-set format version in the digest. */
export const CONTENT_VERSION = 2

/**
 * The def-set identity (version + digest) the client/server handshake (M2.2)
 * will compare. It hashes the merged `ContentDefs`, with every id-keyed list
 * sorted by id, so neither pack order nor key order changes it.
 */
export function contentDigest(defs: ContentDefs): string {
  const sorted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defs)) {
    sorted[key] = Array.isArray(value)
      ? [...value].sort((a: { id: string }, b: { id: string }) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        )
      : value
  }
  return `v${CONTENT_VERSION}-${fnv1a(canonical(sorted))}`
}
