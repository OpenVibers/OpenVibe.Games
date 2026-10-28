/**
 * The Source-style developer console (~).
 *
 * A DOM overlay with a log, an input line, history and Tab completion. It is
 * deliberately independent of the game: the main client and the casual page
 * mount the same component, and the command table decides what each can do.
 * Server cvars are only ever requested here; the authoritative value arrives
 * in welcome/cvar_state and is applied by the caller.
 */
import {
  AUTOEXEC_CONFIG,
  Bindings,
  CommandRegistry,
  ConfigStore,
  CVARS_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  browserStorage,
  intentCommand,
  parseCommandLine,
  type CommandDef,
  type CommandResult,
  type CvarRegistry,
  type CvarSpec,
  type CvarValue,
  type KeyValueStorage,
} from '@openvibe/shared'
import './console.css'

export interface ConsoleContext {
  raw: string
  line: number
  echo(text: string | readonly string[]): void
  error(text: string): void
}

export interface ConsoleOptions {
  parent?: HTMLElement
  cvars: CvarRegistry
  bindings?: Bindings
  configs?: ConfigStore
  storage?: KeyValueStorage | null
  /** The casual page: only commands marked `readOnly` are registered. */
  readOnly?: boolean
  commands?: readonly CommandDef<ConsoleContext>[]
  /** Status lines for `status`. */
  status?: () => string | readonly string[]
}

const MAX_LOG_LINES = 600
const MAX_HISTORY = 100

type PrintKind = 'normal' | 'error' | 'echo'

/** Extract the lines/error/close intent from any command result shape. */
function resultOf(result: CommandResult): { lines: string[]; error?: string; close?: boolean } {
  if (result === undefined) return { lines: [] }
  if (typeof result === 'string') return { lines: [result] }
  if (Array.isArray(result)) return { lines: [...(result as readonly string[])] }
  const object = result as { lines?: readonly string[]; error?: string; close?: boolean }
  return {
    lines: [...(object.lines ?? [])],
    ...(object.error !== undefined ? { error: object.error } : {}),
    ...(object.close ? { close: true } : {}),
  }
}

export class GameConsole {
  readonly root: HTMLElement
  readonly bindings: Bindings
  readonly configs: ConfigStore
  readonly cvars: CvarRegistry
  readonly commands: CommandRegistry<ConsoleContext>

  private readonly logEl: HTMLElement
  private readonly inputEl: HTMLInputElement
  private readonly completionsEl: HTMLElement
  private readonly hintEl: HTMLElement
  private readonly storage: KeyValueStorage | null
  private readonly readOnly: boolean
  private readonly history: string[]
  private historyIndex: number | null = null
  private completionIndex = 0
  private completionSource = ''
  private openState = false
  private autoexecRan = false
  private requestSeq = 1
  private readonly pending = new Map<number, { name: string; value: number | boolean }>()
  private readonly writable = new Set<string>()

  /** Send a server cvar request; the caller owns the connection. */
  onCvarRequest: ((name: string, value: number | boolean, requestId: number) => void) | null = null
  /** Authoritative cvar values arrived (welcome or cvar_state). */
  onServerCvars: ((values: Record<string, number | boolean>) => void) | null = null
  /** A `+jump` / `-jump` typed in the console feeds the intent source. */
  onIntentCommand: ((name: string, down: boolean) => void) | null = null
  /** One-shot bound commands such as `toggle_ghost` and `+restart`. */
  onBoundCommand: ((command: string) => boolean) | null = null
  /** The overlay opened or closed: the caller releases/restores pointer lock. */
  onOpenChange: ((open: boolean) => void) | null = null
  /** A client cvar changed locally (volume, crosshair, fps cap). */
  onLocalCvar: ((name: string, value: CvarValue) => void) | null = null

