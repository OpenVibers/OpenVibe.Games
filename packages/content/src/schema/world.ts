import { z } from 'zod'
import { WorldShapeSchema } from './item.js'

/**
 * Static world definition: the level geometry both sides instantiate
 * identically (server for authority, client for rendering + prediction),
 * plus initial dynamic spawns the server creates on first boot only
 * (afterwards the persistent store is the source of truth).
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const finiteVec3 = vec3.refine((v) => v.every(Number.isFinite), 'must be finite')

/**
 * How a place moves. The style name is content: both sides resolve it to the
 * SAME MovementParams (gameplay/movement/styles.ts) and pass those to the one
 * movement kernel, so a mismatch is a content-digest mismatch, not a feel
 * difference. `default` is the sandbox controller; `surf` is the CS:S-like
 * air-control preset used by the Ride maps.
 */
export const MovementStyleSchema = z.enum(['default', 'surf'])
export type MovementStyle = z.infer<typeof MovementStyleSchema>

/**
 * Canonical authored colour: lower-case six-digit hex. One definition shared
 * by every schema that carries a colour, so a value cannot be accepted by one
 * layer of the stack and rejected — or silently dropped — by another.
 */
export const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'must be #rrggbb lower-case hex')

/**
 * Editor-placed light. Covers every Babylon punctual/ambient light type:
 * point, spot (angle + exponent), directional (sun-like), hemispheric
 * (ambient dome with ground colour) and rectangular area lights.
 *
 * This is the ONE definition. The map wire used to validate lights as
 * `z.record(z.string(), z.unknown())` beside a hand-written interface of the
 * same name, so an authored light was checked nowhere and reached Babylon
 * malformed.
 */
export const MapLightSchema = z.object({
  /** Stable document id (selection, collab locks, live reconciliation). */
  id: z.string().min(1).max(64),
  type: z.enum(['point', 'spot', 'directional', 'hemi', 'rect']),
  pos: finiteVec3,
  /** Direction for spot/directional/hemi/rect (unit-ish vector). */
  dir: finiteVec3.optional(),
  color: HexColorSchema.optional(),
  specular: HexColorSchema.optional(),
  intensity: z.number().min(0).max(1000).optional(),
  /** Reach in metres (point/spot). */
  range: z.number().min(0).max(100_000).optional(),
  /** Spot cone angle in radians. */
  angle: z
    .number()
    .min(0)
    .max(Math.PI * 2)
    .optional(),
  /** Spot decay exponent. */
  exponent: z.number().min(0).max(1000).optional(),
  /** Hemispheric ground (bounce) colour. */
  ground: HexColorSchema.optional(),
  /** Rect area light [width, height] in metres. */
  size: z
    .tuple([z.number(), z.number()])
    .refine((v) => v.every((n) => Number.isFinite(n) && n > 0), 'rect size must be finite and > 0')
    .optional(),
  shadows: z.boolean().optional(),
})
export type MapLight = z.infer<typeof MapLightSchema>

/**
 * Hammer-style face/surface styling: texture + tint + UV transform.
 * On a box static these can be applied per face (keys '0'..'5', Babylon
 * face order); on any shape a single style applies to the whole surface.
 */
export const FaceStyleSchema = z.object({
  tex: z.string().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .optional(),
  /** Texture scale (tiles across the surface); 0/absent = auto. */
  sx: z.number().optional(),
  sy: z.number().optional(),
  /** Texture shift (UV offset, 0..1 wraps). */
  ox: z.number().optional(),
  oy: z.number().optional(),
  /** Texture rotation in radians. */
  rot: z.number().optional(),
})
export type FaceStyle = z.infer<typeof FaceStyleSchema>

/**
 * Inputs an entity accepts through the deterministic I/O graph. Source has a
 * much larger vocabulary; this is the subset the surf trigger core needs plus
 * the door/button inputs the next tier will drive. An unknown input is a
 * parse error, so a typo in the editor cannot silently do nothing.
 */
export const IoInputSchema = z.enum([
  'Enable',
  'Disable',
  'Toggle',
  'Trigger',
  'Open',
  'Close',
  'Press',
  'Teleport',
  'SetSpeed',
  'ResetTimer',
  'FireTimer',
  'CancelPending',
  'TouchTest',
])
export type IoInput = z.infer<typeof IoInputSchema>

/**
 * One edge in the event graph: "when `event` happens, send `input` to
 * `target` after `delay` seconds". `once` means the edge fires at most once
 * for the lifetime of the map.
 */
