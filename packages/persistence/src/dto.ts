import type {
  InventoryDto,
  ItemStack,
  ReputationDto,
  SkillsDto,
  SurvivalStats,
} from '@openvibe/gameplay'
import type { Appearance } from '@openvibe/protocol'

/**
 * Persistence DTOs: the explicit, versionable disk representation of game
 * state. Runtime objects (Babylon meshes, Havok bodies, live Inventory
 * instances) are transient — they are rebuilt FROM these records, never
 * serialized directly.
 */

export interface WorldEntityDto {
  id: string
  kind: 'prop' | 'resource' | 'npc'
  defId: string
  ownerId: string | null
  pos: [number, number, number]
  rot: [number, number, number, number]
  motion: 'dynamic' | 'frozen' | 'static'
  /** Kind-specific extra state (resource remaining, container slots...) as JSON. */
  state: Record<string, unknown> | null
  updatedAt: number
}

export interface PlayerDto {
  id: string
  /**
   * Account key. Signed-in accounts use their canonical openvibe.network
   * subject (`usr_…`/`gst_…`, ADR-0006); guests use their browser token
   * (ADR-0004), which can never take that shape.
   */
  token: string
  /** Canonical openvibe.network subject when the account is signed in; absent for local guests. */
  subjectId?: string
  name: string
  pos: [number, number, number]
  yaw: number
  inventory: InventoryDto
  /** Total XP per skill id (levels are derived at runtime). */
  skills: SkillsDto
  /** Player ids this player trusts with their props (one-directional). */
  friends: string[]
  /** Avatar customization; null until the player first customizes. */
  appearance: Appearance | null
  /** Character slot under this account token (0..2, MMO-style). */
  charSlot: number
  /** Worn armor piece; null for none (durability in stack meta). */
  armor: ItemStack | null
  /** Faction reputation scores (absent factions = 0). */
  reputation: ReputationDto
  /** Unlocked blueprint recipe ids. */
  unlocks: string[]
  /** Active job/contract state; null when none. */
  activeJob: { job: string; progress: number } | null
  /** Survival vitals; null/partial rows predate newer fields — the loader
   * normalizes (see @openvibe/gameplay normalizeStats). */
  stats: Partial<SurvivalStats> | null
  updatedAt: number
}

/** Persistent constraint between two world entities (weld/rope/hinge/axis/slider/spring/motor). */
export interface ConstraintDto {
  id: string
  /** Gameplay constraint type id. Unknown types are pruned on restore. */
  type: string
  entityA: string
  entityB: string
  /** Type-specific parameters (anchors, axes, lengths, limits, motor...). */
  params: Record<string, unknown> | null
  updatedAt: number
}

/** How far the platform trusts a mod's publisher. Metadata only (ADR-013): never consulted by a grant check. */
export type ModTrustTier = 'unreviewed' | 'reviewed' | 'first-party'

/** An installed mod lifecycle state. `revoked` is terminal for the install. */
export type ModStatus = 'enabled' | 'disabled' | 'revoked'

/** One installed mod: its validated manifest, its runtime payload and its lifecycle. */
export interface ModInstallDto {
  /** `mod_<ULID>` from the manifest. */
  id: string
  name: string
  version: string
  /** Runtime target, e.g. `games.browser`. */
  target: string
  /** Runtime adapter, e.g. `games-content@1`. */
  runtime: string
  /** The full manifest as installed (mods/mod-manifest.v1). */
  manifest: Record<string, unknown>
  /** The runtime-specific payload (a content data pack for `games-content@1`). */
  pack: Record<string, unknown>
  trustTier: ModTrustTier
  status: ModStatus
  /** Who installed it: a subject id or `svc:<client>`. */
  installedBy: string
  installedAt: number
  updatedAt: number
}

/** An approved capability of an installed mod; `revokedAt` set = no longer granted. */
export interface ModGrantDto {
  modId: string
  capability: string
  grantedBy: string
  grantedAt: number
  revokedAt: number | null
  revokedBy: string | null
}

/** Append-only audit record: install, grant, use, deny, revoke, … */
export interface ModAuditDto {
  id?: number
  modId: string
  action: string
  capability: string | null
  actor: string
  detail: Record<string, unknown> | null
  at: number
}

/** A world entity a mod placed, keyed by the placement key in its pack. */
export interface ModPlacementDto {
  modId: string
  key: string
  /** The world entity id; null once the entity is gone (destroyed) — it is not placed again. */
  entityId: string | null
  at: number
}

/** A durable copy of a local content-addressed asset in OpenVibe.Media. */
export interface MediaMirrorDto {
  /** `sha256-<hex>` — the local asset identity. */
  assetHash: string
  /** Local file name under the map-assets directory. */
  fileName: string
  mime: string
  bytes: number
  status: 'pending' | 'mirrored' | 'failed'
  /** Media object id (`med_…`) once mirrored. */
  mediaId: string | null
  publicUrl: string | null
  attempts: number
  lastError: string | null
  nextAttemptAt: number
  updatedAt: number
}
