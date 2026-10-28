/**
 * Source-style console input primitives shared by the client's two pages.
 *
 * Nothing here touches the DOM: the parser, the key-binding table, the tiny
 * virtual config filesystem and the command registry are pure data and can be
 * tested on their own. The console overlay in apps/client/src/ui/console.ts is
 * the presentation layer.
 */
import type { IntentName } from './intents.js'

/** The small storage surface the browser and tests both provide. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Present on localStorage; tests may omit it. */
  readonly length?: number
  key?(index: number): string | null
}

/** localStorage, or null where the browser refuses it (private mode, blocked site data). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** One command after tokenising: `bind space +jump` -> name `bind`, args `['space', '+jump']`. */
export interface ParsedCommand {
  name: string
  args: string[]
  /** The command as it reads after tokenising (quotes removed). */
  raw: string
  /** 1-based line in the config it came from. */
  line: number
}

/** Split one line into arguments, honouring quotes and `//` comments. */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = []
  let token = ''
  let inToken = false
  let quoted = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (escaped) {
      token += c
      inToken = true
      escaped = false
      continue
    }
    if (quoted && c === '\\') {
      escaped = true
      continue
    }
    if (c === '"') {
      quoted = !quoted
      inToken = true
      continue
    }
    if (!quoted && c === '/' && line[i + 1] === '/') break
    if (!quoted && /\s/.test(c)) {
      if (inToken) {
        tokens.push(token)
        token = ''
        inToken = false
      }
      continue
    }
    token += c
    inToken = true
  }
  if (escaped) token += '\\'
  if (inToken) tokens.push(token)
  return tokens
}

/**
 * Parse a Source cfg / console script. Newlines and semicolons separate
 * commands; `//` comments and quoted arguments are honoured. A command split
 * over several lines fails rather than guessing, matching Source's
 * one-command-per-line configs.
 */
export function parseConfig(text: string): ParsedCommand[] {
  const commands: ParsedCommand[] = []
  let tokens: string[] = []
  let token = ''
  let inToken = false
  let quoted = false
  let escaped = false
  let line = 1
  let commandLine = 1

  const flushToken = (): void => {
    if (!inToken) return
    tokens.push(token)
    token = ''
    inToken = false
  }
  const flushCommand = (): void => {
    flushToken()
    if (!tokens.length) {
      commandLine = line
      return
    }
    const name = tokens[0]!
    commands.push({
      name,
      args: tokens.slice(1),
      raw: tokens.join(' '),
      line: commandLine,
    })
    tokens = []
    commandLine = line
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (escaped) {
      token += c
      inToken = true
      escaped = false
      continue
    }
    if (quoted && c === '\\') {
      escaped = true
      continue
    }
    if (c === '"') {
      quoted = !quoted
      inToken = true
      continue
    }
    if (!quoted && c === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
      continue
    }
    if (!quoted && (c === '\n' || c === ';')) {
      flushCommand()
      if (c === '\n') line++
      commandLine = line
      continue
    }
    if (!quoted && /\s/.test(c)) {
      flushToken()
      continue
    }
    token += c
    inToken = true
  }
  if (escaped) token += '\\'
  flushCommand()
  return commands
}

/** Parse one console line into the commands it carries. */
export function parseCommandLine(line: string): ParsedCommand[] {
  return parseConfig(line)
}

/**
 * Source key names, normalised. The browser's `KeyboardEvent.code` is the
 * stable identity (layout-independent); a player's `bind a +jump` means the
 * physical A key, exactly as Source reads it.
 */
const KEY_TO_CODE: Readonly<Record<string, string>> = {
  '~': 'Backquote',
  '`': 'Backquote',
  backquote: 'Backquote',
  grave: 'Backquote',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  ctrl: 'ControlLeft',
  control: 'ControlLeft',
  shift: 'ShiftLeft',
  alt: 'AltLeft',
  option: 'AltLeft',
  capslock: 'CapsLock',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  minus: 'Minus',
  equal: 'Equal',
  equals: 'Equal',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
  semicolon: 'Semicolon',
  apostrophe: 'Quote',
  quote: 'Quote',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight',
  backslash: 'Backslash',
}

