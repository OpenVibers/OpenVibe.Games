/**
 * The script mod host: runs the `games-quickjs@1` mods of the def set, one
 * sandbox each, from the tick and the join/leave hooks.
 *
 * A mod reads the world and asks for changes; it never makes them. What it
 * can reach is the frozen global `game` (see docs/mods.md):
 *
 *   game.players()        every player in the world: { id, name, pos, yaw }
 *   game.player(id)       one player, or null
 *   game.emit(intent)     queue an intent (validated on the spot, throws if bad)
 *   game.log(...values)   a line in the server log (a few per tick)
 *
 * Intents queued during a call are applied after the call returns, through
 * `ScriptWorld.apply` (the gameplay modules), and only if the call completed:
 * a call stopped for its budget or by a throw changes nothing.
 *
 * Budgets: `cpuMs` is per tick (every call the mod gets in one tick shares it)
 * and caps each call; `memoryMb` and `stackKb` bound the mod's engine. A
 * budget breach stops the call, disables the mod for this instance (its
 * sandbox is freed), logs it and counts it; so does an engine failure, and
 * ERROR_STRIKES throws in a row. The tick goes on either way; nothing a mod does reaches the
 * caller as an exception.
 */
import { performance } from 'node:perf_hooks'
import { SCRIPT_MOD_BUDGETS, type ScriptMod, type ScriptModHook } from '@openvibe/content'
import type { Logger } from '@openvibe/shared'
import type {
  Json,
  ModSandbox,
  ModSandboxFactory,
  SandboxFailureReason,
  SandboxHostFunctions,
} from './sandbox.js'

/** The load (top-level code) may use this many ticks' worth of cpuMs. */
export const LOAD_CPU_FACTOR = 25
/** Throws in a row that disable a mod. */
export const ERROR_STRIKES = 5
export const MAX_INTENTS_PER_CALL = 16
export const MAX_LOGS_PER_TICK = 4

export interface ScriptPlayer {
  id: string
  name: string
  pos: [number, number, number]
  yaw: number
}

/** Everything a mod may ask for. Each is applied by the gameplay modules, never by the mod. */
export type ScriptIntent =
  | { kind: 'announce'; text: string }
  | { kind: 'giveItem'; playerId: string; item: string; count: number }

/** What the game lends the host: reads, and one door for changes. */
export interface ScriptWorld {
  players(): ScriptPlayer[]
  player(id: string): ScriptPlayer | null
  /** Applies a validated intent; returns why it was refused, or null. */
  apply(modId: string, intent: ScriptIntent): string | null
}

export interface ScriptModBudget {
  cpuMs: number
  memoryMb: number
  stackKb: number
}

export type ScriptModState = 'running' | 'disabled'

export interface ScriptModStatus {
  id: string
  version: string
  hooks: ScriptModHook[]
  budget: ScriptModBudget
  state: ScriptModState
  /** Why it was disabled (a budget, or `error` after ERROR_STRIKES throws). */
  reason: SandboxFailureReason | null
  calls: number
  failures: Record<SandboxFailureReason, number>
  intentsApplied: number
  intentsRejected: number
}

/** The manifest's requested budgets, with defaults for what it left out. */
export function resolveBudget(mod: ScriptMod): ScriptModBudget {
  return {
    cpuMs: mod.budgets?.cpuMs ?? SCRIPT_MOD_BUDGETS.cpuMs.default,
    memoryMb: mod.budgets?.memoryMb ?? SCRIPT_MOD_BUDGETS.memoryMb.default,
    stackKb: mod.budgets?.stackKb ?? SCRIPT_MOD_BUDGETS.stackKb.default,
  }
}

