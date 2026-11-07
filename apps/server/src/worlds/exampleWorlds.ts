import type { MapFileV2 } from '@openvibe/content'

/**
 * The two official example creator worlds (plan §4 Games, "Games' creator worlds (none published yet)"; review
 * next step 3: "Seed one or two staff-published creator worlds so /worlds and the home section have real
 * entries"). They are ordinary v2 map documents, the same file the editor saves, so staff can open either in
 * /editor and keep building on it. Between them they use what the editor can author: sculpted terrain and a
 * built-in texture, boxes, cylinders and spheres, props and resource nodes, point/hemi/directional lights,
 * named zones with their own rules, and a spawn point.
 *
 * Deterministic: no randomness, no clock, so the seed's revision is stable.
 */

type Vec3 = [number, number, number]
type Static = MapFileV2['statics'][number]

const round = (v: number, places = 3): number => Math.round(v * 10 ** places) / 10 ** places
const at = (v: Vec3): Vec3 => v.map((n) => round(n)) as Vec3

/** Base64 Float32 heights, the codec mapFile.ts uses (the module is server-side). */
function heightsOf(sub: number, f: (x: number, z: number) => number, halfExtent: number): string {
  const out = new Float32Array((sub + 1) * (sub + 1))
  for (let iz = 0; iz <= sub; iz++) {
    for (let ix = 0; ix <= sub; ix++) {
      const x = -halfExtent + (2 * halfExtent * ix) / sub
      const z = -halfExtent + (2 * halfExtent * iz) / sub
      out[iz * (sub + 1) + ix] = round(f(x, z), 4)
    }
  }
  return Buffer.from(out.buffer).toString('base64')
}

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/** ── Beacon Hill: one sculpted terrain, a beacon, a path and three zones ─────────────────────────────── */

const BEACON = { x: 0, z: -8, radius: 11, height: 3.4 }

function beaconGround(x: number, z: number): number {
  const d = Math.hypot(x - BEACON.x, z - BEACON.z)
  const hill = BEACON.height * smooth(1 - d / BEACON.radius)
  // A gentle roll around the hill so the ground is not a perfect cone.
  const roll = 0.22 * Math.sin(x / 4.6) * Math.cos(z / 5.2) * smooth(1 - d / 26)
  return round(hill + roll, 3)
}

