/**
 * Scrap Island: Scraplandia's world, generated. Production ran on an empty map document (no terrain, statics, nodes or
 * props), so a new player spawned over open water and drowned. This builds the island as an ordinary v2 map
 * document, the same thing the editor saves, so staff can keep editing it in /editor afterwards.
 *
 *   Scrap City     the walled, safe town in the middle: plaza and fountain, market stalls, a crafting corner,
 *                  avenues and a ring road, houses, tenements and shacks, lamps, four watchtowers
 *   the wilds      PvP and resources: the scrapyard (east), the forest (west), the quarry (south-west),
 *                  Rust Ridge and its radio mast (north), the lake (north-east), the farm (south-east),
 *                  the shipwreck beach (south), ruins along the dirt roads
 *
 * Deterministic: the same seed gives the same document. The NPC spawn points in content (thugs at (43, -40) and
 * (40, 48), hares at (55, 6)) sit just outside the city walls at ±38.
 *
 *   pnpm --filter @openvibe/server exec tsx scripts/writeScrapIsland.ts --out <map.json>
 */
import { deflateSync } from 'node:zlib'
import { WATER_LEVEL, type MapFileV2 } from '@openvibe/content'

type Vec3 = [number, number, number]
type Static = MapFileV2['statics'][number]

// ── Numbers ──────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
const round = (v: number, places = 3): number => Math.round(v * 10 ** places) / 10 ** places

/** Value noise on an integer lattice, smoothly interpolated; fbm sums octaves. */
function makeNoise(seed: number): (x: number, z: number) => number {
  const hash = (ix: number, iz: number): number => {
    let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const value = (x: number, z: number): number => {
    const ix = Math.floor(x)
    const iz = Math.floor(z)
    const fx = x - ix
    const fz = z - iz
    const ux = fx * fx * (3 - 2 * fx)
    const uz = fz * fz * (3 - 2 * fz)
    return lerp(
      lerp(hash(ix, iz), hash(ix + 1, iz), ux),
      lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), ux),
      uz,
    )
  }
  return (x: number, z: number): number => {
    let sum = 0
    let amp = 0.5
    let f = 1
    for (let o = 0; o < 4; o++) {
      sum += amp * value(x * f, z * f)
      f *= 2.03
      amp *= 0.5
    }
    return sum / 0.9375
  }
}

// ── Layout ───────────────────────────────────────────────────
export const ISLAND = {
  halfExtent: 210,
  sub: 210,
  cityGround: 2.2,
  /** The city wall runs at ±WALL; the safe zone covers it. */
  wall: 38.5,
  plaza: 11,
  ring: [24, 29] as const,
  avenue: 4,
  scrapyard: { min: [62, -24] as const, max: [108, 24] as const, ground: 2.0 },
  forest: { center: [-108, 22] as const, radius: 56 },
  quarry: { center: [-78, -88] as const },
  ridge: { center: [0, 126] as const },
  lake: { center: [96, 78] as const },
  farm: { center: [86, -82] as const, ground: 2.6 },
  spawn: [0, 0, -17] as Vec3,
}

/** Dirt roads from the city gates out to each district (x, z polylines). */
const ROADS: [number, number][][] = [
  [
    [-38, 0],
    [-62, 6],
    [-86, 14],
  ],
  [
    [0, -38],
    [-14, -56],
    [-42, -72],
    [-62, -84],
  ],
  [
    [-14, -56],
    [-6, -96],
    [0, -132],
  ],
  [
    [38, 0],
    [62, 0],
  ],
  [
    [50, 0],
    [64, -40],
    [78, -66],
  ],
  [
    [0, 38],
    [4, 70],
    [2, 104],
  ],
  [
    [4, 70],
    [44, 72],
    [76, 74],
  ],
]

function distToSegment(px: number, pz: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const t = clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz), 0, 1)
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz))
}
function roadDistance(x: number, z: number): number {
  let d = Infinity
  for (const road of ROADS)
    for (let i = 0; i + 1 < road.length; i++)
      d = Math.min(d, distToSegment(x, z, road[i]!, road[i + 1]!))
  return d
}
const inCity = (x: number, z: number, pad = 0): boolean =>
  Math.max(Math.abs(x), Math.abs(z)) <= ISLAND.wall + pad
const rectDistance = (
  x: number,
  z: number,
  min: readonly [number, number],
  max: readonly [number, number],
): number => Math.hypot(Math.max(min[0] - x, 0, x - max[0]), Math.max(min[1] - z, 0, z - max[1]))