export const OutputSchema = z.object({
  event: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
  input: IoInputSchema,
  param: z.string().optional(),
  delay: z.number().finite().nonnegative().optional(),
  once: z.boolean().optional(),
})
export type Output = z.infer<typeof OutputSchema>

/** `trigger_multiple` / `trigger_once`: a volume that fires touch outputs. */
export const TriggerZoneSchema = z.object({
  wait: z.number().finite().nonnegative().optional(),
  once: z.boolean().optional(),
  outputs: z.array(OutputSchema).default([]),
})
export type TriggerZone = z.infer<typeof TriggerZoneSchema>

/** `trigger_push`: a volume that applies a velocity to players inside it. */
export const PushZoneSchema = z.object({
  dir: finiteVec3,
  /** Magnitude in Source units/s; the engine converts to m/s at runtime. */
  speed: z.number().finite().min(0),
  onlyFalling: z.boolean().optional(),
})
export type PushZone = z.infer<typeof PushZoneSchema>

/** `trigger_teleport`: a volume that moves a player to a destination point. */
export const TeleportZoneSchema = z.object({
  to: z.string().min(1).max(64),
  landmark: z.string().min(1).max(64).optional(),
  keepAngles: z.boolean().optional(),
})
export type TeleportZone = z.infer<typeof TeleportZoneSchema>

/**
 * A point entity (`info_target`, `info_teleport_destination`, camera marker):
 * a named position and optional facing, referenced by trigger outputs.
 */
export const PointDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  pos: finiteVec3,
  yaw: z.number().optional(),
  class: z.enum(['target', 'teleport_destination', 'camera']).default('target'),
})
export type PointDef = z.infer<typeof PointDefSchema>

/**
 * A logic entity: `logic_relay` forwards inputs, `logic_auto` fires on map
 * spawn, and `logic_timer` fires on an interval.
 */
export const LogicDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  class: z.enum(['relay', 'auto', 'timer']),
  wait: z.number().finite().nonnegative().optional(),
  outputs: z.array(OutputSchema).default([]),
})
export type LogicDef = z.infer<typeof LogicDefSchema>

/** A brush entity (`func_door`, `func_button`, `func_brush`) attached to a static. */
export const BrushEntitySchema = z.object({
  class: z.enum(['door', 'button', 'brush']),
  targetname: z.string().min(1).max(64).optional(),
  speed: z.number().finite().nonnegative().optional(),
  lip: z.number().finite().nonnegative().optional(),
  wait: z.number().finite().nonnegative().optional(),
  outputs: z.array(OutputSchema).default([]),
})
export type BrushEntity = z.infer<typeof BrushEntitySchema>

export const StaticBodySchema = z.object({
  /** Stable editor/document id (selection, collab locks). */
  id: z.string().optional(),
  shape: WorldShapeSchema,
  pos: vec3,
  /** Yaw rotation; ignored when `rot` is present. */
  yaw: z.number().default(0),
  /** Full [pitchX, yawY, rollZ] euler rotation (surf ramps, tilted geometry). */
  rot: vec3.optional(),
  /**
   * Canonical scale, applied on top of the shape's authored dimensions.
   * Absent means [1,1,1]. Scale and dimensions are deliberately SEPARATE:
   * the inspector edits them independently, and `effectiveShape()` is the one
   * place that combines them so rendering and physics cannot drift apart.
   */
  scale: vec3.optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Optional tiling texture (client rendering only; by asset basename). */
  tex: z.string().optional(),
  /** Optional client-side decoration kind (roofs, doors, fountain...). */
  decor: z.string().optional(),
  /** Imported model id (MapFile.models): client renders the glb, the shape
   *  above stays the physics proxy collider. */
  model: z.string().optional(),
  /** Whole-surface UV/texture transform (face-edit tool). */
  uv: FaceStyleSchema.optional(),
  /** Per-face overrides for box statics (face index '0'..'5'). */
  faces: z.record(z.string(), FaceStyleSchema).optional(),
  /** Optional brush-entity behaviour (`func_door`/`func_button`/`func_brush`). */
  brushEntity: BrushEntitySchema.optional(),
})

export const ResourceNodeSpawnSchema = z.object({
  /** Resource node type id (see ResourceNodeTypeSchema). */
  node: z.string(),
  /** Ground position; the node type defines body shape/offset. */
  pos: vec3,
})