function beaconHill(): MapFileV2 {
  let sid = 0
  const statics: Static[] = []
  const box = (x: number, z: number, size: Vec3, color: string, opts: Partial<Static> & { lift?: number; base?: number } = {}): Static => {
    const { lift = 0, base, ...rest } = opts
    const y = (base ?? beaconGround(x, z)) + lift + size[1] / 2
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'box', size: size.map((n) => round(n)) as Vec3 },
      pos: at([x, y, z]),
      yaw: 0,
      color,
      ...rest,
    }
    statics.push(s)
    return s
  }
  const cylinder = (x: number, z: number, radius: number, height: number, color: string, opts: Partial<Static> & { lift?: number } = {}): Static => {
    const { lift = 0, ...rest } = opts
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'cylinder', radius: round(radius), height: round(height) },
      pos: at([x, beaconGround(x, z) + lift + height / 2, z]),
      yaw: 0,
      color,
      ...rest,
    }
    statics.push(s)
    return s
  }
  const sphere = (x: number, z: number, radius: number, color: string, opts: Partial<Static> & { lift?: number; base?: number } = {}): Static => {
    const { lift = 0, base, ...rest } = opts
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'sphere', radius: round(radius) },
      pos: at([x, (base ?? beaconGround(x, z)) + lift + radius, z]),
      yaw: 0,
      color,
      ...rest,
    }
    statics.push(s)
    return s
  }

  // The beacon: three stone stages and a brazier, on the crown of the hill.
  const crown = beaconGround(BEACON.x, BEACON.z)
  box(BEACON.x, BEACON.z, [3.4, 1.1, 3.4], '#8a8d90', { base: crown, tex: 'gray_rocks' })
  box(BEACON.x, BEACON.z, [2.4, 1.1, 2.4], '#9a9187', { base: crown + 1.1, tex: 'gray_rocks' })
  box(BEACON.x, BEACON.z, [1.4, 1.1, 1.4], '#a8a29e', { base: crown + 2.2, tex: 'gray_rocks' })
  sphere(BEACON.x, BEACON.z, 0.62, '#f59e0b', { base: crown + 3.3 })

  // The path down from the beacon: six flagstones, each a shallow box sunk into the hill.
  for (let i = 0; i < 6; i++) {
    const z = -1.5 + i * 2.6
    box(-0.2, z, [2.6, 0.22, 1.7], '#b8b2a7', { lift: -0.08, tex: 'floor_pavement' })
  }

  // A timber bench either side of the path, and three marker stones where the path meets the flat.
  box(-5.2, 9.6, [2.4, 0.42, 0.7], '#7a5c38', { lift: 0.5, tex: 'wood_planks' })
  box(5.2, 9.6, [2.4, 0.42, 0.7], '#7a5c38', { lift: 0.5, tex: 'wood_planks' })
  cylinder(-5.6, 12.6, 0.55, 1.2, '#8a8d90', { tex: 'gray_rocks' })
  cylinder(5.6, 12.6, 0.55, 1.2, '#8a8d90', { tex: 'gray_rocks' })
  cylinder(0, 15.4, 0.55, 1.1, '#8a8d90', { tex: 'gray_rocks' })

  // The trailhead sign, facing the spawn.
  box(3.4, 14.2, [3, 1.7, 0.22], '#efe6d4', { lift: 1.0, yaw: -0.18, tex: 'weathered_plank_siding' })
  box(2.2, 14.2, [0.18, 2.1, 0.18], '#5b4630', { lift: 0, yaw: -0.18 })
  box(4.6, 14.2, [0.18, 2.1, 0.18], '#5b4630', { lift: 0, yaw: -0.18 })

  return {
    v: 2,
    terrains: [
      {
        id: 'terrain-0',
        name: 'Beacon hill',
        pos: [0, 0, 0],
        halfExtent: 26,
        sub: 32,
        heights: heightsOf(32, beaconGround, 26),
        surface: { base: { tex: 'leafy_grass', color: '#9db172' } },
      },
    ],
    statics,
    nodes: [
      { id: 'n1', node: 'oak_tree', pos: at([-14, 0, 4]) },
      { id: 'n2', node: 'oak_tree', pos: at([14, 0, -2]) },
      { id: 'n3', node: 'berry_bush', pos: at([-9, 0, -14]) },
      { id: 'n4', node: 'stone_deposit', pos: at([12, 0, -16]) },
      { id: 'n5', node: 'loose_stones', pos: at([7, 0, 15]) },
    ],
    props: [
      { id: 'p1', item: 'campfire', pos: at([-7, 0.05, 8]), yaw: 0 },
      { id: 'p2', item: 'wooden_crate', pos: at([6.4, 0.7, 6.4]), yaw: 0.4 },
      { id: 'p3', item: 'supply_crate', pos: at([8.2, 0.7, 7.8]), yaw: -0.3 },
      { id: 'p4', item: 'metal_barrel', pos: at([-8.6, 0.6, 5.4]), yaw: 0 },
    ],
    npcs: [],
    points: [],
    logic: [],
    lights: [
      { id: 'light-sun', type: 'directional', pos: at([26, 34, 18]), dir: [-0.38, -1, -0.24], color: '#fff1d6', intensity: 1.15, shadows: true },
      { id: 'light-sky', type: 'hemi', pos: at([0, 24, 0]), color: '#dbeafe', ground: '#5c6b47', intensity: 0.55 },
      { id: 'light-beacon', type: 'point', pos: at([BEACON.x, crown + 4.6, BEACON.z]), color: '#ffb547', intensity: 0.9, range: 22 },
    ],
    zones: [
      {
        id: 'trailhead',
        name: 'Trailhead',
        min: [-11, -2, 8],
        max: [11, 24, 20],
        rules: { pvp: false, build: false, physgun: true },
      },
      {
        id: 'beacon-crown',
        name: 'The beacon',
        min: [-6, -2, -14],
        max: [6, 24, -2],
        rules: { pvp: true, build: true, physgun: true },
      },
      {
        id: 'wilds',
        name: 'The wilds',
        min: [-26, -2, -26],
        max: [26, 24, 26],
        rules: { pvp: true, build: true, physgun: true },
      },
    ],
    models: [],
    textures: [],
    spawn: at([0, 1.2, 16]),
    spawnYaw: 0,
  }
}

