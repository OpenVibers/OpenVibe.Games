/**
 * The script sandbox adapter: the whole contract between the mod host and a
 * script engine. QuickJS (quickjs.ts) is the first implementation; OpenVibe.Run
 * can implement the same interface later (ADR-036) and the host does not change.
 *
 * The contract, which every implementation must keep:
 *  - one isolated context per mod: no state, prototype or object identity is
 *    shared between mods or with the host;
 *  - only JSON crosses the boundary, in both directions: a host function gets
 *    JSON arguments and returns JSON, a hook gets a JSON payload. No host
 *    object, function or prototype is ever reachable from the script;
 *  - nothing but the lent functions: no require/import, fs, net, process,
 *    timers or clock beyond what the engine's language intrinsics provide;
 *  - the host functions appear in the script as the frozen global `game`;
 *  - limits are enforced by the engine, not by trusting the script: `cpuMs`
 *    per call (wall clock on the single-threaded tick), a heap of
 *    `memoryBytes` (beyond the engine's own fixed base), a stack of
 *    `stackBytes`; a breach the script catches or swallows is still a breach;
 *  - `call` and `dispose` never throw: every failure is a `SandboxFailure`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Functions lent to a script, named as they appear on `game`. A throw becomes an Error inside the script. */
export type SandboxHostFunctions = Readonly<Record<string, (...args: Json[]) => Json | undefined>>

export interface SandboxLimits {
  memoryBytes: number
  stackBytes: number
}

/** Why a call (or the load) did not complete. Every reason but `error` is a budget breach. */
export type SandboxFailureReason = 'cpu' | 'memory' | 'stack' | 'error'

export interface SandboxFailure {
  ok: false
  reason: SandboxFailureReason
  message: string
  /** The sandbox cannot be used again (the engine itself failed); the host must dispose it. */
  fatal?: boolean
}

export type SandboxOutcome = { ok: true } | SandboxFailure

export interface ModSandbox {
  /**
   * Calls the script's global function `hook` with `payload`, letting it run
   * for at most `cpuMs`; pending promise jobs it queued run inside the same
   * budget. A missing hook is a success.
   */
  call(hook: string, payload: Json, cpuMs: number): SandboxOutcome
  /** Frees the context and everything in it. Idempotent. */
  dispose(): void
}

export interface SandboxSpec {
  /** The mod id, for diagnostics only. */
  id: string
  /** File name shown in the script's stack traces. */
  filename: string
  source: string
  limits: SandboxLimits
  /** CPU budget for evaluating the source once (top-level code). */
  loadCpuMs: number
  host: SandboxHostFunctions
}

export interface ModSandboxFactory {
  /** Engine name and exact version, for logs and /api/status. */
  readonly engine: string
  /** A fresh, isolated context with `host` installed and `source` evaluated once. */
  create(spec: SandboxSpec): Promise<{ ok: true; sandbox: ModSandbox } | SandboxFailure>
}
