/**
 * The console's cvar layer.
 *
 * Source names and Source units are the player-facing interface; the engine
 * keeps metres and seconds. A definition may therefore name an internal
 * `target` and a `scale` (units × scale = engine value), but the registry
 * itself stores the value the player typed in Source units. The gameplay
 * package owns the actual conversion into `MovementParams`.
 */

/** What a cvar value can be on the wire. */
export type CvarValue = number | boolean | string
export type CvarType = 'float' | 'integer' | 'boolean' | 'string'

/**
 * `server` — authoritative; only the server may change it.
 * `replicated` — sent in welcome/cvar_state (server values).
 * `client` — local to this browser, safe to change from the console.
 * `archive` — persisted in localStorage.
 * `cheat` — exists, but a normal player cannot change it.
 */
export type CvarFlag = 'server' | 'client' | 'replicated' | 'archive' | 'cheat' | 'readonly'

export interface CvarSpec {
  name: string
  type: CvarType
  defaultValue: CvarValue
  flags: readonly CvarFlag[]
  help: string
  aliases?: readonly string[]
  /** Engine-side field this cvar maps onto (gameplay interprets it). */
  target?: string
  /** Source value × scale = engine value. */
  scale?: number
  unit?: string
  min?: number
  max?: number
}

export interface CvarSetResult {
  ok: boolean
  value?: CvarValue
  error?: string
}

const numberFor = (input: CvarValue, type: 'float' | 'integer'): number | null => {
  const value =
    typeof input === 'number'
      ? input
      : typeof input === 'string' && input.trim() !== ''
        ? Number(input)
        : Number.NaN
  if (!Number.isFinite(value)) return null
  if (type === 'integer' && !Number.isInteger(value)) return null
  return value
}

const boolFor = (input: CvarValue): boolean | null => {
  if (typeof input === 'boolean') return input
  const value = typeof input === 'number' ? String(input) : input.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(value)) return true
  if (['0', 'false', 'off', 'no'].includes(value)) return false
  return null
}

/** An in-memory cvar table with Source-style aliases, flags and validation. */
export class CvarRegistry {
  private readonly byName = new Map<string, CvarSpec>()
  private readonly byAlias = new Map<string, CvarSpec>()
  private readonly values = new Map<string, CvarValue>()

  constructor(specs: readonly CvarSpec[] = []) {
    for (const spec of specs) this.register(spec)
  }

  register(spec: CvarSpec): void {
    const name = spec.name.trim().toLowerCase()
    if (!name) throw new Error('cvar name must not be empty')
    if (this.byName.has(name)) throw new Error(`duplicate cvar "${name}"`)
    this.byName.set(name, spec)
    this.byAlias.set(name, spec)
    for (const alias of spec.aliases ?? []) {
      const key = alias.trim().toLowerCase()
      if (!key) continue
      if (this.byAlias.has(key)) throw new Error(`duplicate cvar alias "${key}"`)
      this.byAlias.set(key, spec)
    }
    this.values.set(name, spec.defaultValue)
  }

  /** Resolve an alias to its canonical definition. */
  spec(name: string): CvarSpec | null {
    return this.byAlias.get(name.trim().toLowerCase()) ?? null
  }

  has(name: string): boolean {
    return this.spec(name) !== null
  }

  canonical(name: string): string | null {
    return this.spec(name)?.name ?? null
  }

  get(name: string): CvarValue | null {
    const spec = this.spec(name)
    return spec ? (this.values.get(spec.name) ?? spec.defaultValue) : null
  }

