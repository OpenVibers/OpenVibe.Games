import type {
  WireBodyState,
  WireItemStack,
  WireCraftJob,
  WireEntity,
  WireInventory,
  WirePlayerState,
  WirePlant,
} from '../wire.js'
import type { ServerSurfFinish, ServerSurfState } from './surf.js'

/**
 * Server -> client messages. Plain types (no zod): the client trusts the
 * server. Kept as a discriminated union on `t` for exhaustive handling.
 */

export interface ServerWelcome {
  t: 'welcome'
  v: number
  contentDigest: string
  /** openvibe.network rank of this account: owner/admin/moderator, null for players. */
  rank: 'owner' | 'admin' | 'moderator' | null
  playerId: string
  /** The player's own world entity id. */
  entityId: string
  tick: number
  tickRate: number
  snapshotRate: number
  /** Present when multi-instance mode is enabled. */
  instanceId?: string
  instanceCount?: number
  /** Current server-authoritative cvars in Source units (see cvar_state). */
  cvars?: Record<string, number | boolean>
  /** The cvar names this player's rank may change. */
  cvarsWritable?: string[]
}

/** The room's authoritative cvar values, sent after a change and in reply to `cvar_set`. */
export interface ServerCvarState {
  t: 'cvar_state'
  /** Source-unit values, keyed by canonical Source name. */
  values: Record<string, number | boolean>
  /** Names this session's rank may change (the same subset as welcome). */
  writable: string[]
  /** Echo of the request this answers, when it answers one. */
  requestId?: number
  /** Why a requested change was refused; values are still the authoritative ones. */
  error?: string
}

export interface ServerTransferResult {
  t: 'transfer_result'
  accepted: boolean
  instanceId: string
  reason?: 'same_instance' | 'unknown_instance' | 'instance_full' | 'unavailable'
}

export interface ServerReject {
  t: 'reject'
  reason:
    | 'protocol_mismatch'
    | 'content_mismatch'
    | 'server_full'
    | 'invalid_hello'
    | 'guest_one_character'
    | 'auth_failed'
    /** The person signed out everywhere (or changed their password, or was banned) on the Network. */
    | 'signed_out'
  /** Present when content_mismatch: the offered and required definition sets. */
  clientDigest?: string | null
  serverDigest?: string
}

/** Entities that became relevant to this client (full state). */
export interface ServerSpawn {
  t: 'spawn'
  entities: WireEntity[]
}

export interface ServerDespawn {
  t: 'despawn'
  ids: string[]
}

/**
 * Periodic delta snapshot: authoritative player states plus transforms of
 * awake, relevant physics bodies. Sleeping/settled entities are represented
 * by their last Spawn state and simply stop appearing here — that, plus
 * interest management, is what keeps large worlds cheap on the wire.
 */
export interface ServerSnapshot {
  t: 'snap'
  tick: number
  /** Last input seq processed for the receiving player (reconciliation). */
  ack: number
  players: WirePlayerState[]
  bodies: WireBodyState[]
}

/** Motion-state change for an already-spawned entity (freeze, sleep-settle). */
export interface ServerEntityUpdate {
  t: 'entity'
  id: string
  motion?: 'dynamic' | 'frozen' | 'static'
  pos?: [number, number, number]
  rot?: [number, number, number, number]
  remaining?: number
  /** Planter crop changed (null clears after harvest). */
  plant?: WirePlant | null
  /** Prop health changed (damage/repair). */
  health?: number
}

export interface ServerInventory {
  t: 'inventory'
  inv: WireInventory
  activeHotbar: number
  /** Worn armor (null = nothing equipped). */
  armor?: WireItemStack | null
}

export interface ServerCraftState {
  t: 'craft_state'
  jobs: WireCraftJob[]
}

/** Result of an explicit player request (craft, place, use...). */
export interface ServerActionResult {
  t: 'result'
  action:
    | 'craft'
    | 'drop'
    | 'use'
    | 'attack'
    | 'place'
    | 'inv_move'
    | 'physgun'
    | 'constraint'
    | 'trust'
    | 'consume'
    | 'container'
    | 'trade'
  ok: boolean
  error?: string
}

/** The receiving player's trusted-friends list (welcome + on change). */
export interface ServerFriends {
  t: 'friends'
  friends: { id: string; name: string }[]
}

export interface WireSkill {
  id: string
  level: number
  xp: number
  nextXp: number
}

/** Full skill progression for the receiving player (welcome + on change). */
export interface ServerSkills {
  t: 'skills'
  skills: WireSkill[]
  /** Unlocked blueprint recipe ids (client greys out the rest). */
  unlocks?: string[]
}

export interface ServerLevelUp {
  t: 'levelup'
  skill: string
  level: number
}

