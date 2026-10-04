import type { ContentPackV2 } from '../pack.js'

/**
 * Scraplandia's default map. The released world is a blank slate: city
 * geometry is authored in /editor, so there are no hard-coded statics or
 * initial entities. The zone and spawn are unchanged from the former
 * SCRAP_CITY definition.
 */
export const SCRAPLANDIA_PACK: ContentPackV2 = {
  map: {
    id: 'openvibeville_v2',
    flatTerrain: true,
    name: 'Scrap City',
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
  },
}

/** The authored map, exported for map tooling and compatibility. */
export const SCRAP_CITY = SCRAPLANDIA_PACK.map!
