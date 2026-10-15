import type { ContentPackV2 } from '../pack.js'
import type { MapFileV2 } from '../mapFileV2.js'

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
