import type { ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * The fixed-step physics: advance the world, sync awake props and announce settles so clients pin
 * final transforms. The measured step duration is exposed for the tick metrics.
 */
export class PhysicsSystem implements System {
  readonly name = 'physics'
  /** Duration of the last physics step, for `metrics.recordTick`. */
  physicsMs = 0

  constructor(private readonly ctx: ServerContext) {}

  tick(ctx: ServerContext, dt: number): void {
    const physStart = performance.now()
    ctx.world.physics.step(dt)
    this.physicsMs = performance.now() - physStart

    const { awake, settledCount } = ctx.world.syncFromPhysics({
      onSettle: (entity) => {
        ctx.net.broadcastToKnowing(entity.id, {
          t: 'entity',
          id: entity.id,
          pos: [entity.transform.pos.x, entity.transform.pos.y, entity.transform.pos.z],
          rot: [
            entity.transform.rot.x,
            entity.transform.rot.y,
            entity.transform.rot.z,
            entity.transform.rot.w,
          ],
        })
      },
    })
    ctx.metrics.awakeBodies = awake
    ctx.metrics.settledBodies = settledCount
  }
}
