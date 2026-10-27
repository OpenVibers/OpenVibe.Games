/**
 * The editor's authoring palettes and shared ids.
 *
 * Pure data: what the Mesh and Entity tools can place, which stock textures
 * exist, and how resource nodes are represented in the viewport. Kept out of
 * main.ts so adding a placeable is a data edit, not surgery on boot().
 */
import type { StaticBody } from '@openvibe/content'

export type Tool = 'terrain' | 'paint' | 'entity' | 'mesh' | 'select' | 'face' | 'light' | 'zone'

/**
 * Session-stable id generator for map objects (never array positions). The time and counter alone repeat across
 * sessions: two editors on one map (collaboration, or a team) placing in the same millisecond with the same count
 * would mint the same id, so each session adds a random tag of its own.
 */
let idCounter = 0
const SESSION_TAG = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}${SESSION_TAG}-${(idCounter++).toString(36)}`

export interface Placeable {
  name: string
  kind: 'static' | 'node' | 'spawn' | 'model' | 'prop' | 'patch' | 'npc'
  shape?: StaticBody['shape']
  color?: string
  tex?: string
  decor?: string
  node?: string
  /** NPC archetype id (kind 'npc'). */
  npc?: string
  modelId?: string
}

/** Mesh tool: primitive shapes the user builds everything from (plus
 *  imported glb models, appended at runtime). No prefab world props —
 *  buildings, ramps and furniture are authored, not picked. */
export const PLACEABLES: Placeable[] = [
  { name: '⬛ Box', kind: 'static', shape: { type: 'box', size: [2, 2, 2] }, color: '#8a8d90' },
  {
    name: '▬ Panel / wall',
    kind: 'static',
    shape: { type: 'box', size: [4, 3, 0.3] },
    color: '#9a9187',
  },
  {
    name: '⚫ Cylinder',
    kind: 'static',
    shape: { type: 'cylinder', radius: 1, height: 2 },
    color: '#8f8a82',
  },
  { name: '🔘 Sphere', kind: 'static', shape: { type: 'sphere', radius: 1 }, color: '#7b7f83' },
  { name: '⛰ Terrain patch (32m sculptable)', kind: 'patch' },
]

/** Entity tool: gameplay spawns — not geometry. */
export const ENTITY_DEFS: Placeable[] = [
  { name: '🚩 Spawn point', kind: 'spawn' },
  { name: '🌳 Oak tree (chop)', kind: 'node', node: 'oak_tree' },
  { name: '🫐 Berry bush', kind: 'node', node: 'berry_bush' },
  { name: '🪨 Stone deposit (pick)', kind: 'node', node: 'stone_deposit' },
  { name: '🌿 Branch pile', kind: 'node', node: 'branch_pile' },
  { name: '🥌 Loose stones', kind: 'node', node: 'loose_stones' },
  { name: '⚙ Scrap pile', kind: 'node', node: 'scrap_pile' },
  { name: '🏪 Merchant stall (shop)', kind: 'prop', node: 'merchant_stall' },
  { name: '📦 Wooden crate (prop)', kind: 'prop', node: 'wooden_crate' },
  { name: '🛢 Metal barrel (prop)', kind: 'prop', node: 'metal_barrel' },
  { name: '🛡 City warden (NPC)', kind: 'npc', npc: 'city_warden' },
  { name: '🧑 Townsfolk (NPC)', kind: 'npc', npc: 'townsfolk' },
  { name: '🐇 Dust hare (NPC)', kind: 'npc', npc: 'dust_hare' },
  { name: '☠ Rustjaw thug (NPC, hostile)', kind: 'npc', npc: 'rustjaw_thug' },
]

export const TEXTURES = [
  '',
  'brown_mud_dry',
  'clay_roof_tiles',
  'floor_pavement',
  'gray_rocks',
  'leafy_grass',
  'metal_plate',
  'plastered_wall_02',
  'red_brick',
  'weathered_plank_siding',
  'wood_planks',
]

/** Stand-ins for NPC spawns: a body-sized column in the faction's colour (hostile red). */
export const NPC_LOOKS: Record<string, { color: string; shape: StaticBody['shape'] }> = {
  city_warden: { color: '#3d6fb0', shape: { type: 'cylinder', radius: 0.4, height: 1.9 } },
  townsfolk: { color: '#c9a25a', shape: { type: 'cylinder', radius: 0.35, height: 1.75 } },
  dust_hare: { color: '#a08868', shape: { type: 'box', size: [0.35, 0.3, 0.6] } },
  rustjaw_thug: { color: '#b0413e', shape: { type: 'cylinder', radius: 0.42, height: 1.85 } },
}
const NPC_FALLBACK = {
  color: '#9a7ab0',
  shape: { type: 'cylinder', radius: 0.4, height: 1.8 },
} as const
export const npcLook = (archetype: string): { color: string; shape: StaticBody['shape'] } =>
  NPC_LOOKS[archetype] ?? NPC_FALLBACK

/** Visual stand-ins for resource nodes (matched loosely to the game's). */
export const NODE_LOOKS: Record<string, { color: string; shape: StaticBody['shape'] }> = {
  oak_tree: { color: '#4c7a3a', shape: { type: 'cylinder', radius: 1.3, height: 5 } },
  berry_bush: { color: '#3f6a35', shape: { type: 'sphere', radius: 0.7 } },
  stone_deposit: { color: '#7b7f83', shape: { type: 'sphere', radius: 1.1 } },
  branch_pile: { color: '#7a5c38', shape: { type: 'box', size: [1.2, 0.4, 1.2] } },
  loose_stones: { color: '#8a8d90', shape: { type: 'box', size: [1, 0.35, 1] } },
  scrap_pile: { color: '#6d6f72', shape: { type: 'box', size: [1.4, 0.6, 1.4] } },
}
