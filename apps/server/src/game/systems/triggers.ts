import { getMapOverride } from '@openvibe/content'
import {
  placeMoveStateAt,
  touchTransition,
  TriggerGraph,
  type TriggerZoneRuntime,
} from '@openvibe/gameplay'
import { qfromYaw, vec3 } from '@openvibe/shared'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * Source unit → metre conversion for authored movement values. 1 gameplay
 * unit = 0.0254 m (see the movement research; do not use the 16 u/ft
 * architecture scale here).
 */
export const SOURCE_UNIT_TO_METRES = 0.0254

/**
 * Deterministic trigger/I/O execution. It runs AFTER MovementSystem (so it
 * sees this tick's authoritative segments) and AFTER SurfSystem (so surf's
 * own fail/checkpoint teleports stay authoritative for a surf place). Push
 * and teleport are applied here, so they land before the next movement step.
 */
export class TriggersSystem implements System {
  readonly name = 'triggers'
  private readonly graph: TriggerGraph

  constructor(private readonly ctx: ServerContext) {
    const override = getMapOverride(ctx.world.content.world)
    this.graph = new TriggerGraph({
      zones: override?.zones ?? [],
      points: override?.points ?? [],
      logic: override?.logic ?? [],
      tickRate: ctx.config.tickRate,
    })
  }

  tick(ctx: ServerContext, _dt: number): void {
    const now = ctx.clock.tick
    this.graph.tick(now)
    for (const session of ctx.sessions.values()) this.stepSession(ctx, session, now)
    // Delay-0 edges scheduled by a touch event fire in this same tick.
    this.graph.drain(now)
  }

  private stepSession(ctx: ServerContext, session: PlayerSession, now: number): void {
    for (const segment of session.moveSegments) {
      for (const trigger of this.graph.triggers) {
        if (!trigger.enabled) continue
        const wasInside = session.triggerTouches.get(trigger.id) ?? false
        const transition = touchTransition(trigger, segment.from, segment.to, wasInside)
        session.triggerTouches.set(trigger.id, transition.nowInside)
        if (transition.kind === 'start') {
          this.fireStart(session, trigger, now)
          this.applyTeleport(ctx, session, trigger)
        } else if (transition.kind === 'end') {
          this.graph.fireTouchOutputs(trigger, 'OnEndTouch', now)
        }
        if (transition.nowInside) this.applyPush(session, trigger)
      }
    }
  }

  private fireStart(session: PlayerSession, trigger: TriggerZoneRuntime, now: number): void {
    if (!trigger.trigger) return
    const waitTicks = Math.round(trigger.trigger.wait * this.ctx.config.tickRate)
    const last = session.triggerStartTicks.get(trigger.id) ?? Number.NEGATIVE_INFINITY
    if (waitTicks > 0 && now - last < waitTicks) return
    session.triggerStartTicks.set(trigger.id, now)
    this.graph.fireTouchOutputs(trigger, 'OnStartTouch', now)
    if (trigger.trigger.once) trigger.enabled = false
  }

  private applyTeleport(ctx: ServerContext, session: PlayerSession, trigger: TriggerZoneRuntime): void {
    if (trigger.kind !== 'trigger_teleport' || !trigger.teleport) return
    const dest = this.graph.points.get(trigger.teleport.to)
    if (!dest) return
    const yaw = trigger.teleport.keepAngles ? session.yaw : dest.yaw
    this.teleport(ctx, session, dest.pos, yaw)
  }

  private teleport(
    ctx: ServerContext,
    session: PlayerSession,
    pos: { x: number; y: number; z: number },
    yaw: number,
  ): void {
    placeMoveStateAt(session.move, pos)
    session.yaw = yaw
    const body = ctx.world.bodyOf(session.entityId)
    if (body !== undefined)
      ctx.world.physics.setTransform(body, vec3(pos.x, pos.y + 0.15, pos.z))
    const entity = ctx.world.entities.get(session.entityId)
    if (entity) qfromYaw(entity.transform.rot, yaw)
  }

  private applyPush(session: PlayerSession, trigger: TriggerZoneRuntime): void {
    if (trigger.kind !== 'trigger_push' || !trigger.push) return
    if (trigger.push.onlyFalling && session.move.grounded) return
    const [dx, dy, dz] = trigger.push.dir
    const len = Math.hypot(dx, dy, dz) || 1
    const m = trigger.push.speed * SOURCE_UNIT_TO_METRES
    session.move.vel.x = (dx / len) * m
    session.move.vel.y = (dy / len) * m
    session.move.vel.z = (dz / len) * m
  }
}
