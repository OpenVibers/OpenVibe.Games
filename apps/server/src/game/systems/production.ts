import { recipeSkill, recipeXp } from '@openvibe/content'
import {
  ambientTemperature,
  completeJob,
  type GameEntity,
  plantProgress,
  plantStage,
  precipitation,
  tryStartJob,
  updatePlant,
  waterPlant,
} from '@openvibe/gameplay'
import type { ClientCraft } from '@openvibe/protocol'
import { handleCraft } from '../interactions.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

export class ProductionSystem implements System {
  readonly name = 'production'

  readonly handlers: HandlerMap = {
    craft: (session, msg: ClientCraft, _conn) => {
      const outcome = handleCraft(
        session,
        this.ctx.world,
        msg,
        this.ctx.clock.tick,
        this.ctx.config.tickRate,
      )
      this.ctx.net.send(session, outcome)
      if (outcome.ok) {
        this.ctx.net.sendInventory(session)
        this.ctx.net.sendCraftState(session)
      }
    },
  }

  constructor(private readonly ctx: ServerContext) {}

  /**
   * Utility + production sweep, once a second over prop entities. Plants
   * stay timestamp-lazy (a slower cadence touches them); machines and
   * generators are few, and their jobs are timestamp-based too — this
   * sweep only notices completions/starts, it never simulates.
   */
  tickProduction(): void {
    const nowMs = Date.now()
    const raining = precipitation(this.ctx.env) > 0
    const ambientC = ambientTemperature(this.ctx.env)
    const content = this.ctx.world.content
    const maxStackOf = (defId: string) => content.item(defId)?.maxStack ?? 1
    // Pass 1: generators burn fuel; remember active ones for power checks.
    const activePower: { x: number; z: number; radius: number }[] = []
    for (const entity of this.ctx.world.entities.ofKind('prop')) {
      if (!entity.prop) continue
      const def = content.item(entity.prop.defId)
      if (!def?.powerProducer) continue
      if ((entity.prop.burnUntil ?? 0) <= nowMs && entity.prop.container) {
        // Reload: burn the first fuel item in the hopper.
        for (let i = 0; i < entity.prop.container.length; i++) {
          const slot = entity.prop.container[i]
          const fuel = slot ? content.item(slot.defId)?.fuel : undefined
          if (!slot || !fuel) continue
          slot.count -= 1
          if (slot.count <= 0) entity.prop.container[i] = null
          entity.prop.burnUntil =
            Math.max(nowMs, entity.prop.burnUntil ?? 0) + fuel.burnSeconds * 1000
          entity.dirty = true
          for (const other of this.ctx.sessions.values()) {
            if (other.openContainer === entity.id) this.ctx.net.sendContainer(other, entity)
          }
          break
        }
      }
      if ((entity.prop.burnUntil ?? 0) > nowMs) {
        activePower.push({
          x: entity.transform.pos.x,
          z: entity.transform.pos.z,
          radius: def.powerProducer.radius,
        })
      }
    }
    const powered = (x: number, z: number): boolean =>
      activePower.some((p) => Math.hypot(p.x - x, p.z - z) <= p.radius)

    // Pass 2: machines complete/start jobs (timestamp-based).
    for (const entity of this.ctx.world.entities.ofKind('prop')) {
      if (!entity.prop?.container) continue
      const def = content.item(entity.prop.defId)
      const machine = def?.machine
      if (!machine) continue
      entity.prop.machine ??= {}
      const shape = { inputSlots: machine.inputSlots, outputSlots: machine.outputSlots }
      let changed = false
      if (
        completeJob(
          entity.prop.machine,
          entity.prop.container,
          shape,
          (id) => content.recipe(id),
          maxStackOf,
          nowMs,
        )
      ) {
        changed = true
      }
      const hasPower =
        !machine.needsPower || powered(entity.transform.pos.x, entity.transform.pos.z)
      if (
        hasPower &&
        tryStartJob(
          entity.prop.machine,
          entity.prop.container,
          shape,
          content.machineRecipes(machine.kind),
          nowMs,
        )
      ) {
        changed = true
      }
      if (changed) {
        entity.dirty = true
        for (const other of this.ctx.sessions.values()) {
          if (other.openContainer === entity.id) this.ctx.net.sendContainer(other, entity)
        }
      }
    }

    // Pass 3 (every 5s): tanks catch rain; sprinklers water nearby planters.
    if (this.ctx.clock.tick % (this.ctx.config.tickRate * 5) === 0) {
      const tanks: { entity: GameEntity; capacity: number }[] = []
      for (const entity of this.ctx.world.entities.ofKind('prop')) {
        const cap = entity.prop ? content.item(entity.prop.defId)?.waterTank : undefined
        if (!entity.prop || !cap) continue
        if (raining && (entity.prop.waterAmount ?? 0) < cap.capacity) {
          entity.prop.waterAmount = Math.min(cap.capacity, (entity.prop.waterAmount ?? 0) + 2.5)
          entity.dirty = true
        }
        tanks.push({ entity, capacity: cap.capacity })
      }
      for (const entity of this.ctx.world.entities.ofKind('prop')) {
        const spr = entity.prop ? content.item(entity.prop.defId)?.sprinkler : undefined
        if (!entity.prop || !spr) continue
        const tank = tanks.find(
          (t) =>
            (t.entity.prop!.waterAmount ?? 0) >= 0.5 &&
            Math.hypot(
              t.entity.transform.pos.x - entity.transform.pos.x,
              t.entity.transform.pos.z - entity.transform.pos.z,
            ) <= spr.tankRange,
        )
        if (!tank) continue
        // Planters via the spatial hash (no all-props walk per sprinkler).
        this.ctx.world.spatial.forEachInRadius(
          entity.transform.pos.x,
          entity.transform.pos.z,
          spr.radius,
          (id) => {
            const planter = this.ctx.world.entities.get(id)
            const plant = planter?.prop?.plant
            if (!planter || !plant) return
            if (
              Math.hypot(
                planter.transform.pos.x - entity.transform.pos.x,
                planter.transform.pos.z - entity.transform.pos.z,
              ) > spr.radius
            ) {
              return
            }
            const crop = content.crop(plant.crop)
            if (!crop) return
            updatePlant(plant, crop, { nowMs, raining, ambientC })
            if ((tank.entity.prop!.waterAmount ?? 0) >= 0.5 && waterPlant(plant)) {
              tank.entity.prop!.waterAmount = (tank.entity.prop!.waterAmount ?? 0) - 0.5
              tank.entity.dirty = true
              planter.dirty = true
            }
          },
        )
      }
    }

    // Pass 4 (every 15s): lazy plant advance + growth-stage broadcasts.
    if (this.ctx.clock.tick % (this.ctx.config.tickRate * 15) !== 0) return
    for (const entity of this.ctx.world.entities.ofKind('prop')) {
      const plant = entity.prop?.plant
      if (!plant) continue
      const crop = content.crop(plant.crop)
      if (!crop) continue
      const beforeStage = plantStage(plant, crop)
      const beforeWater = plant.water
      updatePlant(plant, crop, { nowMs, raining, ambientC })
      entity.dirty = true
      const stageChanged = plantStage(plant, crop) !== beforeStage
      const driedOut = beforeWater > 0 && plant.water <= 0
      if (stageChanged || driedOut) {
        this.ctx.net.broadcastToKnowing(entity.id, {
          t: 'entity',
          id: entity.id,
          plant: { crop: plant.crop, t: plantProgress(plant, crop), water: plant.water },
        })
      }
    }
  }

  tickCraftQueues(): void {
    // 5. Crafting queues (completions grant crafting/construction XP).
    for (const session of this.ctx.sessions.values()) {
      const completed = session.craftQueue.update(
        this.ctx.clock.tick,
        this.ctx.world.content,
        session.inventory,
      )
      if (completed.length > 0) {
        session.dirty = true
        this.ctx.net.sendInventory(session)
        this.ctx.net.sendCraftState(session)
        for (const recipe of completed) {
          const ups = session.skills.addXp(recipeSkill(recipe.category), recipeXp(recipe))
          for (const up of ups) {
            this.ctx.net.send(session, { t: 'levelup', skill: up.skill, level: up.level })
          }
        }
        this.ctx.net.sendSkills(session)
      }
    }
  }
}
