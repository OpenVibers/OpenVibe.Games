// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CLIENT_CVARS, CvarRegistry, SOURCE_MOVEMENT_CVARS, type CvarSpec } from './registry.js'

const registry = (): CvarRegistry => new CvarRegistry([...SOURCE_MOVEMENT_CVARS, ...CLIENT_CVARS])

describe('cvar registry', () => {
  it('shows Source values and resolves our names as aliases', () => {
    const cvars = registry()
    expect(cvars.formatValue('sv_gravity')).toBe('800')
    expect(cvars.get('gravity')).toBe(800)
    expect(cvars.canonical('airaccelerate')).toBe('sv_airaccelerate')
    expect(cvars.formatValue('sv_airaccelerate')).toBe('150')
    expect(cvars.formatValue('sv_autobunnyhopping')).toBe('0')
  })

  it('validates types, ranges and readonly flags', () => {
    const cvars = registry()
    expect(cvars.set('sv_airaccelerate', '150').ok).toBe(true)
    expect(cvars.get('sv_airaccelerate')).toBe(150)
    expect(cvars.set('sv_gravity', '-1').ok).toBe(false)
    expect(cvars.set('sv_gravity', 'lots').ok).toBe(false)
    expect(cvars.set('sv_autobunnyhopping', 'on').ok).toBe(true)
    expect(cvars.get('sv_autobunnyhopping')).toBe(true)
    expect(cvars.set('nope', '1').ok).toBe(false)

    const readonly: CvarSpec = {
      name: 'sv_locked',
      type: 'float',
      defaultValue: 1,
      flags: ['server', 'readonly'],
      help: 'locked',
    }
    const locked = new CvarRegistry([readonly])
    expect(locked.set('sv_locked', '2')).toEqual({ ok: false, error: 'sv_locked is read-only' })
    // The server can still replicate it.
    expect(locked.forceSet('sv_locked', 2).ok).toBe(true)
  })

  it('only persists client flags and lets an authoritative map be applied', () => {
    const cvars = registry()
    cvars.set('volume', '0.5')
    cvars.set('cl_interp', '0.05')
    expect(cvars.snapshot((spec) => spec.flags.includes('client'))).toMatchObject({
      volume: 0.5,
      cl_interp: 0.05,
    })
    // A server value overrides the local default but not a client-only setting.
    const changed = cvars.apply({ sv_gravity: 900, volume: 0.2, unknown: 1 })
    expect(changed).toContain('sv_gravity')
    expect(cvars.get('sv_gravity')).toBe(900)
    expect(cvars.get('volume')).toBe(0.5)
  })

  it('searches names, aliases and help, and formats help with units', () => {
    const cvars = registry()
    expect(cvars.find('gravity').map((s) => s.name)).toContain('sv_gravity')
    expect(cvars.find('surf').map((s) => s.name)).toContain('sv_airaccelerate')
    expect(cvars.matching('sv_air')).toContain('sv_airaccelerate')
    const help = cvars.help(cvars.spec('sv_gravity')!)
    expect(help[0]).toBe('sv_gravity = 800 u/s² [float]')
    expect(help.join('\n')).toContain('aliases: gravity')
  })
})