/** Preferred spelling for each physical key: one name per DOM code. */
const CODE_TO_KEY: Readonly<Record<string, string>> = {
  Backquote: '~',
  Space: 'space',
  Tab: 'tab',
  Enter: 'enter',
  Escape: 'escape',
  ControlLeft: 'ctrl',
  ShiftLeft: 'shift',
  AltLeft: 'alt',
  CapsLock: 'capslock',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Minus: 'minus',
  Equal: 'equal',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Semicolon: 'semicolon',
  Quote: 'apostrophe',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
}

/** Normalise a Source key name to one canonical spelling; null when it is not a known key. */
export function normalizeKeyName(name: string): string | null {
  const code = keyCodeFor(name)
  return code ? keyNameFromCode(code) : null
}

/** The DOM code a Source key name means, or null when it is not a keyboard key. */
export function keyCodeFor(name: string): string | null {
  const raw = name.trim().toLowerCase()
  const mapped = KEY_TO_CODE[raw]
  if (mapped) return mapped
  if (/^[a-z]$/.test(raw)) return `Key${raw.toUpperCase()}`
  if (/^[0-9]$/.test(raw)) return `Digit${raw}`
  if (/^f([1-9]|1[0-2])$/.test(raw)) return `F${raw.slice(1)}`
  // A DOM code supplied directly (case-sensitive spellings).
  if (
    /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Control(Left|Right)|Shift(Left|Right)|Alt(Left|Right)|[A-Z][A-Za-z]+)$/.test(
      name.trim(),
    )
  )
    return name.trim()
  return null
}

/** The Source key name for a DOM code (the inverse of keyCodeFor where it is unambiguous). */
export function keyNameFromCode(code: string): string | null {
  const direct = CODE_TO_KEY[code]
  if (direct) return direct
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase()
  return null
}

/** Config cvars and binds are per-browser, as Source's cfg files are per-install. */
export const BINDS_STORAGE_KEY = 'openvibe.console.binds'
export const CVARS_STORAGE_KEY = 'openvibe.console.cvars'
export const HISTORY_STORAGE_KEY = 'openvibe.console.history'
export const CONFIG_STORAGE_PREFIX = 'openvibe.cfg.'
export const AUTOEXEC_CONFIG = 'autoexec.cfg'

/**
 * The keys a fresh install starts with. The default is Source-vocabulary:
 * `+jump` and friends are intent commands; the console reads the same table.
 */
export const DEFAULT_BINDS: Readonly<Record<string, string>> = Object.freeze({
  space: '+jump',
  ctrl: '+duck',
  c: '+duck',
  shift: '+sprint',
  z: '+prone',
  r: '+restart',
  g: 'toggle_ghost',
  '~': 'toggleconsole',
})

export interface BindingsOptions {
  storage?: KeyValueStorage | null
  storageKey?: string
  defaults?: Readonly<Record<string, string>>
}

/** Key -> command bindings, persisted as a single localStorage value. */
export class Bindings {
  private readonly values = new Map<string, string>()
  private readonly storage: KeyValueStorage | null
  private readonly storageKey: string
  private readonly defaults: Readonly<Record<string, string>>

