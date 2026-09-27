/**
 * The mod runtime seam.
 *
 * A mod never touches the game server, the world or the database. It gets a
 * `ModApi`: a frozen object of bindings, one per runtime capability, and
 * every binding checks the registry AT CALL TIME. A capability the install
 * was not granted — or one revoked a moment ago — throws before anything
 * happens, so it cannot be reached from the mod side at all.
 *
 * `games-content@1` packs are interpreted here through that same API; an
 * executable runtime (a script sandbox) would receive the same bindings.
 * Executable mods are not accepted yet: sandboxed execution with enforced
 * CPU, memory, storage and network budgets belongs to OpenVibe.Host
 * (Stage C). Until then the runtime enforces what it can see (roadmap WS-M
 * task 4), and only on the offending mod:
 *   - CPU: each reconcile is timed against the manifest's cpuMs; a mod over
 *     its budget on CPU_STRIKES reconciles in a row is disabled.
 *   - Event flood: every host effect (an announcement, a prop placed or
 *     removed) spends one of the mod's EFFECTS_PER_MINUTE; past that, calls
 *     throw ModThrottledError (audited once a minute), and a mod throttled
 *     FLOOD_WINDOWS minutes in a row is disabled.
 * A disable is the registry's (audit `budget_enforced`, games.mod.disabled and
 * a moderation event); staff enable it again once the pack is fixed.
 *
 * Each tick the runtime reconciles when the registry changed (and once a
 * second otherwise): an inactive mod, or one that lost a capability, has
 * its effects retracted — its props despawned, its announcements stopped —
 * on that very tick.
 */
import type { ContentRegistry } from '@openvibe/content'
import type { PersistenceStore } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import { CAP_ANNOUNCE, CAP_PLACE_PROP, placeableByMod } from './contentPack.js'
import { SYSTEM_ACTOR, type ModRegistry, type ModView } from './registry.js'

/** What the game server lends the runtime. Only the runtime holds it. */
export interface ModHost {
  announce(text: string): void
  /** Spawns an inert prop owned by `owner`; returns its entity id. */
  placeProp(spec: {
    item: string
    pos: [number, number, number]
    yaw: number
    owner: string
  }): string | null
  removeEntity(entityId: string): boolean
  entityExists(entityId: string): boolean
}

/** The bindings a mod gets. Nothing else is reachable from a mod. */
export interface ModApi {
  readonly modId: string
  /** games.world.announce */
  announce(text: string): void
  /** games.prop.place: places (or re-places) the prop for `key`. */
  placeProp(key: string, item: string, pos: [number, number, number], yaw?: number): string | null
  /** games.prop.place: removes the prop for `key`. */
  removeProp(key: string): boolean
}

export class ModCapabilityError extends Error {
  readonly code = 'capability.denied'
  constructor(
    readonly modId: string,
    readonly capability: string,
  ) {
    super(`${modId} is not granted ${capability}`)
  }
}

/** A mod spent its host effects for this minute (the event-flood throttle). */
export class ModThrottledError extends Error {
  readonly code = 'mod.throttled'
  constructor(readonly modId: string) {
    super(`${modId} is over its effects for this minute`)
  }
}

export const CPU_STRIKES = 5
export const EFFECTS_PER_MINUTE = 60
export const FLOOD_WINDOWS = 3

export interface ModRuntimeOptions {
  /** Reconcile at least this often when nothing changed (ticks). */
  reconcileEveryTicks: number
  now?: () => number
  /** Host effects a mod may cause per minute (default EFFECTS_PER_MINUTE). */
  effectsPerMinute?: number
}

export class ModRuntime {
  private seenVersion = -1
  private nextTick = 0
  /** modId -> last announcement time per announcement index. */
  private readonly announced = new Map<string, number[]>()
  /** `${modId}|${cap}` denials already audited since the last registry change. */
  private readonly deniedNoted = new Set<string>()
  private readonly budgetNotedAt = new Map<string, number>()
  /** Reconciles in a row over the CPU budget, per mod. */
  private readonly cpuStrikes = new Map<string, number>()
  /** Host effects per mod in the current minute, and minutes in a row that were throttled. */
  private readonly effects = new Map<string, { windowStart: number; count: number; throttled: boolean; floodWindows: number }>()
  private readonly now: () => number

