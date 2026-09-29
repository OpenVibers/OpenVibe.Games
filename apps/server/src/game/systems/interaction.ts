import { ambientTemperature, plantProgress, precipitation } from '@openvibe/gameplay'
import type { ClientUse } from '@openvibe/protocol'
import type { EntityId } from '@openvibe/shared'
import { handleUse } from '../interactions.js'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

/**
 * Using a tool or bare hand against the world (ADR-0007 M1): gathering resources, doors, plants,
 * repairing and disassembling — plus the world's resource-respawn sweep.
 */
export class InteractionSystem implements System {
  readonly name = 'interaction'

  readonly handlers: HandlerMap = {
    use: (session: PlayerSession, msg: ClientUse, _conn) => {
      // Swing cooldown: silently drop spam faster than ~5 swings/sec.
      if (this.ctx.clock.tick - session.lastUseTick < 6) return
      const targetSession = this.ctx.sessions.getByEntity(msg.target as EntityId)
      if (targetSession) {
        // Legacy path: melee also arrives as 'use' from older flows.
        this.ctx.systems.combat.melee(session, targetSession)
        return
      }
      const vehicleTarget = this.ctx.world.entities.get(msg.target as EntityId)
      if (
        vehicleTarget?.prop &&
        this.ctx.world.content.item(vehicleTarget.prop.defId)?.vehiclePart?.part === 'chassis'
      ) {
        this.ctx.systems.vehicles.useVehicle(session, vehicleTarget)
        return
      }
      const gather = handleUse(
        session,
        this.ctx.world,
        msg,
        Date.now(),
        (e) => this.ctx.systems.manipulation.canManipulate(session, e),
        {
          nowMs: Date.now(),
          raining: precipitation(this.ctx.env) > 0,
          ambientC: ambientTemperature(this.ctx.env),
        },
      )
      this.ctx.net.send(session, gather.outcome)
      if (!gather.outcome.ok) return
      session.lastUseTick = this.ctx.clock.tick
      this.ctx.net.sendInventory(session)
      if (gather.xpChanged) this.ctx.net.sendSkills(session)
      for (const up of gather.levelUps) {
        this.ctx.net.send(session, { t: 'levelup', skill: up.skill, level: up.level })
      }
      if (gather.pickedUp) {
        if (session.held?.entityId === gather.pickedUp.id) {
          this.ctx.systems.manipulation.releaseHeld(session)
        }
        this.ctx.net.broadcastDespawn(gather.pickedUp.id)
      }
      if (gather.spawned) this.ctx.net.broadcastSpawn(gather.spawned)
      if (gather.changed?.prop) {
        // Door swing / plant change / repair: pin authoritative state.
        const e = gather.changed
        const plant = e.prop?.plant
        const max = this.ctx.world.content.item(e.prop!.defId)?.health?.max
        this.ctx.net.broadcastToKnowing(e.id, {
          t: 'entity',
          id: e.id,
          pos: [e.transform.pos.x, e.transform.pos.y, e.transform.pos.z],
          rot: [e.transform.rot.x, e.transform.rot.y, e.transform.rot.z, e.transform.rot.w],
          plant: (() => {
            const crop = plant ? this.ctx.world.content.crop(plant.crop) : undefined
            return plant && crop
              ? { crop: plant.crop, t: plantProgress(plant, crop), water: plant.water }
              : null
          })(),
          ...(max !== undefined ? { health: Math.round(e.prop!.health ?? max) } : {}),
        })
      }
      if (gather.changed?.resource) {
        this.ctx.net.broadcastToKnowing(gather.changed.id, {
          t: 'entity',
          id: gather.changed.id,
          remaining: gather.changed.resource.remaining,
        })
      }
    },
  }

  constructor(private readonly ctx: ServerContext) {}

  /** Resource respawn sweep (once a second). */
  respawnResources(): void {
    if (this.ctx.clock.tick % this.ctx.config.tickRate !== 0) return
    for (const entity of this.ctx.world.respawnDueResources(Date.now())) {
      if (entity.resource) {
        this.ctx.net.broadcastToKnowing(entity.id, {
          t: 'entity',
          id: entity.id,
          remaining: entity.resource.remaining,
        })
      }
    }
  }
}
