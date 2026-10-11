/**
 * The script mod host: runs the `games-quickjs@1` mods of the def set, one
 * sandbox each, from the tick and the join/leave hooks.
 *
 * A mod reads the world and asks for changes; it never makes them. What it
 * can reach is its granted subset of the frozen global `game` (see docs/mods.md):
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
import {
  SCRIPT_MOD_BUDGETS,
  type ScriptCapability,
  type ScriptMod,
  type ScriptModHook,
} from '@openvibe/content'
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
export const STORAGE_MAX_KEYS = 1000
export const STORAGE_MAX_BYTES = 1024 * 1024
export const STORAGE_MAX_VALUE_BYTES = 8 * 1024
export const STORAGE_MAX_KEY_BYTES = 128

export interface ScriptStorage {
  load(modId: string): Promise<Record<string, Json>>
  set(modId: string, key: string, value: Json): void
  delete(modId: string, key: string): void
  flushWrites(): Promise<void>
}

export interface ScriptPlayer {
  id: string
  name: string
  pos: [number, number, number]
  yaw: number
}

/** Everything a mod may ask for. Each is applied by the gameplay modules, never by the mod. */
export type ScriptIntent =
  | { kind: 'announce'; text: string }
  | { kind: 'message'; playerId: string; text: string }
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
    case 'message': {
      if (!shortString(raw.playerId, 64) || !shortString(raw.text, 200))
        return 'message: playerId and text are required'
      return { kind: 'message', playerId: raw.playerId, text: raw.text }
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
  grants: ReadonlySet<ScriptCapability>
  storage: Map<string, Json>
  randomState: number
  loadError: string | null
}

