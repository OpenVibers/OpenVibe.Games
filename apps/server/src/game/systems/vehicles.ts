import type { GameEntity } from '@openvibe/gameplay'
import { qfromYaw, qrotateVec, v3dist, vec3 } from '@openvibe/shared'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import { applyLookInput } from './movement.js'
import type { System } from './system.js'

const _bodyPosScratch = vec3()
const _vehicleFwdLocal = vec3(0, 0, 1)
const _vehicleFwd = vec3()
const _vehicleForce = vec3()
const _vehicleAng = vec3()
const _vehicleVel = vec3()

export class VehicleSystem implements System {
  readonly name = 'vehicles'

  constructor(private readonly ctx: ServerContext) {}

  /** E on a chassis: mount a valid assembly, or dismount if driving it. */
  useVehicle(session: PlayerSession, chassis: GameEntity): void {
    if (session.driving === chassis.id) {
      this.dismount(session, chassis)
      this.ctx.net.send(session, { t: 'result', action: 'use', ok: true })
      return
    }
    if (session.driving) {
      this.ctx.net.send(session, {
        t: 'result',
        action: 'use',
        ok: false,
        error: 'already_driving',
      })
      return
    }
    const d = v3dist(chassis.transform.pos, session.move.pos)
    if (d > 4) {
      this.ctx.net.send(session, { t: 'result', action: 'use', ok: false, error: 'out_of_range' })
      return
    }
    if (!this.ctx.systems.manipulation.canManipulate(session, chassis)) {
      this.ctx.net.send(session, { t: 'result', action: 'use', ok: false, error: 'not_owner' })
      return
    }
    // Somebody else at the wheel?
    for (const other of this.ctx.sessions.values()) {
      if (other.driving === chassis.id) {
        this.ctx.net.send(session, { t: 'result', action: 'use', ok: false, error: 'seat_taken' })
        return
      }
    }
    // A drivable assembly: >= 2 wheels rigged with axis/motor links.
    const wheels = this.ctx.world.constraintsFor(chassis.id).filter((rec) => {
      if (rec.type !== 'axis' && rec.type !== 'motor') return false
      const otherId = rec.a === chassis.id ? rec.b : rec.a
      const other = this.ctx.world.entities.get(otherId)
      return (
        other?.prop !== undefined &&
        this.ctx.world.content.item(other.prop.defId)?.vehiclePart?.part === 'wheel'
      )
    })
    if (wheels.length < 2) {
      this.ctx.net.send(session, { t: 'result', action: 'use', ok: false, error: 'needs_wheels' })
      return
    }
    // The wheel must turn: frozen carts wake up when mounted.
    if (chassis.prop!.motion !== 'dynamic') this.ctx.world.setPropMotion(chassis, 'dynamic')
    session.driving = chassis.id
    if (session.held) this.ctx.systems.manipulation.releaseHeld(session)
    this.ctx.net.send(session, { t: 'result', action: 'use', ok: true })
    this.ctx.net.send(session, { t: 'announce', text: '🛻 Driving — WASD steers, E dismounts.' })
  }

  dismount(session: PlayerSession, chassis: GameEntity | undefined): void {
    session.driving = null
    if (chassis) {
      // Step off beside the cart.
      const rot = chassis.transform.rot
      const side = qrotateVec(vec3(), rot, vec3(1.4, 0, 0))
      session.move.pos.x = chassis.transform.pos.x + side.x
      session.move.pos.y = chassis.transform.pos.y + 0.8
      session.move.pos.z = chassis.transform.pos.z + side.z
      session.move.vel.x = 0
      session.move.vel.y = 0
      session.move.vel.z = 0
    }
  }

