import { createEnvironment } from '@openvibe/gameplay'
import type { PersistenceStore } from '@openvibe/persistence'
import type { ClientMessage } from '@openvibe/protocol'
import type { Logger } from '@openvibe/shared'
import type { ServerConfig } from '../config.js'
import { nearbyWorkstationKinds } from './interactions.js'
import type { PlayerSession } from './playerSession.js'
import { ServerContext } from './systems/context.js'
import type { GameConnection, GameIntegrations, ServerSystems } from './systems/context.js'
import {
  CombatSystem,
  EconomySystem,
  EditorSystem,
  EnvironmentSystem,
  InteractionSystem,
  InventorySystem,
  ManipulationSystem,
  ModSystem,
  MovementSystem,
  NpcSystem,
  PersistenceSystem,
  PhysicsSystem,
  ProductionSystem,
  ReplicationSystem,
  SessionsSystem,
  SocialSystem,
  VehicleSystem,
  WorldEventSystem,
  buildHandlerTable,
} from './systems/index.js'
import type { MessageHandler, System } from './systems/system.js'
import type { ServerMetrics } from '../observability/metrics.js'
import type { GameWorld } from './gameWorld.js'

export type { GameConnection, GameIntegrations }

/**
 * The coordinator (ADR-0007 M1). It owns the shared context, constructs the systems, assembles
 * their message handlers into one table (a duplicate type is a startup error), and drives the tick:
 * `step()` below is the one place the simulation order is written down.
 *
 * Gameplay itself lives in `./systems/`; this class holds no game state beyond wiring.
 */
export class GameServer {
  private readonly ctx: ServerContext
  private readonly systems: ServerSystems
  /** The systems in construction order: the handler table and the join/leave hooks both use it. */
  private readonly ordered: System[]
  private readonly handlers: Map<string, MessageHandler<never>>

  constructor(
    config: ServerConfig,
    world: GameWorld,
    store: PersistenceStore,
    metrics: ServerMetrics,
    log: Logger,
    integrations: GameIntegrations = {},
  ) {
    // The world clock and weather survive restarts (a rainy dusk stays a rainy dusk); they are
    // loaded asynchronously in load(), before the tick loop starts.
    this.ctx = new ServerContext(
      config,
      world,
      store,
      metrics,
      log,
      integrations,
      createEnvironment(0.34),
    )
    const ctx = this.ctx
    const sessions = new SessionsSystem(ctx)
    const movement = new MovementSystem(ctx)
    // The wire surface every system sends through.
    const replication = new ReplicationSystem(ctx)
    ctx.net = replication
    const manipulation = new ManipulationSystem(ctx)
    const combat = new CombatSystem(ctx)
    const vehicles = new VehicleSystem(ctx)
    const inventory = new InventorySystem(ctx)
    const interaction = new InteractionSystem(ctx)
    const economy = new EconomySystem(ctx)
    const production = new ProductionSystem(ctx)
    const npcs = new NpcSystem(ctx)
    const social = new SocialSystem(ctx)
    const worldEvents = new WorldEventSystem(ctx)
    const persistence = new PersistenceSystem(ctx)
    const mods = new ModSystem(ctx)
    const editor = new EditorSystem(ctx)
    const environment = new EnvironmentSystem(ctx)
    const physics = new PhysicsSystem(ctx)

    this.systems = {
      sessions,
      movement,
      replication,
      manipulation,
      combat,
      vehicles,
      inventory,
      interaction,
      economy,
      production,
      npcs,
      social,
      worldEvents,
      persistence,
      mods,
      editor,
      environment,
      physics,
    }
    // Bound together once, here: a system may reach its peers only from a handler, a tick or a
    // lifecycle hook, never during construction.
    ctx.systems = this.systems
    this.ordered = [
      sessions,
      movement,
      replication,
      manipulation,
      combat,
      vehicles,
      inventory,
      interaction,
      economy,
      production,
      npcs,
      social,
      worldEvents,
      persistence,
      mods,
      editor,
      environment,
      physics,
    ]
    ctx.lifecycle = {
      joined: (session) => {
        for (const system of this.ordered) system.onJoin?.(session)
      },
      left: (session) => {
        for (const system of this.ordered) system.onLeave?.(session)
      },
    }
    this.handlers = buildHandlerTable(this.ordered)
  }

  /**
   * Async boot: world clock/weather, market stock and the NPC population are read from PostgreSQL.
   * main.ts awaits this before starting the tick loop.
   */
  async load(): Promise<void> {
    await this.systems.environment.load()
    await this.systems.economy.load()
    await this.systems.npcs.load()
  }

  get currentTick(): number {
    return this.ctx.clock.tick
  }

  /** Players connected now (the readiness `sessions` check; a restart would disconnect them). */
  onlineCount(): number {
    return this.systems.sessions.onlineCount()
  }

  /**
   * The client message types this server dispatches, one handler each. Diagnostics, and the
   * handler-table test that pins it against the protocol.
   */
  get messageTypes(): readonly string[] {
    return [...this.handlers.keys()]
  }

