import { WATER_LEVEL, terrainHeight } from '@openvibe/content'
import { clearStatus, containerAdd, containerSort, eat, type GameEntity } from '@openvibe/gameplay'
import type {
  ClientConsume,
  ClientContainerMove,
  ClientContainerOpen,
  ClientContainerSort,
  ClientDrink,
  ClientDrop,
  ClientEquipArmor,
  ClientHotbarSelect,
  ClientInvMove,
  ClientPlace,
} from '@openvibe/protocol'
import type { EntityId } from '@openvibe/shared'
import { equippedTool, handleDrop, handleInvMove, handlePlace } from '../interactions.js'
import { HOTBAR_SIZE, type PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

/**
 * The player's items: worn armor, the hotbar, consumables, dropped and placed props, and the
 * containers they open and move things through (ADR-0007 M1).
 */
export class InventorySystem implements System {
  readonly name = 'inventory'
  readonly handlers: HandlerMap

  constructor(private readonly ctx: ServerContext) {
    this.handlers = {
      equip_armor: (session, msg: ClientEquipArmor, _conn) => {
        if (msg.slot === undefined) {
          // Unequip into the first free inventory slot.
          if (!session.armor) {
            ctx.net.send(session, { t: 'result', action: 'inv_move', ok: false, error: 'no_armor' })
            return
          }
          if (!session.inventory.addStack(session.armor)) {
            ctx.net.send(session, {
              t: 'result',
              action: 'inv_move',
              ok: false,
              error: 'inventory_full',
            })
            return
          }
          session.armor = null
          session.dirty = true
          ctx.net.send(session, { t: 'result', action: 'inv_move', ok: true })
          ctx.net.sendInventory(session)
          return
        }
        const stack = session.inventory.get(msg.slot)
        const armorDef = stack ? ctx.world.content.item(stack.defId)?.armor : undefined
        if (!stack || !armorDef) {
          ctx.net.send(session, { t: 'result', action: 'inv_move', ok: false, error: 'not_armor' })
          return
        }
        const removed = session.inventory.removeFromSlot(msg.slot, 1)
        if (!removed) return
        // Fresh pieces get their full durability stamped into the stack.
        if (removed.meta?.dur === undefined) {
          removed.meta = { ...removed.meta, dur: armorDef.durability }
        }
        const previous = session.armor
        session.armor = removed
        if (previous) session.inventory.addStack(previous)
        session.dirty = true
        ctx.net.send(session, { t: 'result', action: 'inv_move', ok: true })
        ctx.net.sendInventory(session)
      },
      drop: (session, msg: ClientDrop, _conn) => {
        const { outcome, droppedId } = handleDrop(session, ctx.world, msg)
        ctx.net.send(session, outcome)
        if (outcome.ok) {
          ctx.net.sendInventory(session)
          if (droppedId) {
            const entity = ctx.world.entities.get(droppedId as EntityId)
            if (entity) ctx.net.broadcastSpawn(entity)
          }
        }
      },
      place: (session, msg: ClientPlace, _conn) => {
        const { outcome, placedId } = handlePlace(session, ctx.world, msg)
        ctx.net.send(session, outcome)
        if (outcome.ok) {
          ctx.net.sendInventory(session)
          if (placedId) {
            const entity = ctx.world.entities.get(placedId as EntityId)
            if (entity) ctx.net.broadcastSpawn(entity)
          }
        }
      },
      inv_move: (session, msg: ClientInvMove, _conn) => {
        const outcome = handleInvMove(session, msg)
        ctx.net.send(session, outcome)
        ctx.net.sendInventory(session)
      },
      hotbar: (session, msg: ClientHotbarSelect, _conn) => {
        if (msg.slot < HOTBAR_SIZE) {
          // Re-pressing the active slot holsters/unholsters (empty hands).
          if (msg.slot === session.activeHotbar) {
            session.holstered = !session.holstered
          } else {
            session.activeHotbar = msg.slot
            session.holstered = false
          }
          // Switching away from the physgun drops beam and anything held.
          if (equippedTool(session)?.kind !== 'physgun') {
            session.grabbing = false
            if (session.held) ctx.systems.manipulation.releaseHeld(session)
          }
        }
      },
      consume: (session, msg: ClientConsume, _conn) => {
        const stack = session.inventory.get(msg.slot)
        const def = stack ? ctx.world.content.item(stack.defId) : undefined
        // Blueprints: using one permanently unlocks its recipe.
        if (stack && def?.blueprint) {
          if (session.unlocks.has(def.blueprint.recipe)) {
            ctx.net.send(session, {
              t: 'result',
              action: 'consume',
              ok: false,
              error: 'already_known',
            })
            return
          }
          session.inventory.removeFromSlot(msg.slot, 1)
          session.unlocks.add(def.blueprint.recipe)
          session.dirty = true
          const recipeName = ctx.world.content.recipe(def.blueprint.recipe)?.name ?? 'recipe'
          ctx.net.send(session, { t: 'result', action: 'consume', ok: true })
          ctx.net.send(session, { t: 'announce', text: `📜 Blueprint learned: ${recipeName}!` })
          ctx.net.sendInventory(session)
          ctx.net.sendSkills(session)
          return
        }
        if (!stack || (!def?.food && !def?.medical)) {
          ctx.net.send(session, { t: 'result', action: 'consume', ok: false, error: 'not_food' })
          return
        }
        session.inventory.removeFromSlot(msg.slot, 1)
        if (def.food) eat(session.stats, def.food, Date.now())
        if (def.medical) {
          session.stats.health = Math.min(100, session.stats.health + def.medical.heal)
          if (def.medical.curesBleeding) clearStatus(session.stats, 'bleeding')
        }
        session.statsDirty = true
        session.dirty = true
        ctx.net.send(session, { t: 'result', action: 'consume', ok: true })
        ctx.net.send(session, { t: 'stats', ...ctx.net.statsWire(session) })
        session.statsDirty = false
        ctx.net.sendInventory(session)
      },
      drink: (session, _msg: ClientDrink, _conn) => {
        if (ctx.clock.tick - session.lastUseTick < 15) return
        const ground = terrainHeight(
          ctx.world.content.world,
          session.move.pos.x,
          session.move.pos.z,
        )
        if (ground > WATER_LEVEL - 0.03) {
          ctx.net.send(session, { t: 'result', action: 'consume', ok: false, error: 'no_water' })
          return
        }
        session.lastUseTick = ctx.clock.tick
        // A held watering can fills instead of drinking.
        const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
        const fluidCap = held ? ctx.world.content.item(held.defId)?.fluidContainer : undefined
        if (held && fluidCap) {
          held.meta = { ...held.meta, fluid: fluidCap.capacity }
          session.dirty = true
          ctx.net.send(session, { t: 'result', action: 'consume', ok: true })
          ctx.net.sendInventory(session)
          return
        }
        session.stats.thirst = Math.min(100, session.stats.thirst + 30)
        session.statsDirty = true
        session.dirty = true
        ctx.net.send(session, { t: 'result', action: 'consume', ok: true })
        ctx.net.send(session, { t: 'stats', ...ctx.net.statsWire(session) })
        session.statsDirty = false
      },
      container_open: (session, msg: ClientContainerOpen, _conn) => {
        const entity = ctx.world.entities.get(msg.target as EntityId)
        const denied = this.containerAccessDenied(session, entity)
        if (denied || !entity?.prop?.container) {
          ctx.net.send(session, {
            t: 'result',
            action: 'container',
            ok: false,
            error: denied ?? 'no_container',
          })
          return
        }
        session.openContainer = entity.id
        ctx.net.sendContainer(session, entity)
      },
      container_move: (session, msg: ClientContainerMove, _conn) => {
        const entity = ctx.world.entities.get(msg.target as EntityId)
        const denied = this.containerAccessDenied(session, entity)
        const box = entity?.prop?.container
        if (denied || !entity || !box) {
          ctx.net.send(session, {
            t: 'result',
            action: 'container',
            ok: false,
            error: denied ?? 'no_container',
          })
          return
        }
        const maxStackOf = (defId: string) => ctx.world.content.item(defId)?.maxStack ?? 1
        let ok = false
        if (msg.dir === 'in') {
          const stack = session.inventory.get(msg.slot)
          if (stack) {
            const want = msg.count !== undefined ? Math.min(msg.count, stack.count) : stack.count
            const moved = containerAdd(box, stack.defId, want, maxStackOf)
            if (moved > 0) {
              session.inventory.removeFromSlot(msg.slot, moved)
              ok = true
            }
          }
        } else {
          const slot = box[msg.slot]
          if (slot) {
            const want = msg.count !== undefined ? Math.min(msg.count, slot.count) : slot.count
            const leftover = session.inventory.add(slot.defId, want)
            const moved = want - leftover
            if (moved > 0) {
              slot.count -= moved
              if (slot.count <= 0) box[msg.slot] = null
              ok = true
            }
          }
        }
        if (ok) {
          entity.dirty = true
          session.dirty = true
          ctx.net.sendInventory(session)
          // Push fresh contents to EVERYONE with this container open.
          for (const other of ctx.sessions.values()) {
            if (other.openContainer === entity.id) ctx.net.sendContainer(other, entity)
          }
        } else {
          ctx.net.send(session, { t: 'result', action: 'container', ok: false, error: 'no_space' })
        }
      },
      container_sort: (session, msg: ClientContainerSort, _conn) => {
        const entity = ctx.world.entities.get(msg.target as EntityId)
        const denied = this.containerAccessDenied(session, entity)
        const box = entity?.prop?.container
        if (denied || !entity || !box) {
          ctx.net.send(session, {
            t: 'result',
            action: 'container',
            ok: false,
            error: denied ?? 'no_container',
          })
          return
        }
        containerSort(box, (defId) => ctx.world.content.item(defId)?.maxStack ?? 1)
        entity.dirty = true
        ctx.net.send(session, { t: 'result', action: 'container', ok: true })
        for (const other of ctx.sessions.values()) {
          if (other.openContainer === entity.id) ctx.net.sendContainer(other, entity)
        }
      },
    }
  }

  /** Range + prop-protection gate shared by all container operations. */
  private containerAccessDenied(
    session: PlayerSession,
    entity: GameEntity | undefined,
  ): string | null {
    if (!entity?.prop) return 'no_target'
    const d = Math.hypot(
      entity.transform.pos.x - session.move.pos.x,
      entity.transform.pos.y - session.move.pos.y,
      entity.transform.pos.z - session.move.pos.z,
    )
    if (d > 4.5) return 'out_of_range'
    if (!this.ctx.systems.manipulation.canManipulate(session, entity)) return 'not_owner'
    return null
  }
}