  constructor(
    private readonly registry: ModRegistry,
    private readonly store: PersistenceStore,
    private readonly content: ContentRegistry,
    private readonly log: Logger,
    private readonly opts: ModRuntimeOptions,
  ) {
    this.now = opts.now ?? Date.now
  }

  /**
   * The mod-facing API for one install. Frozen, and closed over nothing a
   * mod could use to reach the host except through a checked binding.
   */
  bindingsFor(modId: string, host: ModHost): ModApi {
    const check = (capability: string) => {
      if (!this.registry.isGranted(modId, capability)) {
        throw new ModCapabilityError(modId, capability)
      }
      this.spend(modId)
    }
    const name = () => this.registry.get(modId)?.mod.name ?? modId
    const api: ModApi = {
      modId,
      announce: (text: string) => {
        check(CAP_ANNOUNCE)
        const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!clean) return
        host.announce(`[${name()}] ${clean}`)
        this.registry.audit(modId, 'use', CAP_ANNOUNCE, { chars: clean.length })
      },
      placeProp: (key, item, pos, yaw = 0) => {
        check(CAP_PLACE_PROP)
        const problem = placeableByMod(this.content, item)
        if (problem) throw new Error(problem)
        if (!pos.every((v) => Number.isFinite(v)) || !Number.isFinite(yaw)) {
          throw new Error('position must be finite')
        }
        const existing = this.store.mods.placements(modId).find((p) => p.key === key)
        if (existing?.entityId && host.entityExists(existing.entityId)) {
          host.removeEntity(existing.entityId)
        }
        const entityId = host.placeProp({ item, pos: [pos[0], pos[1], pos[2]], yaw, owner: modId })
        this.store.mods.setPlacement({ modId, key, entityId, at: this.now() })
        this.registry.audit(modId, 'use', CAP_PLACE_PROP, { key, item, entity: entityId })
        return entityId
      },
      removeProp: (key) => {
        check(CAP_PLACE_PROP)
        const existing = this.store.mods.placements(modId).find((p) => p.key === key)
        if (!existing) return false
        if (existing.entityId) host.removeEntity(existing.entityId)
        this.store.mods.deletePlacement(modId, key)
        this.registry.audit(modId, 'use', CAP_PLACE_PROP, { key, removed: true })
        return true
      },
    }
    return Object.freeze(api)
  }

  tick(tick: number, host: ModHost): void {
    const changed = this.registry.version !== this.seenVersion
    if (!changed && tick < this.nextTick) return
    if (changed) this.deniedNoted.clear()
    this.seenVersion = this.registry.version
    this.nextTick = tick + this.opts.reconcileEveryTicks
    for (const view of this.registry.list()) {
      try {
        if (!this.registry.isActive(view.mod.id)) {
          this.retractProps(view.mod.id, host)
          this.announced.delete(view.mod.id)
          continue
        }
        const started = performance.now()
        this.runContentPack(view, host)
        this.meter(view, performance.now() - started)
      } catch (err) {
        // One broken mod never stops the tick or the other mods.
        this.log.warn('mod tick failed', { mod: view.mod.id, error: String(err) })
      }
    }
  }

  private runContentPack(view: ModView, host: ModHost): void {
    const id = view.mod.id
    const api = this.bindingsFor(id, host)

    // Props: present exactly while games.prop.place is granted.
    const props = view.pack.props ?? []
    if (!this.registry.isGranted(id, CAP_PLACE_PROP)) {
      this.retractProps(id, host)
      if (props.length > 0) this.noteDenied(id, CAP_PLACE_PROP)
    } else {
      const placed = new Map(this.store.mods.placements(id).map((p) => [p.key, p]))
      const wanted = new Set(props.map((p) => p.key))
      for (const prop of props) {
        const p = placed.get(prop.key)
        if (p?.entityId && host.entityExists(p.entityId)) continue
        this.attempt(id, () => api.placeProp(prop.key, prop.item, prop.pos, prop.yaw ?? 0))
      }
      // Placements the pack no longer lists (an older version) go away.
      for (const [key] of placed) {
        if (!wanted.has(key)) this.attempt(id, () => api.removeProp(key))
      }
    }

    // Announcements: on their own cadence, only while granted.
    const announcements = view.pack.announcements ?? []
    if (announcements.length === 0) return
    if (!this.registry.isGranted(id, CAP_ANNOUNCE)) {
      this.announced.delete(id)
      this.noteDenied(id, CAP_ANNOUNCE)
      return
    }
    const nowMs = this.now()
    let last = this.announced.get(id)
    if (!last) {
      // First sight of an active mod: the first announcement comes one
      // interval later, so restarts do not replay every announcement.
      last = announcements.map(() => nowMs)
      this.announced.set(id, last)
      return
    }
    announcements.forEach((a, i) => {
      if (nowMs - (last[i] ?? nowMs) < a.everySeconds * 1000) return
      last[i] = nowMs
      this.attempt(id, () => api.announce(a.text))
    })
  }

  private attempt(id: string, fn: () => unknown): void {
    try {
      fn()
    } catch (err) {
      if (err instanceof ModCapabilityError) this.noteDenied(id, err.capability)
      else if (err instanceof ModThrottledError) return
      else throw err
    }
  }

  /** One host effect for `id`: throws ModThrottledError past the minute's allowance; a sustained flood disables it. */
  private spend(id: string): void {
    const limit = this.opts.effectsPerMinute ?? EFFECTS_PER_MINUTE
    const nowMs = this.now()
    let e = this.effects.get(id)
    if (!e || nowMs - e.windowStart >= 60_000) {
      const floodWindows = e && e.throttled && nowMs - e.windowStart < 120_000 ? e.floodWindows + 1 : 0
      e = { windowStart: nowMs, count: 0, throttled: false, floodWindows }
      this.effects.set(id, e)
      if (floodWindows >= FLOOD_WINDOWS) {
        this.enforce(id, 'event_flood', { effects_per_minute: limit, minutes: floodWindows })
        throw new ModThrottledError(id)
      }
    }
    if (e.count >= limit) {
      if (!e.throttled) {
        e.throttled = true
        this.registry.audit(id, 'throttled', null, { effects_per_minute: limit })
      }
      throw new ModThrottledError(id)
    }
    e.count++
  }

  /** Disables the offending mod only; the others keep running. */
  private enforce(id: string, reason: 'cpu' | 'event_flood', detail: Record<string, unknown>): void {
    if (!this.registry.isActive(id)) return
    this.registry.audit(id, 'budget_enforced', null, { reason, ...detail })
    this.registry.disable(id, SYSTEM_ACTOR)
    this.cpuStrikes.delete(id)
    this.effects.delete(id)
    this.log.warn('mod disabled: over its budget', { mod: id, reason })
  }

  /** Despawns everything the mod placed. */
  private retractProps(id: string, host: ModHost): void {
    const placements = this.store.mods.placements(id)
    if (placements.length === 0) return
    let removed = 0
    for (const p of placements) {
      if (p.entityId && host.removeEntity(p.entityId)) removed++
      this.store.mods.deletePlacement(id, p.key)
    }
    this.registry.audit(id, 'retract', CAP_PLACE_PROP, { placements: placements.length, removed })
    this.log.info('mod props retracted', { mod: id, removed })
  }

  private noteDenied(id: string, capability: string): void {
    const key = `${id}|${capability}`
    if (this.deniedNoted.has(key)) return
    this.deniedNoted.add(key)
    this.registry.audit(id, 'deny', capability)
  }

  /** Meters the declared per-reconcile CPU budget; CPU_STRIKES reconciles over it in a row disable the mod. */
  private meter(view: ModView, ms: number): void {
    const budget = view.manifest.resources.cpuMs
    if (ms <= budget) {
      this.cpuStrikes.delete(view.mod.id)
      return
    }
    const strikes = (this.cpuStrikes.get(view.mod.id) ?? 0) + 1
    this.cpuStrikes.set(view.mod.id, strikes)
    if (strikes >= CPU_STRIKES) {
      this.enforce(view.mod.id, 'cpu', { cpu_ms: Math.round(ms * 1000) / 1000, budget_ms: budget, reconciles: strikes })
      return
    }
    const nowMs = this.now()
    if (nowMs - (this.budgetNotedAt.get(view.mod.id) ?? 0) < 60_000) return
    this.budgetNotedAt.set(view.mod.id, nowMs)
    this.registry.audit(view.mod.id, 'budget_exceeded', null, {
      cpu_ms: Math.round(ms * 1000) / 1000,
      budget_ms: budget,
    })
  }
}