  /** All canonical definitions in name order. */
  all(): CvarSpec[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Canonical names and aliases that start with `prefix`. */
  matching(prefix: string): string[] {
    const p = prefix.trim().toLowerCase()
    return [...this.byAlias.keys()].filter((name) => name.startsWith(p)).sort()
  }

  /** Definitions whose name, alias or help contains `text`. */
  find(text: string): CvarSpec[] {
    const needle = text.trim().toLowerCase()
    const out = new Set<CvarSpec>()
    for (const spec of this.byName.values()) {
      if (
        spec.name.includes(needle) ||
        spec.help.toLowerCase().includes(needle) ||
        (spec.aliases ?? []).some((a) => a.toLowerCase().includes(needle))
      )
        out.add(spec)
    }
    return [...out].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Validate and store a player-entered value. */
  set(name: string, input: CvarValue): CvarSetResult {
    const spec = this.spec(name)
    if (!spec) return { ok: false, error: `unknown cvar "${name}"` }
    if (spec.flags.includes('readonly')) return { ok: false, error: `${spec.name} is read-only` }
    const result = this.parse(spec, input)
    if (!result.ok) return result
    this.values.set(spec.name, result.value!)
    return { ok: true, value: result.value! }
  }

  /** Validate a value without storing it (the client does this before asking the server). */
  check(name: string, input: CvarValue): CvarSetResult {
    const spec = this.spec(name)
    if (!spec) return { ok: false, error: `unknown cvar "${name}"` }
    if (spec.flags.includes('readonly')) return { ok: false, error: `${spec.name} is read-only` }
    return this.parse(spec, input)
  }

  /** Apply a value received from the server, bypassing the local read-only/cheat guard. */
  forceSet(name: string, input: CvarValue): CvarSetResult {
    const spec = this.spec(name)
    if (!spec) return { ok: false, error: `unknown cvar "${name}"` }
    const result = this.parse(spec, input)
    if (!result.ok) return result
    this.values.set(spec.name, result.value!)
    return { ok: true, value: result.value! }
  }

  /** Apply an authoritative map; unknown names are ignored (newer-server tolerance). */
  apply(values: Readonly<Record<string, CvarValue>>): string[] {
    const changed: string[] = []
    for (const [name, value] of Object.entries(values)) {
      const spec = this.spec(name)
      if (!spec) continue
      // A server payload can never change a client-only setting.
      if (!spec.flags.includes('server') && !spec.flags.includes('replicated')) continue
      const result = this.forceSet(spec.name, value)
      if (result.ok) changed.push(spec.name)
    }
    return changed
  }

  /** Canonical `{name: value}` snapshot, optionally filtered. */
  snapshot(filter?: (spec: CvarSpec) => boolean): Record<string, CvarValue> {
    const out: Record<string, CvarValue> = {}
    for (const spec of this.byName.values()) {
      if (filter && !filter(spec)) continue
      out[spec.name] = this.values.get(spec.name) ?? spec.defaultValue
    }
    return out
  }

  /** `800`, `0.1`, `1`/`0` for booleans — what the console prints. */
  formatValue(name: string, value: CvarValue | null = this.get(name)): string {
    const spec = this.spec(name)
    if (value === null) return ''
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (typeof value === 'number') {
      if (spec?.type === 'integer') return String(Math.round(value))
      return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
    }
    return value
  }

  /** `sv_gravity = 800` with the unit only when asked (help shows it separately). */
  formatLine(name: string): string {
    const spec = this.spec(name)
    if (!spec) return name
    return `${spec.name} = ${this.formatValue(name)}`
  }

  help(spec: CvarSpec): string[] {
    const lines = [
      `${spec.name} = ${this.formatValue(spec.name)}${spec.unit ? ` ${spec.unit}` : ''} [${spec.type}]`,
      spec.help,
      `flags: ${spec.flags.join(' ') || 'none'} · default: ${this.formatValue(spec.name, spec.defaultValue)}`,
    ]
    if (spec.aliases?.length) lines.push(`aliases: ${spec.aliases.join(', ')}`)
    return lines
  }

  private parse(spec: CvarSpec, input: CvarValue): CvarSetResult {
    if (spec.type === 'string') {
      if (typeof input === 'number' || typeof input === 'boolean')
        return { ok: true, value: String(input) }
      return { ok: true, value: input }
    }
    if (spec.type === 'boolean') {
      const value = boolFor(input)
      return value === null
        ? { ok: false, error: `${spec.name} expects 0 or 1` }
        : { ok: true, value }
    }
    const value = numberFor(input, spec.type)
    if (value === null)
      return {
        ok: false,
        error: `${spec.name} expects ${spec.type === 'integer' ? 'a whole number' : 'a number'}`,
      }
    if (spec.min !== undefined && value < spec.min)
      return { ok: false, error: `${spec.name} must be at least ${spec.min}` }
    if (spec.max !== undefined && value > spec.max)
      return { ok: false, error: `${spec.name} must be at most ${spec.max}` }
    return { ok: true, value }
  }
}

/** Source's gameplay scale: one Hammer unit is one inch. */
export const METRES_PER_UNIT = 0.0254

/**
 * The movement cvars of §4.2, in Source units. `target`/`scale` let both the
 * client's prediction and the server's simulation apply the exact same map.
 */
export const SOURCE_MOVEMENT_CVARS: readonly CvarSpec[] = [
  {
    name: 'sv_gravity',
    aliases: ['gravity'],
    type: 'float',
    defaultValue: 800,
    min: 0,
    max: 5000,
    unit: 'u/s²',
    target: 'gravity',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: "World gravity in Hammer units per second squared. 800 is Source's Earth-like default.",
  },
  {
    name: 'sv_accelerate',
    aliases: ['accelerate', 'groundaccel'],
    type: 'float',
    defaultValue: 10,
    min: 0,
    max: 100,
    target: 'groundAccel',
    scale: 1,
    flags: ['server', 'replicated'],
    help: 'Ground acceleration factor while walking.',
  },
  {
    name: 'sv_airaccelerate',
    aliases: ['airaccelerate', 'airaccel'],
    type: 'float',
    defaultValue: 150,
    min: 0,
    max: 1000,
    target: 'airAccel',
    scale: 1,
    flags: ['server', 'replicated'],
    help: 'Air acceleration factor. Surf servers use 150; CS:S default is 10.',
  },
  {
    name: 'sv_friction',
    aliases: ['friction'],
    type: 'float',
    defaultValue: 4,
    min: 0,
    max: 100,
    target: 'friction',
    scale: 1,
    flags: ['server', 'replicated'],
    help: 'Ground friction. CS:S uses 4.',
  },
  {
    name: 'sv_stopspeed',
    aliases: ['stopspeed'],
    type: 'float',
    defaultValue: 2.032 / METRES_PER_UNIT,
    min: 0,
    max: 1000,
    unit: 'u/s',
    target: 'stopSpeed',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: 'Speed below which friction stops the player crisply (Source: 80 u/s).',
  },
  {
    name: 'sv_maxspeed',
    aliases: ['maxspeed', 'maxgroundspeed'],
    type: 'float',
    defaultValue: 250,
    min: 0,
    max: 3500,
    unit: 'u/s',
    target: 'maxGroundSpeed',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: 'Maximum ground speed. CS:S run speed is 250 u/s.',
  },
  {
    name: 'sv_maxvelocity',
    aliases: ['maxvelocity', 'maxhorizontalspeed'],
    type: 'float',
    defaultValue: 3500,
    min: 0,
    max: 100000,
    unit: 'u/s',
    target: 'maxHorizontalSpeed',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: 'Horizontal speed ceiling. Source caps velocity at 3500 u/s.',
  },
  {
    name: 'sv_stepsize',
    aliases: ['stepsize', 'stepheight'],
    type: 'float',
    defaultValue: 18,
    min: 0,
    max: 72,
    unit: 'u',
    target: 'stepHeight',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: 'Maximum obstacle height stepped over. Source uses 18 units.',
  },
  {
    name: 'sv_air_max_wishspeed',
    aliases: ['air_max_wishspeed', 'airspeedcap'],
    type: 'float',
    defaultValue: 30,
    min: 0,
    max: 1000,
    unit: 'u/s',
    target: 'airSpeedCap',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: 'Per-tick air wish-speed cap in Hammer units. Surf uses 30 u/s (0.762 m/s per tick at 100 Hz).',
  },
  {
    name: 'sv_jump_impulse',
    aliases: ['jump_impulse', 'jumpspeed'],
    type: 'float',
    defaultValue: 301.993,
    min: 0,
    max: 1000,
    unit: 'u/s',
    target: 'jumpSpeed',
    scale: METRES_PER_UNIT,
    flags: ['server', 'replicated'],
    help: "Vertical jump impulse. Source's 301.993 u/s clears a 52-unit block.",
  },
  {
    name: 'sv_autobunnyhopping',
    aliases: ['autobunnyhopping', 'autobhop'],
    type: 'boolean',
    defaultValue: false,
    target: 'autoBhop',
    scale: 1,
    flags: ['server', 'replicated'],
    help: 'Hold jump to bunnyhop automatically. Source servers opt in; surf defaults off.',
  },
  {
    name: 'sv_standable_normal',
    aliases: ['standable_normal', 'groundnormaly'],
    type: 'float',
    defaultValue: 0.7,
    min: 0,
    max: 1,
    target: 'groundNormalY',
    scale: 1,
    flags: ['server', 'replicated'],
    help: 'Lowest surface normal Y treated as walkable ground. 0.7 ≈ 45.6°.',
  },
]

/** Client-only settings; the server never sees these. */
export const CLIENT_CVARS: readonly CvarSpec[] = [
  {
    name: 'cl_interp',
    type: 'float',
    defaultValue: 0.1,
    min: 0,
    max: 1,
    unit: 's',
    flags: ['client', 'archive'],
    help: 'Interpolation delay used for remote entities. Source default is 0.1 s.',
  },
  {
    name: 'fps_max',
    type: 'integer',
    defaultValue: 0,
    min: 0,
    max: 1000,
    flags: ['client', 'archive'],
    help: 'Frame-rate cap; 0 means the browser decides.',
  },
  {
    name: 'volume',
    type: 'float',
    defaultValue: 1,
    min: 0,
    max: 1,
    flags: ['client', 'archive'],
    help: 'Game audio volume, 0 to 1.',
  },
  {
    name: 'crosshair',
    type: 'integer',
    defaultValue: 1,
    min: 0,
    max: 1,
    flags: ['client', 'archive'],
    help: 'Draw the crosshair: 1 on, 0 off.',
  },
]
