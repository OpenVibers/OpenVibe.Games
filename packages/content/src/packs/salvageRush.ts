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
    // A scrapyard pit: the four cover blocks, a plated wall round the edge with a lamp on each corner, and heaps,
    // crates and drums in the gaps between the scrap spots (pickups at ±12 on the axes and ±11 on the diagonals stay
    // clear, and so does the spawn pad). It was a bare floor with four coloured boxes.
    statics: [
      { shape: { type: 'box', size: [3, 1, 3] }, pos: [-7, 0.5, -7], yaw: 0, color: '#ef8d4a' },
      { shape: { type: 'box', size: [3, 1, 3] }, pos: [7, 0.5, 7], yaw: 0, color: '#4ac9c2' },
      { shape: { type: 'box', size: [4, 1, 2] }, pos: [-7, 0.5, 7], yaw: 0, color: '#f4cb65' },
      { shape: { type: 'box', size: [4, 1, 2] }, pos: [7, 0.5, -7], yaw: 0, color: '#8e9ce9' },
      // The spawn pad.
      {
        shape: { type: 'cylinder', radius: 2.4, height: 0.12 },
        pos: [0, 0.06, 0],
        yaw: 0,
        color: '#3c4650',
        tex: 'metal_plate',
      },
      // The wall.
      {
        shape: { type: 'box', size: [44.6, 1.6, 0.6] },
        pos: [0, 0.8, 22],
        yaw: 0,
        color: '#8a5a3c',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [44.6, 1.6, 0.6] },
        pos: [0, 0.8, -22],
        yaw: 0,
        color: '#7a6048',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [0.6, 1.6, 44.6] },
        pos: [22, 0.8, 0],
        yaw: 0,
        color: '#86603f',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [0.6, 1.6, 44.6] },
        pos: [-22, 0.8, 0],
        yaw: 0,
        color: '#7e5a44',
        tex: 'metal_plate',
      },
      // Lamps on the corners (they light up after dark).
      {
        shape: { type: 'cylinder', radius: 0.08, height: 3.5 },
        pos: [-20.8, 1.75, -20.8],
        yaw: 0,
        color: '#2c3136',
        decor: 'lamp',
      },
      {
        shape: { type: 'cylinder', radius: 0.08, height: 3.5 },
        pos: [20.8, 1.75, -20.8],
        yaw: 0,
        color: '#2c3136',
        decor: 'lamp',
      },
      {
        shape: { type: 'cylinder', radius: 0.08, height: 3.5 },
        pos: [-20.8, 1.75, 20.8],
        yaw: 0,
        color: '#2c3136',
        decor: 'lamp',
      },
      {
        shape: { type: 'cylinder', radius: 0.08, height: 3.5 },
        pos: [20.8, 1.75, 20.8],
        yaw: 0,
        color: '#2c3136',
        decor: 'lamp',
      },
      // Scrap heaps against the wall, between the scrap spots.
      {
        shape: { type: 'box', size: [3.2, 1.3, 1.8] },
        pos: [-18.5, 0.65, -5.5],
        yaw: 0.35,
        color: '#6d6f72',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [2, 0.9, 1.4] },
        pos: [-18.8, 1.6, -5.2],
        yaw: -0.2,
        color: '#7b5236',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [3, 1.2, 2] },
        pos: [18.6, 0.6, 5.8],
        yaw: -0.4,
        color: '#6a6c6f',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [1.8, 0.8, 1.2] },
        pos: [18.3, 1.5, 5.4],
        yaw: 0.3,
        color: '#8a5a3c',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [2.8, 1.1, 1.8] },
        pos: [5.6, 0.55, -18.7],
        yaw: 0.25,
        color: '#646669',
        tex: 'metal_plate',
      },
      {
        shape: { type: 'box', size: [3, 1.2, 1.9] },
        pos: [-5.8, 0.6, 18.6],
        yaw: -0.3,
        color: '#6f7174',
        tex: 'metal_plate',
      },
      // Crates and drums in the far corners.
      {
        shape: { type: 'box', size: [1.1, 1.1, 1.1] },
        pos: [-17.5, 0.55, 18.2],
        yaw: 0.2,
        color: '#a5713a',
        tex: 'wood_planks',
      },
      {
        shape: { type: 'box', size: [1.1, 1.1, 1.1] },
        pos: [-16.2, 0.55, 18.6],
        yaw: -0.15,
        color: '#9a6a36',
        tex: 'wood_planks',
      },
      {
        shape: { type: 'box', size: [1, 1, 1] },
        pos: [-17, 1.6, 18.4],
        yaw: 0.5,
        color: '#a5713a',
        tex: 'wood_planks',
      },
      {
        shape: { type: 'cylinder', radius: 0.45, height: 1.1 },
        pos: [17.6, 0.55, -18.2],
        yaw: 0,
        color: '#3e5a7a',
      },
      {
        shape: { type: 'cylinder', radius: 0.45, height: 1.1 },
        pos: [18.6, 0.55, -17.4],
        yaw: 0,
        color: '#7a3b32',
      },
      {
        shape: { type: 'cylinder', radius: 0.45, height: 1.1 },
        pos: [16.8, 0.55, -17.2],
        yaw: 0,
        color: '#4a6b52',
      },
    ],
    resourceNodes: [],
    initialProps: [],
    // A 90-second scrap round: no NPCs. The content's spawns put townsfolk and a warden inside the arena and Rustjaw
    // thugs just past its edge.
    npcSpawns: [],
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
        reward: { item: 'fx_neon', name: 'Neon Name' },
        name: 'First Haul',
        description: 'Score in a Salvage Rush round.',
        criterion: { event: 'round_finished', minScore: 1 },
      },
      {
        id: 'big-haul',
        reward: { item: 'px_flames', name: 'Flames' },
        name: 'Big Haul',
        description: 'Score at least five points in one round.',
        criterion: { event: 'round_finished', minScore: 5 },
      },
      {
        id: 'arena-winner',
        reward: { item: 'px_stars', name: 'Stars' },
        name: 'Arena Winner',
        description: 'Finish a round in first place.',
        criterion: { event: 'round_finished', minRank: 1 },
      },
    ],
  },
}
