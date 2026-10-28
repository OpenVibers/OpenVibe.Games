import { describe, expect, it } from 'vitest'
import type { ClientCvarSet, ServerMessage } from '@openvibe/protocol'
import type { PlayerSession } from '../playerSession.js'
import type { GameConnection, ServerContext } from './context.js'
import { canChangeServerCvars, SettingsSystem } from './settings.js'

const guest = { rank: null, playerId: 'guest' } as unknown as PlayerSession
const moderator = { rank: 'moderator', playerId: 'mod' } as unknown as PlayerSession
const admin = { rank: 'admin', playerId: 'admin' } as unknown as PlayerSession

function setup() {
  const sent: { to: string; msg: ServerMessage }[] = []
  const sessions = [guest, moderator, admin]
  const ctx = {
    // Surf values: gravity 800 u/s², airaccelerate 150.
    content: { world: { id: 'surf_test', movement: 'surf' } },
    sessions: {
      values: () => sessions[Symbol.iterator](),
    },
    net: {
      send: (session: PlayerSession, msg: ServerMessage) =>
        sent.push({ to: session.playerId, msg }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ServerContext
  const settings = new SettingsSystem(ctx)
  const call = (session: PlayerSession, msg: ClientCvarSet): void =>
    (
      settings.handlers.cvar_set as unknown as (
        s: PlayerSession,
        m: ClientCvarSet,
        c: GameConnection,
      ) => void
    )(session, msg, {} as GameConnection)
  return { settings, sent, call }
}

describe('server-authoritative console cvars', () => {
  it('shows the surf preset in Source units', () => {
    const { settings } = setup()
    expect(settings.values().sv_gravity).toBe(800)
    expect(settings.values().sv_airaccelerate).toBe(150)
    expect(settings.movementParams().gravity).toBeCloseTo(20.32, 9)
  })

  it('refuses a guest without changing a single value', () => {
    const { settings, sent, call } = setup()
    call(guest, { t: 'cvar_set', name: 'sv_gravity', value: 900, requestId: 7 })
    expect(sent).toHaveLength(1)
    const state = sent[0]!.msg
    expect(state.t).toBe('cvar_state')
    if (state.t !== 'cvar_state') return
    expect(state.error).toContain('permission')
    expect(state.values.sv_gravity).toBe(800)
    expect(settings.movementParams().gravity).toBeCloseTo(20.32, 9)
    expect(canChangeServerCvars(guest.rank)).toBe(false)
    expect(canChangeServerCvars(moderator.rank)).toBe(false)
  })

  it('applies an admin change to the room and broadcasts the authoritative values', () => {
    const { settings, sent, call } = setup()
    call(admin, { t: 'cvar_set', name: 'sv_gravity', value: 900, requestId: 9 })
    expect(settings.values().sv_gravity).toBe(900)
    expect(settings.movementParams().gravity).toBeCloseTo(22.86, 9)
    expect(sent.map((s) => s.to).sort()).toEqual(['admin', 'guest', 'mod'])
    const answer = sent.find((s) => s.to === 'admin')!.msg
    if (answer.t !== 'cvar_state') throw new Error('expected cvar_state')
    expect(answer.requestId).toBe(9)
    expect(answer.error).toBeUndefined()
    expect(answer.values.sv_gravity).toBe(900)
    // Another player's copy has the value but not this request's id.
    const peer = sent.find((s) => s.to === 'guest')!.msg
    if (peer.t !== 'cvar_state') throw new Error('expected cvar_state')
    expect(peer.requestId).toBeUndefined()
    expect(peer.writable).toEqual([])
  })

  it('refuses names outside the allowlist and values outside the range', () => {
    const { settings, sent, call } = setup()
    call(admin, { t: 'cvar_set', name: 'cl_interp', value: 0.2, requestId: 1 })
    const badName = sent.at(-1)!.msg
    if (badName.t !== 'cvar_state') throw new Error('expected cvar_state')
    expect(badName.error).toContain('not a server cvar')

    call(admin, { t: 'cvar_set', name: 'sv_gravity', value: 9_999, requestId: 2 })
    const badRange = sent.at(-1)!.msg
    if (badRange.t !== 'cvar_state') throw new Error('expected cvar_state')
    expect(badRange.error).toContain('at most')
    expect(settings.values().sv_gravity).toBe(800)
  })
})