function seedRandom(placeSeed: string, modId: string): number {
  let h = 0x811c9dc5
  for (const c of `${placeSeed}:${modId}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
  return h || 1
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
    private readonly options: {
      placeSeed?: string
      grants?: Readonly<Record<string, readonly ScriptCapability[]>>
      storage?: ScriptStorage
    } = {},
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
      grants: new Set(
        this.options.grants?.[mod.id] ??
          mod.granted ??
          (mod.capabilities ? [] : ['players.read', 'world.emit']),
      ),
      storage: new Map(),
      randomState: seedRandom(this.options.placeSeed ?? 'scraplandia', mod.id),
      loadError: null,
    }))
  }

  /** The world the mods read and change; the game server binds it once. */
  bind(world: ScriptWorld): void {
    this.world = world
  }

  /** Creates every sandbox and evaluates each mod once. A mod that fails to load is disabled. */
  async start(): Promise<void> {
    for (const slot of this.slots) {
      if (this.options.storage) {
        const saved = await this.options.storage.load(slot.mod.id)
        slot.storage = new Map(Object.entries(saved))
      }
      await this.startSlot(slot)
    }
  }

  private async startSlot(slot: ModSlot): Promise<void> {
    const { mod, budget } = slot
    let created: Awaited<ReturnType<ModSandboxFactory['create']>>
    try {
      created = await this.factory.create({
        id: mod.id,
        filename: mod.entry,
        source: mod.source ?? mod.files?.[mod.entry] ?? '',
        ...(mod.files ? { files: mod.files, hooks: mod.hooks } : {}),
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
      slot.loadError = created.message
      slot.failures[created.reason]++
      this.disable(slot, created.reason, `load: ${created.message}`)
      return
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

  /** Prepare the replacement first. A failed load leaves the old sandbox running. */
  async reload(
    mod: ScriptMod,
    grants?: readonly ScriptCapability[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const prepared = await this.prepareReload(mod, grants)
    if (!prepared.ok) return prepared
    prepared.commit()
    return { ok: true }
  }

  async prepareReload(
    mod: ScriptMod,
    grants?: readonly ScriptCapability[],
  ): Promise<{ ok: true; commit(): void; cancel(): void } | { ok: false; error: string }> {
    const old = this.slots.find((s) => s.mod.id === mod.id)
    if (!old) return { ok: false, error: `unknown mod ${mod.id}` }
    const candidate: ModSlot = {
      ...old,
      mod,
      budget: resolveBudget(mod),
      hooks: new Set(mod.hooks),
      sandbox: null,
      state: 'running',
      reason: null,
      strikes: 0,
      spentMs: 0,
      logsThisTick: 0,
      loadError: null,
      storage: new Map(old.storage),
      grants: new Set(
        grants ??
          this.options.grants?.[mod.id] ??
          mod.granted ??
          (mod.capabilities ? [] : ['players.read', 'world.emit']),
      ),
    }
    await this.startSlot(candidate)
    if (!candidate.sandbox)
      return { ok: false, error: candidate.loadError ?? `failed to start ${mod.id}` }
    return {
      ok: true,
      commit: () => {
        old.sandbox?.dispose()
        this.slots[this.slots.indexOf(old)] = candidate
      },
      cancel: () => candidate.sandbox?.dispose(),
    }
  }

  async add(
    mod: ScriptMod,
    grants?: readonly ScriptCapability[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.slots.some((s) => s.mod.id === mod.id))
      return { ok: false, error: `mod ${mod.id} already runs` }
    const slot: ModSlot = {
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
      grants: new Set(
        grants ?? mod.granted ?? (mod.capabilities ? [] : ['players.read', 'world.emit']),
      ),
      storage: new Map(Object.entries((await this.options.storage?.load(mod.id)) ?? {})),
      randomState: seedRandom(this.options.placeSeed ?? 'scraplandia', mod.id),
      loadError: null,
    }
    await this.startSlot(slot)
    if (!slot.sandbox) return { ok: false, error: slot.loadError ?? `failed to start ${mod.id}` }
    this.slots.push(slot)
    return { ok: true }
  }

  has(id: string): boolean {
    return this.slots.some((slot) => slot.mod.id === id)
  }

  remove(id: string): void {
    const at = this.slots.findIndex((slot) => slot.mod.id === id)
    if (at < 0) return
    this.slots[at]?.sandbox?.dispose()
    this.slots.splice(at, 1)
  }

  flushWrites(): Promise<void> {
    return this.options.storage?.flushWrites() ?? Promise.resolve()
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
    const host: Record<string, (...args: Json[]) => Json | undefined> = {
      random: () => {
        let x = slot.randomState
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        slot.randomState = x >>> 0
        return slot.randomState / 0x1_0000_0000
      },
      log: (...values) => {
        if (slot.logsThisTick >= MAX_LOGS_PER_TICK) return undefined
        slot.logsThisTick++
        const text = values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')
        this.log.info('script mod log', { mod: slot.mod.id, text: text.slice(0, 500) })
        return undefined
      },
    }
    if (slot.grants.has('players.read'))
      Object.assign(host, {
        players: () => (this.world?.players() ?? []) as unknown as Json,
        player: (id: Json) => {
          if (typeof id !== 'string') throw new Error('game.player(id): id must be a string')
          return (this.world?.player(id) ?? null) as unknown as Json
        },
      })
    if (slot.grants.has('world.emit'))
      host.emit = (raw) => {
        const call = this.current
        if (!call || call.slot !== slot)
          throw new Error('game.emit is only available inside a hook')
        if (call.intents.length >= MAX_INTENTS_PER_CALL)
          throw new Error(`at most ${MAX_INTENTS_PER_CALL} intents per call`)
        const intent = parseIntent(raw ?? null)
        if (typeof intent === 'string') throw new Error(intent)
        if (intent.kind === 'message') throw new Error('message requires game.message')
        call.intents.push(intent)
        return undefined
      }
    if (slot.grants.has('player.message'))
      host.message = (playerId, text) => {
        const call = this.current
        if (!call || call.slot !== slot)
          throw new Error('game.message is only available inside a hook')
        if (call.intents.length >= MAX_INTENTS_PER_CALL)
          throw new Error(`at most ${MAX_INTENTS_PER_CALL} intents per call`)
        const intent = parseIntent({
          kind: 'message',
          playerId: playerId ?? null,
          text: text ?? null,
        })
        if (typeof intent === 'string') throw new Error(intent)
        call.intents.push(intent)
        return undefined
      }
    if (slot.grants.has('storage.kv')) {
      const checkedKey = (key: Json | undefined): string => {
        if (typeof key !== 'string' || new TextEncoder().encode(key).length > STORAGE_MAX_KEY_BYTES)
          throw new Error('storage key must be at most 128 UTF-8 bytes')
        return key
      }
      host['storage.get'] = (key) => slot.storage.get(checkedKey(key)) ?? null
      host['storage.keys'] = (prefix) => {
        if (prefix !== undefined && typeof prefix !== 'string')
          throw new Error('storage prefix must be a string')
        return [...slot.storage.keys()].filter((k) => k.startsWith(prefix ?? '')).sort()
      }
      host['storage.set'] = (key, value) => {
        if (this.current?.slot !== slot)
          throw new Error('storage writes are only available inside a hook')
        const k = checkedKey(key)
        if (value === undefined) throw new Error('storage value must be JSON')
        const bytes = new TextEncoder().encode(JSON.stringify(value)).length
        if (bytes > STORAGE_MAX_VALUE_BYTES) throw new Error('storage value exceeds 8 KiB')
        if (!slot.storage.has(k) && slot.storage.size >= STORAGE_MAX_KEYS)
          throw new Error('storage exceeds 1000 keys')
        const total = [...slot.storage].reduce(
          (n, [name, item]) =>
            n +
            (name === k
              ? 0
              : new TextEncoder().encode(name).length +
                new TextEncoder().encode(JSON.stringify(item)).length),
          bytes + new TextEncoder().encode(k).length,
        )
        if (total > STORAGE_MAX_BYTES) throw new Error('storage exceeds 1 MiB')
        slot.storage.set(k, value)
        this.options.storage?.set(slot.mod.id, k, value)
        return undefined
      }
      host['storage.delete'] = (key) => {
        if (this.current?.slot !== slot)
          throw new Error('storage writes are only available inside a hook')
        const k = checkedKey(key)
        const existed = slot.storage.delete(k)
        if (existed) this.options.storage?.delete(slot.mod.id, k)
        return existed
      }
    }
    return host
  }
}
