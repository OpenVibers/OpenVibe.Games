import { describe, expect, it } from 'vitest'
import type { ScriptMod } from '@openvibe/content'
import type { Logger } from '@openvibe/shared'
import {
  ERROR_STRIKES,
  parseIntent,
  ScriptModHost,
  type ScriptIntent,
  type ScriptWorld,
} from './host.js'
import type { Json, ModSandboxFactory, SandboxHostFunctions, SandboxOutcome } from './sandbox.js'

/** A fake engine: each mod's "script" is a host-side function driving the lent `game` functions. */
type FakeScript = (
  game: SandboxHostFunctions,
  hook: string,
  payload: Json,
  cpuMs: number,
  clock: { t: number },
) => SandboxOutcome

function fakeFactory(scripts: Record<string, FakeScript>, clock: { t: number }) {
  const disposed: string[] = []
  const factory: ModSandboxFactory = {
    engine: 'fake',
    async create(spec) {
      const script = scripts[spec.id]
      if (!script) throw new Error(`no script ${spec.id}`)
      return {
        ok: true,
        sandbox: {
          call: (hook, payload, cpuMs) => script(spec.host, hook, payload, cpuMs, clock),
          dispose: () => void disposed.push(spec.id),
        },
      }
    },
  }
  return { factory, disposed }
}

function mod(id: string, budgets?: ScriptMod['budgets']): ScriptMod {
  return {
    format: 'games-quickjs@1',
    id,
    version: '1.0.0',
    entry: `${id}.js`,
    source: '/* fake */',
    hooks: ['onTick', 'onPlayerJoin'],
    ...(budgets ? { budgets } : {}),
  }
}

function recordingWorld(): ScriptWorld & { applied: [string, ScriptIntent][] } {
  const applied: [string, ScriptIntent][] = []
  return {
    applied,
    players: () => [{ id: 'p1', name: 'Ana', pos: [0, 1, 0], yaw: 0 }],
    player: (id) => (id === 'p1' ? { id: 'p1', name: 'Ana', pos: [0, 1, 0], yaw: 0 } : null),
    apply: (modId, intent) => {
      applied.push([modId, intent])
      return null
    },
  }
}

const logs: [string, string, unknown][] = []
const log: Logger = {
  debug: (m, f) => void logs.push(['debug', m, f]),
  info: (m, f) => void logs.push(['info', m, f]),
  warn: (m, f) => void logs.push(['warn', m, f]),
  error: (m, f) => void logs.push(['error', m, f]),
  child: () => log,
}

async function boot(scripts: Record<string, FakeScript>, mods: ScriptMod[]) {
  const clock = { t: 0 }
  const { factory, disposed } = fakeFactory(scripts, clock)
  const host = new ScriptModHost(mods, factory, log, () => clock.t)
  const world = recordingWorld()
  host.bind(world)
  await host.start()
  return { host, world, clock, disposed }
}

