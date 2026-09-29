import { RegionTracker, type EnvironmentState, type GameEntity } from '@openvibe/gameplay'
import type { PersistenceStore } from '@openvibe/persistence'
import type { BodyId } from '@openvibe/physics'
import type { ServerMessage, ServerStats } from '@openvibe/protocol'
import type { EntityId, Logger, PlayerId } from '@openvibe/shared'
import type { ServerConfig } from '../../config.js'
import type { TicketIdentity } from '../../net/wsTicket.js'
import type { ModRuntime } from '../../mods/runtime.js'
import type { ServerMetrics } from '../../observability/metrics.js'
import type { GameEventRecorder } from '../../platform/gameEvents.js'
import type { ProgressSummaryWriter } from '../../platform/progressSummary.js'
import type { ConstraintRecord, GameWorld } from '../gameWorld.js'
import type { PlayerSession } from '../playerSession.js'
import type { CombatSystem } from './combat.js'
import type { EconomySystem } from './economy.js'
import type { EditorSystem } from './editor.js'
import type { EnvironmentSystem } from './environment.js'
import type { InteractionSystem } from './interaction.js'
import type { InventorySystem } from './inventory.js'
import type { ManipulationSystem } from './manipulation.js'
import type { ModSystem } from './mods.js'
import type { MovementSystem } from './movement.js'
import type { NpcSystem } from './npcs.js'
import type { PersistenceSystem } from './persistence.js'
import type { PhysicsSystem } from './physics.js'
import type { ProductionSystem } from './production.js'
import type { ReplicationSystem } from './replication.js'
import type { SessionsSystem } from './sessions.js'
import type { SocialSystem } from './social.js'
import type { VehicleSystem } from './vehicles.js'
import type { WorldEventSystem } from './worldEvents.js'

/**
 * A network connection as the game sees it — transport-agnostic.
 *
 * `identity` is the resolved identity stamped on the socket by the WS
 * upgrade handler after it consumed the ticket. The session system reads
 * this and ignores `msg.auth` (ADR-0007 netcode + decision 8).
 */
export interface GameConnection {
  send(text: string): void
  close(code: number, reason: string): void
  /**
   * Either a Network subject (signed-in caller) or a hashed guest key
   * (local guest). Exactly one per connection; absent only when the
   * upgrade handler bypassed ticket validation, which the session system
   * treats as a connection error.
   */
  identity?: ResolvedConnectionIdentity
}

/**
 * The identity bound to a WS connection at the upgrade: exactly the ticket
 * identity, so the two shapes cannot drift.
 */
export type ResolvedConnectionIdentity = TicketIdentity

/**
 * Platform adapters the server drives (roadmap Wave 12). Both optional: the
 * game runs exactly as before without them.
 */
export interface GameIntegrations {
  /** Durable lifecycle/progression events through the outbox. */
  events?: GameEventRecorder
  /** Installed mods (content packs), reconciled every tick. */
  mods?: ModRuntime
  /** The person's games.progress.summary user module on Network, written when a character leaves. */
  progressSummary?: ProgressSummaryWriter
}

/** The mutable tick counter, shared by every system that reads cadence or cooldowns. */
export interface Clock {
  tick: number
}

/** The wire helpers every system sends through (implemented by ReplicationSystem). */
export interface Net {
  send(session: PlayerSession, msg: ServerMessage): void
  sendRaw(session: PlayerSession, encoded: string): void
  broadcastAll(msg: ServerMessage): void
  /** Sends to every session whose interest set currently contains `id`. */
  broadcastToKnowing(id: EntityId, msg: ServerMessage): void
  /** Immediate spawn to in-range sessions, adding the id to their interest sets. */
  broadcastSpawn(entity: GameEntity): void
  /** Despawn to every session that knew it, removing it from their interest sets. */
  broadcastDespawn(id: string): void
  /** Constraint create/remove to every client that knows either end. */
  broadcastConstraintState(rec: ConstraintRecord, active: boolean): void
  timeWire(): ServerMessage
  sendInventory(session: PlayerSession): void
  sendSkills(session: PlayerSession): void
  sendCraftState(session: PlayerSession): void
  sendContainer(session: PlayerSession, entity: GameEntity): void
  /** The vitals payload shared by every stats message (without `t`/`died`). */
  statsWire(session: PlayerSession): Omit<ServerStats, 't' | 'died'>
  /** Interest diff + snapshot for every session (every `snapshotEvery` ticks). */
  replicate(): void
}