  /**
   * Vehicle drive: intent (WASD) becomes thrust force + steering on the
   * chassis body; wheels roll on their rigged bearings; fuel burns from
   * the trunk like a generator. The rider is carried kinematically.
   */
  driveVehicle(session: PlayerSession): void {
    const chassis = session.driving ? this.ctx.world.entities.get(session.driving) : undefined
    const def = chassis?.prop ? this.ctx.world.content.item(chassis.prop.defId) : undefined
    const part = def?.vehiclePart
    const bodyId = chassis ? this.ctx.world.bodyOf(chassis.id) : undefined
    if (!chassis || !part || bodyId === undefined || chassis.prop!.motion !== 'dynamic') {
      this.dismount(session, chassis)
      return
    }
    // Drain inputs (ack them; the client does not predict while driving).
    let input = session.lastInput
    while (session.inputQueue.length > 0) {
      input = session.inputQueue.shift()!
      session.lastInput = input
      session.lastProcessedSeq = input.seq
      applyLookInput(session, input)
      session.buttons = input.intents
    }
    const nowMs = Date.now()
    // Fuel: burn items from the trunk while driving.
    if ((chassis.prop!.burnUntil ?? 0) <= nowMs && chassis.prop!.container) {
      let reloaded = false
      for (let i = 0; i < chassis.prop!.container.length; i++) {
        const slot = chassis.prop!.container[i]
        const fuel = slot ? this.ctx.world.content.item(slot.defId)?.fuel : undefined
        if (!slot || !fuel) continue
        slot.count -= 1
        if (slot.count <= 0) chassis.prop!.container[i] = null
        chassis.prop!.burnUntil = nowMs + fuel.burnSeconds * 1000
        chassis.dirty = true
        reloaded = true
        for (const other of this.ctx.sessions.values()) {
          if (other.openContainer === chassis.id) this.ctx.net.sendContainer(other, chassis)
        }
        break
      }
      if (!reloaded && input && (input.moveZ !== 0 || input.moveX !== 0)) {
        // Out of fuel: coast only. (A once-per-mount nag would need state;
        // the HUD prompt shows the tank.)
      }
    }
    const fueled = (chassis.prop!.burnUntil ?? 0) > nowMs
    if (input && fueled) {
      this.ctx.world.physics.wake(bodyId)
      // Thrust along the chassis' flat forward.
      qrotateVec(_vehicleFwd, chassis.transform.rot, _vehicleFwdLocal)
      _vehicleFwd.y = 0
      const len = Math.hypot(_vehicleFwd.x, _vehicleFwd.z) || 1
      _vehicleFwd.x /= len
      _vehicleFwd.z /= len
      const power = (part.power ?? 4000) * input.moveZ
      _vehicleForce.x = _vehicleFwd.x * power
      _vehicleForce.y = 0
      _vehicleForce.z = _vehicleFwd.z * power
      if (input.moveZ !== 0) this.ctx.world.physics.applyForce(bodyId, _vehicleForce)
      // Steering: blend yaw angular velocity toward the wheel input.
      this.ctx.world.physics.getAngularVelocity(bodyId, _vehicleAng)
      const steer = -input.moveX * 1.6 * (input.moveZ < 0 ? -1 : 1)
      _vehicleAng.y = _vehicleAng.y + (steer - _vehicleAng.y) * 0.25
      this.ctx.world.physics.setAngularVelocity(bodyId, _vehicleAng)
      // Top speed cap.
      this.ctx.world.physics.getLinearVelocity(bodyId, _vehicleVel)
      const speed = Math.hypot(_vehicleVel.x, _vehicleVel.z)
      const top = part.topSpeed ?? 9
      if (speed > top) {
        const k = top / speed
        _vehicleVel.x *= k
        _vehicleVel.z *= k
        this.ctx.world.physics.setLinearVelocity(bodyId, _vehicleVel)
      }
    }
    // Carry the rider: perch on the chassis, share its velocity.
    session.move.pos.x = chassis.transform.pos.x
    session.move.pos.y = chassis.transform.pos.y + 0.75
    session.move.pos.z = chassis.transform.pos.z
    this.ctx.world.physics.getLinearVelocity(bodyId, _vehicleVel)
    session.move.vel.x = _vehicleVel.x
    session.move.vel.y = _vehicleVel.y
    session.move.vel.z = _vehicleVel.z
    session.move.grounded = true
    session.fallVy = 0
    const body = this.ctx.sessions.bodyOf(session.playerId)
    if (body !== undefined) {
      _bodyPosScratch.x = session.move.pos.x
      _bodyPosScratch.y = session.move.pos.y + 0.15
      _bodyPosScratch.z = session.move.pos.z
      this.ctx.world.physics.setTransform(body, _bodyPosScratch)
    }
    const entity = this.ctx.world.entities.get(session.entityId)
    if (entity) qfromYaw(entity.transform.rot, session.yaw)
    this.ctx.world.spatial.move(session.entityId, session.move.pos.x, session.move.pos.z)
  }
}