  constructor(options: BindingsOptions = {}) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage
    this.storageKey = options.storageKey ?? BINDS_STORAGE_KEY
    this.defaults = options.defaults ?? DEFAULT_BINDS
    for (const [key, command] of Object.entries(this.defaults)) {
      const normalized = normalizeKeyName(key)
      if (normalized) this.values.set(normalized, command)
    }
    this.load()
  }

  private load(): void {
    let raw: string | null = null
    try {
      raw = this.storage?.getItem(this.storageKey) ?? null
    } catch {
      return
    }
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { v?: number; binds?: Record<string, unknown> }
      if (parsed.v !== 1 || !parsed.binds || typeof parsed.binds !== 'object') return
      for (const [key, command] of Object.entries(parsed.binds)) {
        const normalized = normalizeKeyName(key)
        if (normalized && typeof command === 'string' && command.trim()) {
          this.values.set(normalized, command.trim())
        }
      }
    } catch {
      // Corrupt storage: defaults still work.
    }
  }

  private save(): void {
    if (!this.storage) return
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({ v: 1, binds: this.asRecord() }))
    } catch {
      // Private mode/quota: the bindings still work until reload.
    }
  }

  /** Bind a key; an empty command unbinds it. Returns the canonical key. */
  bind(key: string, command: string): { ok: true; key: string } | { ok: false; error: string } {
    const normalized = normalizeKeyName(key)
    if (!normalized) return { ok: false, error: `unknown key "${key}"` }
    if (!command.trim()) {
      this.values.delete(normalized)
    } else {
      this.values.set(normalized, command.trim())
    }
    this.save()
    return { ok: true, key: normalized }
  }

  unbind(key: string): { ok: true; key: string } | { ok: false; error: string } {
    const normalized = normalizeKeyName(key)
    if (!normalized) return { ok: false, error: `unknown key "${key}"` }
    this.values.delete(normalized)
    this.save()
    return { ok: true, key: normalized }
  }

  get(key: string): string | null {
    const normalized = normalizeKeyName(key)
    return normalized ? (this.values.get(normalized) ?? null) : null
  }

  /** The command a DOM key code expresses, if any. */
  commandForCode(code: string): string | null {
    const name = keyNameFromCode(code)
    return name ? (this.values.get(name) ?? null) : null
  }

  /** Every binding, sorted by key name. */
  entries(): { key: string; command: string }[] {
    return [...this.values.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, command]) => ({ key, command }))
  }

  asRecord(): Record<string, string> {
    return Object.fromEntries(this.values)
  }
}

/** What a `+command` means for the intent bitfield. */
const INTENT_COMMANDS: Readonly<Record<string, IntentName>> = {
  jump: 'Jump',
  duck: 'Crouch',
  crouch: 'Crouch',
  sprint: 'Sprint',
  use: 'Use',
  attack: 'Attack',
  prone: 'Prone',
}

/** `+jump` -> { name: 'Jump', down: true }; `-jump` -> down false. */
export function intentCommand(command: string): { name: IntentName; down: boolean } | null {
  const raw = command.trim().toLowerCase()
  if (raw.length < 2) return null
  const sign = raw[0]
  if (sign !== '+' && sign !== '-') return null
  const name = INTENT_COMMANDS[raw.slice(1)]
  return name ? { name, down: sign === '+' } : null
}

/** Is this a `+`/`-` intent command (so a bind should feed intents, not a one-shot action)? */
export function isIntentCommand(command: string): boolean {
  return intentCommand(command) !== null
}

export interface ConfigStoreOptions {
  storage?: KeyValueStorage | null
  prefix?: string
}

/** A virtual `.cfg` folder in localStorage: `exec practice.cfg`, `autoexec.cfg`, etc. */
export class ConfigStore {
  private readonly storage: KeyValueStorage | null
  private readonly prefix: string