  onMessage(conn: GameConnection, msg: ClientMessage): void {
    const session = this.ctx.sessions.getByConn(conn)
    // Everything but `hello` needs a session; anything else first is a protocol error.
    if (!session && msg.t !== 'hello') {
      conn.close(4001, 'hello_first')
      return
    }
    const handler = this.handlers.get(msg.t)
    if (!handler) return
    // The table guarantees `msg.t` matches the handler's declared message type. The one exception is
    // `hello`, whose handler takes `PlayerSession | undefined` and ignores the argument.
    handler(session as PlayerSession, msg as never, conn)
  }

  onDisconnect(conn: GameConnection): void {
    this.systems.sessions.onDisconnect(conn)
  }

  /**
   * Live map edit: every client refetches and rebuilds its terrain. The reconcile itself is
   * main.ts's (it owns the map document); this is the wire half.
   */
  broadcastMapReload(): void {
    this.systems.editor.broadcastMapReload()
  }

  /**
   * Network moved this person's token cutoff (sign out everywhere, password changed, banned): close
   * every session they opened with an older Network sign-in. Returns how many closed.
   */
  revokeSubject(subjectId: string, validAfterMs: number): number {
    return this.systems.sessions.revokeSubject(subjectId, validAfterMs)
  }

  /**
   * Graceful stop (WS-P lifecycle): everyone in the world is told the server is restarting. main.ts
   * then closes every socket with 1012 (service restart); each close saves that character and records
   * games.player.left, as when a player leaves, and the client reconnects on its own.
   */
  announceRestart(): void {
    this.systems.social.announceRestart()
  }

  /** Full save on shutdown; main.ts awaits drain() after this. */
  shutdown(): void {
    this.systems.persistence.shutdown()
  }

  /** Resolves when the write-behind queue is empty (shutdown). */
  async drain(timeoutMs = 25_000): Promise<boolean> {
    return this.systems.persistence.drain(timeoutMs)
  }

  /** Exposes crafting context for the client-facing recipe availability (welcome-time). */
  workstationsNear(session: PlayerSession): ReadonlySet<string> {
    return nearbyWorkstationKinds(session, this.ctx.world)
  }

  /**
   * The simulation tick, 30 Hz. This is the ONE place the order is written down; the systems'
   * internal cadence (1 Hz sweeps, every-2-tick snapshots) is their own.
   */
  step(): void {
    const ctx = this.ctx
    const s = this.systems
    const tickStart = performance.now()
    ctx.clock.tick++
    const dt = 1 / ctx.config.tickRate

    // 1. Movement from queued inputs (server-simulated, never client positions).
    s.movement.tick(ctx, dt)

    // 2. Physgun: retry unlatched beams (sweep-to-grab), drive held bodies.
    s.manipulation.tick(ctx, dt)

    // 3. Fixed-step physics.
    // 4. Sync awake props; announce settles so clients pin final transforms.
    s.physics.tick(ctx, dt)

    // 5. NPC simulation (LOD-aware; abstract NPCs cost nothing here).
    //    The sound buffer resets once a second inside the same step.
    s.npcs.tick(ctx, dt)

    // 6. Crafting queues (completions grant crafting/construction XP).
    s.production.tickCraftQueues()

    // 7. Once a second: environment (clock, weather, region activation), survival vitals,
    //    death by exposure, void rescue and the periodic clock broadcast.
    s.environment.tick(ctx, dt)

    // 8. Once a second: world events (supply drops, extraction).
    s.worldEvents.tick(ctx, dt)

    // 9. Once a second: production sweep (generators, machines, tanks, crops).
    s.production.tickProduction()

    // 10. Once a second: resource respawn sweep.
    s.interaction.respawnResources()

    // 11. Replication: interest diff + snapshot (every `snapshotEvery` ticks → 15 Hz).
    s.replication.tick(ctx, dt)

    // 12. Mods: reconcile installs (a revoked or disabled mod's effects are
    //     retracted on the first tick after the change).
    s.mods.tick(ctx, dt)

    // 13. Periodic persistence checkpoint (write-behind: returns immediately).
    s.persistence.tick(ctx, dt)

    // 14. Metrics sampling.
    ctx.metrics.tick = ctx.clock.tick
    ctx.metrics.lastTickAt = Date.now()
    ctx.metrics.entities = ctx.world.entities.size
    ctx.metrics.constraints = ctx.world.constraintCount
    ctx.metrics.constraintIslands = ctx.world.islands.islandCount()
    ctx.metrics.activeRegions = ctx.regions.activeRegionCount
    ctx.metrics.occupiedRegions = ctx.regions.occupiedRegionCount
    const [npcFull, npcAbstract] = s.npcs.counts()
    ctx.metrics.npcsFull = npcFull
    ctx.metrics.npcsAbstract = npcAbstract
    ctx.metrics.mapStatics = ctx.world.mapStaticCount()
    ctx.metrics.mapTerrains = ctx.world.mapTerrainCount()
    ctx.metrics.mapZones = ctx.world.mapZoneCount()
    ctx.metrics.mapRebuilds = ctx.world.mapRebuildCount()
    ctx.metrics.recordTick(performance.now() - tickStart, s.physics.physicsMs)
  }
}
