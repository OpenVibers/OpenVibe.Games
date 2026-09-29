import type { GameEntity } from '@openvibe/gameplay'
import type { ClientConstraint, ClientConstraintRemove, ClientPhysgun } from '@openvibe/protocol'
import { v3dist, vec3, type EntityId } from '@openvibe/shared'
import { equippedTool, handleConstraint } from '../interactions.js'
import { adjustDistance, driveHeld, freezeHeld, release, rotateHeld, tryGrab } from '../physgun.js'
import { eyePosition, type PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

const _eyeScratch = vec3()
const _relVel = vec3()

/**
 * Manipulation: the physgun beam and the rigging tool — everything gated by prop protection. It
 * owns who is holding what (the exclusivity latch) and the offline-owner friend cache that
 * `canManipulate` consults, so no other system ever has to look up an offline owner.
 */
export class ManipulationSystem implements System {
  readonly name = 'manipulation'

  /** Exclusivity set for physgun grabs (one beam per prop). */
  private readonly heldEntityIds = new Set<string>()
  /** Short-lived cache of OFFLINE owners' friend lists (prop protection). */
  private readonly offlineFriendsCache = new Map<string, { friends: Set<string>; at: number }>()
  /** Offline-owner lookups in flight, so the tick never issues the same read twice. */
  private readonly friendsLoadInFlight = new Set<string>()

  readonly handlers: HandlerMap = {
    physgun: (session, msg: ClientPhysgun, _conn) => {
      this.handlePhysgun(session, msg)
    },
    constraint: (session, msg: ClientConstraint, _conn) => {
      const { outcome, created } = handleConstraint(session, this.ctx.world, msg, (e) =>
        this.canManipulate(session, e),
      )
      this.ctx.net.send(session, outcome)
      if (created) {
        this.ctx.net.broadcastConstraintState(created, true)
        this.ctx.net.sendSkills(session)
        // Rope/spring/motor constraints consume materials.
        this.ctx.net.sendInventory(session)
      }
    },
    constraint_remove: (session, msg: ClientConstraintRemove, _conn) => {
      const ctx = this.ctx
      const tool = equippedTool(session)
      if (tool?.kind !== 'rigging') {
        ctx.net.send(session, {
          t: 'result',
          action: 'constraint',
          ok: false,
          error: 'requires_rigging_tool',
        })
        return
      }
      const target = ctx.world.entities.get(msg.target as EntityId)
      if (!target?.prop) {
        ctx.net.send(session, { t: 'result', action: 'constraint', ok: false, error: 'no_target' })
        return
      }
      if (!this.canManipulate(session, target)) {
        ctx.net.send(session, { t: 'result', action: 'constraint', ok: false, error: 'not_owner' })
        return
      }
      eyePosition(session, _eyeScratch)
      if (v3dist(_eyeScratch, target.transform.pos) > (tool.range ?? 6) + 1.5) {
        ctx.net.send(session, {
          t: 'result',
          action: 'constraint',
          ok: false,
          error: 'out_of_range',
        })
        return
      }
      const removed = ctx.world.removeConstraintsFor(target.id)
      ctx.net.send(session, {
        t: 'result',
        action: 'constraint',
        ok: removed.length > 0,
        ...(removed.length === 0 ? { error: 'no_constraints' } : {}),
      })
      for (const rec of removed) ctx.net.broadcastConstraintState(rec, false)
    },
  }

  constructor(private readonly ctx: ServerContext) {}

  /** A player joined: their own offline-friend entry is stale. */
  onJoin(session: PlayerSession): void {
    this.offlineFriendsCache.delete(session.playerId as string)
  }

  /** A player left: keep protection checks fresh, and drop the beam latch (no broadcast). */
  onLeave(session: PlayerSession): void {
    this.offlineFriendsCache.set(session.playerId as string, {
      friends: new Set(session.friends),
      at: Date.now(),
    })
    if (session.held) {
      this.heldEntityIds.delete(session.held.entityId)
      session.held = null
    }
  }

  /**
   * Prop protection: world props (no owner) are free; otherwise the owner
   * or anyone the OWNER trusts may manipulate. Works for offline owners via
   * a TTL-cached repository lookup.
   */
  canManipulate(session: PlayerSession, entity: GameEntity): boolean {
    if (entity.owner === undefined) return true
    if (entity.owner === session.playerId) return true
    const ownerSession = this.ctx.sessions.get(entity.owner)
    if (ownerSession) return ownerSession.friends.has(session.playerId)
    const cached = this.offlineFriendsCache.get(entity.owner)
    if (cached && Date.now() - cached.at < 30_000) {
      return cached.friends.has(session.playerId)
    }
    // Offline owner, no cached answer: start an async load and DENY this tick. The tick never awaits
    // I/O; the cached answer is used from the next tick on (the same 30 s TTL).
    const owner = entity.owner
    if (!this.friendsLoadInFlight.has(owner)) {
      this.friendsLoadInFlight.add(owner)
      void this.ctx.store.players
        .findById(owner)
        .then((found) => {
          this.offlineFriendsCache.set(owner, {
            friends: new Set(found?.friends ?? []),
            at: Date.now(),
          })
        })
        .catch((err: unknown) => {
          this.ctx.log.warn('offline owner lookup failed', { owner, error: String(err) })
        })
        .finally(() => this.friendsLoadInFlight.delete(owner))
    }
    return false
  }

  /** Retry unlatched beams (sweep-to-grab) and drive held bodies. */
  tick(ctx: ServerContext, _dt: number): void {
    for (const session of ctx.sessions.values()) {
      if (session.grabbing && !session.held && equippedTool(session)?.kind === 'physgun') {
        this.attemptGrab(session)
      }
      if (session.held) driveHeld(session, ctx.world)
    }
  }

  private handlePhysgun(session: PlayerSession, msg: ClientPhysgun): void {
    const ctx = this.ctx
    // Physgun actions require the physgun in the active hotbar slot.
    if ((msg.a === 'grab' || msg.a === 'unfreeze') && equippedTool(session)?.kind !== 'physgun') {
      ctx.net.send(session, {
        t: 'result',
        action: 'physgun',
        ok: false,
        error: 'no_physgun_equipped',
      })
      return
    }
    if (msg.a === 'grab') {
      if (session.held) return
      // Beam on: even with nothing under the crosshair, keep trying each
      // tick — sweeping the beam onto a prop picks it up (GMod behavior).
      session.grabbing = true
      const denied = this.attemptGrab(session)
      // Only meaningful denials are surfaced; an empty beam is not an error.
      if (denied && denied !== 'no_target') {
        ctx.net.send(session, { t: 'result', action: 'physgun', ok: false, error: denied })
      }
    } else if (msg.a === 'release') {
      session.grabbing = false
      this.releaseHeld(session)
    } else if (msg.a === 'adjust') {
      adjustDistance(session, msg.dist)
    } else if (msg.a === 'rotate') {
      rotateHeld(session, msg.dyaw, msg.dpitch, msg.snap ?? false, msg.snapStep)
    } else if (msg.a === 'grid') {
      if (session.held) {
        session.held.grid = msg.on
        if (msg.size !== undefined) session.held.gridSize = msg.size
      }
    } else if (msg.a === 'freeze') {
      // Freezing ends the beam — otherwise the sweep-to-grab retry would
      // immediately unfreeze what was just frozen.
      session.grabbing = false
      const frozen = freezeHeld(session, ctx.world)
      if (frozen) {
        this.heldEntityIds.delete(frozen.id)
        ctx.net.broadcastToKnowing(frozen.id, {
          t: 'entity',
          id: frozen.id,
          motion: 'frozen',
          pos: [frozen.transform.pos.x, frozen.transform.pos.y, frozen.transform.pos.z],
          rot: [
            frozen.transform.rot.x,
            frozen.transform.rot.y,
            frozen.transform.rot.z,
            frozen.transform.rot.w,
          ],
        })
        ctx.net.broadcastAll({ t: 'physgun_state', player: session.entityId, target: null })
      }
    } else if (msg.a === 'unfreeze') {
      const entity = ctx.world.entities.get(msg.target as EntityId)
      if (!entity?.prop || entity.prop.motion !== 'frozen') {
        ctx.net.send(session, { t: 'result', action: 'physgun', ok: false, error: 'no_target' })
        return
      }
      if (!ctx.world.zones.rulesAt(entity.transform.pos).physgun) {
        ctx.net.send(session, { t: 'result', action: 'physgun', ok: false, error: 'zone' })
        return
      }
      if (!this.canManipulate(session, entity)) {
        ctx.net.send(session, { t: 'result', action: 'physgun', ok: false, error: 'not_owner' })
        return
      }
      eyePosition(session, _eyeScratch)
      if (
        Math.hypot(
          entity.transform.pos.x - _eyeScratch.x,
          entity.transform.pos.y - _eyeScratch.y,
          entity.transform.pos.z - _eyeScratch.z,
        ) > 10
      ) {
        ctx.net.send(session, { t: 'result', action: 'physgun', ok: false, error: 'out_of_range' })
        return
      }
      ctx.world.setPropMotion(entity, 'dynamic')
      ctx.net.broadcastToKnowing(entity.id, { t: 'entity', id: entity.id, motion: 'dynamic' })
    }
  }

  /** One grab attempt down the view ray; latches + broadcasts on success. */
  private attemptGrab(session: PlayerSession): string | null {
    const grabbed = tryGrab(session, this.ctx.world, this.heldEntityIds, (e) =>
      this.canManipulate(session, e),
    )
    if (typeof grabbed === 'string') return grabbed
    this.heldEntityIds.add(grabbed.id)
    // Grabbing a frozen prop unfreezes it — tell clients about the motion
    // change (physics resumes; frozen visuals must clear).
    this.ctx.net.broadcastToKnowing(grabbed.id, { t: 'entity', id: grabbed.id, motion: 'dynamic' })
    const grab = session.held?.localOffset
    this.ctx.net.broadcastAll({
      t: 'physgun_state',
      player: session.entityId,
      target: grabbed.id,
      ...(grab ? { grab: [grab.x, grab.y, grab.z] as [number, number, number] } : {}),
    })
    return null
  }

  releaseHeld(session: PlayerSession): void {
    const ctx = this.ctx
    if (!session.held) return
    // Wake the released body: if it was driven into a sleeping neighbor,
    // the depenetration solver needs it active to push them apart.
    const bodyId = ctx.world.bodyOf(session.held.entityId)
    if (bodyId !== undefined) {
      ctx.world.physics.wake(bodyId)
      // Source-feel throw cap: the drive can move props at 45 m/s, but a
      // LET-GO should toss, not rocket-launch. Clamp exit velocity.
      ctx.world.physics.getLinearVelocity(bodyId, _relVel)
      const speed = Math.hypot(_relVel.x, _relVel.y, _relVel.z)
      const cap = 9
      if (speed > cap) {
        const k = cap / speed
        _relVel.x *= k
        _relVel.y *= k
        _relVel.z *= k
        ctx.world.physics.setLinearVelocity(bodyId, _relVel)
      }
    }
    this.heldEntityIds.delete(session.held.entityId)
    release(session)
    ctx.net.broadcastAll({ t: 'physgun_state', player: session.entityId, target: null })
  }
}
