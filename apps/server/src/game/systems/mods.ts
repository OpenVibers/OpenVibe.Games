import { terrainHeight } from '@openvibe/content'
import { qfromYaw, quat, vec3, type EntityId, type PlayerId } from '@openvibe/shared'
import type { ModHost } from '../../mods/runtime.js'
import type { ScriptPlayer, ScriptWorld } from '../../mods/script/host.js'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { System } from './system.js'

function scriptPlayer(s: PlayerSession): ScriptPlayer {
  return {
    id: s.playerId,
    name: s.name,
    pos: [s.move.pos.x, s.move.pos.y, s.move.pos.z],
    yaw: s.yaw,
  }
}

/**
 * The mod runtime's host: the tick that reconciles installs and the capability surface it is lent,
 * and, where the place enables them, the script mods' tick, join/leave hooks and world.
 */
export class ModSystem implements System {
  readonly name = 'mods'

  /**
   * What mods may do to the world, lent to the mod runtime only. Mod props
   * are owned by the mod id, so prop protection keeps players' hands off.
   */
  readonly host: ModHost = {
    announce: (text) => this.ctx.net.broadcastAll({ t: 'announce', text }),
    placeProp: ({ item, pos, yaw, owner }) => {
      const entity = this.ctx.world.spawnProp({
        defId: item,
        pos: vec3(
          pos[0],
          pos[1] + terrainHeight(this.ctx.world.content.world, pos[0], pos[2]),
          pos[2],
        ),
        rot: qfromYaw(quat(), yaw),
        motion: 'frozen',
        owner: owner as PlayerId,
      })
      this.ctx.net.broadcastSpawn(entity)
      return entity.id as string
    },
    removeEntity: (id) => {
      const entityId = id as EntityId
      if (!this.ctx.world.entities.get(entityId)) return false
      this.ctx.world.despawn(entityId)
      this.ctx.net.broadcastDespawn(entityId)
      return true
    },
    entityExists: (id) => this.ctx.world.entities.get(id as EntityId) !== undefined,
  }

  /**
   * What script mods read and change. Changes arrive as validated intents and
   * go through the same inventory and broadcast paths the game itself uses.
   */
  readonly scriptWorld: ScriptWorld = {
    players: () => [...this.ctx.sessions.values()].map(scriptPlayer),
    player: (id) => {
      const session = this.ctx.sessions.get(id)
      return session ? scriptPlayer(session) : null
    },
    apply: (_modId, intent) => {
      switch (intent.kind) {
        case 'announce':
          this.ctx.net.broadcastAll({ t: 'announce', text: intent.text })
          return null
        case 'giveItem': {
          const session = this.ctx.sessions.get(intent.playerId)
          if (!session) return 'no such player'
          if (!this.ctx.world.content.item(intent.item)) return 'unknown item'
          if (!session.inventory.canFit(intent.item, intent.count)) return 'inventory_full'
          session.inventory.add(intent.item, intent.count)
          session.dirty = true
          this.ctx.net.sendInventory(session)
          return null
        }
      }
    },
  }

  constructor(private readonly ctx: ServerContext) {
    ctx.integrations.scripts?.bind(this.scriptWorld)
  }

  tick(ctx: ServerContext, dt: number): void {
    // Reconcile installs (a revoked or disabled mod's effects are
    // retracted on the first tick after the change).
    ctx.integrations.mods?.tick(ctx.clock.tick, this.host)
    const scripts = ctx.integrations.scripts
    if (scripts) {
      scripts.tick(ctx.clock.tick, dt)
      let running = 0
      let failures = 0
      const status = scripts.status()
      for (const s of status) {
        if (s.state === 'running') running++
        failures += s.failures.cpu + s.failures.memory + s.failures.stack + s.failures.error
      }
      ctx.metrics.scriptModsRunning = running
      ctx.metrics.scriptModsDisabled = status.length - running
      ctx.metrics.scriptModFailures = failures
    }
  }

  onJoin(session: PlayerSession): void {
    this.ctx.integrations.scripts?.playerJoined(scriptPlayer(session))
  }

  onLeave(session: PlayerSession): void {
    this.ctx.integrations.scripts?.playerLeft(session.playerId)
  }
}
