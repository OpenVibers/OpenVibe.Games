import type { NpcState } from '@openvibe/gameplay'
import type { WorldEntityDto } from '@openvibe/persistence'
import { v3dist, type EntityId } from '@openvibe/shared'
import { NpcManager } from '../npcManager.js'
import type { ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * The server-authoritative NPC simulation (ADR-0007 M1): an {@link NpcManager} plus the two pieces
 * of mutable state its AI reads — the per-entity aggro deadlines (a player who recently attacked
 * draws defensive NPCs) and the per-second sound-event buffer (gunshots, fights) for NPC hearing.
 */
export class NpcSystem implements System {
  readonly name = 'npcs'
  /** Players who recently attacked someone (defensive NPCs respond); entity id -> aggro-until ms. */
  private readonly aggro = new Map<string, number>()
  /** Sound events (gunshots, fights) accumulated for NPC hearing. */
  private sounds: { x: number; z: number }[] = []
  private readonly npcs: NpcManager

  constructor(private readonly ctx: ServerContext) {
    this.npcs = new NpcManager(
      ctx.world,
      ctx.regions,
      {
        onAttackPlayer: (npcId, playerEntityId, damage) => {
          const victim = ctx.sessions.getByEntity(playerEntityId as EntityId)
          const npcEntity = ctx.world.entities.get(npcId)
          if (!victim || !npcEntity) return
          // NPC melee has reach limits too (no cross-map slaps).
          const d = v3dist(npcEntity.transform.pos, victim.move.pos)
          if (d > 3) return
          ctx.systems.combat.damagePlayer(null, victim, {
            type: 'blunt',
            amount: damage,
            sourceId: npcId,
          })
        },
        soundsThisTick: () => this.sounds,
        hostilesNear: (x, z, radius, faction) => {
          const stance = ctx.world.content.faction(faction)?.playerStance ?? 'neutral'
          const nowMs = Date.now()
          const out: { id: string; x: number; z: number; hostile: boolean }[] = []
          for (const other of ctx.sessions.values()) {
            const dx = other.move.pos.x - x
            const dz = other.move.pos.z - z
            if (dx * dx + dz * dz > radius * radius) continue
            const aggro = (this.aggro.get(other.entityId as string) ?? 0) > nowMs
            const hostile = stance === 'hostile' || aggro
            out.push({
              id: other.entityId as string,
              x: other.move.pos.x,
              z: other.move.pos.z,
              hostile,
            })
          }
          return out
        },
      },
      ctx.log.child({ system: 'npc' }),
    )
  }

  /** Boot: restore persisted NPCs, then seed content spawns not yet known. */
  async load(): Promise<void> {
    await this.npcs.seedOrRestore(this.ctx.store)
  }

  /** One NPC simulation step; the sound buffer is cleared once a second. */
  tick(ctx: ServerContext, _dt: number): void {
    this.npcs.step(Date.now(), ctx.clock.tick, ctx.config.tickRate)
    if (ctx.clock.tick % ctx.config.tickRate === 0) this.sounds = []
  }

  /** Damage an NPC (melee/ranged already mitigated upstream). */
  damage(entityId: EntityId, amount: number, nowMs: number): 'dead' | 'hurt' | null {
    return this.npcs.damage(entityId, amount, nowMs)
  }

  npcStateOf(entityId: EntityId): NpcState | undefined {
    return this.npcs.npcStateOf(entityId)
  }

  /** Counts for metrics: [full-sim, abstract]. */
  counts(): [number, number] {
    return this.npcs.counts()
  }

  /** A sound event (gunshot, fight) for NPC hearing this second. */
  recordSound(x: number, z: number): void {
    this.sounds.push({ x, z })
  }

  /** A player recently attacked, so defensive NPCs respond until `untilMs`. */
  markAggro(entityId: string, untilMs: number): void {
    this.aggro.set(entityId, untilMs)
  }

  /** Copy-on-write snapshot of the NPC rows whose abstract state changed (for the flusher). */
  takeDirty(nowMs: number): WorldEntityDto[] {
    return this.npcs.takeDirty(nowMs)
  }

  /** A failed flush: mark these NPCs dirty again. */
  restoreDirty(ids: readonly string[]): void {
    this.npcs.restoreDirty(ids)
  }
}