/** ── The Workshop: a flat yard, a shed you can walk into, benches and a scrap corner ──────────────────── */

function workshop(): MapFileV2 {
  let sid = 0
  const statics: Static[] = []
  const box = (x: number, z: number, size: Vec3, color: string, opts: Partial<Static> & { lift?: number } = {}): Static => {
    const { lift = 0, ...rest } = opts
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'box', size: size.map((n) => round(n)) as Vec3 },
      pos: at([x, lift + size[1] / 2, z]),
      yaw: 0,
      color,
      ...rest,
    }
    statics.push(s)
    return s
  }
  const cylinder = (x: number, z: number, radius: number, height: number, color: string, opts: Partial<Static> = {}): Static => {
    const { ...rest } = opts
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'cylinder', radius: round(radius), height: round(height) },
      pos: at([x, height / 2, z]),
      yaw: 0,
      color,
      ...rest,
    }
    statics.push(s)
    return s
  }

  // The yard: a paved pad with a kerb, so the flat ground reads as a place rather than a void.
  for (const [x, z, w, d] of [
    [0, 0, 44, 0.35], [0, -30, 44, 0.35], [-22, -15, 0.35, 30], [22, -15, 0.35, 30],
  ] as const) {
    box(x, z, [w, 0.3, d], '#8b8f96', { lift: 0.15, tex: 'floor_pavement' })
  }

  // The shed: back and side walls, a roof slab and a door opening facing the spawn (+z).
  box(0, -22, [16, 4.2, 0.4], '#9a9187', { tex: 'weathered_plank_siding' })
  box(-7.8, -16.8, [0.4, 4.2, 10.4], '#9a9187', { tex: 'weathered_plank_siding' })
  box(7.8, -16.8, [0.4, 4.2, 10.4], '#9a9187', { tex: 'weathered_plank_siding' })
  box(0, -16.8, [16.4, 0.35, 11], '#6b4f33', { lift: 4.2, tex: 'clay_roof_tiles' })
  box(-4.5, -11.8, [6, 4.2, 0.35], '#9a9187', { tex: 'weathered_plank_siding' })
  box(4.5, -11.8, [6, 4.2, 0.35], '#9a9187', { tex: 'weathered_plank_siding' })
  // A chimney and a stove, because a workshop needs one.
  box(5.6, -21.4, [1.4, 2.2, 1.4], '#7d5a4f', { lift: 4.55, tex: 'red_brick' })
  cylinder(-5.4, -19.4, 0.6, 1.6, '#4b5563', { tex: 'metal_plate' })

  // Two long workbenches and a shelf.
  box(-3.6, -14.4, [5.6, 0.9, 1.4], '#8a6a45', { tex: 'wood_planks' })
  box(3.8, -14.4, [5.6, 0.9, 1.4], '#8a6a45', { tex: 'wood_planks' })
  box(0, -21.3, [7, 0.35, 0.9], '#7a5c38', { lift: 2.6, tex: 'wood_planks' })

  // A rail of posts along the north edge, and a sign by the gate.
  for (let i = 0; i < 5; i++) box(-18 + i * 9, 20.5, [0.35, 2.2, 0.35], '#6b4f33', { tex: 'wood_planks' })
  box(-14.5, 18.2, [3.4, 1.6, 0.24], '#efe6d4', { lift: 0.9, yaw: 0.12, tex: 'weathered_plank_siding' })
  box(-15.6, 18.2, [0.2, 2.0, 0.2], '#5b4630', {})
  box(-13.4, 18.2, [0.2, 2.0, 0.2], '#5b4630', {})

  return {
    v: 2,
    terrains: [
      {
        id: 'terrain-0',
        name: 'The yard',
        pos: [0, 0, 0],
        halfExtent: 32,
        sub: 16,
        heights: heightsOf(16, () => 0, 32),
        surface: { base: { tex: 'floor_pavement', color: '#a9a49b' } },
      },
    ],
    statics,
    nodes: [
      { id: 'n1', node: 'scrap_pile', pos: at([-16, 0, 10]) },
      { id: 'n2', node: 'branch_pile', pos: at([15, 0, 8]) },
      { id: 'n3', node: 'loose_stones', pos: at([12, 0, 14]) },
      { id: 'n4', node: 'stone_deposit', pos: at([18, 0, 2]) },
    ],
    props: [
      { id: 'p1', item: 'storage_box', pos: at([-5.4, 0.55, -13.2]), yaw: 0.2 },
      { id: 'p2', item: 'wooden_crate', pos: at([5.2, 0.75, -10.4]), yaw: -0.35 },
      { id: 'p3', item: 'wooden_crate', pos: at([6.4, 0.75, -9.1]), yaw: 0.5 },
      { id: 'p4', item: 'metal_barrel', pos: at([10.6, 0.6, 16.2]), yaw: 0 },
      { id: 'p5', item: 'metal_barrel', pos: at([11.9, 0.6, 15.1]), yaw: 0 },
      { id: 'p6', item: 'campfire', pos: at([-16.6, 0.05, 11.4]), yaw: 0 },
      { id: 'p7', item: 'planter_box', pos: at([-9.6, 0.5, 16.4]), yaw: 0.1 },
      { id: 'p8', item: 'merchant_stall', pos: at([17, 0.15, 17]), yaw: -0.7 },
    ],
    npcs: [],
    points: [],
    logic: [],
    lights: [
      { id: 'light-sun', type: 'directional', pos: at([30, 40, 24]), dir: [-0.35, -1, -0.2], color: '#fff4e0', intensity: 1.05, shadows: true },
      { id: 'light-sky', type: 'hemi', pos: at([0, 30, 0]), color: '#e0eaff', ground: '#6b6257', intensity: 0.5 },
      { id: 'light-shed', type: 'point', pos: at([0, 3.6, -16.8]), color: '#ffe0a3', intensity: 0.85, range: 14 },
      { id: 'light-gate', type: 'point', pos: at([-14.5, 3.2, 18.2]), color: '#ffd08a', intensity: 0.55, range: 12 },
    ],
    zones: [
      {
        id: 'yard',
        name: 'The yard',
        min: [-24, -2, -32],
        max: [24, 30, 24],
        rules: { pvp: false, build: true, physgun: true },
      },
      {
        id: 'shed',
        name: 'The workshop',
        min: [-9, -2, -24],
        max: [9, 8, -10],
        rules: { pvp: false, build: false, physgun: true },
      },
    ],
    models: [],
    textures: [],
    spawn: at([0, 1.2, 17]),
    spawnYaw: 0,
  }
}

export interface ExampleWorld {
  title: string
  summary: string
  map: MapFileV2
}

export const EXAMPLE_WORLDS: readonly ExampleWorld[] = [
  {
    title: 'Beacon Hill',
    summary:
      'A small hill to climb, a beacon to light and a trailhead to meet at. Sculpted ground, a flagstone path, benches, a campfire and three zones that decide where you can build and fight.',
    map: beaconHill(),
  },
  {
    title: 'The Workshop',
    summary:
      'A walled yard to build in: a shed you can walk into, two workbenches, crates, barrels, a scrap corner and lamps for the evening. A quiet place to try the editor.',
    map: workshop(),
  },
]
