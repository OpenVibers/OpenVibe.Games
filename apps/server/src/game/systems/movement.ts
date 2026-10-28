import {
  DEFAULT_MOVEMENT,
  applyDamage,
  hullHeightFor,
  movementParamsFor,
  movementStyleFor,
  stepMovement,
  type CollisionQueries,
  type MoveInput,
  type MovementParams,
} from '@openvibe/gameplay'
import { CollisionLayer, type BodyId } from '@openvibe/physics'
import type { ClientEditMode, ClientInput } from '@openvibe/protocol'
import { clamp, dequantiseAngle, qfromYaw, vec3, wrapAngle } from '@openvibe/shared'
import { canEditMap } from '../../net/networkAuth.js'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

export const MOVE = DEFAULT_MOVEMENT

/*
 * Every input a client sends is simulated once, in order, and the server never invents one. The client predicts each
 * input as it sends it and replays the ones the server has not acknowledged, so any input the server drops or adds
 * is a misprediction, and the next snapshot snaps the player back. The queue used to hold 6 inputs and drop the
 * rest, and an empty queue repeated the last input: a frame hitch or network jitter (a home connection, OBS on the
 * same machine) made walking rubber-band (owner, 2026-10-19).
 *
 * Speed stays honest through credit: one per tick, banked up to a second's worth, one spent per simulated input.
 * After a hitch the bank lets the backlog catch up a few inputs a tick; a client sending faster than real time runs
 * out of credit and its extra inputs only wait.
 */
/** Inputs that may wait: a second of play. A client past it is flooding, and its oldest go. */
export const MAX_INPUT_QUEUE = 30
/** Credit banked at most: a second of play. */
export const MAX_INPUT_CREDIT = 30
/** Inputs simulated in one tick at most, while catching up. */
export const CATCH_UP_PER_TICK = 4
/** Ticks a late client is waited for (its player holds still) before its player coasts to a stop. */
export const STALL_TICKS = 15

/** Queue one input from the client. */
export function queueInput(session: PlayerSession, input: ClientInput): void {
  if (session.inputQueue.length >= MAX_INPUT_QUEUE) session.inputQueue.shift()
  session.inputQueue.push(input)
}

/** This tick's inputs, in order: earn one credit, then spend one per input, at most CATCH_UP_PER_TICK. */
export function takeInputs(session: PlayerSession): ClientInput[] {
  session.inputCredit = Math.min(MAX_INPUT_CREDIT, session.inputCredit + 1)
  const out: ClientInput[] = []
  while (
    out.length < CATCH_UP_PER_TICK &&
    session.inputCredit >= 1 &&
    session.inputQueue.length > 0
  ) {
    out.push(session.inputQueue.shift()!)
    session.inputCredit -= 1
  }
  return out
}
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
      queueInput(session, msg)
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
    // Resolve the place's movement once per tick, not once per player: the
    // style is room-wide, and instanceHub's per-tick budget is tight.
    const style = movementStyleFor(ctx.world.content.world)
    const params = movementParamsFor(style)
    const surfPlace = style === 'surf'
    for (const session of ctx.sessions.values()) {
      this.stepSession(ctx, session, dt, params, surfPlace)
    }
  }

  private stepSession(
    ctx: ServerContext,
    session: PlayerSession,
    dt: number,
    params: MovementParams,
    surfPlace: boolean,
  ): void {
    if (session.driving) {
      ctx.systems.vehicles.driveVehicle(session)
      return
    }
    this.sweepSelf = ctx.sessions.bodyOf(session.playerId)
    session.moveSegments.length = 0
    let simulated = 0
    for (const input of takeInputs(session)) {
      session.lastInput = input
      session.starvedTicks = 0
      session.lastProcessedSeq = input.seq
      applyLookInput(session, input)
      session.buttons = input.intents
      const from = surfPlace
        ? vec3(session.move.pos.x, session.move.pos.y, session.move.pos.z)
        : null
      stepMovement(session.move, toMoveInput(session, input), params, this.moveQueries, dt)
      if (from)
        session.moveSegments.push({
          from,
          to: vec3(session.move.pos.x, session.move.pos.y, session.move.pos.z),
          yaw: session.yaw,
        })
      simulated++
    }
    if (simulated === 0 && session.lastInput) {
      // No input this tick. A late client's inputs are on their way: its player holds still and catches up when
      // they land (simulating anything now would be a step the client never predicted). A client quiet for longer
      // (a background tab, a dropped connection) coasts to a stop under gravity.
      session.starvedTicks++
      if (session.starvedTicks > STALL_TICKS) {
        // Zero MOVEMENT only: buttons stay held. Zeroing buttons fabricates release edges for toggle keys
        // (prone/crouch), and the server flapped stances.
        const from = surfPlace
          ? vec3(session.move.pos.x, session.move.pos.y, session.move.pos.z)
          : null
        stepMovement(
          session.move,
          toMoveInput(session, { ...session.lastInput, moveX: 0, moveZ: 0 }),
          params,
          this.moveQueries,
          dt,
        )
        if (from)
          session.moveSegments.push({
            from,
            to: vec3(session.move.pos.x, session.move.pos.y, session.move.pos.z),
            yaw: session.yaw,
          })
      }
    }
    let bodyId = ctx.sessions.bodyOf(session.playerId)
    if (bodyId !== undefined && session.bodyStance !== session.move.stance) {
      // Stance changed: swap the kinematic hull to match the new posture.
      ctx.world.physics.removeBody(bodyId)
      const hull = hullHeightFor(session.move.stance)
      bodyId = ctx.world.physics.addBody({
        shape: {
          type: 'capsule',
          radius: params.capsuleRadius,
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
    // A surf place is a time trial: misses teleport to the last checkpoint and
    // the clock keeps running, so falls must not kill (brief decision 4).
    if (surfPlace) {
      session.fallVy = 0
    } else if (!session.move.grounded) {
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
