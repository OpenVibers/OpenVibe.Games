import type { ContentPackV2 } from '../pack.js'
import type { MovementStyle } from '../schema/world.js'

/**
 * OpenVibe.Surf (openvibe.surf) — Ride v1's three original maps.
 *
 * A surf map is an ordinary `MapFileV2` document (`content/surf/<id>.json`) with
 * the `surf` block, surf zones and `movement: "surf"`. These records are the
 * catalogue the client's `?map=` URL and the server's place router share; a
 * place id is the map id (`surf_lagoon`), so `/surf/surf_lagoon` and
 * `?game=surf_lagoon` name the same place. The old `surf-<slug>` place ids are
 * accepted only as redirect aliases. None of the maps, names or layouts are CS
 * maps: they are authored for this engine and this brief.
 */
export interface SurfMapInfo {
  /** Stable map id, also the content world id (`surf_lagoon`). */
  id: `surf_${'lagoon' | 'canyon' | 'orbit'}`
  /** Place id, the same canonical form as the map id (`surf_lagoon`). */
  placeId: string
  /** Visible name: the map id, as a Source map name is (`surf_lagoon`). */
  name: string
  /** Difficulty: 1 beginner, 2 intermediate, 4 advanced. */
  tier: number
  /** Total stages, including the finish. */
  stages: number
  author: 'OpenVibe'
  /** Map document under `content/surf/`. */
  file: string
}

export const SURF_AUTHOR = 'OpenVibe' as const

export const SURF_MAPS: readonly SurfMapInfo[] = [
  {
    id: 'surf_lagoon',
    placeId: 'surf_lagoon',
    name: 'surf_lagoon',
    tier: 1,
    stages: 3,
    author: SURF_AUTHOR,
    file: 'surf_lagoon.json',
  },
  {
    id: 'surf_canyon',
    placeId: 'surf_canyon',
    name: 'surf_canyon',
    tier: 2,
    stages: 4,
    author: SURF_AUTHOR,
    file: 'surf_canyon.json',
  },
  {
    id: 'surf_orbit',
    placeId: 'surf_orbit',
    name: 'surf_orbit',
    tier: 4,
    stages: 6,
    author: SURF_AUTHOR,
    file: 'surf_orbit.json',
  },
] as const

export type SurfMapId = SurfMapInfo['id']

export function isSurfMapId(value: string): value is SurfMapId {
  return SURF_MAPS.some((m) => m.id === value)
}

/**
 * Resolve a map id, its old hyphenated alias (`surf_lagoon` / `surf-lagoon`), or
 * the bare game selector `surf` (which has always meant the first map, Lagoon).
 */
export function surfMap(value: string): SurfMapInfo | undefined {
  if (value === 'surf') return SURF_MAPS[0]
  const canonical = value.replace(/-/g, '_')
  return SURF_MAPS.find((m) => m.id === value || m.placeId === value || m.id === canonical)
}

export function surfPlaceId(mapId: SurfMapId): string {
  return SURF_MAPS.find((m) => m.id === mapId)!.placeId
}

/** The place id a map id maps to, or null. */
export function surfPlaceOf(value: string | undefined): string | null {
  return value ? (surfMap(value)?.placeId ?? null) : null
}

/** The map a place id names, including the old hyphenated alias; null when it is not surf. */
export function surfMapOfPlace(placeId: string): SurfMapInfo | null {
  return SURF_MAPS.find((m) => m.placeId === placeId) ?? surfMap(placeId) ?? null
}

export function isSurfPlace(placeId: string): boolean {
  return surfMapOfPlace(placeId) !== null
}

/**
 * The content pack for one surf place: a world whose movement is the surf
 * preset. Geometry, zones and spawn all come from the map document, so this
 * world def is deliberately empty. Both server and client build it, which is
 * what puts `movement: "surf"` inside the content digest.
 */
export function surfPack(mapId: SurfMapId): ContentPackV2 {
  const info = SURF_MAPS.find((m) => m.id === mapId)
  if (!info) throw new Error(`unknown surf map: ${mapId}`)
  const movement: MovementStyle = 'surf'
  return {
    map: {
      id: info.id,
      name: info.name,
      flatTerrain: true,
      groundHalfExtent: 120,
      spawnPoint: [0, 2, 0],
      spawnYaw: 0,
      statics: [],
      resourceNodes: [],
      initialProps: [],
      zones: [],
      movement,
    },
  }
}

export const SURF_PACKS: Record<SurfMapId, ContentPackV2> = {
  surf_lagoon: surfPack('surf_lagoon'),
  surf_canyon: surfPack('surf_canyon'),
  surf_orbit: surfPack('surf_orbit'),
}
