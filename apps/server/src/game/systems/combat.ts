import {
  BLEED_SECONDS,
  REP_DELTAS,
  addReputation,
  applyDamage,
  applyStatus,
  canFire,
  causesBleeding,
  mitigate,
  recordShot,
  startReload,
  weaponStateFromMeta,
  weaponStateToMeta,
  type DamageEvent,
  type DamageType,
  type GameEntity,
} from '@openvibe/gameplay'
import { worldSpawn } from '@openvibe/content'
import { CollisionLayer } from '@openvibe/physics'
import {
  encodeServerMessage,
  type ClientAttack,
  type ClientFire,
  type ClientReload,
  type ServerMessage,
} from '@openvibe/protocol'
import { qfromYaw, quat, v3dist, vec3, type EntityId } from '@openvibe/shared'
import { equippedTool } from '../interactions.js'
import { eyePosition, viewDirection, type PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

const _eyeScratch = vec3()
const _fireDir = vec3()
const _fireFrom = vec3()
const _fireTo = vec3()

/**
 * Combat: melee, ranged fire, reload, the single damage sink, prop destruction and respawn. Every
 * death path (NPC melee, bullets, falls, exposure, the void) converges on `damagePlayer`/`respawn`.
 */
export class CombatSystem implements System {
  readonly name = 'combat'

  readonly handlers: HandlerMap = {
    attack: (session, msg: ClientAttack, _conn) => {
      // Swing cooldown: silently drop spam faster than ~5 swings/sec.
      if (this.ctx.clock.tick - session.lastUseTick < 6) return
      const victimSession = this.ctx.sessions.getByEntity(msg.target)
      if (victimSession) {
        this.melee(session, victimSession)
        return
      }
      const propTarget = this.ctx.world.entities.get(msg.target as EntityId)
      if (propTarget?.prop) {
        this.handlePropAttack(session, propTarget)
        return
      }
      if (propTarget?.kind === 'npc') {
        this.handleNpcAttack(session, propTarget)
        return
      }
      this.ctx.net.send(session, { t: 'result', action: 'attack', ok: false, error: 'no_target' })
    },
    fire: (session, _msg: ClientFire, _conn) => {
      this.handleFire(session)
    },
    reload: (session, _msg: ClientReload, _conn) => {
      const ctx = this.ctx
      const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
      const spec = held ? ctx.world.content.item(held.defId)?.rangedWeapon : undefined
      if (!held || !spec) {
        ctx.net.send(session, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
        return
      }
      const state = weaponStateFromMeta(held.meta)
      const available = session.inventory.countOf(spec.ammoItem)
      const took = startReload(state, spec, available, Date.now())
      if (took <= 0) {
        ctx.net.send(session, { t: 'result', action: 'attack', ok: false, error: 'no_ammo' })
        return
      }
      session.inventory.consume([{ item: spec.ammoItem, count: took }])
      held.meta = weaponStateToMeta(state, held.meta)
      session.dirty = true
      ctx.net.send(session, { t: 'result', action: 'attack', ok: true })
      ctx.net.sendInventory(session)
    },
  }

  constructor(private readonly ctx: ServerContext) {}

  /** Melee swing on another player: range + zone PvP rules + tool damage. */
  melee(attacker: PlayerSession, victim: PlayerSession): void {
    const ctx = this.ctx
    const d = Math.hypot(
      victim.move.pos.x - attacker.move.pos.x,
      victim.move.pos.y - attacker.move.pos.y,
      victim.move.pos.z - attacker.move.pos.z,
    )
    const tool = equippedTool(attacker)
    if (tool?.kind === 'physgun') {
      ctx.net.send(attacker, { t: 'result', action: 'use', ok: false, error: 'not_a_weapon' })
      return
    }
    // ANY held item swings; weapon capability > tool power > improvised.
    const heldDef = attacker.holstered
      ? undefined
      : ctx.world.content.item(attacker.inventory.get(attacker.activeHotbar)?.defId ?? '')
    const weapon = heldDef?.weapon
    const range = weapon?.range ?? (tool ? Math.min(tool.range, 3.5) : 2.4)
    if (d > range) {
      ctx.net.send(attacker, { t: 'result', action: 'use', ok: false, error: 'out_of_range' })
      return
    }
    // PvP must be legal where BOTH players stand (no shooting into the city).
    if (
      !ctx.world.zones.rulesAt(attacker.move.pos).pvp ||
      !ctx.world.zones.rulesAt(victim.move.pos).pvp
    ) {
      ctx.net.send(attacker, { t: 'result', action: 'use', ok: false, error: 'safe_zone' })
      return
    }
    attacker.lastUseTick = ctx.clock.tick
    // Swinging costs stamina; an exhausted swing lands soft.
    const exhausted = attacker.stats.stamina < 10
    attacker.stats.stamina = Math.max(0, attacker.stats.stamina - 12)
    attacker.statsDirty = true
    const base = weapon?.damage ?? (tool ? 6 + tool.power * 4 : heldDef ? 5 : 6)
    // Edged tools cut (can open wounds); everything else is blunt.
    const type: DamageType =
      weapon || tool?.kind === 'axe' || tool?.kind === 'pickaxe' ? 'cutting' : 'blunt'
    // Knockback: shove the victim away (replicates through prediction).
    const kx = victim.move.pos.x - attacker.move.pos.x
    const kz = victim.move.pos.z - attacker.move.pos.z
    const kl = Math.hypot(kx, kz) || 1
    victim.move.vel.x += (kx / kl) * 4.5
    victim.move.vel.z += (kz / kl) * 4.5
    victim.move.vel.y += 2.2
    ctx.net.send(attacker, { t: 'result', action: 'use', ok: true })
    this.damagePlayer(attacker, victim, { type, amount: base * (exhausted ? 0.5 : 1) })
  }

  /**
   * Ranged fire: the client sent pure intent — the shot leaves the
   * player's AUTHORITATIVE eye along their AUTHORITATIVE view (from
   * movement inputs) plus server-rolled spread. Magazine, cadence and
   * reload state live in the weapon stack's meta and are validated here.
   */
  private handleFire(session: PlayerSession): void {
    const ctx = this.ctx
    const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
    const spec = held ? ctx.world.content.item(held.defId)?.rangedWeapon : undefined
    if (!held || !spec) {
      ctx.net.send(session, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
      return
    }
    if (!ctx.world.zones.rulesAt(session.move.pos).pvp) {
      ctx.net.send(session, { t: 'result', action: 'attack', ok: false, error: 'safe_zone' })
      return
    }
    const nowMs = Date.now()
    const state = weaponStateFromMeta(held.meta)
    const verdict = canFire(state, spec, nowMs)
    if (verdict !== 'ok') {
      ctx.net.send(session, { t: 'result', action: 'attack', ok: false, error: verdict })
      return
    }
    recordShot(state, nowMs)
    held.meta = weaponStateToMeta(state, held.meta)
    session.dirty = true

    eyePosition(session, _eyeScratch)
    viewDirection(session, _fireDir)
    // Server-rolled spread: deflect the view ray inside the cone.
    const spread = (spec.spreadDeg * Math.PI) / 180
    const dyaw = (Math.random() * 2 - 1) * spread
    const dpitch = (Math.random() * 2 - 1) * spread
    const cosP = Math.cos(dpitch)
    const yaw = Math.atan2(_fireDir.x, _fireDir.z) + dyaw
    const pitch = Math.asin(Math.max(-1, Math.min(1, _fireDir.y))) + dpitch
    _fireDir.x = Math.sin(yaw) * Math.cos(pitch)
    _fireDir.y = Math.sin(pitch)
    _fireDir.z = Math.cos(yaw) * Math.cos(pitch)
    void cosP
    // Start past the shooter's own capsule (raycast cannot exclude bodies).
    _fireFrom.x = _eyeScratch.x + _fireDir.x * 0.6
    _fireFrom.y = _eyeScratch.y + _fireDir.y * 0.6
    _fireFrom.z = _eyeScratch.z + _fireDir.z * 0.6
    _fireTo.x = _fireFrom.x + _fireDir.x * spec.range
    _fireTo.y = _fireFrom.y + _fireDir.y * spec.range
    _fireTo.z = _fireFrom.z + _fireDir.z * spec.range
    const hit = ctx.world.physics.raycast(
      _fireFrom,
      _fireTo,
      CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
    )
    let end = _fireTo
    let landed = false
    if (hit) {
      end = hit.point
      // Player hit?
      let victim: PlayerSession | null = null
      for (const other of ctx.sessions.values()) {
        if (ctx.sessions.bodyOf(other.playerId) === hit.bodyId) {
          victim = other
          break
        }
      }
      if (victim && victim !== session) {
        if (ctx.world.zones.rulesAt(victim.move.pos).pvp) {
          landed = true
          this.damagePlayer(session, victim, {
            type: 'projectile',
            amount: spec.damage,
            sourceId: session.entityId as string,
          })
        }
      } else if (!victim) {
        const entity = ctx.world.entityOfBody(hit.bodyId)
        if (entity?.kind === 'npc') {
          landed = this.applyNpcDamage(session, entity, spec.damage)
        } else if (entity?.prop && ctx.world.content.item(entity.prop.defId)?.health) {
          landed = this.applyPropDamage(entity, spec.damage, 'projectile')
        }
      }
    }
    ctx.systems.npcs.recordSound(session.move.pos.x, session.move.pos.z)
    ctx.net.send(session, { t: 'result', action: 'attack', ok: true })
    const tracer: ServerMessage = {
      t: 'tracer',
      shooter: session.entityId as string,
      from: [_fireFrom.x, _fireFrom.y, _fireFrom.z],
      to: [end.x, end.y, end.z],
      hit: landed,
    }
    const encoded = encodeServerMessage(tracer)
    for (const other of ctx.sessions.values()) {
      if (other === session || other.known.has(session.entityId)) ctx.net.sendRaw(other, encoded)
    }
    ctx.net.sendInventory(session)
  }

  /**
   * The one place player damage lands: armor mitigation (with durability
   * wear), wound statuses, death handling, and hit feedback. Melee, bullets
   * and future explosions all converge here.
   */
  damagePlayer(attacker: PlayerSession | null, victim: PlayerSession, event: DamageEvent): void {
    const ctx = this.ctx
    const armorDef = victim.armor ? ctx.world.content.item(victim.armor.defId)?.armor : undefined
    const damage = mitigate(event, armorDef ? { reduction: armorDef.reduction } : null)
    // Armor wears: every mitigated hit costs a point of durability.
    if (victim.armor && armorDef && damage < event.amount) {
      const dur = Number(victim.armor.meta?.dur ?? armorDef.durability) - 1
      if (dur <= 0) {
        victim.armor = null
        ctx.net.send(victim, { t: 'announce', text: '🧥 Your armor fell apart!' })
      } else {
        victim.armor.meta = { ...victim.armor.meta, dur }
      }
      ctx.net.sendInventory(victim)
    }
    if (causesBleeding(event.type, damage)) {
      applyStatus(victim.stats, 'bleeding', BLEED_SECONDS, Date.now())
    }
    const died = applyDamage(victim.stats, damage)
    victim.statsDirty = true
    victim.dirty = true
    ctx.net.send(victim, {
      t: 'stats',
      ...ctx.net.statsWire(victim),
      ...(died ? { died: true } : {}),
    })
    victim.statsDirty = false
    ctx.net.broadcastToKnowing(victim.entityId, {
      t: 'fx',
      kind: died ? 'death' : 'hurt',
      id: victim.entityId as string,
    })
    if (died) {
      ctx.log.info('player killed', {
        victim: victim.playerId,
        attacker: attacker?.playerId ?? 'world',
        type: event.type,
      })
      this.respawn(victim, true)
    }
  }

  /**
   * Melee swing on a damageable prop: range + zone build rules + the same
   * stamina/cooldown economics as PvP. Structures are only destructible
   * where building is legal (safe city props are untouchable).
   */
  private handlePropAttack(attacker: PlayerSession, entity: GameEntity): void {
    const ctx = this.ctx
    const def = entity.prop ? ctx.world.content.item(entity.prop.defId) : undefined
    const cap = def?.health
    if (!entity.prop || !cap) {
      ctx.net.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'not_damageable' })
      return
    }
    const tool = equippedTool(attacker)
    if (tool?.kind === 'physgun') {
      ctx.net.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
      return
    }
    const heldDef = attacker.holstered
      ? undefined
      : ctx.world.content.item(attacker.inventory.get(attacker.activeHotbar)?.defId ?? '')
    const weapon = heldDef?.weapon
    const range = weapon?.range ?? (tool ? Math.min(tool.range, 3.5) : 2.4)
    eyePosition(attacker, _eyeScratch)
    if (v3dist(_eyeScratch, entity.transform.pos) > range + 1) {
      ctx.net.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'out_of_range' })
      return
    }
    if (!ctx.world.zones.rulesAt(entity.transform.pos).build) {
      ctx.net.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'safe_zone' })
      return
    }
    attacker.lastUseTick = ctx.clock.tick
    const exhausted = attacker.stats.stamina < 10
    attacker.stats.stamina = Math.max(0, attacker.stats.stamina - 12)
    attacker.statsDirty = true
    const base = weapon?.damage ?? (tool ? 6 + tool.power * 4 : heldDef ? 5 : 6)
    ctx.net.send(attacker, { t: 'result', action: 'attack', ok: true })
    this.applyPropDamage(entity, base * (exhausted ? 0.5 : 1), 'blunt')
  }

  /** Melee swing on an NPC: reach + the shared stamina economics. */
  private handleNpcAttack(attacker: PlayerSession, entity: GameEntity): void {
    const ctx = this.ctx
    const tool = equippedTool(attacker)
    if (tool?.kind === 'physgun') {
      ctx.net.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
      return
    }
    const heldDef = attacker.holstered
      ? undefined
      : ctx.world.content.item(attacker.inventory.get(attacker.activeHotbar)?.defId ?? '')
    const weapon = heldDef?.weapon
    const range = weapon?.range ?? (tool ? Math.min(tool.range, 3.5) : 2.4)
    eyePosition(attacker, _eyeScratch)
    if (v3dist(_eyeScratch, entity.transform.pos) > range + 1) {
      ctx.net.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'out_of_range' })
      return
    }
    attacker.lastUseTick = ctx.clock.tick
    const exhausted = attacker.stats.stamina < 10
    attacker.stats.stamina = Math.max(0, attacker.stats.stamina - 12)
    attacker.statsDirty = true
    const base = weapon?.damage ?? (tool ? 6 + tool.power * 4 : heldDef ? 5 : 6)
    ctx.net.send(attacker, { t: 'result', action: 'attack', ok: true })
    this.applyNpcDamage(attacker, entity, base * (exhausted ? 0.5 : 1))
  }

  /** NPC damage sink: aggro marking, death, loot scatter, feedback. */
  private applyNpcDamage(
    attacker: PlayerSession | null,
    entity: GameEntity,
    amount: number,
  ): boolean {
    const ctx = this.ctx
    const nowMs = Date.now()
    const result = ctx.systems.npcs.damage(entity.id, amount, nowMs)
    if (result === null) return false
    // Defensive NPCs (wardens) now treat this player as hostile for a while.
    if (attacker) ctx.systems.npcs.markAggro(attacker.entityId as string, nowMs + 45_000)
    if (result === 'hurt') {
      ctx.net.broadcastToKnowing(entity.id, { t: 'fx', kind: 'hurt', id: entity.id as string })
      return true
    }
    // Death: scatter loot rolls as physical props. The entity was already
    // dematerialized; interest diffs despawn it on the next snapshot.
    const state = ctx.systems.npcs.npcStateOf(entity.id)
    const arch = state ? ctx.world.content.npc(state.archetype) : undefined
    const around = entity.transform.pos
    ctx.net.broadcastToKnowing(entity.id, { t: 'fx', kind: 'death', id: entity.id as string })
    let slot = 0
    for (const loot of arch?.loot ?? []) {
      if (Math.random() > loot.chance) continue
      const angle = slot * 1.6
      slot++
      const spawned = ctx.world.spawnProp({
        defId: loot.item,
        pos: vec3(
          around.x + Math.cos(angle) * 0.4,
          around.y + 0.3,
          around.z + Math.sin(angle) * 0.4,
        ),
        rot: qfromYaw(quat(), angle),
        motion: 'dynamic',
        lootCount: loot.count,
        velocity: vec3(Math.cos(angle) * 1.2, 1.5, Math.sin(angle) * 1.2),
      })
      ctx.net.broadcastSpawn(spawned)
    }
    if (attacker && arch) {
      addReputation(attacker.reputation, arch.faction, REP_DELTAS.killMember)
      // Kill contracts count matching archetypes.
      const job = attacker.activeJob ? ctx.world.content.job(attacker.activeJob.job) : undefined
      if (
        attacker.activeJob &&
        job?.objective.kind === 'kill' &&
        job.objective.archetype === arch.id &&
        attacker.activeJob.progress < job.objective.count
      ) {
        attacker.activeJob.progress++
        ctx.net.send(attacker, {
          t: 'announce',
          text: `📋 ${job.name}: ${attacker.activeJob.progress}/${job.objective.count}`,
        })
        ctx.systems.economy.sendJobs(attacker, job.market)
      }
      attacker.dirty = true
      ctx.systems.economy.sendReputation(attacker)
    }
    ctx.log.info('npc killed', {
      archetype: arch?.id ?? 'unknown',
      by: attacker?.playerId ?? 'world',
    })
    return true
  }

  /** Damage application for props: resistance, destruction, feedback.
   * Returns false when the prop has no health capability. */
  private applyPropDamage(entity: GameEntity, rawAmount: number, _type: DamageType): boolean {
    const ctx = this.ctx
    const cap = entity.prop ? ctx.world.content.item(entity.prop.defId)?.health : undefined
    if (!entity.prop || !cap) return false
    if (!ctx.world.zones.rulesAt(entity.transform.pos).build) return false
    entity.prop.health = (entity.prop.health ?? cap.max) - rawAmount * cap.resistance
    entity.dirty = true
    if (entity.prop.health <= 0) {
      this.destroyProp(entity)
      return true
    }
    ctx.net.broadcastToKnowing(entity.id, {
      t: 'entity',
      id: entity.id,
      health: Math.round(entity.prop.health),
    })
    ctx.net.broadcastToKnowing(entity.id, { t: 'fx', kind: 'hurt', id: entity.id as string })
    return true
  }

  /** Destruction: scatter salvage + stored contents as physical props. */
  private destroyProp(entity: GameEntity): void {
    const ctx = this.ctx
    const def = entity.prop ? ctx.world.content.item(entity.prop.defId) : undefined
    const drops: { defId: string; count: number }[] = []
    for (const loot of def?.health?.destroyLoot ?? []) {
      drops.push({ defId: loot.item, count: loot.count })
    }
    // A destroyed container spills everything it held.
    for (const slot of entity.prop?.container ?? []) {
      if (slot) drops.push({ defId: slot.defId, count: slot.count })
    }
    const around = entity.transform.pos
    ctx.world.despawn(entity.id)
    ctx.net.broadcastDespawn(entity.id)
    for (const [i, drop] of drops.entries()) {
      if (!ctx.world.content.item(drop.defId)) continue
      const angle = (i / Math.max(drops.length, 1)) * Math.PI * 2
      const spawned = ctx.world.spawnProp({
        defId: drop.defId,
        pos: vec3(
          around.x + Math.cos(angle) * 0.4,
          around.y + 0.4,
          around.z + Math.sin(angle) * 0.4,
        ),
        rot: qfromYaw(quat(), angle),
        motion: 'dynamic',
        lootCount: drop.count,
        velocity: vec3(Math.cos(angle) * 1.5, 2, Math.sin(angle) * 1.5),
      })
      ctx.net.broadcastSpawn(spawned)
    }
    ctx.log.info('prop destroyed', { def: def?.id ?? 'unknown', drops: drops.length })
  }

  /** Death/rescue respawn: back to the city with restored vitals. */
  respawn(session: PlayerSession, died: boolean): void {
    const ctx = this.ctx
    const spawn = worldSpawn(ctx.world.content.world).pos
    // Risk made real: UNSECURED valuables drop where you fell, in a bag
    // anyone can loot. Secured loot and ordinary gear stay with you.
    if (died) {
      const dropped = session.inventory.takeUnsecuredValuables(
        (defId) => ctx.world.content.item(defId)?.valuable !== undefined,
      )
      if (dropped.length > 0) {
        const bag = ctx.world.spawnProp({
          defId: 'loot_bag',
          pos: vec3(session.move.pos.x, session.move.pos.y + 0.4, session.move.pos.z),
          rot: qfromYaw(quat(), session.yaw),
          motion: 'dynamic',
        })
        if (bag.prop?.container) {
          for (let i = 0; i < dropped.length && i < bag.prop.container.length; i++) {
            bag.prop.container[i] = { defId: dropped[i]!.defId, count: dropped[i]!.count }
          }
        }
        ctx.net.broadcastSpawn(bag)
        ctx.net.send(session, { t: 'announce', text: '💀 Your unsecured loot hit the dirt.' })
      }
    }
    session.move.pos.x = spawn[0]
    session.move.pos.y = spawn[1]
    session.move.pos.z = spawn[2]
    session.move.vel.x = 0
    session.move.vel.y = 0
    session.move.vel.z = 0
    if (died) {
      session.stats.health = 60
      session.stats.hunger = Math.max(session.stats.hunger, 40)
      session.stats.thirst = Math.max(session.stats.thirst, 40)
      session.statsDirty = true
      ctx.net.send(session, { t: 'stats', ...ctx.net.statsWire(session), died: true })
      session.statsDirty = false
    }
    session.dirty = true
  }
}
