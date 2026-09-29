import type { ClientMessage } from '@openvibe/protocol'
import type { PlayerSession } from '../playerSession.js'
import type { GameConnection, ServerContext } from './context.js'

/**
 * A message handler for ONE client message type. The handler table is keyed by `msg.t`, so a
 * handler registered under `physgun` only ever sees `ClientPhysgun`; it declares that type and the
 * table stores it as {@link MessageHandler}`<never>`. A function taking `never` accepts every
 * narrower parameter type, which is exactly the guarantee the key gives us.
 *
 * `hello` is the one message a connection sends before it has a session, so its handler declares
 * `PlayerSession | undefined` — still assignable here, because the parameter widens.
 */
export type MessageHandler<M extends ClientMessage = ClientMessage> = (
  session: PlayerSession,
  msg: M,
  conn: GameConnection,
) => void

/** What a system registers: message type -> handler. */
export type HandlerMap = Readonly<Record<string, MessageHandler<never>>>

/**
 * One gameplay system (ADR-0007 M1). Systems own their state and reach shared state, other systems
 * and the wire through the ServerContext; no system reads another's private fields.
 */
export interface System {
  /** Stable name, used in duplicate-handler errors and logging. */
  readonly name: string
  /** Message types this system handles; assembled into ONE table by {@link buildHandlerTable}. */
  readonly handlers?: HandlerMap
  /** Per-tick work, called by GameServer.step in the documented order. */
  tick?(ctx: ServerContext, dt: number): void
  /** A session joined the world (after it is registered, before the welcome). */
  onJoin?(session: PlayerSession): void
  /** A session left the world (after it is unregistered, before its entity is despawned). */
  onLeave?(session: PlayerSession): void
}

/**
 * The one place the message handler table is assembled (ADR-0007 M1). A duplicate message type is
 * a startup error: two systems claiming `use` would otherwise silently shadow each other.
 */
export function buildHandlerTable(systems: readonly System[]): Map<string, MessageHandler<never>> {
  const table = new Map<string, MessageHandler<never>>()
  for (const system of systems) {
    for (const [type, handler] of Object.entries(system.handlers ?? {})) {
      if (table.has(type)) {
        throw new Error(`duplicate message handler for "${type}" (${system.name})`)
      }
      table.set(type, handler)
    }
  }
  return table
}
