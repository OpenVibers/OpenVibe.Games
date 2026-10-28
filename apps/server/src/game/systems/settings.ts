/**
 * Server-authoritative console cvars (job 4).
 *
 * The client console may ask, but this system is the only place a `sv_*`
 * value changes. It owns the allowlist: movement cvars from the Source layer
 * in packages/shared, validated by the same registry the client displays, with
 * a rank gate (owner/admin, the same staff permission as map editing).
 *
 * Values are stored in Source units, so `sv_gravity 800` means 800 u/s² on the
 * wire and 20.32 m/s² in the simulation. The movement system asks for the
 * effective params every tick; the client applies the same conversion from the
 * welcome/cvar_state payload.
 */
import {
  movementCvarValues,
  movementParamsFor,
  movementParamsWithCvars,
  movementStyleFor,
  type MovementParams,
} from '@openvibe/gameplay'
import type { ClientCvarSet, ServerCvarState } from '@openvibe/protocol'
import { CvarRegistry, SOURCE_MOVEMENT_CVARS, type CvarValue } from '@openvibe/shared'
import { canEditMap } from '../../net/networkAuth.js'
import type { PlayerSession } from '../playerSession.js'
import type { GameConnection, ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

/** The server may be asked to change only these cvars. */
export const SERVER_CVAR_ALLOWLIST: readonly string[] = SOURCE_MOVEMENT_CVARS.map(
  (spec) => spec.name,
)
const ALLOWED = new Set(SERVER_CVAR_ALLOWLIST)
const SPECS = new Map(SOURCE_MOVEMENT_CVARS.map((spec) => [spec.name, spec]))

/** The same staff gate as map editing: owners and admins, not moderators. */
export function canChangeServerCvars(rank: PlayerSession['rank']): boolean {
  return canEditMap(rank)
}

export class SettingsSystem implements System {
  readonly name = 'settings'
  private readonly overrides = new Map<string, number | boolean>()
  /** Validation only; the authoritative values live in `overrides`. */
  private readonly validator = new CvarRegistry(SOURCE_MOVEMENT_CVARS)

  readonly handlers: HandlerMap = {
    cvar_set: (session, msg: ClientCvarSet, _conn: GameConnection) => this.set(session, msg),
  }

  constructor(private readonly ctx: ServerContext) {}

  private baseParams(): MovementParams {
    return movementParamsFor(movementStyleFor(this.ctx.content.world))
  }

  /** Current effective Source-unit values, including the map preset's defaults. */
  values(base: MovementParams = this.baseParams()): Record<string, number | boolean> {
    const values = movementCvarValues(base)
    for (const [name, value] of this.overrides) values[name] = value
    // Every movement spec is numeric or boolean; movementCvarValues only
    // emits those types because the specs have no string cvars.
    return values as Record<string, number | boolean>
  }

  /** Current simulation params: the preset plus any server cvar overrides. */
  movementParams(base: MovementParams = this.baseParams()): MovementParams {
    return movementParamsWithCvars(base, this.values(base))
  }

  /** The welcome/`cvar_state` payload for one session. */
  writable(rank: PlayerSession['rank']): string[] {
    return canChangeServerCvars(rank) ? [...SERVER_CVAR_ALLOWLIST] : []
  }

  wireFor(rank: PlayerSession['rank']): {
    values: Record<string, number | boolean>
    writable: string[]
  } {
    return { values: this.values(), writable: this.writable(rank) }
  }

  private stateFor(
    session: PlayerSession,
    extra: { requestId?: number; error?: string } = {},
  ): ServerCvarState {
    return {
      t: 'cvar_state',
      values: this.values(),
      writable: this.writable(session.rank),
      ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    }
  }

  private set(session: PlayerSession, msg: ClientCvarSet): void {
    const requestId = msg.requestId
    const fail = (error: string): void => {
      this.ctx.net.send(
        session,
        this.stateFor(session, {
          ...(requestId !== undefined ? { requestId } : {}),
          error,
        }),
      )
    }
    if (!canChangeServerCvars(session.rank)) {
      fail('server cvars need staff permission')
      return
    }
    const name = msg.name.trim().toLowerCase()
    if (!ALLOWED.has(name)) {
      fail(`${name} is not a server cvar; it stays local`)
      return
    }
    const parsed = this.validator.set(name, msg.value as CvarValue)
    if (!parsed.ok) {
      fail(parsed.error ?? `invalid value for ${name}`)
      return
    }
    const spec = SPECS.get(name)
    if (!spec || (typeof parsed.value !== 'number' && typeof parsed.value !== 'boolean')) {
      fail(`${name} is not a server cvar`)
      return
    }
    this.overrides.set(name, parsed.value)
    const values = this.values()
    // A room-wide change: everyone's prediction needs the new numbers.
    for (const peer of this.ctx.sessions.values()) {
      this.ctx.net.send(peer, {
        t: 'cvar_state',
        values,
        writable: this.writable(peer.rank),
        ...(peer === session && requestId !== undefined ? { requestId } : {}),
      })
    }
    this.ctx.log.info('cvar changed', {
      cvar: name,
      value: parsed.value,
      by: session.playerId,
    })
  }
}