// ── Terrain ──────────────────────────────────────────────────
export function makeHeight(seed: number): (x: number, z: number) => number {
  const n = makeNoise(seed)
  const n2 = makeNoise(seed + 17)
  return (x: number, z: number): number => {
    const r = Math.hypot(x, z)
    const coast = 158 + 22 * (n(x * 0.009 + 40, z * 0.009 - 12) - 0.5) * 2
    const inland = coast - r
    // Rolling interior, a little higher toward the north.
    let land =
      3 +
      3.2 * (n(x * 0.018, z * 0.018) - 0.5) * 2 +
      1.2 * (n2(x * 0.06, z * 0.06) - 0.5) +
      clamp(z / 160, -0.4, 1) * 2.5
    // Rust Ridge: a long spine of hills across the north.
    const [rx, rz] = ISLAND.ridge.center
    land +=
      26 *
      Math.exp(-(((x - rx) / 72) ** 2 + ((z - rz) / 24) ** 2)) *
      (0.75 + 0.5 * n2(x * 0.03, z * 0.03))
    land += 12 * Math.exp(-(((x + 60) / 30) ** 2 + ((z - 110) / 22) ** 2))
    // The forest's hills.
    const [fx, fz] = ISLAND.forest.center
    land +=
      7 *
      Math.exp(-(((x - fx) / 46) ** 2 + ((z - fz) / 58) ** 2)) *
      (0.6 + 0.8 * n(x * 0.04, z * 0.04))
    // The quarry: a mesa cut into terraces.
    const [qx, qz] = ISLAND.quarry.center
    const dq = Math.hypot(x - qx, z - qz)
    land += 9 * smoothstep(40, 27, dq)
    land -= Math.floor((9.5 * smoothstep(25, 6, dq)) / 2.4) * 2.4
    // The lake.
    const [lx, lz] = ISLAND.lake.center
    land -= 7.5 * smoothstep(30, 9, Math.hypot(x - lx, z - lz))
    // Flat places: the city basin, the scrapyard, the farm.
    land = lerp(
      land,
      ISLAND.cityGround,
      smoothstep(ISLAND.wall + 22, ISLAND.wall + 7, Math.max(Math.abs(x), Math.abs(z))),
    )
    land = lerp(
      land,
      ISLAND.scrapyard.ground,
      smoothstep(14, 3, rectDistance(x, z, ISLAND.scrapyard.min, ISLAND.scrapyard.max)),
    )
    const [ax, az] = ISLAND.farm.center
    land = lerp(land, ISLAND.farm.ground, smoothstep(30, 18, Math.hypot(x - ax, z - az)))
    // Roads keep a gentle grade.
    land = lerp(
      land,
      Math.min(land, 3.4 + clamp(z / 160, -0.4, 1) * 2.5),
      smoothstep(9, 2, roadDistance(x, z)) * 0.6,
    )
    // Beaches down to the sea floor.
    const sea = WATER_LEVEL - 1.4 - clamp(-inland * 0.16, 0, 9)
    const beach = lerp(WATER_LEVEL + 0.35, Math.max(land, 1.4), smoothstep(2, 22, inland))
    return inland <= 0 ? lerp(beach, sea, smoothstep(0, 10, -inland)) : beach
  }
}

// ── The paint mask (r grass, g rock, b sand; alpha stays opaque) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** A minimal RGBA PNG encoder (no filters), enough for a coverage mask. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    )
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}

