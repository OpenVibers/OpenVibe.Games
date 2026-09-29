import {
  DEFAULT_MOVEMENT,
  applyDamage,
  hullHeightFor,
  stepMovement,
  type CollisionQueries,
  type MoveInput,
} from '@openvibe/gameplay'
import { CollisionLayer, type BodyId } from '@openvibe/physics'
import type { ClientEditMode, ClientInput } from '@openvibe/protocol'
import { clamp, dequantiseAngle, qfromYaw, vec3, wrapAngle } from '@openvibe/shared'
import { canEditMap } from '../../net/networkAuth.js'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

export const MOVE = DEFAULT_MOVEMENT
/** Bounded input queue: the cap stops a client from buying simulation speed with backlog. */
export const MAX_INPUT_QUEUE = 6
const _bodyPosScratch = vec3()

/**
 * Apply a client's absolute, quantised view angles (ADR-0007 decision 3). Look is the client's: the
 * server takes the angles as sent, like client prediction does, so the two integrate identical
 * values. Yaw stays wrapped to one turn and pitch is clamped to ±90°; the wire schema already bounds
 * both.
 */
export function applyLookInput(session: PlayerSession, input: ClientInput): void {
  session.yaw = wrapAngle(dequantiseAngle(input.yawQ))
  session.pitch = clamp(dequantiseAngle(input.pitchQ), -Math.PI / 2, Math.PI / 2)
}

/** A client command as the movement sim's input, reading the session's applied view. */
function toMoveInput(session: PlayerSession, input: ClientInput): MoveInput {
  return {
    moveX: input.moveX,
    moveZ: input.moveZ,
    yaw: session.yaw,
    pitch: session.pitch,
    buttons: input.intents,
  }
}

/**
 * Authoritative movement: queued input commands become positions, the kinematic capsule follows,
 * stance swaps rebuild the hull, and falling hurts. Vehicle driving is the one exception — it
 * lives in the vehicles system and takes over a session's movement while it is mounted.
 */
export class MovementSystem implements System {
  readonly name = 'movement'

  private readonly moveQueries: CollisionQueries
  /** Body excluded from the current movement sweep (the moving player's own). */
  private sweepSelf: BodyId | undefined

  readonly handlers: HandlerMap = {
    input: (session, msg: ClientInput, _conn) => {
      if (session.inputQueue.length < MAX_INPUT_QUEUE) session.inputQueue.push(msg)
    },
    editmode: (session, msg: ClientEditMode, _conn) => {
      // Rank-gated noclip build mode. The flag lives in the move state so
      // server sim and client prediction stay in lockstep via the normal
      // self-state replication path.
      if (canEditMap(session.rank)) {
        session.move.noclip = msg.on
        session.move.vel.x = 0
        session.move.vel.y = 0
        session.move.vel.z = 0
        this.ctx.net.send(session, {
          t: 'announce',
          text: msg.on ? '🛠 Edit mode ON — noclip flight' : '🛠 Edit mode OFF',
        })
      }
    },
  }

  constructor(private readonly ctx: ServerContext) {
    // Players block players: sweeps include the Player layer, minus the
    // mover's own kinematic body.
    this.moveQueries = {
      sweepCapsule: (from, to, radius, height) =>
        ctx.world.physics.sweepCapsule(
          from,
          to,
          radius,
          height,
          CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
          this.sweepSelf,
        ),
    }
  }

  tick(ctx: ServerContext, dt: number): void {
    for (const session of ctx.sessions.values()) {
      this.stepSession(ctx, session, dt)
    }
  }

  private stepSession(ctx: ServerContext, session: PlayerSession, dt: number): void {
    if (session.driving) {
      ctx.systems.vehicles.driveVehicle(session)
      return
    }
    this.sweepSelf = ctx.sessions.bodyOf(session.playerId)
    // Process at most 2 queued inputs per tick (catch-up), else repeat the
    // last input — the queue bound caps client-driven speedup.
    const budget = session.inputQueue.length > 2 ? 2 : 1
    let simulated = 0
    for (let i = 0; i < budget; i++) {
      const input = session.inputQueue.shift()
      if (!input) break
      session.lastInput = input
      session.starvedTicks = 0
      session.lastProcessedSeq = input.seq
      applyLookInput(session, input)
      session.buttons = input.intents
      stepMovement(session.move, toMoveInput(session, input), MOVE, this.moveQueries, dt)
      simulated++
    }
    if (simulated === 0 && session.lastInput) {
      // Bridge short network jitter by repeating the last command, but only
      // briefly — a silent client must coast to a stop, not walk forever.
      session.starvedTicks++
      // Zero MOVEMENT only — buttons stay held. Zeroing buttons fabricates
      // release edges for toggle keys (prone/crouch), so any client hitch
      // longer than 3 ticks made the server flap stances endlessly.
      const input =
        session.starvedTicks <= 3 ? session.lastInput : { ...session.lastInput, moveX: 0, moveZ: 0 }
      stepMovement(session.move, toMoveInput(session, input), MOVE, this.moveQueries, dt)
    }
    let bodyId = ctx.sessions.bodyOf(session.playerId)
    if (bodyId !== undefined && session.bodyStance !== session.move.stance) {
      // Stance changed: swap the kinematic hull to match the new posture.
      ctx.world.physics.removeBody(bodyId)
      const hull = hullHeightFor(session.move.stance)
      bodyId = ctx.world.physics.addBody({
        shape: {
          type: 'capsule',
          radius: MOVE.capsuleRadius,
          height: Math.max(hull - 0.3, 0.4),
        },
        motion: 'kinematic',
        pos: vec3(session.move.pos.x, session.move.pos.y + 0.15, session.move.pos.z),
        layer: CollisionLayer.Player,
        collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
      })
      ctx.sessions.setBody(session.playerId, bodyId)
      session.bodyStance = session.move.stance
    }
    if (bodyId !== undefined) {
      _bodyPosScratch.x = session.move.pos.x
      _bodyPosScratch.y = session.move.pos.y + 0.15
      _bodyPosScratch.z = session.move.pos.z
      ctx.world.physics.setTransform(bodyId, _bodyPosScratch)
    }
    // Fall damage: track the hardest downward velocity while airborne and
    // cash it in on landing. ~13 m/s (≈2.5 story drop) is the free threshold.
    if (!session.move.grounded) {
      session.fallVy = Math.min(session.fallVy, session.move.vel.y)
    } else if (session.fallVy < -13) {
      const dmg = Math.round((-session.fallVy - 13) * 3.5)
      session.fallVy = 0
      if (applyDamage(session.stats, dmg)) {
        ctx.log.info('fall death', { playerId: session.playerId })
        ctx.systems.combat.respawn(session, true)
      } else {
        session.statsDirty = true
      }
    } else {
      session.fallVy = 0
    }
    const entity = ctx.world.entities.get(session.entityId)
    if (entity) qfromYaw(entity.transform.rot, session.yaw)
    ctx.world.spatial.move(session.entityId, session.move.pos.x, session.move.pos.z)
  }
}