  constructor(options: ConfigStoreOptions = {}) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage
    this.prefix = options.prefix ?? CONFIG_STORAGE_PREFIX
  }

  /** `practice`, `practice.cfg` and `PRACTICE.CFG` all name `practice.cfg`. */
  normalize(name: string): string | null {
    let value = name.trim().toLowerCase()
    if (value.startsWith('cfg/')) value = value.slice(4)
    if (!value) return null
    if (!value.endsWith('.cfg')) value += '.cfg'
    if (!/^[a-z0-9][a-z0-9_.-]*\.cfg$/.test(value)) return null
    if (value.includes('..')) return null
    return value
  }

  read(name: string): string | null {
    const key = this.normalize(name)
    if (!key || !this.storage) return null
    try {
      return this.storage.getItem(this.prefix + key)
    } catch {
      return null
    }
  }

  has(name: string): boolean {
    return this.read(name) !== null
  }

  write(name: string, text: string): { ok: true; name: string } | { ok: false; error: string } {
    const key = this.normalize(name)
    if (!key) return { ok: false, error: `invalid config name "${name}"` }
    if (!this.storage) return { ok: false, error: 'browser storage is unavailable' }
    try {
      this.storage.setItem(this.prefix + key, text)
      return { ok: true, name: key }
    } catch {
      return { ok: false, error: 'browser storage refused the config' }
    }
  }

  remove(name: string): boolean {
    const key = this.normalize(name)
    if (!key || !this.storage) return false
    try {
      this.storage.removeItem(this.prefix + key)
      return true
    } catch {
      return false
    }
  }

  list(): string[] {
    if (!this.storage) return []
    const prefix = this.prefix
    const names: string[] = []
    try {
      const length = this.storage.length ?? 0
      for (let i = 0; i < length; i++) {
        const key = this.storage.key?.(i)
        if (key?.startsWith(prefix)) names.push(key.slice(prefix.length))
      }
    } catch {
      return []
    }
    return names.sort()
  }
}

/** The result a command reports back to the console. */
export type CommandResult =
  string | readonly string[] | { lines?: readonly string[]; error?: string; close?: boolean } | void

/** One console command. `run` may be async (exec and server round-trips are). */
export interface CommandDef<C = unknown> {
  name: string
  aliases?: readonly string[]
  usage?: string
  help: string
  /** Allowed in the casual page's read-only console. */
  readOnly?: boolean
  run(args: string[], context: C): CommandResult | Promise<CommandResult>
}

/** A case-insensitive command table with alias lookup and help search. */
export class CommandRegistry<C = unknown> {
  private readonly canonical = new Map<string, CommandDef<C>>()
  private readonly byName = new Map<string, CommandDef<C>>()

  constructor(defs: readonly CommandDef<C>[] = []) {
    for (const def of defs) this.register(def)
  }

  register(def: CommandDef<C>): void {
    const name = def.name.trim().toLowerCase()
    if (!name) throw new Error('command name must not be empty')
    if (this.byName.has(name)) throw new Error(`duplicate command "${name}"`)
    this.canonical.set(name, def)
    this.byName.set(name, def)
    for (const alias of def.aliases ?? []) {
      const key = alias.trim().toLowerCase()
      if (!key) continue
      if (this.byName.has(key)) throw new Error(`duplicate command alias "${key}"`)
      this.byName.set(key, def)
    }
  }

  get(name: string): CommandDef<C> | null {
    return this.byName.get(name.trim().toLowerCase()) ?? null
  }

  /** Registered commands in name order (aliases are not repeated). */
  all(): CommandDef<C>[] {
    return [...this.canonical.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Command and alias names starting with `prefix`. */
  matching(prefix: string): string[] {
    const p = prefix.trim().toLowerCase()
    return [...this.byName.keys()].filter((name) => name.startsWith(p)).sort()
  }

  /** Commands whose name, alias or help contains `text`. */
  find(text: string): CommandDef<C>[] {
    const needle = text.trim().toLowerCase()
    if (!needle) return this.all()
    const out = new Set<CommandDef<C>>()
    for (const def of this.canonical.values()) {
      if (
        def.name.toLowerCase().includes(needle) ||
        def.help.toLowerCase().includes(needle) ||
        (def.aliases ?? []).some((a) => a.toLowerCase().includes(needle))
      )
        out.add(def)
    }
    return [...out].sort((a, b) => a.name.localeCompare(b.name))
  }

  help(def: CommandDef<C>): string[] {
    const lines = [def.usage ? `${def.name} — ${def.usage}` : def.name, def.help]
    if (def.aliases?.length) lines.push(`aliases: ${def.aliases.join(', ')}`)
    return lines
  }
}
