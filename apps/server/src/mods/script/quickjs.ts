/**
 * The QuickJS implementation of the sandbox adapter (sandbox.ts), on
 * quickjs-emscripten: QuickJS compiled to WASM, no native build.
 *
 * Every mod gets its own WASM module instance and linear memory, runtime and
 * context, so a mod cannot see another's heap even through an engine bug, and
 * an engine abort poisons only that mod's instance. A fresh context holds the
 * language intrinsics only — QuickJS's std/os libraries are not part of the
 * build — and the host adds exactly one thing, the frozen global `game`.
 *
 * Budgets:
 *  - cpuMs: the interrupt handler stops a call at its deadline (QuickJS polls
 *    it every few thousand operations). An interrupt a promise job or async
 *    hook swallows into a rejection is still a breach: the flag is ours.
 *  - memory: QuickJS's own malloc limit cannot count bytes under emscripten
 *    (no malloc_usable_size: it sees single allocations and a per-block
 *    overhead, not the total), so the bound is the WASM memory itself, capped
 *    at the engine's base heap plus `memoryBytes` (HeapCeiling). The malloc
 *    limit stays as a second line against any single allocation that large.
 *  - stack: the runtime's max stack size turns deep recursion into a catchable
 *    stack overflow. A few engine paths recurse in C without that check (a
 *    deeply nested JSON.stringify) and exhaust the host's own stack instead;
 *    that RangeError is caught here, reported as a stack breach, and the
 *    instance is treated as dead.
 */
import { performance } from 'node:perf_hooks'
import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten'
import type {
  Json,
  ModSandbox,
  ModSandboxFactory,
  SandboxFailure,
  SandboxFailureReason,
  SandboxHostFunctions,
  SandboxOutcome,
  SandboxSpec,
} from './sandbox.js'

/** Must match the exact version pinned in apps/server/package.json. */
export const QUICKJS_ENGINE = 'quickjs-emscripten@0.32.0'

/** The linear memory this build declares it starts with; QuickJS's own state lives in it. */
export const ENGINE_BASE_BYTES = 16 * 1024 * 1024
const WASM_PAGE = 64 * 1024

/** Longest JSON a host call may pass either way; past it the call throws inside the script. */
const MAX_HOST_JSON = 64 * 1024
/** Longest failure message kept from a script (it chooses what it throws). */
const MAX_MESSAGE = 500

/**
 * Runs before the mod, with the native bridge as its only argument; the bridge
 * never becomes a global. It builds the frozen `game` object (one wrapper per
 * lent function, JSON in and out) and returns the hook dispatcher the host
 * keeps. Nothing it does at call time looks up a global or a prototype method
 * the mod could have replaced (`JSON` is captured, arguments are copied by index).
 */
const PRELUDE = `(function (bridge, namesJson) {
  'use strict';
  const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze;
  const game = {};
  const names = parse(namesJson);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    game[name] = function () {
      const args = [];
      for (let k = 0; k < arguments.length; k++) args[k] = arguments[k];
      const out = bridge(name, stringify(args));
      return out === undefined ? undefined : parse(out);
    };
    freeze(game[name]);
  }
  freeze(game);
  Object.defineProperty(globalThis, 'game', { value: game, writable: false, enumerable: false, configurable: false });
  return function dispatch(hook, payload) {
    const fn = globalThis[hook];
    if (typeof fn === 'function') fn(parse(payload));
  };
})`

/** The part of WebAssembly.Memory used here; the server's TS lib (ES2022, no DOM) does not declare it. */
interface WasmMemory {
  readonly buffer: ArrayBuffer
  grow(deltaPages: number): number
}
const { Memory } = (
  globalThis as unknown as {
    WebAssembly: { Memory: new (d: { initial: number; maximum: number }) => WasmMemory }
  }
).WebAssembly

/**
 * A mod's linear memory, capped at ENGINE_BASE_BYTES + `memoryBytes`. Past the
 * cap the engine's allocator is refused and the allocation fails inside the
 * script ("out of memory"). `exceeded` stays true from the moment an
 * allocation needed more than the cap — even if the script caught the error —
 * because the memory never shrinks and can no longer grow.
 */
