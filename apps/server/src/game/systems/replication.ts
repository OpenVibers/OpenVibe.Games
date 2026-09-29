import { activeStatuses, type GameEntity } from '@openvibe/gameplay'
import { encodeServerMessage, type ServerMessage, type ServerStats } from '@openvibe/protocol'
import type { EntityId } from '@openvibe/shared'
import type { ConstraintRecord } from '../gameWorld.js'
import type { PlayerSession } from '../playerSession.js'
import { buildSnapshot, updateInterest, wireEntityFor } from '../replication.js'
import type { Net, ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * Replication: the one place every system sends through, plus interest management and the
 * authoritative snapshot phase. It owns the byte/message counters and the geometry of who knows
 * what; it holds no gameplay state of its own.
 */
export class ReplicationSystem implements System, Net {
  readonly name = 'replication'

  constructor(private readonly ctx: ServerContext) {}

  tick(ctx: ServerContext, _dt: number): void {
    // Snapshots go out at `tickRate / snapshotEvery` Hz (15 with the defaults).
    if (ctx.clock.tick % ctx.config.snapshotEvery === 0) this.replicate()
  }

  // ── The wire surface (Net) ─────────────────────────────────────────

  send(session: PlayerSession, msg: ServerMessage): void {
    this.sendRaw(session, encodeServerMessage(msg))
  }

  sendRaw(session: PlayerSession, encoded: string): void {
    session.send(encoded)
    this.ctx.metrics.bytesOut += encoded.length
    this.ctx.metrics.messagesOut++
  }

  sendInventory(session: PlayerSession): void {
    const dto = session.inventory.toDto()
    this.send(session, {
      t: 'inventory',
      inv: {
        size: dto.size,
        hotbar: dto.hotbar,
        slots: dto.slots.map(({ i, stack }) => ({
          i,
          stack: {
            def: stack.defId,
            count: stack.count,
            ...(stack.meta !== undefined ? { meta: stack.meta } : {}),
          },
        })),
      },
      activeHotbar: session.activeHotbar,
      armor: session.armor
        ? {
            def: session.armor.defId,
            count: session.armor.count,
            ...(session.armor.meta !== undefined ? { meta: session.armor.meta } : {}),
          }
        : null,
    })
  }

  sendSkills(session: PlayerSession): void {
    this.send(session, {
      t: 'skills',
      skills: session.skills.all(),
      unlocks: [...session.unlocks],
    })
  }

  sendCraftState(session: PlayerSession): void {
    this.send(session, {
      t: 'craft_state',
      jobs: session.craftQueue.pending.map((j) => ({ recipe: j.recipeId, readyTick: j.readyTick })),
    })
  }

  sendContainer(session: PlayerSession, entity: GameEntity): void {
    const box = entity.prop?.container ?? []
    this.send(session, {
      t: 'container',
      id: entity.id,
      size: box.length,
      slots: box.flatMap((slot, i) => (slot ? [{ i, def: slot.defId, count: slot.count }] : [])),
    })
  }

  timeWire(): ServerMessage {
    return { t: 'time', frac: this.ctx.env.timeOfDay, weather: this.ctx.env.weather }
  }

  statsWire(session: PlayerSession): Omit<ServerStats, 't' | 'died'> {
    return {
      hp: Math.round(session.stats.health),
      hunger: Math.round(session.stats.hunger),
      thirst: Math.round(session.stats.thirst),
      stamina: Math.round(session.stats.stamina),
      temp: Math.round(session.stats.bodyTemp * 10) / 10,
      statuses: activeStatuses(session.stats, Date.now()) as string[],
    }
  }

  broadcastAll(msg: ServerMessage): void {
    const encoded = encodeServerMessage(msg)
    for (const session of this.ctx.sessions.values()) this.sendRaw(session, encoded)
  }

  broadcastSpawn(entity: GameEntity): void {
    // Deliver immediately to sessions in range; interest diff would send it
    // next snapshot anyway, but placement feedback should be instant.
    const wire = wireEntityFor(this.ctx.world, entity)
    const encoded = encodeServerMessage({ t: 'spawn', entities: [wire] })
    const radiusSq = this.ctx.config.interestRadius ** 2
    for (const session of this.ctx.sessions.values()) {
      const d2 =
        (entity.transform.pos.x - session.move.pos.x) ** 2 +
        (entity.transform.pos.y - session.move.pos.y) ** 2 +
        (entity.transform.pos.z - session.move.pos.z) ** 2
      if (d2 <= radiusSq) {
        session.known.add(entity.id)
        this.sendRaw(session, encoded)
      }
    }
  }

  /** Constraint create/remove: tell every client that knows either prop. */
  broadcastConstraintState(rec: ConstraintRecord, active: boolean): void {
    const msg = constraintStateWire(rec, active)
    const encoded = encodeServerMessage(msg)
    for (const session of this.ctx.sessions.values()) {
      if (session.known.has(rec.a) || session.known.has(rec.b)) {
        this.sendRaw(session, encoded)
      }
    }
  }

  broadcastDespawn(id: string): void {
    for (const session of this.ctx.sessions.values()) {
      if (session.known.delete(id as EntityId)) {
        this.send(session, { t: 'despawn', ids: [id] })
      }
    }
  }

  broadcastToKnowing(id: EntityId, msg: ServerMessage): void {
    const encoded = encodeServerMessage(msg)
    for (const session of this.ctx.sessions.values()) {
      if (session.known.has(id)) this.sendRaw(session, encoded)
    }
  }

  // ── Interest + snapshots ───────────────────────────────────────────

  replicate(): void {
    const ctx = this.ctx
    for (const session of ctx.sessions.values()) {
      const diff = updateInterest(session, ctx.world, ctx.config.interestRadius)
      if (diff.entered.length > 0) {
        this.send(session, {
          t: 'spawn',
          entities: diff.entered.map((e) => {
            const wire = wireEntityFor(ctx.world, e)
            const owner = ctx.sessions.getByEntity(e.id)
            if (owner) {
              wire.name = owner.name
              wire.player = owner.playerId as string
              wire.appearance = owner.appearance
            }
            return wire
          }),
        })
      }
      if (diff.left.length > 0) {
        this.send(session, { t: 'despawn', ids: diff.left as string[] })
      }
      // Constraints touching newly-known props (visuals need endpoints).
      if (diff.entered.length > 0) {
        const sent = new Set<string>()
        for (const entity of diff.entered) {
          for (const rec of ctx.world.constraintsFor(entity.id)) {
            if (sent.has(rec.id)) continue
            sent.add(rec.id)
            this.send(session, constraintStateWire(rec, true))
          }
        }
      }
      const snapshot = buildSnapshot(session, ctx.world, ctx.sessions.values(), ctx.clock.tick)
      const encoded = encodeServerMessage(snapshot)
      ctx.metrics.snapshotBytes = encoded.length
      this.sendRaw(session, encoded)
    }
  }
}

export function constraintStateWire(rec: ConstraintRecord, active: boolean): ServerMessage {
  return {
    t: 'constraint_state',
    id: rec.id,
    kind: rec.type,
    a: rec.a as string,
    b: rec.b as string,
    anchorA: rec.params.anchorA ?? [0, 0, 0],
    anchorB: rec.params.anchorB ?? [0, 0, 0],
    ...(rec.params.length !== undefined ? { length: rec.params.length } : {}),
    active,
  }
}
