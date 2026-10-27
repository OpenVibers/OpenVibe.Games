import type { ContentPackV2 } from '../pack.js'
import { blankHeights, emptyMapV2, type MapFileV2 } from '../mapFileV2.js'
import { ScriptModSchema, type ScriptMod } from '../schema/scriptMod.js'

/**
 * Creator worlds: a place a signed-in player builds in /editor and publishes at /worlds. The server and
 * the client build the same pack from the world id, so the def-set digest agrees without shipping a pack.
 * The pack is deliberately plain (flat ground, no zones, no achievements): everything a creator adds lives in
 * the world's map document, and the title stays out of the pack so renaming a world never changes its digest.
 */

/** A creator world id: `w` and ten lower-case base-36 characters. */
export const CREATOR_WORLD_ID = /^w[0-9a-z]{10}$/

/** The place a creator world runs as; `hello.place` carries it. */
export function creatorPlaceId(worldId: string): string {
  return `world:${worldId}`
}

/** The world id inside a creator place id, or null for any other place. */
export function creatorWorldOf(placeId: string | undefined | null): string | null {
  const id = placeId?.startsWith('world:') ? placeId.slice('world:'.length) : null
  return id && CREATOR_WORLD_ID.test(id) ? id : null
}

export function creatorWorldPack(worldId: string): ContentPackV2 {
  if (!CREATOR_WORLD_ID.test(worldId)) throw new Error(`not a creator world id: ${worldId}`)
  return {
    map: {
      id: `creator_${worldId}`,
      name: 'Creator world',
      flatTerrain: true,
      groundHalfExtent: 80,
      spawnPoint: [0, 1.2, 4],
      spawnYaw: 0,
      statics: [],
      resourceNodes: [],
      initialProps: [],
      zones: [],
    },
  }
}

/** The starter ground's id in a new world's map. */
export const STARTER_GROUND_ID = 'ground'

/**
 * A new creator world's map: flat grass over the whole play area (one sculptable terrain patch, 160 m square in 2 m
 * cells), so there is ground to stand on before anything is built. A map's terrain objects are its ground (a blank map
 * has only the safety floor, 1.5 m under the sea), and worlds made from emptyMapV2() put their players in the water.
 */
export function starterCreatorMap(): MapFileV2 {
  const sub = 80
  return {
    ...emptyMapV2(),
    terrains: [
      {
        id: STARTER_GROUND_ID,
        name: 'Ground',
        pos: [0, 0, 0],
        halfExtent: 80,
        sub,
        heights: blankHeights(sub),
        surface: { base: { tex: 'leafy_grass' } },
      },
    ],
  }
}

/** What a creator world's map may hold. Staff maps keep the schema's own (much larger) limits. */
export const CREATOR_MAP_LIMITS = {
  bytes: 2 * 1024 * 1024,
  terrains: 16,
  statics: 4000,
  nodes: 400,
  props: 400,
  lights: 64,
  zones: 64,
} as const

/**
 * Checks a parsed map against what creator worlds take: the limits above, and only the built-in materials.
 * Uploads (custom textures, models and paint masks) are staff-only for now: an uploaded image is shown to
 * everyone who joins, and creator uploads wait for the Pics safety pipeline.
 */
export function creatorMapIssues(map: MapFileV2, bytes: number): string[] {
  const issues: string[] = []
  const limit = (what: keyof typeof CREATOR_MAP_LIMITS, count: number): void => {
    if (count > CREATOR_MAP_LIMITS[what])
      issues.push(
        `${what}: ${count} is more than the ${CREATOR_MAP_LIMITS[what]} a creator world takes`,
      )
  }
  limit('bytes', bytes)
  limit('terrains', map.terrains.length)
  limit('statics', map.statics.length)
  limit('nodes', map.nodes.length)
  limit('props', map.props.length)
  limit('lights', map.lights.length)
  limit('zones', map.zones.length)
  if (map.npcs.length > 0) issues.push('npcs: creator worlds have no NPCs yet')
  if (map.models.length > 0)
    issues.push('models: uploaded models are not available in creator worlds yet')
  if (map.textures.length > 0)
    issues.push('textures: uploaded textures are not available in creator worlds yet')
  const painted = (
    surface: { paint?: { layers: unknown[]; mask?: string | undefined } | undefined } | undefined,
  ): boolean => !!surface?.paint && (surface.paint.layers.length > 0 || !!surface.paint.mask)
  if (map.terrains.some((t) => painted(t.surface)))
    issues.push('terrains: painted surfaces are not available in creator worlds yet')
  if (
    map.statics.some(
      (s) =>
        painted(s.surface) || Object.values(s.surfaces ?? {}).some((surface) => painted(surface)),
    )
  )
    issues.push('statics: painted surfaces are not available in creator worlds yet')
  return issues
}

/**
 * What a creator world's scripts may be: its own `games-quickjs@1` mods (docs/mods.md), at most four, together at
 * most 128 KiB of source. Each passes the content package's script schema, so a creator gets exactly the checks an
 * installed pack gets (hooks, capabilities, budgets under their ceilings, module imports inside the mod). The server
 * grants what each asks for: the capabilities are all scoped to the world's own room and storage.
 */
export const CREATOR_SCRIPT_LIMITS = { mods: 4, bytes: 128 * 1024 } as const

/** A world's scripts, validated: the mods to run, or the reasons they cannot (an empty list is fine: no scripts). */
export function creatorScriptsOf(raw: unknown): { scripts: ScriptMod[]; issues: string[] } {
  if (!Array.isArray(raw))
    return { scripts: [], issues: ['scripts: a list of games-quickjs@1 mods'] }
  const issues: string[] = []
  if (raw.length > CREATOR_SCRIPT_LIMITS.mods)
    issues.push(
      `scripts: ${raw.length} is more than the ${CREATOR_SCRIPT_LIMITS.mods} a creator world takes`,
    )
  const bytes = new TextEncoder().encode(JSON.stringify(raw)).length
  if (bytes > CREATOR_SCRIPT_LIMITS.bytes)
    issues.push(
      `scripts: ${bytes} bytes is more than the ${CREATOR_SCRIPT_LIMITS.bytes} a creator world takes`,
    )
  const scripts: ScriptMod[] = []
  const ids = new Set<string>()
  raw.slice(0, CREATOR_SCRIPT_LIMITS.mods).forEach((item, i) => {
    // `granted` is the server's to set, never the creator's.
    const { granted: _granted, ...asked } = (
      item && typeof item === 'object' ? item : {}
    ) as Record<string, unknown>
    const parsed = ScriptModSchema.safeParse(asked)
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push(
          `scripts[${i}]${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
        )
      return
    }
    if (ids.has(parsed.data.id)) {
      issues.push(`scripts[${i}].id: ${parsed.data.id} is used twice`)
      return
    }
    ids.add(parsed.data.id)
    scripts.push({
      ...parsed.data,
      granted: parsed.data.capabilities ?? ['players.read', 'world.emit'],
    })
  })
  return { scripts: issues.length ? [] : scripts, issues }
}