describe('ScriptModHost', () => {
  it('applies intents only after the call completes; a failed call changes nothing', async () => {
    const { host, world } = await boot(
      {
        good: (game, hook) => {
          if (hook === 'onTick') game.emit!({ kind: 'announce', text: 'tick' })
          return { ok: true }
        },
        half: (game) => {
          game.emit!({ kind: 'giveItem', playerId: 'p1', item: 'scrap', count: 1 })
          return { ok: false, reason: 'error', message: 'boom after emitting' }
        },
      },
      [mod('good'), mod('half')],
    )
    host.tick(1, 1 / 30)
    expect(world.applied).toEqual([['good', { kind: 'announce', text: 'tick' }]])
    expect(host.status().find((s) => s.id === 'half')).toMatchObject({
      state: 'running',
      failures: { error: 1 },
      intentsApplied: 0,
    })
  })

  it('disables a mod over its cpuMs for this instance and keeps ticking the others', async () => {
    const seen: number[] = []
    const { host, world, disposed } = await boot(
      {
        hog: (_game, _hook, _payload, cpuMs, clock) => {
          clock.t += cpuMs
          return { ok: false, reason: 'cpu', message: 'interrupted' }
        },
        fine: (game, _hook, _payload, cpuMs) => {
          seen.push(cpuMs)
          game.emit!({ kind: 'announce', text: 'still here' })
          return { ok: true }
        },
      },
      [mod('hog', { cpuMs: 3 }), mod('fine')],
    )
    host.tick(1, 1 / 30)
    host.tick(2, 1 / 30)
    const hog = host.status().find((s) => s.id === 'hog')!
    expect(hog).toMatchObject({ state: 'disabled', reason: 'cpu', calls: 1, failures: { cpu: 1 } })
    expect(disposed).toEqual(['hog'])
    expect(seen).toEqual([2, 2]) // the default budget, offered whole each tick
    expect(world.applied).toHaveLength(2)
    expect(logs.some(([l, m]) => l === 'warn' && m === 'script mod disabled')).toBe(true)
  })

  it('shares cpuMs across every call in a tick and disables a mod that spent it', async () => {
    const offered: number[] = []
    const { host } = await boot(
      {
        busy: (_g, _h, _p, cpuMs, clock) => {
          offered.push(cpuMs)
          clock.t += 1.5
          return { ok: true }
        },
      },
      [mod('busy', { cpuMs: 3 })],
    )
    host.tick(1, 1 / 30)
    host.playerJoined({ id: 'p1', name: 'Ana', pos: [0, 1, 0], yaw: 0 })
    expect(offered).toEqual([3, 1.5])
    host.playerJoined({ id: 'p2', name: 'Bo', pos: [0, 1, 0], yaw: 0 })
    expect(host.status()[0]).toMatchObject({ state: 'disabled', reason: 'cpu' })
  })

  it('a throwing mod never throws into the tick, and is disabled after ERROR_STRIKES in a row', async () => {
    const { host } = await boot(
      {
        thrower: () => {
          throw new Error('engine bug')
        },
      },
      [mod('thrower')],
    )
    for (let i = 1; i < ERROR_STRIKES; i++) expect(() => host.tick(i, 1 / 30)).not.toThrow()
    expect(host.status()[0]).toMatchObject({
      state: 'running',
      failures: { error: ERROR_STRIKES - 1 },
    })
    host.tick(ERROR_STRIKES, 1 / 30)
    expect(host.status()[0]).toMatchObject({ state: 'disabled', reason: 'error' })
  })

  it('a mod whose sandbox cannot be created is disabled and the rest load', async () => {
    const { host } = await boot({ ok: () => ({ ok: true }) }, [mod('missing'), mod('ok')])
    expect(host.status().map((s) => [s.id, s.state])).toEqual([
      ['missing', 'disabled'],
      ['ok', 'running'],
    ])
  })

  it('refuses bad intents inside the call and caps intents per call', async () => {
    const errors: string[] = []
    const { host, world } = await boot(
      {
        spam: (game) => {
          for (const bad of [{ kind: 'teleport' }, { kind: 'announce', text: '' }, 'x']) {
            try {
              game.emit!(bad)
            } catch (err) {
              errors.push((err as Error).message)
            }
          }
          try {
            for (let i = 0; i < 100; i++) game.emit!({ kind: 'announce', text: `n${i}` })
          } catch (err) {
            errors.push((err as Error).message)
          }
          return { ok: true }
        },
      },
      [mod('spam')],
    )
    host.tick(1, 1 / 30)
    expect(errors).toHaveLength(4)
    expect(world.applied).toHaveLength(16)
  })

  it('game.emit outside a hook throws', async () => {
    let captured: SandboxHostFunctions | null = null
    const { host } = await boot(
      {
        keep: (game) => {
          captured = game
          return { ok: true }
        },
      },
      [mod('keep')],
    )
    host.tick(1, 1 / 30)
    expect(() => captured!.emit!({ kind: 'announce', text: 'late' })).toThrow(/inside a hook/)
  })
})

describe('parseIntent', () => {
  it('rebuilds the intent from known fields only', () => {
    const raw = JSON.parse(
      '{"kind":"giveItem","playerId":"p1","item":"scrap","count":2,"admin":true,"__proto__":{"polluted":1}}',
    ) as Json
    const intent = parseIntent(raw)
    expect(intent).toEqual({ kind: 'giveItem', playerId: 'p1', item: 'scrap', count: 2 })
    expect(Object.getPrototypeOf(intent)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(parseIntent({ kind: 'giveItem', playerId: 'p1', item: 'scrap', count: 1000 })).toMatch(
      /count/,
    )
  })
})