const isObject = (v: Json): v is { [key: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const shortString = (v: Json | undefined, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/**
 * An intent from script JSON, rebuilt field by field: nothing the script put
 * on the object besides the known fields (a `__proto__` key included) survives.
 */
export function parseIntent(raw: Json): ScriptIntent | string {
  if (!isObject(raw)) return 'an intent must be an object'
  switch (raw.kind) {
    case 'announce': {
      const text = typeof raw.text === 'string' ? raw.text.trim() : ''
      if (!shortString(text, 200)) return 'announce: text must be 1-200 characters'
      return { kind: 'announce', text }
    }
    case 'giveItem': {
      const { playerId, item, count } = raw
      if (!shortString(playerId, 64)) return 'giveItem: playerId must be a string'
      if (!shortString(item, 64)) return 'giveItem: item must be a string'
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100)
        return 'giveItem: count must be an integer 1-100'
      return { kind: 'giveItem', playerId, item, count }
    }
    default:
      return `unknown intent kind ${JSON.stringify(raw.kind ?? null)}`
  }
}

interface ModSlot {
  mod: ScriptMod
  budget: ScriptModBudget
  hooks: Set<ScriptModHook>
  sandbox: ModSandbox | null
  state: ScriptModState
  reason: SandboxFailureReason | null
  /** CPU spent since the current tick began. */
  spentMs: number
  logsThisTick: number
  strikes: number
  calls: number
  failures: Record<SandboxFailureReason, number>
  intentsApplied: number
  intentsRejected: number
}

export class ScriptModHost {
  private readonly slots: ModSlot[]
  private world: ScriptWorld | null = null
  /** The call in progress: whose intents `game.emit` queues, and where. */
  private current: { slot: ModSlot; intents: ScriptIntent[] } | null = null

  constructor(
    mods: readonly ScriptMod[],
    private readonly factory: ModSandboxFactory,
    private readonly log: Logger,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.slots = mods.map((mod) => ({
      mod,
      budget: resolveBudget(mod),
      hooks: new Set(mod.hooks),
      sandbox: null,
      state: 'running',
      reason: null,
      spentMs: 0,
      logsThisTick: 0,
      strikes: 0,
      calls: 0,
      failures: { cpu: 0, memory: 0, stack: 0, error: 0 },
      intentsApplied: 0,
      intentsRejected: 0,
    }))
  }

  /** The world the mods read and change; the game server binds it once. */
  bind(world: ScriptWorld): void {
    this.world = world
  }

  /** Creates every sandbox and evaluates each mod once. A mod that fails to load is disabled. */
  async start(): Promise<void> {
    for (const slot of this.slots) {
      const { mod, budget } = slot
      let created: Awaited<ReturnType<ModSandboxFactory['create']>>
      try {
        created = await this.factory.create({
          id: mod.id,
          filename: mod.entry,
          source: mod.source,
          limits: { memoryBytes: budget.memoryMb * 1024 * 1024, stackBytes: budget.stackKb * 1024 },
          loadCpuMs: budget.cpuMs * LOAD_CPU_FACTOR,
          host: this.hostFunctions(slot),
        })
      } catch (err) {
        created = {
          ok: false,
          reason: 'error',
          message: err instanceof Error ? err.message : String(err),
        }
      }
      if (!created.ok) {
        slot.failures[created.reason]++
        this.disable(slot, created.reason, `load: ${created.message}`)
        continue
      }
      slot.sandbox = created.sandbox
      this.log.info('script mod loaded', {
        mod: mod.id,
        version: mod.version,
        engine: this.factory.engine,
        hooks: mod.hooks.join(','),
        cpuMs: budget.cpuMs,
        memoryMb: budget.memoryMb,
        stackKb: budget.stackKb,
      })
    }
  }

  tick(tick: number, dtSeconds: number): void {
    for (const slot of this.slots) {
      slot.spentMs = 0
      slot.logsThisTick = 0
    }
    for (const slot of this.slots) this.run(slot, 'onTick', { tick, dt: dtSeconds })
  }

  playerJoined(player: ScriptPlayer): void {
    for (const slot of this.slots) this.run(slot, 'onPlayerJoin', { player: { ...player } })
  }

  playerLeft(playerId: string): void {
    for (const slot of this.slots) this.run(slot, 'onPlayerLeave', { playerId })
  }

  status(): ScriptModStatus[] {
    return this.slots.map((s) => ({
      id: s.mod.id,
      version: s.mod.version,
      hooks: [...s.mod.hooks],
      budget: { ...s.budget },
      state: s.state,
      reason: s.reason,
      calls: s.calls,
      failures: { ...s.failures },
      intentsApplied: s.intentsApplied,
      intentsRejected: s.intentsRejected,
    }))
  }

  /** Frees every sandbox (shutdown). */
  dispose(): void {
    for (const slot of this.slots) {
      slot.sandbox?.dispose()
      slot.sandbox = null
    }
  }

  private run(slot: ModSlot, hook: ScriptModHook, payload: Json): void {
    const sandbox = slot.sandbox
    if (slot.state !== 'running' || !sandbox || !slot.hooks.has(hook)) return
    const remaining = slot.budget.cpuMs - slot.spentMs
    if (remaining <= 0) {
      slot.failures.cpu++
      this.disable(slot, 'cpu', `${hook}: this tick's ${slot.budget.cpuMs} cpuMs are spent`)
      return
    }
    const intents: ScriptIntent[] = []
    this.current = { slot, intents }
    const started = this.now()
    let outcome: ReturnType<ModSandbox['call']>
    try {
      outcome = sandbox.call(hook, payload, remaining)
    } catch (err) {
      outcome = {
        ok: false,
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      }
    } finally {
      this.current = null
    }
    slot.spentMs += this.now() - started
    slot.calls++
    if (!outcome.ok) {
      slot.failures[outcome.reason]++
      if (outcome.reason !== 'error' || outcome.fatal) {
        this.disable(slot, outcome.reason, `${hook}: ${outcome.message}`)
        return
      }
      slot.strikes++
      if (slot.strikes >= ERROR_STRIKES) {
        this.disable(
          slot,
          'error',
          `${hook}: ${ERROR_STRIKES} throws in a row, last: ${outcome.message}`,
        )
      } else if (slot.strikes === 1) {
        this.log.warn('script mod threw', { mod: slot.mod.id, hook, error: outcome.message })
      }
      return
    }
    slot.strikes = 0
    for (const intent of intents) {
      const refused = this.world ? this.world.apply(slot.mod.id, intent) : 'no world bound'
      if (refused === null) slot.intentsApplied++
      else {
        slot.intentsRejected++
        this.log.debug('script mod intent refused', {
          mod: slot.mod.id,
          kind: intent.kind,
          refused,
        })
      }
    }
  }

  private disable(slot: ModSlot, reason: SandboxFailureReason, message: string): void {
    slot.state = 'disabled'
    slot.reason = reason
    slot.sandbox?.dispose()
    slot.sandbox = null
    this.log.warn('script mod disabled', {
      mod: slot.mod.id,
      reason,
      message: message.slice(0, 500),
    })
  }

  /** The functions behind `game`; each knows its mod, so no mod can act as another. */
  private hostFunctions(slot: ModSlot): SandboxHostFunctions {
    return {
      players: () => (this.world?.players() ?? []) as unknown as Json,
      player: (id) => {
        if (typeof id !== 'string') throw new Error('game.player(id): id must be a string')
        return (this.world?.player(id) ?? null) as unknown as Json
      },
      emit: (raw) => {
        const call = this.current
        if (!call || call.slot !== slot)
          throw new Error('game.emit is only available inside a hook')
        if (call.intents.length >= MAX_INTENTS_PER_CALL)
          throw new Error(`at most ${MAX_INTENTS_PER_CALL} intents per call`)
        const intent = parseIntent(raw ?? null)
        if (typeof intent === 'string') throw new Error(intent)
        call.intents.push(intent)
        return undefined
      },
      log: (...values) => {
        if (slot.logsThisTick >= MAX_LOGS_PER_TICK) return undefined
        slot.logsThisTick++
        const text = values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')
        this.log.info('script mod log', { mod: slot.mod.id, text: text.slice(0, 500) })
        return undefined
      },
    }
  }
}