// ── The document ─────────────────────────────────────────────
export function generateScrapIsland(seed = 20261019): MapFileV2 {
  const rand = mulberry32(seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const range = (lo: number, hi: number): number => lo + rand() * (hi - lo)
  const height = makeHeight(seed)
  const { halfExtent: H, sub } = ISLAND
  const cell = (H * 2) / sub

  // Heights on the patch grid: index j*(sub+1)+col is x = col*cell - H, z = j*cell - H (content terrain.ts).
  const heights = new Float32Array((sub + 1) * (sub + 1))
  for (let j = 0; j <= sub; j++)
    for (let col = 0; col <= sub; col++)
      heights[j * (sub + 1) + col] = height(col * cell - H, j * cell - H)
  const ground = (x: number, z: number): number => {
    const fx = clamp((x + H) / cell, 0, sub)
    const fz = clamp((z + H) / cell, 0, sub)
    const c0 = Math.min(sub - 1, Math.floor(fx))
    const j0 = Math.min(sub - 1, Math.floor(fz))
    const tx = fx - c0
    const tz = fz - j0
    const at = (c: number, j: number): number => heights[j * (sub + 1) + c]!
    return lerp(
      lerp(at(c0, j0), at(c0 + 1, j0), tx),
      lerp(at(c0, j0 + 1), at(c0 + 1, j0 + 1), tx),
      tz,
    )
  }
  const slope = (x: number, z: number): number =>
    Math.hypot(ground(x + 1, z) - ground(x - 1, z), ground(x, z + 1) - ground(x, z - 1)) / 2

  // Mask: image row 0 is +z (the patch's v = 1), column 0 is -x.
  const M = 512
  const mask = new Uint8Array(M * M * 4)
  for (let py = 0; py < M; py++) {
    for (let px = 0; px < M; px++) {
      const x = -H + ((px + 0.5) / M) * 2 * H
      const z = H - ((py + 0.5) / M) * 2 * H
      const h = ground(x, z)
      const s = slope(x, z)
      const road = smoothstep(3.2, 1.6, roadDistance(x, z))
      const yard = rectDistance(x, z, ISLAND.scrapyard.min, ISLAND.scrapyard.max) < 1 ? 1 : 0
      const sand = smoothstep(1.9, 0.9, h)
      const rock = Math.max(smoothstep(0.55, 0.95, s), smoothstep(15, 21, h) * 0.85)
      const grass = (1 - sand) * (1 - rock) * (1 - road) * (1 - yard) * smoothstep(0.6, 1.4, h)
      const o = (py * M + px) * 4
      mask[o] = Math.round(255 * clamp(grass, 0, 1))
      mask[o + 1] = Math.round(255 * clamp(rock, 0, 1))
      mask[o + 2] = Math.round(255 * clamp(sand * (1 - rock), 0, 1))
      mask[o + 3] = 255
    }
  }

  const statics: Static[] = []
  const nodes: MapFileV2['nodes'] = []
  const props: MapFileV2['props'] = []
  const lights: MapFileV2['lights'] = []
  let sid = 0
  /** A box standing on the ground at (x, z): `lift` raises its base. */
  const box = (
    x: number,
    z: number,
    size: Vec3,
    style: Partial<Static> & { lift?: number; base?: number } = {},
  ): Static => {
    const { lift = 0, base, ...rest } = style
    const y = (base ?? ground(x, z)) + lift + size[1] / 2
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'box', size: size.map((v) => round(v)) as Vec3 },
      pos: [round(x), round(y), round(z)],
      yaw: 0,
      color: '#ffffff',
      ...rest,
    }
    statics.push(s)
    return s
  }
  const cylinder = (
    x: number,
    z: number,
    radius: number,
    h: number,
    style: Partial<Static> & { lift?: number; base?: number } = {},
  ): Static => {
    const { lift = 0, base, ...rest } = style
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'cylinder', radius: round(radius), height: round(h) },
      pos: [round(x), round((base ?? ground(x, z)) + lift + h / 2), round(z)],
      yaw: 0,
      color: '#ffffff',
      ...rest,
    }
    statics.push(s)
    return s
  }
  const rock = (x: number, z: number, r: number): Static => {
    const s: Static = {
      id: `s${++sid}`,
      shape: { type: 'sphere', radius: round(r) },
      pos: [round(x), round(ground(x, z) + r * 0.35), round(z)],
      yaw: 0,
      color: pick(['#8d8a83', '#7c7a74', '#9a958c']),
      tex: 'gray_rocks',
    }
    statics.push(s)
    return s
  }
  let nid = 0
  const node = (kind: string, x: number, z: number): void => {
    nodes.push({ id: `n${++nid}`, node: kind, pos: [round(x), 0, round(z)] })
  }
  let pid = 0
  const prop = (item: string, x: number, z: number, yaw = 0, lift = 0): void => {
    props.push({ id: `p${++pid}`, item, pos: [round(x), round(lift), round(z)], yaw: round(yaw) })
  }
  const G = ISLAND.cityGround
  const RUST = ['#8a4b2a', '#7a5a3a', '#6e4a36', '#94603a', '#5f5348']
  const PAINT = ['#b4553f', '#3f6f8c', '#6d7a3a', '#b08a3c', '#7b4f7a', '#4e7d6b']

  // ── Scrap City ──
  const slab = (x0: number, z0: number, x1: number, z1: number): void => {
    box((x0 + x1) / 2, (z0 + z1) / 2, [x1 - x0, 0.1, z1 - z0], {
      base: G - 0.05,
      tex: 'floor_pavement',
      color: '#c9c4ba',
      uv: { sx: (x1 - x0) / 4, sy: (z1 - z0) / 4 },
    })
  }
  const {
    plaza: P,
    avenue: A,
    ring: [R0, R1],
    wall: W,
  } = ISLAND
  slab(-P, -P, P, P)
  for (const s of [-1, 1]) {
    slab(-A, s > 0 ? P : -W, A, s > 0 ? W : -P)
    slab(s > 0 ? P : -W, -A, s > 0 ? W : -P, A)
    slab(-R1, s > 0 ? R0 : -R1, R1, s > 0 ? R1 : -R0)
    slab(s > 0 ? R0 : -R1, -R0, s > 0 ? R1 : -R0, R0)
  }
  cylinder(0, 0, 1.7, 0.9, { base: G, decor: 'fountain', color: '#8f8a82' })
  for (const [x, z, yaw] of [
    [0, 6.5, 0],
    [0, -6.5, 0],
    [6.5, 0, Math.PI / 2],
    [-6.5, 0, Math.PI / 2],
  ] as const) {
    box(x, z, [2.4, 0.45, 0.55], { base: G, yaw, tex: 'wood_planks', color: '#a07a52' })
  }
  // The market around the plaza, the crafting corner, the noticeboard.
  for (const [x, z, yaw] of [
    [-8.5, 8.5, Math.PI * 0.75],
    [8.5, 8.5, -Math.PI * 0.75],
    [-8.5, -8.5, Math.PI * 0.25],
    [8.5, -8.5, -Math.PI * 0.25],
  ] as const)
    prop('merchant_stall', x, z, yaw)
  prop('workbench', 9.2, 2.5, -Math.PI / 2)
  prop('campfire', 9.2, -1.8)
  prop('storage_box', 10, -4.4, -Math.PI / 2)
  prop('copper_still', -9.6, 2.6, Math.PI / 2)
  prop('storage_box', -10, -3, Math.PI / 2)
  box(-4.6, P - 0.6, [2.2, 2.4, 0.2], { base: G, tex: 'weathered_plank_siding', color: '#c8a978' })

  // Buildings on lots: houses (pitched roofs), tenements (tall, flat, rooftop tanks), shacks (rusty, leaning).
  const building = (cx: number, cz: number, room: number): void => {
    const kind = rand() < 0.45 ? 'house' : rand() < 0.6 ? 'tenement' : 'shack'
    const yaw = (Math.floor(rand() * 4) * Math.PI) / 2
    if (kind === 'house') {
      const w = range(room * 0.55, room * 0.8)
      const d = range(room * 0.55, room * 0.8)
      box(cx, cz, [w, range(3.6, 5.2), d], {
        base: G,
        yaw,
        decor: 'building',
        tex: pick(['plastered_wall_02', 'red_brick', 'weathered_plank_siding']),
        color: pick(['#ffffff', '#efe2cf', '#e6d2c0', '#d9e0e6']),
      })
    } else if (kind === 'tenement') {
      const w = range(room * 0.6, room * 0.85)
      const d = range(room * 0.6, room * 0.85)
      const h = range(7.5, 13.5)
      box(cx, cz, [w, h, d], {
        base: G,
        yaw,
        tex: pick(['red_brick', 'plastered_wall_02']),
        color: pick(['#ffffff', '#e8ddd0', '#d8cbbb']),
      })
      box(cx, cz, [w + 0.4, 0.5, d + 0.4], {
        base: G + h,
        yaw,
        color: '#5d5a55',
        tex: 'metal_plate',
      })
      if (rand() < 0.7)
        cylinder(
          cx + range(-w / 4, w / 4),
          cz + range(-d / 4, d / 4),
          range(0.9, 1.4),
          range(1.6, 2.4),
          { base: G + h + 0.5, color: pick(RUST), tex: 'metal_plate' },
        )
      if (rand() < 0.6)
        box(cx + range(-w / 4, w / 4), cz + range(-d / 4, d / 4), [1.4, 1, 1.2], {
          base: G + h + 0.5,
          color: '#7b7d80',
          tex: 'metal_plate',
        })
    } else {
      const w = range(room * 0.45, room * 0.7)
      const d = range(room * 0.45, room * 0.7)
      const h = range(2.8, 3.8)
      const tilt = range(-0.03, 0.03)
      box(cx, cz, [w, h, d], {
        base: G,
        rot: [tilt, yaw, -tilt],
        tex: 'metal_plate',
        color: pick(RUST),
      })
      box(cx, cz, [w + 0.9, 0.18, d + 0.9], {
        base: G + h,
        rot: [range(0.04, 0.1), yaw, 0],
        tex: 'metal_plate',
        color: pick(RUST),
      })
    }
  }
  const yardFill = (cx: number, cz: number): void => {
    const r = rand()
    if (r < 0.4) {
      node('scrap_pile', cx + range(-1.5, 1.5), cz + range(-1.5, 1.5))
      prop(
        pick(['metal_barrel', 'wooden_crate']),
        cx + range(-2.5, 2.5),
        cz + range(-2.5, 2.5),
        range(0, 6),
      )
    } else if (r < 0.7) {
      node('berry_bush', cx + range(-1.5, 1.5), cz + range(-1.5, 1.5))
      prop('planter_box', cx + range(-2, 2), cz + range(-2, 2), range(0, 6))
    } else {
      for (let k = 0; k < 3; k++)
        prop(
          pick(['wooden_crate', 'metal_barrel', 'supply_crate']),
          cx + range(-2.8, 2.8),
          cz + range(-2.8, 2.8),
          range(0, 6),
        )
    }
  }
  for (const cx of [-20, -14, -8, 8, 14, 20]) {
    for (const cz of [-20, -14, -8, 8, 14, 20]) {
      if (Math.max(Math.abs(cx), Math.abs(cz)) <= 14 && Math.min(Math.abs(cx), Math.abs(cz)) <= 8)
        continue // the plaza's edge stays open
      if (rand() < 0.72) building(cx, cz, 5.6)
      else yardFill(cx, cz)
    }
  }
  for (const cx of [-33.5, -22.5, -11.5, 11.5, 22.5, 33.5]) {
    for (const cz of [-33.5, 33.5]) {
      for (const [x, z] of [
        [cx, cz],
        [cz, cx],
      ] as const) {
        if (rand() < 0.75) building(x, z, 8)
        else yardFill(x, z)
      }
    }
  }
  for (const [x, z] of [
    [-33.5, -33.5],
    [33.5, -33.5],
    [-33.5, 33.5],
    [33.5, 33.5],
  ] as const)
    building(x, z, 8)

  // The wall: scrap plates of uneven height, gates at the four avenues, a watchtower on each corner.
  for (const side of [-1, 1]) {
    for (let t = -W; t < W; t += 3) {
      if (Math.abs(t + 1.5) < A + 1.2) continue
      const h = range(3.4, 5.2)
      const tint = pick(RUST)
      box(t + 1.5, side * W, [3.1, h, 0.6], {
        base: G,
        rot: [0, 0, range(-0.04, 0.04)],
        tex: 'metal_plate',
        color: tint,
      })
      box(side * W, t + 1.5, [0.6, h, 3.1], {
        base: G,
        rot: [range(-0.04, 0.04), 0, 0],
        tex: 'metal_plate',
        color: pick(RUST),
      })
    }
    for (const gate of [
      [0, side * W],
      [side * W, 0],
    ] as const) {
      const along = gate[0] === 0
      for (const off of [-A - 0.6, A + 0.6]) {
        const [x, z] = along ? [off, gate[1]] : [gate[0], off]
        box(x, z, [1.2, 6.4, 1.2], { base: G, tex: 'metal_plate', color: '#4d4a46' })
      }
      box(gate[0], gate[1], along ? [2 * A + 2.4, 0.9, 1] : [1, 0.9, 2 * A + 2.4], {
        base: G + 6.4,
        tex: 'metal_plate',
        color: '#6e4a36',
      })
    }
  }
  for (const [x, z] of [
    [-W, -W],
    [W, -W],
    [-W, W],
    [W, W],
  ] as const) {
    box(x, z, [3, 9, 3], { base: G, tex: 'weathered_plank_siding', color: '#b89a74' })
    box(x, z, [4.6, 0.35, 4.6], { base: G + 9, tex: 'wood_planks', color: '#9c7a55' })
    for (const [dx, dz] of [
      [-2.1, 0],
      [2.1, 0],
      [0, -2.1],
      [0, 2.1],
    ] as const)
      box(x + dx, z + dz, dx ? [0.2, 1.1, 4.6] : [4.6, 1.1, 0.2], {
        base: G + 9.35,
        tex: 'wood_planks',
        color: '#8a6b48',
      })
    box(x, z, [4.2, 0.2, 4.2], {
      base: G + 11.6,
      rot: [0.06, 0, 0.06],
      tex: 'metal_plate',
      color: '#6e4a36',
    })
  }
  // Starter piles just inside each gate: fallen branches and loose stones, which need no tool, so a new player's first
  // planks and stone axe are a short walk from spawn.
  for (const [ax, az] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    const at = (along: number, depth: number): [number, number] =>
      ax === 0 ? [along, az * depth] : [ax * depth, along]
    for (const [along, depth, kind] of [
      [-6.2, 34.5, 'branch_pile'],
      [6.2, 34.5, 'loose_stones'],
      [-6.2, 31.5, 'loose_stones'],
      [6.2, 31.5, 'branch_pile'],
    ] as const) {
      const [x, z] = at(along, depth)
      node(kind, x, z)
    }
  }
  // Lamps: down each avenue and round the plaza (each one is a point light at night, so not too many).
  for (const [x, z] of [
    [5, 16],
    [-5, -16],
    [16, -5],
    [-16, 5],
    [5, -32],
    [-5, 32],
    [32, 5],
    [-32, -5],
    [10.5, 10.5],
    [-10.5, -10.5],
    [10.5, -10.5],
    [-10.5, 10.5],
  ] as const) {
    cylinder(x, z, 0.08, 3.5, { base: G, decor: 'lamp', color: '#2c3136' })
  }

  // ── The scrapyard (east) ──
  const { min: ymin, max: ymax, ground: YG } = ISLAND.scrapyard
  box((ymin[0] + ymax[0]) / 2, 0, [ymax[0] - ymin[0], 0.1, ymax[1] - ymin[1]], {
    base: YG - 0.05,
    tex: 'floor_pavement',
    color: '#8f8b84',
    uv: { sx: 12, sy: 12 },
  })
  for (let x = ymin[0]; x < ymax[0]; x += 4) {
    for (const z of [ymin[1], ymax[1]])
      box(x + 2, z, [4.05, range(2.6, 3.6), 0.35], {
        base: YG,
        tex: 'metal_plate',
        color: pick(RUST),
      })
  }
  for (let z = ymin[1]; z < ymax[1]; z += 4) {
    if (Math.abs(z + 2) < 6) continue // the gate faces the city
    for (const x of [ymin[0], ymax[0]])
      box(x, z + 2, [0.35, range(2.6, 3.6), 4.05], {
        base: YG,
        tex: 'metal_plate',
        color: pick(RUST),
      })
  }
  // Container stacks in rows, with lanes between them.
  for (const zRow of [-17, -9, 9, 17]) {
    for (let x = ymin[0] + 8; x < ymax[0] - 6; x += 7) {
      if (rand() < 0.2) continue
      const levels = rand() < 0.5 ? 1 : rand() < 0.7 ? 2 : 3
      const yaw = rand() < 0.15 ? range(-0.4, 0.4) : 0
      for (let k = 0; k < levels; k++)
        box(x + range(-0.3, 0.3), zRow + range(-0.3, 0.3), [6.1, 2.6, 2.44], {
          base: YG + k * 2.6,
          yaw: yaw + range(-0.05, 0.05),
          tex: 'metal_plate',
          color: pick(PAINT),
        })
    }
  }
  // The crane and its boom.
  box(100, -2, [2.2, 19, 2.2], { base: YG, tex: 'metal_plate', color: '#c49a2c' })
  box(92, -2, [17, 1.1, 1.1], { base: YG + 19, tex: 'metal_plate', color: '#c49a2c' })
  box(102.5, -2, [3.2, 2.2, 2.2], { base: YG + 18, color: '#5a5650', tex: 'metal_plate' })
  // Car wrecks.
  for (let k = 0; k < 9; k++) {
    const x = range(ymin[0] + 6, ymax[0] - 6)
    const z = range(-5, 5)
    const yaw = range(0, Math.PI)
    const tint = pick(RUST)
    box(x, z, [4.2, 1.2, 1.9], {
      base: YG,
      yaw,
      tex: 'metal_plate',
      color: tint,
      rot: [range(-0.06, 0.06), yaw, range(-0.12, 0.12)],
    })
    box(x, z, [2.1, 0.8, 1.7], {
      base: YG + 1.2,
      yaw,
      tex: 'metal_plate',
      color: tint,
      rot: [0, yaw, range(-0.1, 0.1)],
    })
  }
  for (let k = 0; k < 18; k++)
    node('scrap_pile', range(ymin[0] + 4, ymax[0] - 4), range(ymin[1] + 3, ymax[1] - 3))
  for (let k = 0; k < 10; k++)
    prop(
      pick(['metal_barrel', 'wooden_crate', 'supply_crate']),
      range(ymin[0] + 4, ymax[0] - 4),
      range(-4, 4),
      range(0, 6),
    )
  prop('salvaged_motor', 86, 3)
  lights.push({
    id: 'l-yard',
    type: 'point',
    pos: [round(84), round(YG + 8), 0],
    color: '#ffc27a',
    intensity: 0.6,
    range: 34,
  })

  // ── The wilds: forest, quarry, ridge, lake, farm, beach, ruins ──
  const placed: [number, number][] = []
  const spaced = (x: number, z: number, d: number): boolean =>
    placed.every(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 >= d * d)
  const wildOk = (x: number, z: number, minH = 1): boolean =>
    !inCity(x, z, 6) &&
    ground(x, z) > minH &&
    roadDistance(x, z) > 3.5 &&
    rectDistance(x, z, ymin, ymax) > 4 &&
    slope(x, z) < 0.6
  const scatter = (
    kind: string,
    cx: number,
    cz: number,
    radius: number,
    count: number,
    minDist: number,
    minH = 1,
  ): void => {
    for (let tries = 0, n = 0; n < count && tries < count * 40; tries++) {
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(rand()) * radius
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      if (!wildOk(x, z, minH) || !spaced(x, z, minDist)) continue
      placed.push([x, z])
      node(kind, x, z)
      n++
    }
  }
  const [fcx, fcz] = ISLAND.forest.center
  scatter('oak_tree', fcx, fcz, ISLAND.forest.radius, 150, 4.6)
  scatter('branch_pile', fcx, fcz, ISLAND.forest.radius, 22, 3)
  scatter('berry_bush', fcx + 20, fcz - 10, ISLAND.forest.radius * 0.9, 26, 3)
  scatter('oak_tree', -30, 88, 34, 40, 5.5)
  scatter('oak_tree', 40, 112, 30, 26, 6)
  scatter('oak_tree', 120, 20, 26, 22, 6)
  scatter('loose_stones', 0, 0, 150, 30, 6)
  scatter('branch_pile', 0, 0, 150, 24, 6)
  // The quarry: deposits on the terraces and the pit floor.
  const [qcx, qcz] = ISLAND.quarry.center
  for (let tries = 0, n = 0; n < 26 && tries < 2000; tries++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 24
    const x = qcx + Math.cos(a) * r
    const z = qcz + Math.sin(a) * r
    if (ground(x, z) < 1 || slope(x, z) > 0.45 || !spaced(x, z, 4)) continue
    placed.push([x, z])
    node('stone_deposit', x, z)
    n++
  }
  scatter('loose_stones', qcx, qcz, 34, 14, 3)
  box(qcx + 18, qcz + 22, [5, 3, 4], {
    yaw: 0.5,
    tex: 'weathered_plank_siding',
    color: '#a88c6a',
    decor: 'building',
  })
  box(qcx + 12, qcz + 26, [1.4, 1.4, 1.4], { yaw: 0.2, tex: 'wood_planks', color: '#8a6b48' })
  // Boulders all over, big ones on the ridge.
  for (let k = 0; k < 46; k++) {
    const x = range(-150, 150)
    const z = range(-150, 150)
    if (!wildOk(x, z, 0.8) || !spaced(x, z, 5)) continue
    placed.push([x, z])
    rock(x, z, range(0.8, 2.2))
  }
  for (let k = 0; k < 18; k++) {
    const x = range(-70, 70)
    const z = range(105, 145)
    if (ground(x, z) < 6 || !spaced(x, z, 6)) continue
    placed.push([x, z])
    rock(x, z, range(1.6, 3.4))
  }
  // Rust Ridge: the old radio mast on the highest point, a lookout shack beside it.
  let peak: [number, number] = [0, 126]
  for (let x = -60; x <= 60; x += 3)
    for (let z = 110; z <= 140; z += 3) if (ground(x, z) > ground(peak[0], peak[1])) peak = [x, z]
  const [mx, mz] = peak
  cylinder(mx, mz, 0.35, 28, { lift: -0.5, tex: 'metal_plate', color: '#9a3a2a' })
  for (const [dx, dz] of [
    [0.9, 0],
    [-0.9, 0],
    [0, 0.9],
    [0, -0.9],
  ] as const)
    box(mx + dx, mz + dz, [0.12, 22, 0.12], {
      lift: -0.5,
      rot: [dz ? Math.sign(dz) * 0.04 : 0, 0, dx ? -Math.sign(dx) * 0.04 : 0],
      color: '#8a8a8a',
      tex: 'metal_plate',
    })
  box(mx, mz, [3.2, 0.3, 3.2], { lift: 14, tex: 'metal_plate', color: '#6b6b6b' })
  box(mx + 6, mz - 3, [4, 2.6, 3.4], { yaw: 0.3, tex: 'metal_plate', color: '#7a5a3a' })
  prop('storage_box', mx + 6, mz - 6, 0.3)
  lights.push({
    id: 'l-mast',
    type: 'point',
    pos: [round(mx), round(ground(mx, mz) + 27.6), round(mz)],
    color: '#ff3b2f',
    intensity: 1.2,
    range: 40,
  })
  // The lake: a jetty and a rowboat.
  const [lcx, lcz] = ISLAND.lake.center
  let shore: [number, number] = [lcx - 30, lcz]
  for (let r = 4; r < 40; r += 0.5)
    if (ground(lcx - r, lcz) > 0.3) {
      shore = [lcx - r, lcz]
      break
    }
  box(shore[0] + 5, shore[1], [12, 0.25, 2.6], {
    base: Math.max(ground(shore[0], shore[1]), WATER_LEVEL) + 0.35,
    tex: 'wood_planks',
    color: '#9c7a55',
  })
  for (const dx of [0, 4, 8, 11])
    for (const dz of [-1.1, 1.1])
      cylinder(shore[0] + dx, shore[1] + dz, 0.14, 2.8, {
        base: WATER_LEVEL - 1.8,
        tex: 'wood_planks',
        color: '#6e5238',
      })
  box(shore[0] + 9, shore[1] + 3.4, [3.2, 0.6, 1.3], {
    base: WATER_LEVEL - 0.15,
    yaw: 0.4,
    tex: 'wood_planks',
    color: '#7d5a3a',
  })
  scatter('berry_bush', lcx, lcz, 40, 10, 3)
  // The farm: fenced fields, a barn, planters.
  const [acx, acz] = ISLAND.farm.center
  const FG = ISLAND.farm.ground
  for (const [x0, z0, x1, z1] of [[acx - 16, acz - 12, acx + 16, acz + 12]] as const) {
    for (let x = x0; x < x1; x += 3)
      for (const z of [z0, z1])
        if (Math.abs(x + 1.5 - acx) > 2.5)
          box(x + 1.5, z, [3, 1.1, 0.15], { base: FG, tex: 'wood_planks', color: '#8a6b48' })
    for (let z = z0; z < z1; z += 3)
      for (const x of [x0, x1])
        box(x, z + 1.5, [0.15, 1.1, 3], { base: FG, tex: 'wood_planks', color: '#8a6b48' })
  }
  box(acx + 9, acz + 4, [10, 5.5, 8], {
    base: FG,
    tex: 'weathered_plank_siding',
    color: '#b0503c',
    decor: 'building',
  })
  box(acx - 10, acz + 6, [3.2, 7, 3.2], { base: FG, tex: 'metal_plate', color: '#9aa0a6' })
  for (let k = 0; k < 8; k++)
    prop('planter_box', acx - 11 + (k % 4) * 4, acz - 6 + Math.floor(k / 4) * 5, 0)
  prop('water_tank', acx - 4, acz + 8)
  for (let k = 0; k < 8; k++) node('berry_bush', acx - 13 + k * 3.4, acz - 10.5)
  cylinder(acx + 2, acz - 2, 0.1, 2.2, { base: FG, color: '#6e5238' })
  box(acx + 2, acz - 2, [1.4, 0.12, 0.12], { base: FG + 1.6, color: '#6e5238' })
  // The shipwreck on the south beach.
  let wreck: [number, number] = [0, -150]
  for (let z = -120; z > -175; z -= 0.5)
    if (ground(6, z) < WATER_LEVEL + 0.4) {
      wreck = [6, z + 2]
      break
    }
  const WG = WATER_LEVEL - 0.6
  box(wreck[0], wreck[1], [18, 4.2, 5.2], {
    base: WG,
    rot: [0.12, 0.35, 0.28],
    tex: 'wood_planks',
    color: '#6e5238',
  })
  box(wreck[0] - 2, wreck[1] + 0.8, [9, 0.3, 4], {
    base: WG + 4,
    rot: [0.12, 0.35, 0.28],
    tex: 'wood_planks',
    color: '#8a6b48',
  })
  cylinder(wreck[0] + 2, wreck[1] - 1, 0.3, 13, {
    base: WG + 2,
    rot: [0.5, 0.35, 0.3],
    tex: 'wood_planks',
    color: '#5e4430',
  })
  for (let k = 0; k < 6; k++)
    prop(
      pick(['wooden_crate', 'supply_crate', 'metal_barrel']),
      wreck[0] + range(-9, 9),
      wreck[1] + range(4, 12),
      range(0, 6),
    )
  scatter('branch_pile', wreck[0], wreck[1] + 12, 30, 8, 3, 0.2)
  // Ruins along the roads: broken walls of old houses, a crate or two.
  for (const [x, z] of [
    [-60, 18],
    [-30, -66],
    [60, -46],
    [10, 82],
    [-120, -40],
    [124, -20],
    [-40, 130],
    [40, -120],
  ] as const) {
    if (!wildOk(x, z, 0.6)) continue
    const yaw = range(0, Math.PI)
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const at = (dx: number, dz: number): [number, number] => [
      x + dx * c + dz * s,
      z - dx * s + dz * c,
    ]
    const tex = pick(['red_brick', 'plastered_wall_02'])
    for (const [dx, dz, w, d, h] of [
      [0, -3, 7, 0.5, range(1.2, 3.4)],
      [-3.5, 0, 0.5, 6, range(0.8, 2.8)],
      [3.5, 0.8, 0.5, 4.2, range(1, 2.4)],
    ] as const) {
      const [px, pz] = at(dx, dz)
      box(px, pz, [w, h, d], { yaw, tex, color: '#d8cbbb' })
    }
    const [cx, cz] = at(0, 0.5)
    prop(pick(['wooden_crate', 'supply_crate', 'storage_box']), cx, cz, yaw)
  }

  const terrain: MapFileV2['terrains'][number] = {
    id: 'island',
    name: 'Scrap Island',
    pos: [0, 0, 0],
    halfExtent: H,
    sub,
    heights: Buffer.from(heights.buffer).toString('base64'),
    surface: {
      base: { tex: 'brown_mud_dry', color: '#9a8466' },
      paint: {
        layers: [
          // No `scale`: layers tile like the ones the editor paints (half the terrain's extent, ~4 m a tile).
          { id: 'grass', tex: 'leafy_grass', color: '#b9c79a', channel: 'r' },
          { id: 'rock', tex: 'gray_rocks', channel: 'g' },
          { id: 'sand', tex: 'brown_mud_dry', color: '#efdcae', channel: 'b' },
        ],
        mask: `data:image/png;base64,${encodePng(M, M, mask).toString('base64')}`,
      },
    },
  }
  const top = (x: number, z: number): number => ground(x, z) + 1.2
  return {
    v: 2,
    terrains: [terrain],
    statics,
    nodes,
    props,
    lights,
    zones: [
      {
        id: 'scrap-city',
        name: 'Scrap City',
        min: [-W - 2, -10, -W - 2],
        max: [W + 2, 60, W + 2],
        rules: { pvp: false, build: false, physgun: true },
      },
    ],
    models: [],
    textures: [],
    spawn: [ISLAND.spawn[0], round(top(ISLAND.spawn[0], ISLAND.spawn[2])), ISLAND.spawn[2]],
    spawnYaw: 0,
  }
}
