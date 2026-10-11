/**
 * The QuickJS sandbox against real scripts: escapes, budgets, and the host
 * driving it end to end. Timings use generous slack (software CI) but stay far
 * below what an unbounded script would take.
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { ScriptMod } from '@openvibe/content'
import type { Logger } from '@openvibe/shared'
import { openTestStore } from '@openvibe/persistence/testing'
import { ScriptModHost, type ScriptIntent, type ScriptPlayer, type ScriptWorld } from './host.js'
import { createQuickJsSandboxFactory } from './quickjs.js'
import { PgScriptStorage } from './storage.js'
import type { Json, ModSandbox, SandboxHostFunctions, SandboxSpec } from './sandbox.js'

const factory = createQuickJsSandboxFactory()
const MB = 1024 * 1024

async function sandbox(
  source: string,
  host: SandboxHostFunctions = {},
  limits: Partial<SandboxSpec['limits']> = {},
): Promise<ModSandbox> {
  const made = await factory.create({
    id: 'test',
    filename: 'test.js',
    source,
    limits: { memoryBytes: 8 * MB, stackBytes: 128 * 1024, ...limits },
    loadCpuMs: 200,
    host,
  })
  if (!made.ok) throw new Error(`load failed: ${made.reason} ${made.message}`)
  return made.sandbox
}

/** A sandbox whose `report(v)` collects values, for scripts that answer questions. */
async function asking(source: string): Promise<{ box: ModSandbox; answers: Json[] }> {
  const answers: Json[] = []
  const box = await sandbox(source, { report: (v) => void answers.push(v ?? null) })
  return { box, answers }
}

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
}

describe('QuickJS sandbox: escapes', () => {
  it('exposes no require, process, timers, module system or host objects', async () => {
    const { box, answers } = await asking(`
      function onTick() {
        const names = ['require', 'process', 'module', 'exports', '__dirname', 'global', 'Buffer',
          'setTimeout', 'setInterval', 'setImmediate', 'fetch', 'XMLHttpRequest', 'WebSocket',
          'std', 'os', 'scriptArgs', 'print', 'Deno', 'Bun', 'WebAssembly'];
        game.report(names.filter((n) => typeof globalThis[n] !== 'undefined'));
        // The Function constructor reaches this context's global, never the host's.
        game.report(Function('return typeof process')());
        game.report(game.report.constructor('return typeof require')());
        // Everything on the global that is not a language intrinsic.
        game.report(Object.getOwnPropertyNames(globalThis).filter((n) => /^[a-z_$]/.test(n) && ![
          'globalThis', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
          'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval', 'undefined', 'onTick',
          'game'].includes(n)));
        // The lent object is frozen and cannot be replaced.
        try { game.report = null } catch (e) {}
        try { globalThis.game = {} } catch (e) {}
        game.report([Object.isFrozen(game), typeof game.report]);
      }`)
    expect(box.call('onTick', null, 100)).toEqual({ ok: true })
    expect(answers).toEqual([[], 'undefined', 'undefined', [], [true, 'function']])
    box.dispose()
  })

  it('cannot pollute host prototypes or reach host objects through the bridge', async () => {
    const seen: Json[] = []
    const box = await sandbox(
      `function onTick() {
        Object.prototype.polluted = 'yes';
        Array.prototype.push = function () { return 'hijacked' };
        JSON.parse = function () { return { admin: true } };
        const got = game.echo({ __proto__: { admin: true }, constructor: { prototype: { admin: true } } });
        game.echo(JSON.stringify(Object.keys(got)));
      }`,
      { echo: (v) => (seen.push(v ?? null), v ?? null) },
    )
    expect(box.call('onTick', null, 100)).toEqual({ ok: true })
    const plain: Record<string, unknown> = {}
    expect(plain.polluted).toBeUndefined()
    expect(plain.admin).toBeUndefined()
    const host: number[] = []
    expect(host.push(1)).toBe(1)
    expect(JSON.parse('{}')).toEqual({})
    // Only data arrived, as fresh host objects with the host's own prototype.
    expect(Object.getPrototypeOf(seen[0])).toBe(Object.prototype)
    expect((seen[0] as Record<string, unknown>).admin).toBeUndefined()
    box.dispose()
  })

  it("cannot read or change another mod's state", async () => {
    const a = await asking(`
      globalThis.secret = 'a-only';
      Object.prototype.leak = 'from a';
      function onTick() { game.report([typeof secret, ({}).leak ?? null]) }`)
    const b = await asking(`
      function onTick() {
        game.report([typeof secret, ({}).leak ?? null, typeof globalThis.onTick]);
      }`)
    expect(b.box.call('onTick', null, 100)).toEqual({ ok: true })
    expect(a.box.call('onTick', null, 100)).toEqual({ ok: true })
    expect(b.answers).toEqual([['undefined', null, 'function']])
    expect(a.answers).toEqual([['string', 'from a']])
    a.box.dispose()
    b.box.dispose()
  })
})

