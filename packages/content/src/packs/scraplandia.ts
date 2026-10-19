import type { ContentPackV2 } from '../pack.js'

/**
 * Scraplandia's default map. The released world is a blank slate: city
 * geometry is authored in /editor, so there are no hard-coded statics or
 * initial entities. The zone and spawn are unchanged from the former
 * SCRAP_CITY definition.
 */
export const SCRAPLANDIA_PACK: ContentPackV2 = {
  achievements: [
    {
      id: 'first-visit',
      name: 'First Visit',
      description: 'Join Scraplandia.',
      criterion: { event: 'player_joined' },
    },
    {
      id: 'first-haul',
      reward: { item: 'fx_toxic', name: 'Toxic Name' },
      name: 'First Haul',
      description: 'Extract valuables to Scrap City.',
      criterion: { event: 'haul_recorded' },
    },
    {
      id: 'big-haul',
      reward: { item: 'fx_golden', name: 'Golden Name' },
      name: 'Big Haul',
      description: 'Score at least 500 haul points in one extraction.',
      criterion: { event: 'haul_recorded', minScore: 500 },
    },
    {
      id: 'haul-week',
      reward: { item: 'hat_cowboy', name: 'Cowboy Hat' },
      name: 'Haul Week',
      description: 'Score at least 2,000 haul points in one week.',
      criterion: { event: 'haul_week', minScore: 2000 },
    },
  ],
  map: {
    // Scrap Island (apps/server/src/maps/scrapIsland.ts) is the map document the server loads from MAP_PATH. The id
    // changed with it: a new id makes the server re-seed resources and move every character to the island's spawn,
    // since positions saved on the old blank map would sit inside the island's ground.
    id: 'scrap_island',
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
