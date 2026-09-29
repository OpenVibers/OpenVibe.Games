import { worldSpawn } from '@openvibe/content'
import type { EntityId } from '@openvibe/shared'
import { EventManager } from '../eventManager.js'
import type { ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * Generic world events (supply drops, extraction): the manager's hooks are bound to the wire here,
 * and the 1 Hz driver lives in `tick`.
 */
export class WorldEventSystem implements System {
  readonly name = 'worldEvents'
  private readonly events: EventManager

  constructor(private readonly ctx: ServerContext) {
    this.events = new EventManager(
      ctx.world,
      {
        announce: (text) => ctx.net.broadcastAll({ t: 'announce', text }),
        announceTo: (entityId, text) => {
          const target = ctx.sessions.getByEntity(entityId as EntityId)
          if (target) ctx.net.send(target, { t: 'announce', text })
        },
        playersIn: (x, z, radius) => {
          const out: { entityId: string; alive: boolean }[] = []
          for (const s of ctx.sessions.values()) {
            if (Math.hypot(s.move.pos.x - x, s.move.pos.z - z) <= radius) {
              out.push({ entityId: s.entityId as string, alive: s.stats.health > 0 })
            }
          }
          return out
        },
        extractPlayer: (entityId) => this.extractPlayer(entityId),
        broadcastSpawn: (entity) => ctx.net.broadcastSpawn(entity),
        broadcastDespawn: (id) => ctx.net.broadcastDespawn(id),
      },
      ctx.config.eventIntervalScale,
      ctx.log.child({ system: 'events' }),
    )
  }

  tick(ctx: ServerContext, _dt: number): void {
    if (ctx.clock.tick % ctx.config.tickRate !== 0) return
    this.events.tick(Date.now(), ctx.sessions.size)
  }

  /**
   * Extraction success: carried valuables become SECURED (they no longer
   * drop on death) and the player is recalled to the safe city.
   */
  private extractPlayer(entityId: string): void {
    const session = this.ctx.sessions.getByEntity(entityId as EntityId)
    if (!session) return
    const secured = session.inventory.secureValuables(
      (defId) => this.ctx.world.content.item(defId)?.valuable !== undefined,
    )
    const spawn = worldSpawn(this.ctx.world.content.world).pos
    session.move.pos.x = spawn[0]
    session.move.pos.y = spawn[1]
    session.move.pos.z = spawn[2]
    session.move.vel.x = 0
    session.move.vel.y = 0
    session.move.vel.z = 0
    session.dirty = true
    this.ctx.net.send(session, {
      t: 'announce',
      text:
        secured > 0
          ? `🚁 Extracted! ${secured} stack${secured === 1 ? '' : 's'} of loot secured.`
          : '🚁 Extracted safely back to Scrap City.',
    })
    this.ctx.net.sendInventory(session)
    this.ctx.log.info('player extracted', { playerId: session.playerId, secured })
  }
}