describe('QuickJS sandbox: budgets', () => {
  it('stops an infinite loop within its cpuMs', async () => {
    const box = await sandbox('function onTick() { for (;;) {} }')
    const started = performance.now()
    const outcome = box.call('onTick', null, 5)
    const took = performance.now() - started
    expect(outcome).toMatchObject({ ok: false, reason: 'cpu' })
    expect(took).toBeLessThan(5 + 100)
    box.dispose()
  })

  it('stops a promise-job loop, even one that swallows the interrupt, within the same cpuMs', async () => {
    for (const source of [
      'function onTick() { const spin = () => Promise.resolve().then(spin); spin() }',
      'function onTick() { const spin = () => Promise.resolve().then(spin, spin); spin() }',
      'async function onTick() { for (;;) {} }',
    ]) {
      const box = await sandbox(source)
      const started = performance.now()
      expect(box.call('onTick', null, 5)).toMatchObject({ ok: false, reason: 'cpu' })
      expect(performance.now() - started).toBeLessThan(5 + 100)
      box.dispose()
    }
  })

  it('stops an allocation bomb at memoryMb, even one that catches the error', async () => {
    for (const source of [
      'function onTick() { const keep = []; for (;;) keep.push(new Array(1 << 16).fill(1.5)) }',
      'function onTick() { const keep = []; for (;;) keep.push({ n: keep.length }) }',
      `function onTick() {
        const keep = [];
        try { for (;;) keep.push(new Float64Array(1 << 16)) } catch (e) { keep.length = 0 }
      }`,
    ]) {
      const box = await sandbox(source, {}, { memoryBytes: 4 * MB })
      expect(box.call('onTick', null, 2000)).toMatchObject({ ok: false, reason: 'memory' })
      box.dispose()
    }
  })

  it('refuses a single allocation larger than memoryMb', async () => {
    const box = await sandbox(
      'function onTick() { new Float64Array(1 << 20) }',
      {},
      {
        memoryBytes: 4 * MB,
      },
    )
    expect(box.call('onTick', null, 100)).toMatchObject({ ok: false, reason: 'memory' })
    box.dispose()
  })

  it("survives an engine path that exhausts the host's own stack, as a fatal stack breach", async () => {
    const other = await asking('function onTick() { game.report("still here") }')
    const box = await sandbox(
      'function onTick() { let a = []; for (let i = 0; i < 1e5; i++) a = [a]; JSON.stringify(a) }',
      {},
      { memoryBytes: 32 * MB },
    )
    expect(box.call('onTick', null, 2000)).toMatchObject({
      ok: false,
      reason: 'stack',
      fatal: true,
    })
    expect(box.call('onTick', null, 100)).toMatchObject({ ok: false, fatal: true })
    expect(() => box.dispose()).not.toThrow()
    expect(other.box.call('onTick', null, 100)).toEqual({ ok: true })
    expect(other.answers).toEqual(['still here'])
    other.box.dispose()
  })

  it('stops runaway recursion at the stack limit', async () => {
    const box = await sandbox('function onTick() { const f = (n) => f(n + 1) + 1; f(0) }')
    expect(box.call('onTick', null, 2000)).toMatchObject({ ok: false, reason: 'stack' })
    box.dispose()
  })

  it('reports a top-level infinite loop as a load failure', async () => {
    const made = await factory.create({
      id: 'boot-loop',
      filename: 'boot-loop.js',
      source: 'while (true) {}',
      limits: { memoryBytes: 8 * MB, stackBytes: 128 * 1024 },
      loadCpuMs: 10,
      host: {},
    })
    expect(made).toMatchObject({ ok: false, reason: 'cpu' })
  })
})

