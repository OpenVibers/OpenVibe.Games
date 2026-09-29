import { terrainHeight } from '@openvibe/content'
import { qfromYaw, quat, vec3, type EntityId, type PlayerId } from '@openvibe/shared'
import type { ModHost } from '../../mods/runtime.js'
import type { ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * The mod runtime's host: the tick that reconciles installs and the capability surface it is lent.
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

  constructor(private readonly ctx: ServerContext) {}

  tick(ctx: ServerContext, _dt: number): void {
    // Reconcile installs (a revoked or disabled mod's effects are
    // retracted on the first tick after the change).
    ctx.integrations.mods?.tick(ctx.clock.tick, this.host)
  }
}