/**
 * Every live session and the handles the server keeps beside them. This is the one piece of state
 * more than half the systems touch, so it lives behind the context rather than inside a system.
 */
export class SessionRegistry {
  private readonly byPlayer = new Map<PlayerId, PlayerSession>()
  private readonly byConn = new Map<GameConnection, PlayerSession>()
  private readonly byEntity = new Map<EntityId, PlayerSession>()
  /** Kinematic capsule handle per player (movement, vehicles and combat all need it). */
  private readonly bodies = new Map<PlayerId, BodyId>()

  get size(): number {
    return this.byPlayer.size
  }

  get(playerId: PlayerId | string): PlayerSession | undefined {
    return this.byPlayer.get(playerId as PlayerId)
  }

  getByConn(conn: GameConnection): PlayerSession | undefined {
    return this.byConn.get(conn)
  }

  getByEntity(entityId: EntityId | string): PlayerSession | undefined {
    return this.byEntity.get(entityId as EntityId)
  }

  values(): IterableIterator<PlayerSession> {
    return this.byPlayer.values()
  }

  /** A snapshot, for loops that may remove a session. */
  all(): PlayerSession[] {
    return [...this.byPlayer.values()]
  }

  add(conn: GameConnection, session: PlayerSession): void {
    this.byPlayer.set(session.playerId, session)
    this.byConn.set(conn, session)
    this.byEntity.set(session.entityId, session)
  }

  /** Removes the session from all three maps; returns it (undefined when the conn is unknown). */
  remove(conn: GameConnection): PlayerSession | undefined {
    const session = this.byConn.get(conn)
    if (!session) return undefined
    this.byConn.delete(conn)
    this.byPlayer.delete(session.playerId)
    this.byEntity.delete(session.entityId)
    return session
  }

  bodyOf(playerId: PlayerId): BodyId | undefined {
    return this.bodies.get(playerId)
  }

  setBody(playerId: PlayerId, bodyId: BodyId): void {
    this.bodies.set(playerId, bodyId)
  }

  deleteBody(playerId: PlayerId): BodyId | undefined {
    const bodyId = this.bodies.get(playerId)
    this.bodies.delete(playerId)
    return bodyId
  }
}

/**
 * The systems, late-bound so a system can reach its peers. Assigned once, after every system is
 * constructed; no system may touch it before the first message or tick.
 */
export interface ServerSystems {
  sessions: SessionsSystem
  movement: MovementSystem
  replication: ReplicationSystem
  manipulation: ManipulationSystem
  combat: CombatSystem
  vehicles: VehicleSystem
  inventory: InventorySystem
  interaction: InteractionSystem
  economy: EconomySystem
  production: ProductionSystem
  npcs: NpcSystem
  social: SocialSystem
  worldEvents: WorldEventSystem
  persistence: PersistenceSystem
  mods: ModSystem
  editor: EditorSystem
  environment: EnvironmentSystem
  physics: PhysicsSystem
}

/**
 * Drives the systems' `onJoin`/`onLeave` hooks in construction order. GameServer binds this to its
 * ordered system list, so the session system never has to know which systems keep session state.
 */
export interface Lifecycle {
  joined(session: PlayerSession): void
  left(session: PlayerSession): void
}

/**
 * What every system shares (ADR-0007 M1): the world, the sessions registry, content, config, log,
 * metrics, the store, the wire helpers and the clock. Anything a system owns alone stays inside it.
 */
export class ServerContext {
  readonly sessions = new SessionRegistry()
  readonly clock: Clock = { tick: 0 }
  /** Coarse activation regions: the environment system moves them, NPC LOD and metrics read them. */
  readonly regions = new RegionTracker(32)
  /** The wire helpers; assigned right after this context is constructed. */
  net!: Net
  /** Every system; assigned once they all exist. */
  systems!: ServerSystems
  /** The join/leave hooks; assigned with the systems. */
  lifecycle!: Lifecycle

  constructor(
    readonly config: ServerConfig,
    readonly world: GameWorld,
    readonly store: PersistenceStore,
    readonly metrics: ServerMetrics,
    readonly log: Logger,
    readonly integrations: GameIntegrations,
    /** Authoritative world environment: clock, weather, temperature. */
    readonly env: EnvironmentState,
  ) {}

  /** The zod content registry the world was built with. */
  get content(): GameWorld['content'] {
    return this.world.content
  }
}