describe('ScriptModHost on QuickJS', () => {
  const base = { format: 'games-quickjs@1', version: '1.0.0', hooks: ['onTick'] } as const
  const scriptMod = (id: string, source: string, extra: Partial<ScriptMod> = {}): ScriptMod => ({
    ...base,
    hooks: [...base.hooks],
    id,
    entry: `${id}.js`,
    source,
    ...extra,
  })

  it('omits ungranted bindings and replaces Math.random with seeded game.random', async () => {
    const answers: Json[] = []
    const make = (seed: string) =>
      new ScriptModHost(
        [
          scriptMod(
            'caps',
            `function onTick() {
        game.log(typeof game.players, typeof game.emit, typeof game.storage,
          game.random(), Math.random());
      }`,
            { capabilities: ['players.read', 'world.emit', 'storage.kv'] },
          ),
        ],
        factory,
        {
          ...quiet,
          info: (_message, fields) => {
            if (fields && typeof fields === 'object' && 'text' in fields)
              answers.push(String(fields.text))
          },
        },
        undefined,
        { placeSeed: seed, grants: { caps: ['players.read'] } },
      )
    const a = make('place-a')
    await a.start()
    a.tick(1, 1 / 30)
    a.dispose()
    const b = make('place-a')
    await b.start()
    b.tick(1, 1 / 30)
    b.dispose()
    const c = make('place-b')
    await c.start()
    c.tick(1, 1 / 30)
    c.dispose()
    expect(answers[0]).toBe(answers[1])
    expect(answers[2]).not.toBe(answers[0])
    expect(String(answers[0])).toMatch(/^function undefined undefined /)
    const numbers = String(answers[0]).split(' ').slice(-2)
    expect(numbers[0]).not.toBe(numbers[1])
  })

  it('loads a relative module import and calls an exported hook', async () => {
    const seen: Json[] = []
    const made = await factory.create({
      id: 'modules',
      filename: 'main.js',
      source: 'import { value } from "./lib.js"; export function onTick() { game.report(value) }',
      files: {
        'main.js':
          'import { value } from "./lib.js"; export function onTick() { game.report(value) }',
        'lib.js': 'export const value = 17',
      },
      hooks: ['onTick'],
      host: {
        report: (value) => {
          seen.push(value ?? null)
          return undefined
        },
      },
      limits: { memoryBytes: 8 * MB, stackBytes: 128 * 1024 },
      loadCpuMs: 200,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.sandbox.call('onTick', null, 100)).toEqual({ ok: true })
    expect(seen).toEqual([17])
    made.sandbox.dispose()
  })

  it('keeps storage through reload and a new host on the same database; failed reload keeps old code', async () => {
    const store = await openTestStore()
    const storage = new PgScriptStorage(store.mods, store.placeId, quiet)
    const code = (step: number) => `function onTick() {
      game.storage.set('count', (game.storage.get('count') || 0) + ${step});
    }`
    const make = (source: string, backing = storage) =>
      new ScriptModHost(
        [scriptMod('persist', source, { capabilities: ['storage.kv'] })],
        factory,
        quiet,
        undefined,
        { placeSeed: 'place', grants: { persist: ['storage.kv'] }, storage: backing },
      )
    const host = make(code(1))
    await host.start()
    host.tick(1, 1 / 30)
    const failed = await host.reload(
      scriptMod('persist', 'function onTick( {', { capabilities: ['storage.kv'] }),
      ['storage.kv'],
    )
    expect(failed.ok).toBe(false)
    host.tick(2, 1 / 30)
    expect(
      (
        await host.reload(scriptMod('persist', code(3), { capabilities: ['storage.kv'] }), [
          'storage.kv',
        ])
      ).ok,
    ).toBe(true)
    host.tick(3, 1 / 30)
    await host.flushWrites()
    host.dispose()
    expect(await store.mods.storage('persist', store.placeId)).toEqual({ count: 5 })
    const restarted = make(code(1), new PgScriptStorage(store.mods, store.placeId, quiet))
    await restarted.start()
    restarted.tick(1, 1 / 30)
    await restarted.flushWrites()
    restarted.dispose()
    expect(await store.mods.storage('persist', store.placeId)).toEqual({ count: 6 })
  })

  function world(): ScriptWorld & { applied: ScriptIntent[]; ana: ScriptPlayer } {
    const ana: ScriptPlayer = { id: 'p1', name: 'Ana', pos: [1, 2, 3], yaw: 0 }
    const applied: ScriptIntent[] = []
    return {
      ana,
      applied,
      players: () => [ana],
      player: (id) => (id === ana.id ? ana : null),
      apply: (_mod, intent) => {
        applied.push(intent)
        if (intent.kind === 'giveItem') ana.name = `${ana.name}+${intent.count}${intent.item}`
        return null
      },
    }
  }

  it('a valid mod changes game state through intents only', async () => {
    const w = world()
    const host = new ScriptModHost(
      [
        scriptMod(
          'gifts',
          `function onTick(e) {
            const [p] = game.players();
            p.name = 'renamed in the sandbox';   // a copy: changes nothing outside
            p.pos[0] = 999;
            game.emit({ kind: 'giveItem', playerId: p.id, item: 'scrap', count: 2 });
            game.log('gave scrap on tick', e.tick);
          }`,
        ),
      ],
      factory,
      quiet,
    )
    host.bind(w)
    await host.start()
    host.tick(7, 1 / 30)
    expect(w.applied).toEqual([{ kind: 'giveItem', playerId: 'p1', item: 'scrap', count: 2 }])
    expect(w.ana).toEqual({ id: 'p1', name: 'Ana+2scrap', pos: [1, 2, 3], yaw: 0 })
    expect(host.status()[0]).toMatchObject({ state: 'running', intentsApplied: 1 })
    host.dispose()
  })

  it('a throwing or runaway mod does not stop the tick or the other mods', async () => {
    const w = world()
    const host = new ScriptModHost(
      [
        scriptMod('thrower', 'function onTick() { throw new TypeError("nope") }'),
        scriptMod('looper', 'function onTick() { for (;;) {} }', { budgets: { cpuMs: 3 } }),
        scriptMod(
          'bomb',
          'function onTick() { const k = []; for (;;) k.push(new Array(65536).fill(0)) }',
          {
            budgets: { memoryMb: 4, cpuMs: 10 },
          },
        ),
        scriptMod('steady', 'function onTick() { game.emit({ kind: "announce", text: "ok" }) }'),
      ],
      factory,
      quiet,
    )
    host.bind(w)
    await host.start()
    expect(() => {
      host.tick(1, 1 / 30)
      host.tick(2, 1 / 30)
    }).not.toThrow()
    const byId = Object.fromEntries(host.status().map((s) => [s.id, s]))
    expect(byId.thrower).toMatchObject({ state: 'running', failures: { error: 2 } })
    expect(byId.looper).toMatchObject({ state: 'disabled', reason: 'cpu' })
    expect(byId.bomb).toMatchObject({ state: 'disabled', reason: 'memory' })
    expect(byId.steady).toMatchObject({ state: 'running', intentsApplied: 2 })
    expect(w.applied).toEqual([
      { kind: 'announce', text: 'ok' },
      { kind: 'announce', text: 'ok' },
    ])
    host.dispose()
  })
})