/**
 * A constraint exists (or was removed) between two props — drives client
 * visuals (rope/spring lines, joint markers). Anchors are body-local so
 * the client can render endpoints on moving props.
 */
export interface ServerConstraintState {
  t: 'constraint_state'
  id: string
  kind: 'weld' | 'rope' | 'hinge' | 'axis' | 'slider' | 'spring' | 'motor'
  a: string
  b: string
  anchorA: [number, number, number]
  anchorB: [number, number, number]
  /** Rope/spring rest length, for sag rendering. */
  length?: number
  active: boolean
}

/** Physgun beam state for rendering (any player's beam). */
export interface ServerPhysgunState {
  t: 'physgun_state'
  player: string
  /** Held entity id, or null when the beam turned off. */
  target: string | null
  /** Grab point in the held body's LOCAL space — beams attach to the spot
   * the beam first touched, not the prop's center. */
  grab?: [number, number, number]
}

/** The receiving player's own vitals (sent on meaningful change). */
export interface ServerStats {
  t: 'stats'
  hp: number
  hunger: number
  thirst: number
  stamina: number
  /** Body temperature °C (37 normal). */
  temp: number
  /** Active status effect ids (cold, wet, well_fed, bleeding...). */
  statuses: string[]
  /** Set on the update that killed you (client shows death feedback). */
  died?: boolean
}

/** World clock + weather sync: fraction of the day cycle [0..1). */
export interface ServerTime {
  t: 'time'
  frac: number
  weather: 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog'
}

/** The world map was edited live — refetch /map.json and rebuild terrain. */
export interface ServerMapReload {
  t: 'map_reload'
}

/** A shot was fired: brief tracer + report for everyone nearby. */
export interface ServerTracer {
  t: 'tracer'
  /** Shooter's entity id (viewmodel/beam anchoring). */
  shooter: string
  from: [number, number, number]
  to: [number, number, number]
  hit: boolean
}

/** Transient visual effect on an entity (hurt flinch, death...). */
export interface ServerFx {
  t: 'fx'
  kind: 'hurt' | 'death'
  id: string
}

/** World-event banner shown to everyone (supply drops etc.). */
export interface ServerAnnounce {
  t: 'announce'
  text: string
}

/**
 * One chat line. Player lines carry `from`; server/command lines are
 * `channel: 'system'` with no speaker. `text` is plain text — clients render
 * it with textContent, never as markup.
 */
export interface ServerSay {
  t: 'say'
  channel: 'say' | 'say_team' | 'system'
  text: string
  /** Speaker display name; absent on system lines. */
  from?: string
  /** Speaker entity id; absent on system lines. */
  fromId?: string
}

/** Market data for an opened trading post (refreshed after each deal). */
export interface ServerMarket {
  t: 'market'
  id: string
  name: string
  /** The owning faction's current stance toward this player. */
  stance: 'friendly' | 'neutral' | 'hostile'
  sells: { item: string; count: number; price: number; stock: number }[]
  buys: { item: string; count: number; price: number }[]
}

/** The receiving player's faction standings (welcome + on change). */
export interface ServerReputation {
  t: 'reputation'
  factions: {
    id: string
    name: string
    value: number
    stance: 'friendly' | 'neutral' | 'hostile'
  }[]
}

/** Contracts at a trading post + the player's active one (with progress). */
export interface ServerJobs {
  t: 'jobs'
  market: string
  available: { id: string; name: string; description: string; done: boolean }[]
  active: { job: string; name: string; progress: number; goal: number; ready: boolean } | null
}

/** Contents of an opened container (and pushed while it stays open). */
export interface ServerContainer {
  t: 'container'
  id: string
  slots: { i: number; def: string; count: number }[]
  size: number
}

export type ServerMessage =
  | ServerSurfState
  | ServerSurfFinish
  | {
      t: 'salvage_round'
      roundId: string
      phase: 'intermission' | 'active'
      endsAt: number
      pickups: { x: number; z: number; available: boolean }[]
      scores: { name: string; score: number; rank: number }[]
    }
  | ServerWelcome
  | ServerCvarState
  | ServerTransferResult
  | ServerReject
  | ServerSpawn
  | ServerDespawn
  | ServerSnapshot
  | ServerEntityUpdate
  | ServerInventory
  | ServerCraftState
  | ServerActionResult
  | ServerPhysgunState
  | ServerSkills
  | ServerLevelUp
  | ServerConstraintState
  | ServerFriends
  | ServerStats
  | ServerTime
  | ServerContainer
  | ServerMarket
  | ServerReputation
  | ServerJobs
  | ServerAnnounce
  | ServerSay
  | ServerTracer
  | ServerFx
  | ServerMapReload