class HeapCeiling {
  readonly memory: WasmMemory
  private refusedAt = -1

  constructor(memoryBytes: number) {
    const base = ENGINE_BASE_BYTES / WASM_PAGE
    const memory = new Memory({
      initial: base,
      maximum: base + Math.ceil(memoryBytes / WASM_PAGE),
    })
    // The allocator asks for a generous step first and smaller ones after a
    // refusal; only a refusal not followed by a successful grow is a breach.
    const grow = memory.grow.bind(memory)
    memory.grow = (delta) => {
      try {
        return grow(delta)
      } catch (err) {
        this.refusedAt = memory.buffer.byteLength
        throw err
      }
    }
    this.memory = memory
  }

  get exceeded(): boolean {
    return this.refusedAt === this.memory.buffer.byteLength
  }
}

function failure(reason: SandboxFailureReason, message: string, fatal = false): SandboxFailure {
  return { ok: false, reason, message: message.slice(0, MAX_MESSAGE), ...(fatal && { fatal }) }
}

/** A script exception that is not a breach of ours: the engine's own limits, or a throw. */
function classify(message: string): SandboxFailure {
  if (/out of memory/i.test(message)) return failure('memory', message)
  if (/stack overflow/i.test(message)) return failure('stack', message)
  return failure('error', message)
}

/** A thrown script value as one line of text (an Error's name, message and first stack frame). */
function describe(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const v: unknown = ctx.dump(handle)
    if (v && typeof v === 'object' && 'message' in v) {
      const e = v as { name?: unknown; message?: unknown; stack?: unknown }
      const at = typeof e.stack === 'string' ? e.stack.trim().split('\n')[0] : ''
      return `${String(e.name ?? 'Error')}: ${String(e.message)}${at ? ` (${at.trim()})` : ''}`
    }
    return String(v)
  } catch {
    return 'an exception the engine could not describe'
  } finally {
    handle.dispose()
  }
}

class QuickJsSandbox implements ModSandbox {
  private deadline = Infinity
  private cpuMs = 0
  /** Set by us, never by the script: the interrupt handler stops the call while it is set. */
  private breach: 'cpu' | 'memory' | null = null
  /** The engine threw into the host (an abort, the host's stack): nothing in it can be trusted. */
  private poisoned = false
  private disposed = false
  private dispatch: QuickJSHandle | null = null

  constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly ctx: QuickJSContext,
    private readonly heap: HeapCeiling,
  ) {
    runtime.setInterruptHandler(() => {
      if (this.breach === null) {
        if (heap.exceeded) this.breach = 'memory'
        else if (performance.now() > this.deadline) this.breach = 'cpu'
      }
      return this.breach !== null
    })
  }

  /** Installs `game`, then evaluates the mod once. */
  load(spec: SandboxSpec): SandboxOutcome {
    const ctx = this.ctx
    return this.run(spec.loadCpuMs, () => {
      const bridge = ctx.newFunction('bridge', (nameH, argsH) =>
        bridgeCall(ctx, spec.host, nameH, argsH),
      )
      const names = ctx.newString(JSON.stringify(Object.keys(spec.host)))
      const prelude = ctx.evalCode(PRELUDE, 'host-prelude.js')
      if (prelude.error) {
        bridge.dispose()
        names.dispose()
        return prelude.error
      }
      const made = ctx.callFunction(prelude.value, ctx.undefined, bridge, names)
      prelude.value.dispose()
      bridge.dispose()
      names.dispose()
      if (made.error) return made.error
      this.dispatch = made.value
      const evaluated = ctx.evalCode(spec.source, spec.filename)
      if (evaluated.error) return evaluated.error
      evaluated.value.dispose()
      return null
    })
  }

  call(hook: string, payload: Json, cpuMs: number): SandboxOutcome {
    if (this.disposed || this.poisoned || !this.dispatch)
      return failure('error', 'the sandbox is no longer usable', true)
    const ctx = this.ctx
    const dispatch = this.dispatch
    return this.run(cpuMs, () => {
      const hookH = ctx.newString(hook)
      const payloadH = ctx.newString(JSON.stringify(payload))
      const r = ctx.callFunction(dispatch, ctx.undefined, hookH, payloadH)
      hookH.dispose()
      payloadH.dispose()
      if (r.error) return r.error
      r.value.dispose()
      return null
    })
  }

  /**
   * Runs `body` (which returns the script's exception handle, or null) and the
   * promise jobs it queued, one at a time, all before one deadline.
   */
  private run(cpuMs: number, body: () => QuickJSHandle | null): SandboxOutcome {
    this.breach = null
    this.cpuMs = cpuMs
    this.deadline = performance.now() + cpuMs
    try {
      let thrown = body()
      while (!thrown && this.breach === null && this.runtime.hasPendingJob()) {
        if (performance.now() > this.deadline) this.breach = 'cpu'
        else {
          const jobs = this.runtime.executePendingJobs(1)
          if (jobs.error) thrown = jobs.error
        }
      }
      if (this.breach === null && this.heap.exceeded) this.breach = 'memory'
      const message = thrown ? describe(this.ctx, thrown) : ''
      if (this.breach === 'cpu') return failure('cpu', `interrupted: over its ${this.cpuMs} cpuMs`)
      if (this.breach === 'memory')
        return failure('memory', `heap over its memory budget${message ? `: ${message}` : ''}`)
      return thrown ? classify(message) : { ok: true }
    } catch (err) {
      this.poisoned = true
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      if (err instanceof RangeError && /call stack/i.test(message))
        return failure('stack', `the host's stack ran out: ${message}`, true)
      return failure(this.breach ?? 'error', `the engine failed: ${message}`, true)
    } finally {
      this.deadline = Infinity
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // A poisoned engine is only dropped: its teardown would trip the engine's
    // own consistency checks. The WASM instance is this mod's alone.
    if (this.poisoned) return
    try {
      this.dispatch?.dispose()
      this.ctx.dispose()
      this.runtime.dispose()
    } catch {
      // Same: a runtime stopped mid-allocation can fail its teardown checks.
    }
  }
}

/** The native side of `game.<name>(...)`: JSON in, JSON out, errors as script exceptions. */
function bridgeCall(
  ctx: QuickJSContext,
  host: SandboxHostFunctions,
  nameH: QuickJSHandle | undefined,
  argsH: QuickJSHandle | undefined,
): QuickJSHandle | { error: QuickJSHandle } {
  try {
    if (!nameH || !argsH) throw new Error('bad bridge call')
    const name = ctx.getString(nameH)
    const raw = ctx.getString(argsH)
    if (raw.length > MAX_HOST_JSON) throw new Error(`arguments to game.${name} are too large`)
    const fn = Object.prototype.hasOwnProperty.call(host, name) ? host[name] : undefined
    if (!fn) throw new Error(`game.${name} is not a function`)
    const args = JSON.parse(raw) as Json[]
    const out = fn(...args)
    if (out === undefined) return ctx.undefined
    const json = JSON.stringify(out)
    if (json.length > MAX_HOST_JSON) throw new Error(`game.${name} returned too much`)
    return ctx.newString(json)
  } catch (err) {
    // Only the message crosses: never the host Error object or its stack.
    return { error: ctx.newError(err instanceof Error ? err.message : String(err)) }
  }
}

export function createQuickJsSandboxFactory(): ModSandboxFactory {
  return {
    engine: QUICKJS_ENGINE,
    async create(spec) {
      const heap = new HeapCeiling(spec.limits.memoryBytes)
      const module = await newQuickJSWASMModule(
        newVariant(RELEASE_SYNC, { wasmMemory: heap.memory }),
      )
      const runtime = module.newRuntime()
      runtime.setMemoryLimit(spec.limits.memoryBytes)
      runtime.setMaxStackSize(spec.limits.stackBytes)
      const sandbox = new QuickJsSandbox(runtime, runtime.newContext(), heap)
      const loaded = sandbox.load(spec)
      if (!loaded.ok) {
        sandbox.dispose()
        return loaded
      }
      return { ok: true, sandbox }
    },
  }
}
