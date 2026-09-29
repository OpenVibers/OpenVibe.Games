/**
 * The gameplay systems (ADR-0007 M1). `gameServer.ts` is the coordinator: it constructs these,
 * assembles their message handlers in one table, and calls their ticks in the documented order.
 * Everything else lives in the file named after the system.
 */
export { ServerContext, SessionRegistry } from './context.js'
export type {
  Clock,
  GameConnection,
  GameIntegrations,
  Lifecycle,
  Net,
  ServerSystems,
} from './context.js'
export { buildHandlerTable } from './system.js'
export type { HandlerMap, MessageHandler, System } from './system.js'

export { SessionsSystem } from './sessions.js'
export { MovementSystem, MOVE, MAX_INPUT_QUEUE } from './movement.js'
export { ReplicationSystem } from './replication.js'
export { ManipulationSystem } from './manipulation.js'
export { CombatSystem } from './combat.js'
export { VehicleSystem } from './vehicles.js'
export { InventorySystem } from './inventory.js'
export { InteractionSystem } from './interaction.js'
export { EconomySystem } from './economy.js'
export { ProductionSystem } from './production.js'
export { NpcSystem } from './npcs.js'
export { SocialSystem } from './social.js'
export { WorldEventSystem } from './worldEvents.js'
export { PersistenceSystem } from './persistence.js'
export { ModSystem } from './mods.js'
export { EditorSystem } from './editor.js'
export { EnvironmentSystem } from './environment.js'
export { PhysicsSystem } from './physics.js'
