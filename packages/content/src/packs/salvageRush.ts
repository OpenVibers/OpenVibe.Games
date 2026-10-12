import type { ContentPackV2 } from '../pack.js'

/** A compact on-foot collection arena. Pickups are virtual, server-owned points. */
export const SALVAGE_RUSH_PACK: ContentPackV2 = {
  map: {
    id: 'salvage_rush_arena',
    name: 'Salvage Rush Arena',
    flatTerrain: true,
    groundHalfExtent: 22,
    spawnPoint: [0, 1.2, 0],
    spawnYaw: 0,
    statics: [
      { shape: { type: 'box', size: [3, 1, 3] }, pos: [-7, 0.5, -7], yaw: 0, color: '#ef8d4a' },
      { shape: { type: 'box', size: [3, 1, 3] }, pos: [7, 0.5, 7], yaw: 0, color: '#4ac9c2' },
      { shape: { type: 'box', size: [4, 1, 2] }, pos: [-7, 0.5, 7], yaw: 0, color: '#f4cb65' },
      { shape: { type: 'box', size: [4, 1, 2] }, pos: [7, 0.5, -7], yaw: 0, color: '#8e9ce9' },
    ],
    resourceNodes: [],
    initialProps: [],
    zones: [
      {
        id: 'arena',
        name: 'Arena',
        min: [-22, -2, -22],
        max: [22, 10, 22],
        rules: { pvp: false, build: false, physgun: false },
      },
    ],
  },
  game: {
    id: 'salvage-rush',
    roundSeconds: 90,
    intermissionSeconds: 10,
    pickups: [
      [-12, 1, 0],
      [12, 1, 0],
      [0, 1, -12],
      [0, 1, 12],
      [-11, 1, -11],
      [11, 1, 11],
      [-11, 1, 11],
      [11, 1, -11],
    ],
    achievements: [
      {
        id: 'first-haul',
        name: 'First Haul',
        description: 'Score in a Salvage Rush round.',
        criterion: { event: 'round_finished', minScore: 1 },
      },
      {
        id: 'big-haul',
        name: 'Big Haul',
        description: 'Score at least five points in one round.',
        criterion: { event: 'round_finished', minScore: 5 },
      },
      {
        id: 'arena-winner',
        name: 'Arena Winner',
        description: 'Finish a round in first place.',
        criterion: { event: 'round_finished', minRank: 1 },
      },
    ],
  },
}