  constructor(options: ConsoleOptions) {
    this.cvars = options.cvars
    this.bindings = options.bindings ?? new Bindings()
    this.configs = options.configs ?? new ConfigStore()
    this.storage = options.storage === undefined ? browserStorage() : options.storage
    this.readOnly = options.readOnly ?? false
    this.history = this.loadHistory()

    this.root = document.createElement('section')
    this.root.className = 'ovg-console'
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Developer console')

    const head = document.createElement('header')
    head.className = 'console-head'
    const title = document.createElement('span')
    title.className = 'console-title'
    title.textContent = 'Console'
    const hint = document.createElement('span')
    hint.className = 'console-keyhint'
    hint.textContent = '~ close · Tab complete · ↑↓ history'
    head.append(title, hint)

    this.logEl = document.createElement('div')
    this.logEl.className = 'console-log'
    this.logEl.setAttribute('role', 'log')
    this.logEl.setAttribute('aria-live', 'polite')

    const form = document.createElement('form')
    form.className = 'console-form'
    const prompt = document.createElement('span')
    prompt.className = 'console-prompt'
    prompt.textContent = ']'
    prompt.setAttribute('aria-hidden', 'true')
    this.inputEl = document.createElement('input')
    this.inputEl.className = 'console-input'
    this.inputEl.type = 'text'
    this.inputEl.autocomplete = 'off'
    this.inputEl.spellcheck = false
    this.inputEl.setAttribute('aria-label', 'Console command')
    this.inputEl.setAttribute('autocapitalize', 'off')
    this.hintEl = document.createElement('output')
    this.hintEl.className = 'console-suggestion'
    form.append(prompt, this.inputEl, this.hintEl)

    this.completionsEl = document.createElement('ul')
    this.completionsEl.className = 'console-completions'
    this.completionsEl.hidden = true
    this.completionsEl.setAttribute('aria-label', 'Completions')

    this.root.append(head, this.logEl, form, this.completionsEl)
    const parent = options.parent ?? document.body
    parent.append(this.root)

    this.commands = new CommandRegistry<ConsoleContext>()
    this.registerCoreCommands()
    if (!this.readOnly) this.registerEditCommands()
    for (const command of options.commands ?? []) {
      if (this.readOnly && !command.readOnly) continue
      this.commands.register(command)
    }
    if (options.status) this.status = options.status

    this.loadLocalCvars()
    this.inputEl.addEventListener('keydown', (e) => this.onInputKeyDown(e))
    this.inputEl.addEventListener('input', () => this.resetCompletion())
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submit()
    })
    // A press inside the console is UI, not a game click.
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.completionsEl.addEventListener('pointerdown', (e) => e.stopPropagation())
    window.addEventListener('keydown', this.onWindowKeyDown)
    window.addEventListener('keyup', this.onWindowKeyUp)
  }

  private status: () => string | readonly string[] = () => []

  get isOpen(): boolean {
    return this.openState
  }

  open(): void {
    if (this.openState) return
    this.openState = true
    this.root.hidden = false
    this.root.classList.add('is-open')
    this.onOpenChange?.(true)
    // After the current key event, so the same ~ does not race focus.
    queueMicrotask(() => this.inputEl.focus())
  }

  close(): void {
    if (!this.openState) return
    this.openState = false
    this.root.hidden = true
    this.root.classList.remove('is-open')
    this.completionsEl.hidden = true
    this.inputEl.blur()
    this.onOpenChange?.(false)
  }

  toggle(): void {
    if (this.openState) this.close()
    else this.open()
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onWindowKeyDown)
    window.removeEventListener('keyup', this.onWindowKeyUp)
    this.root.remove()
  }

  registerCommand(command: CommandDef<ConsoleContext>): void {
    if (this.readOnly && !command.readOnly) return
    this.commands.register(command)
  }

  /** Set the `status` command's text provider after the game state exists. */
  setStatusProvider(provider: () => string | readonly string[]): void {
    this.status = provider
  }

  /** Print a line (or lines) into the log; errors are red, echoes dim. */
  print(lines: string | readonly string[], kind: PrintKind = 'normal'): void {
    const list = typeof lines === 'string' ? [lines] : lines
    for (const text of list) {
      const line = document.createElement('div')
      line.className = `console-line${kind === 'error' ? ' is-error' : kind === 'echo' ? ' is-echo' : ''}`
      line.textContent = text
      this.logEl.append(line)
    }
    while (this.logEl.childElementCount > MAX_LOG_LINES) this.logEl.firstElementChild?.remove()
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  /** Apply the server's authoritative values; called after welcome and on cvar_state. */
  applyServerCvars(
    values: Record<string, number | boolean>,
    writable: readonly string[],
    options: { error?: string; requestId?: number } = {},
  ): void {
    this.writable.clear()
    for (const name of writable) this.writable.add(name)
    this.cvars.apply(values)
    this.onServerCvars?.(values)
    const pending =
      options.requestId !== undefined ? this.pending.get(options.requestId) : undefined
    if (options.requestId !== undefined) this.pending.delete(options.requestId)
    if (options.error) {
      this.print(options.error, 'error')
      return
    }
    if (pending) this.print(`${pending.name} = ${this.cvars.formatValue(pending.name)}`)
  }

  /** Run `autoexec.cfg` once, after the server's welcome has been applied. */
  async runAutoexec(): Promise<void> {
    if (this.autoexecRan || this.readOnly) return
    this.autoexecRan = true
    const text = this.configs.read(AUTOEXEC_CONFIG)
    if (!text) return
    this.print(`Executing ${AUTOEXEC_CONFIG}…`, 'echo')
    await this.runConfig(text, AUTOEXEC_CONFIG, 0)
  }

  /** Execute one line as if typed, including `;`-separated commands. */
  async executeLine(line: string): Promise<void> {
    const commands = parseCommandLine(line)
    for (const command of commands) await this.execute(command)
  }

  private async submit(): Promise<void> {
    const line = this.inputEl.value.trim()
    if (!line) {
      this.inputEl.value = ''
      this.resetCompletion()
      return
    }
    this.print(`] ${line}`, 'echo')
    this.remember(line)
    this.inputEl.value = ''
    this.historyIndex = null
    this.resetCompletion()
    await this.executeLine(line)
    this.inputEl.focus()
  }

  private async execute(command: ReturnType<typeof parseCommandLine>[number]): Promise<void> {
    const context: ConsoleContext = {
      raw: command.raw,
      line: command.line,
      echo: (text) => this.print(text),
      error: (text) => this.print(text, 'error'),
    }
    // `+jump`/`-jump` are intents, not commands: they feed the same bits a
    // bound key does. This also works for `exec` scripts.
    const intent = intentCommand(command.name)
    if (intent) {
      if (this.readOnly) {
        context.error('read-only console: intents are unavailable')
        return
      }
      this.onIntentCommand?.(intent.name, intent.down)
      this.print(`${intent.down ? '+' : '-'}${intent.name.toLowerCase()}`, 'echo')
      return
    }
    const def = this.commands.get(command.name)
    if (def) {
      try {
        const result = resultOf(await def.run(command.args, context))
        if (result.error) this.print(result.error, 'error')
        if (result.lines.length) this.print(result.lines)
        if (result.close) this.close()
      } catch (err) {
        this.print(err instanceof Error ? err.message : 'command failed', 'error')
      }
      return
    }
    const spec = this.cvars.spec(command.name)
    if (spec) {
      this.runCvar(spec, command.args)
      return
    }
    if (this.onBoundCommand?.(command.raw)) return
    this.print(`Unknown command "${command.name}". Try help or find ${command.name}.`, 'error')
  }

  private runCvar(spec: CvarSpec, args: string[]): void {
    if (!args.length) {
      this.print(
        `${spec.name} = ${this.cvars.formatValue(spec.name)}${spec.unit ? ` ${spec.unit}` : ''}`,
      )
      return
    }
    if (this.readOnly) {
      this.print('read-only console: cvars cannot be changed here', 'error')
      return
    }
    const raw = args.join(' ')
    if (spec.flags.includes('client')) {
      const result = this.cvars.set(spec.name, raw)
      if (!result.ok) {
        this.print(result.error ?? `invalid ${spec.name}`, 'error')
        return
      }
      this.persistLocalCvars()
      this.onLocalCvar?.(spec.name, result.value!)
      this.print(`${spec.name} = ${this.cvars.formatValue(spec.name)}`)
      return
    }
    // Server cvars are requests. Never change the local copy before the
    // authoritative cvar_state arrives: that would let a client predict a
    // value the server refused.
    if (!this.writable.has(spec.name)) {
      this.print(`${spec.name} is server-controlled; you do not have permission`, 'error')
      return
    }
    const checked = this.cvars.check(spec.name, raw)
    if (!checked.ok || (typeof checked.value !== 'number' && typeof checked.value !== 'boolean')) {
      this.print(checked.error ?? `${spec.name} expects a number`, 'error')
      return
    }
    const requestId = this.requestSeq++
    this.pending.set(requestId, { name: spec.name, value: checked.value })
    if (!this.onCvarRequest) {
      this.pending.delete(requestId)
      this.print('not connected: server cvars are unavailable', 'error')
      return
    }
    this.onCvarRequest(spec.name, checked.value, requestId)
    this.print(`Requesting ${spec.name} = ${checked.value} (server)`, 'echo')
  }

  private async runConfig(text: string, name: string, depth: number): Promise<boolean> {
    if (depth > 8) {
      this.print(`exec ${name}: nested configs are too deep`, 'error')
      return false
    }
    let ok = true
    for (const command of parseCommandLine(text)) {
      if (command.name.toLowerCase() === 'exec' && depth >= 8) {
        this.print('exec: nested configs are too deep', 'error')
        return false
      }
      // Re-dispatch through the regular path so binds/cvars/commands behave
      // exactly as if typed.
      try {
        await this.execute(command)
      } catch (err) {
        ok = false
        this.print(
          `${name}:${command.line}: ${err instanceof Error ? err.message : 'failed'}`,
          'error',
        )
      }
    }
    return ok
  }

  private loadHistory(): string[] {
    try {
      const raw = this.storage?.getItem(HISTORY_STORAGE_KEY) ?? null
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((line): line is string => typeof line === 'string').slice(-MAX_HISTORY)
        : []
    } catch {
      return []
    }
  }

  private remember(line: string): void {
    if (this.history[this.history.length - 1] !== line) this.history.push(line)
    while (this.history.length > MAX_HISTORY) this.history.shift()
    try {
      this.storage?.setItem(HISTORY_STORAGE_KEY, JSON.stringify(this.history))
    } catch {
      // History is a convenience; a refused localStorage must not break the console.
    }
  }

  private loadLocalCvars(): void {
    try {
      const raw = this.storage?.getItem(CVARS_STORAGE_KEY) ?? null
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [name, value] of Object.entries(parsed)) {
        const spec = this.cvars.spec(name)
        if (!spec?.flags.includes('client')) continue
        if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string')
          continue
        this.cvars.set(spec.name, value)
      }
    } catch {
      // Corrupt settings fall back to the defaults.
    }
  }

  private persistLocalCvars(): void {
    if (!this.storage) return
    const values = this.cvars.snapshot((spec) => spec.flags.includes('client'))
    try {
      this.storage.setItem(CVARS_STORAGE_KEY, JSON.stringify(values))
    } catch {
      // Private mode/quota: the value still applies this session.
    }
  }

  private onWindowKeyDown = (e: KeyboardEvent): void => {
    // A bound `~ toggleconsole` already prevented the default and toggled
    // through InputTracker.onBind; do not toggle twice.
    if (e.defaultPrevented) return
    if (this.openState) {
      if (e.code === 'Escape' || e.code === 'Backquote') {
        e.preventDefault()
        this.close()
      }
      return
    }
    if (e.code === 'Backquote') {
      e.preventDefault()
      this.open()
    }
  }

  private onWindowKeyUp = (e: KeyboardEvent): void => {
    if (!this.openState) return
    if (e.code === 'Backquote' || e.code === 'Escape') e.preventDefault()
  }

  private onInputKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      void this.submit()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      this.complete()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.historyStep(-1)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.historyStep(1)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    }
  }

  private historyStep(direction: -1 | 1): void {
    if (!this.history.length) return
    if (this.historyIndex === null) {
      if (direction === 1) return
      this.historyIndex = this.history.length - 1
    } else {
      const next = this.historyIndex + direction
      if (next < 0) {
        this.historyIndex = 0
      } else if (next >= this.history.length) {
        this.historyIndex = null
        this.inputEl.value = ''
        this.resetCompletion()
        return
      } else {
        this.historyIndex = next
      }
    }
    this.inputEl.value = this.history[this.historyIndex] ?? ''
    this.resetCompletion()
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length)
  }

  private complete(): void {
    const value = this.inputEl.value
    const start = value.lastIndexOf(' ', this.inputEl.selectionStart ?? value.length) + 1
    const prefix = value.slice(start)
    const source = `${start}:${prefix}`
    if (source !== this.completionSource) {
      this.completionSource = source
      this.completionIndex = -1
    }
    const candidates = this.completionCandidates(prefix)
    if (!candidates.length) {
      this.completionsEl.hidden = true
      return
    }
    this.completionIndex = (this.completionIndex + 1) % candidates.length
    const candidate = candidates[this.completionIndex]!
    this.inputEl.value = value.slice(0, start) + candidate + value.slice(start + prefix.length)
    this.inputEl.setSelectionRange(start + candidate.length, start + candidate.length)
    this.renderCompletions(candidates.slice(0, 10), candidate)
  }

  private completionCandidates(prefix: string): string[] {
    const names = new Set<string>()
    for (const name of this.commands.matching(prefix)) names.add(name)
    for (const name of this.cvars.matching(prefix)) names.add(name)
    return [...names].sort()
  }

  private renderCompletions(candidates: readonly string[], selected: string): void {
    this.completionsEl.replaceChildren(
      ...candidates.map((name) => {
        const item = document.createElement('li')
        item.className = `console-completion${name === selected ? ' is-selected' : ''}`
        item.textContent = name
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          const value = this.inputEl.value
          const start = value.lastIndexOf(' ', this.inputEl.selectionStart ?? value.length) + 1
          const end = this.inputEl.selectionStart ?? value.length
          this.inputEl.value = value.slice(0, start) + name + value.slice(end)
          this.inputEl.setSelectionRange(start + name.length, start + name.length)
          this.completionsEl.hidden = true
          this.inputEl.focus()
        })
        return item
      }),
    )
    this.completionsEl.hidden = false
  }

  private resetCompletion(): void {
    this.completionIndex = 0
    this.completionSource = ''
    this.completionsEl.hidden = true
  }

  private registerCoreCommands(): void {
    this.commands.register({
      name: 'help',
      aliases: ['?'],
      readOnly: true,
      usage: 'help [command|cvar|text]',
      help: 'List commands and cvars, or explain one name. With text, same as find.',
      run: (args, _context) => {
        const query = args[0]
        if (!query) {
          const commands = this.commands.all().map((command) => command.name)
          return [
            `Commands: ${commands.join(', ')}`,
            `Cvars: ${this.cvars.all().length} (cvarlist) · search with find <text>`,
          ]
        }
        const def = this.commands.get(query)
        if (def) return this.commands.help(def)
        const spec = this.cvars.spec(query)
        if (spec) return this.cvars.help(spec)
        return this.findLines(args.join(' '))
      },
    })
    this.commands.register({
      name: 'find',
      readOnly: true,
      usage: 'find <text>',
      help: 'Search command names, cvar names and help text.',
      run: (args, _context) =>
        args.length ? this.findLines(args.join(' ')) : 'usage: find <text>',
    })
    this.commands.register({
      name: 'cvarlist',
      readOnly: true,
      usage: 'cvarlist [prefix]',
      help: 'List server and client cvars with their current values.',
      run: (args, _context) => {
        const prefix = (args[0] ?? '').toLowerCase()
        const specs = this.cvars.all().filter((spec) => spec.name.startsWith(prefix))
        if (!specs.length) return `no cvars match "${prefix}"`
        return specs.map(
          (spec) =>
            `${spec.name} = ${this.cvars.formatValue(spec.name)}${spec.unit ? ` ${spec.unit}` : ''} [${spec.flags.join(' ')}]`,
        )
      },
    })
    this.commands.register({
      name: 'clear',
      aliases: ['cls'],
      readOnly: true,
      help: 'Clear the console log.',
      run: () => {
        this.logEl.replaceChildren()
      },
    })
    this.commands.register({
      name: 'echo',
      readOnly: true,
      usage: 'echo <text>',
      help: 'Print text to the console.',
      run: (args) => args.join(' '),
    })
    this.commands.register({
      name: 'status',
      readOnly: true,
      help: 'Show connection and world status supplied by the page.',
      run: () => this.status(),
    })
    this.commands.register({
      name: 'toggleconsole',
      readOnly: true,
      help: 'Close the console. Bound to ~ by default.',
      run: () => ({ close: true }),
    })
  }

  private registerEditCommands(): void {
    this.commands.register({
      name: 'bind',
      usage: 'bind [key] [command]',
      help: 'Show, set or list key bindings. Persisted in this browser.',
      run: (args) => {
        if (!args.length) {
          return this.bindings.entries().map(({ key, command }) => `${key} = ${command}`)
        }
        const key = args[0]!
        if (args.length === 1) {
          const bound = this.bindings.get(key)
          return bound ? `${key} = ${bound}` : `${key} is not bound`
        }
        const command = args.slice(1).join(' ')
        const result = this.bindings.bind(key, command)
        return result.ok ? `${result.key} = ${command}` : { error: result.error }
      },
    })
    this.commands.register({
      name: 'unbind',
      usage: 'unbind <key>',
      help: 'Remove a key binding.',
      run: (args) => {
        if (!args.length) return 'usage: unbind <key>'
        const result = this.bindings.unbind(args[0]!)
        return result.ok ? `${result.key} is unbound` : { error: result.error }
      },
    })
    this.commands.register({
      name: 'writecfg',
      aliases: ['savecfg'],
      usage: 'writecfg <name.cfg> "<commands>"',
      help: 'Save commands to a virtual cfg in this browser (quotes keep ;-separated commands).',
      run: (args) => {
        if (args.length < 2) return 'usage: writecfg <name.cfg> "<commands>"'
        const result = this.configs.write(args[0]!, args.slice(1).join(' '))
        return result.ok ? `wrote ${result.name}` : { error: result.error }
      },
    })
    this.commands.register({
      name: 'exec',
      usage: 'exec <name.cfg>',
      help: 'Run a saved cfg from this browser (exec practice.cfg).',
      run: async (args, context) => {
        if (!args.length) return 'usage: exec <name.cfg>'
        const name = this.configs.normalize(args[0]!)
        if (!name) return { error: `invalid config name "${args[0]}"` }
        const text = this.configs.read(name)
        if (text === null) return { error: `couldn't exec ${name}` }
        this.print(`Executing ${name}…`, 'echo')
        await this.runConfig(text, name, 1)
        context.echo(`exec ${name}: done`)
      },
    })
  }

  private findLines(text: string): string[] {
    const needle = text.trim()
    if (!needle) return ['usage: find <text>']
    const commands = this.commands.find(needle)
    const specs = this.cvars.find(needle)
    if (!commands.length && !specs.length) return [`nothing found for "${needle}"`]
    return [
      ...commands.map((command) => `[cmd] ${command.name} — ${command.help}`),
      ...specs.map(
        (spec) => `[cvar] ${spec.name} = ${this.cvars.formatValue(spec.name)} — ${spec.help}`,
      ),
    ]
  }
}