export const PropSpawnSchema = z.object({
  item: z.string(),
  pos: vec3,
  yaw: z.number().default(0),
})

/** What a surf zone means: the run's start, an ordered checkpoint, the finish, or a kill volume. */
export const SurfZoneMetaSchema = z.object({
  kind: z.enum(['start', 'checkpoint', 'finish', 'kill']),
  /** 0 for the start, 1.. for checkpoints, the final stage for the finish. */
  stage: z.number().int().min(0).max(63).default(0),
  /** Checkpoint respawn (capsule centre) and yaw; the start uses the map spawn. */
  spawn: finiteVec3.optional(),
  yaw: z.number().optional(),
})
export type SurfZoneMeta = z.infer<typeof SurfZoneMetaSchema>

/** Map-level surf metadata: the fail plane and the advertised run shape. */
export const SurfMapMetaSchema = z.object({
  title: z.string().min(1).max(80),
  author: z.string().min(1).max(80),
  tier: z.number().int().min(1).max(5),
  /** Total stages, including the finish (checkpoints are stages - 1). */
  stages: z.number().int().min(1).max(64),
  /** Below this height (metres) the run fails to the last checkpoint. */
  failY: z.number(),
})
export type SurfMapMeta = z.infer<typeof SurfMapMetaSchema>

export const ZoneDefSchema = z.object({
  /**
   * Stable zone id. Dashes are permitted so the map editor can mint ids in the
   * same `<kind>-<n>` shape it uses for every other document object.
   */
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  /** Axis-aligned box zone; richer volumes later. */
  min: vec3,
  max: vec3,
  /** Declarative rule flags — systems consult these; never `if (city)`. */
  rules: z.object({
    pvp: z.boolean().default(true),
    build: z.boolean().default(true),
    physgun: z.boolean().default(true),
  }),
  /** Surf trigger metadata; absent on ordinary rule zones. */
  surf: SurfZoneMetaSchema.optional(),
  /** `trigger_multiple` / `trigger_once` touch outputs. */
  trigger: TriggerZoneSchema.optional(),
  /** `trigger_push` velocity volume. */
  push: PushZoneSchema.optional(),
  /** `trigger_teleport` destination volume. */
  teleport: TeleportZoneSchema.optional(),
})

export const WorldDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Ground plane half-extent, meters. */
  groundHalfExtent: z.number().positive(),
  spawnPoint: vec3,
  spawnYaw: z.number().default(0),
  /** Blank-slate world: terrain is a flat floor (map editor builds the rest). */
  flatTerrain: z.boolean().default(false),
  /** Movement preset for this place; resolved to params on both sides (default when absent). */
  movement: MovementStyleSchema.optional(),
  statics: z.array(StaticBodySchema),
  resourceNodes: z.array(ResourceNodeSpawnSchema),
  initialProps: z.array(PropSpawnSchema),
  zones: z.array(ZoneDefSchema),
  /**
   * The world's own NPCs, when it has an opinion: `[]` for none (a timed arena), else archetypes and ground
   * positions. Absent, it gets the content's NPC_SPAWNS. A map's own NPCs win over either (npcSpawnsFor).
   */
  npcSpawns: z.array(z.object({ archetype: z.string(), pos: vec3 })).optional(),
})

export type WorldDef = z.infer<typeof WorldDefSchema>
export type ZoneDef = z.infer<typeof ZoneDefSchema>
export type StaticBody = z.infer<typeof StaticBodySchema>

/**
 * The shape a static ACTUALLY occupies: authored dimensions × canonical
 * scale. Client meshes, client prediction physics and server physics all go
 * through this, so a scaled object can never render at one size and collide
 * at another.
 */
export function effectiveShape(body: Pick<StaticBody, 'shape' | 'scale'>): StaticBody['shape'] {
  const s = body.scale
  if (!s || (s[0] === 1 && s[1] === 1 && s[2] === 1)) return body.shape
  const shape = body.shape
  if (shape.type === 'box')
    return {
      ...shape,
      size: [shape.size[0] * s[0], shape.size[1] * s[1], shape.size[2] * s[2]],
    }
  if (shape.type === 'cylinder')
    return {
      ...shape,
      radius: shape.radius * Math.max(Math.abs(s[0]), Math.abs(s[2])),
      height: shape.height * s[1],
    }
  return {
    ...shape,
    radius: shape.radius * Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])),
  }
}
