import type { PlayerDto } from '@openvibe/persistence'
import { Flusher, type FlushCharacter, type FlushPayload } from '../flusher.js'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import { eventPlayer, sessionProgress } from './platform.js'
import type { System } from './system.js'

/**
 * The write-behind checkpoint cadence (ADR-0007 M1): the tick builds a copy-on-write snapshot of
 * everything dirty and hands it to the {@link Flusher}, which runs one database transaction at a
 * time. The tick never awaits I/O.
 */
export class PersistenceSystem implements System {
  readonly name = 'persistence'

  private readonly flusher: Flusher
  private lastFlushTick = 0

  constructor(private readonly ctx: ServerContext) {
    this.flusher = new Flusher(
      ctx.store,
      ctx.metrics,
      ctx.log.child({ system: 'persist' }),
      ctx.integrations.events,
    )
  }

  /**
   * The tick's persistence call: builds the snapshot synchronously and hands it to the write-behind
   * flusher. It returns immediately; a checkpoint already in flight coalesces this one.
   */
  checkpoint(reason: 'checkpoint' | 'shutdown' = 'checkpoint'): void {
    this.flusher.checkpoint(() => this.buildFlushPayload(reason))
  }

  /** The periodic checkpoint gate, called once per tick by GameServer.step. */
  tick(ctx: ServerContext, _dt: number): void {
    if (
      ctx.clock.tick - this.lastFlushTick >=
      ctx.config.persistFlushSeconds * ctx.config.tickRate
    ) {
      this.lastFlushTick = ctx.clock.tick
      this.checkpoint()
    }
  }

  /**
   * Copy-on-write snapshot of everything dirty (clearing the flags as it copies). One transaction
   * writes meta, NPC/entity upserts and deletes, constraints, characters and the outbox events
   * describing them; on failure the snapshot's dirtiness is restored.
   */
  private buildFlushPayload(reason: 'checkpoint' | 'shutdown'): FlushPayload {
    const now = Date.now()
    const world = this.ctx.world.takeDirty()
    const npcs = this.ctx.systems.npcs.takeDirty(now)
    const characters: FlushCharacter[] = []
    for (const session of this.ctx.sessions.values()) {
      if (!session.dirty) continue
      session.dirty = false
      characters.push(this.flushCharacter(session))
    }
    // World clock + weather and the market blobs ride along with every checkpoint.
    const meta: Record<string, unknown> = {
      env_time: this.ctx.env.timeOfDay,
      env_weather: this.ctx.env.weather,
    }
    Object.assign(meta, this.ctx.systems.economy.marketMeta())
    if (world.entityUpserts.length > 0 || characters.length > 0) {
      this.ctx.log.debug('persistence checkpoint', {
        entities: world.entityUpserts.length,
        npcs: npcs.length,
        players: characters.length,
      })
    }
    return {
      reason,
      leaving: false,
      worldSaved: true,
      meta,
      entityUpserts: world.entityUpserts,
      entityDeletes: world.entityDeletes,
      npcUpserts: npcs,
      constraintUpserts: world.constraintUpserts,
      constraintDeletes: world.constraintDeletes,
      characters,
      worldSavedCount: world.entityUpserts.length,
      restore: () => {
        this.ctx.world.restoreDirty(world)
        this.ctx.systems.npcs.restoreDirty(npcs.map((n) => n.id))
        // A disconnected session was saved by its own queued save, which runs after this one.
        for (const c of characters) {
          if (this.ctx.sessions.get(c.session.playerId) !== undefined) c.session.dirty = true
        }
      },
    }
  }

  private flushCharacter(session: PlayerSession): FlushCharacter {
    return {
      session,
      dto: this.playerToDto(session),
      player: eventPlayer(session),
      progress: sessionProgress(session),
    }
  }

  /** Full save on shutdown; main.ts awaits drain() after this. */
  shutdown(): void {
    for (const session of this.ctx.sessions.values()) session.dirty = true
    // Never coalesced: behind a checkpoint still in flight this one is queued, not dropped.
    this.flusher.checkpoint(() => this.buildFlushPayload('shutdown'), { final: true })
    this.ctx.log.info('world saved on shutdown', {})
  }

  /** Resolves when the write-behind queue is empty (shutdown). */
  async drain(timeoutMs = 25_000): Promise<boolean> {
    return this.flusher.drain(timeoutMs)
  }

  /**
   * Saves one character; `leaving` also records games.player.left in the same transaction. The DTO is
   * built synchronously and the transaction is queued on the same queue as checkpoints, so a
   * disconnect save always lands after an earlier checkpoint of that character. The caller does not
   * await it.
   */
  savePlayer(session: PlayerSession, leaving = false): void {
    session.dirty = false
    this.flusher.savePlayer(
      {
        reason: 'checkpoint',
        leaving,
        worldSaved: false,
        meta: {},
        entityUpserts: [],
        entityDeletes: [],
        npcUpserts: [],
        constraintUpserts: [],
        constraintDeletes: [],
        characters: [this.flushCharacter(session)],
        worldSavedCount: 0,
        restore: () => {
          if (this.ctx.sessions.get(session.playerId) !== undefined) session.dirty = true
        },
      },
      () => this.ctx.sessions.get(session.playerId) !== undefined,
    )
  }

  /**
   * A session left the world; it has already been removed from the registry, so the save's `returned`
   * check sees it as gone. The session system calls this through `ctx.lifecycle.left(session)`.
   */
  onLeave(session: PlayerSession): void {
    this.savePlayer(session, true)
  }

  private playerToDto(session: PlayerSession): PlayerDto {
    const { pos } = session.move
    return {
      id: session.playerId as string,
      token: session.token,
      ...(session.subjectId ? { subjectId: session.subjectId } : {}),
      charSlot: session.charSlot,
      name: session.name,
      pos: [pos.x, pos.y, pos.z],
      yaw: session.yaw,
      inventory: session.inventory.toDto(),
      skills: session.skills.toDto(),
      friends: [...session.friends],
      appearance: session.appearance,
      stats: session.stats,
      armor: session.armor,
      reputation: session.reputation,
      unlocks: [...session.unlocks],
      activeJob: session.activeJob,
      updatedAt: Date.now(),
    }
  }
}
