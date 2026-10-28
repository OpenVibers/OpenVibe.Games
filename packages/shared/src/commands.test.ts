// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  AUTOEXEC_CONFIG,
  Bindings,
  ConfigStore,
  CommandRegistry,
  DEFAULT_BINDS,
  intentCommand,
  keyCodeFor,
  keyNameFromCode,
  normalizeKeyName,
  parseConfig,
  parseCommandLine,
  tokenizeCommand,
  type KeyValueStorage,
} from './commands.js'

/** A localStorage-shaped store, with the enumeration ConfigStore.list uses. */
class MemoryStorage implements KeyValueStorage {
  private readonly data = new Map<string, string>()
  get length(): number {
    return this.data.size
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }
}

describe('console config parser', () => {
  it('splits quoted arguments, comments and semicolon-separated commands', () => {
    const text = [
      '// a comment, not a command',
      'bind space +jump',
      'bind "a" "say hello world"; sv_gravity 800 // trailing',
      '',
      'exec practice.cfg',
    ].join('\n')
    expect(parseConfig(text)).toEqual([
      { name: 'bind', args: ['space', '+jump'], raw: 'bind space +jump', line: 2 },
      { name: 'bind', args: ['a', 'say hello world'], raw: 'bind a say hello world', line: 3 },
      { name: 'sv_gravity', args: ['800'], raw: 'sv_gravity 800', line: 3 },
      { name: 'exec', args: ['practice.cfg'], raw: 'exec practice.cfg', line: 5 },
    ])
  })

  it('tokenises one line and keeps empty quoted arguments', () => {
    expect(tokenizeCommand('say "hi there" x')).toEqual(['say', 'hi there', 'x'])
    expect(tokenizeCommand('bind "a" ""')).toEqual(['bind', 'a', ''])
    expect(parseCommandLine('+jump; -jump')).toEqual([
      { name: '+jump', args: [], raw: '+jump', line: 1 },
      { name: '-jump', args: [], raw: '-jump', line: 1 },
    ])
  })
})

describe('Source key names and bindings', () => {
  it('maps Source key names to stable DOM codes', () => {
    expect(keyCodeFor('space')).toBe('Space')
    expect(keyCodeFor('ctrl')).toBe('ControlLeft')
    expect(keyCodeFor('a')).toBe('KeyA')
    expect(keyCodeFor('1')).toBe('Digit1')
    expect(normalizeKeyName('grave')).toBe('~')
    expect(normalizeKeyName('KeyA')).toBe('a')
    expect(keyNameFromCode('Space')).toBe('space')
    expect(normalizeKeyName('not-a-key')).toBeNull()
  })

  it('starts from Source defaults and persists bind changes', () => {
    const storage = new MemoryStorage()
    const first = new Bindings({ storage })
    expect(first.commandForCode('Space')).toBe('+jump')
    expect(first.commandForCode('ControlLeft')).toBe('+duck')
    first.bind('space', '+duck')
    first.bind('q', 'toggle_ghost')
    expect(first.commandForCode('Space')).toBe('+duck')

    // A new browser session reads the same binds back.
    const second = new Bindings({ storage })
    expect(second.commandForCode('Space')).toBe('+duck')
    expect(second.commandForCode('KeyQ')).toBe('toggle_ghost')
    expect(second.unbind('q').ok).toBe(true)
    expect(new Bindings({ storage }).commandForCode('KeyQ')).toBeNull()
  })

  it('unbinds an intent and keeps the other defaults', () => {
    const storage = new MemoryStorage()
    const bindings = new Bindings({ storage })
    bindings.unbind('space')
    expect(bindings.commandForCode('Space')).toBeNull()
    expect(bindings.commandForCode('KeyR')).toBe(DEFAULT_BINDS.r)
    expect(intentCommand('+jump')).toEqual({ name: 'Jump', down: true })
    expect(intentCommand('-jump')).toEqual({ name: 'Jump', down: false })
    expect(intentCommand('+not-an-intent')).toBeNull()
  })
})

describe('virtual cfg files', () => {
  it('normalises names and persists through a fresh store', () => {
    const storage = new MemoryStorage()
    const configs = new ConfigStore({ storage })
    expect(configs.normalize('practice')).toBe('practice.cfg')
    expect(configs.normalize('CFG/AUTOEXEC.CFG')).toBe(AUTOEXEC_CONFIG)
    expect(configs.normalize('../evil')).toBeNull()
    expect(configs.normalize('')).toBeNull()
    expect(configs.write('practice', 'bind space +jump').ok).toBe(true)
    expect(new ConfigStore({ storage }).read('practice.cfg')).toBe('bind space +jump')
    expect(configs.list()).toEqual(['practice.cfg'])
    expect(configs.remove('practice.cfg')).toBe(true)
    expect(configs.read('practice.cfg')).toBeNull()
  })

  it('returns no list without a storage implementation', () => {
    const configs = new ConfigStore({ storage: null })
    expect(configs.write('autoexec.cfg', 'bind space +jump')).toEqual({
      ok: false,
      error: 'browser storage is unavailable',
    })
    expect(configs.list()).toEqual([])
  })
})

describe('command registry', () => {
  it('resolves aliases, searches help text and lists canonical commands once', () => {
    const registry = new CommandRegistry<{ hits: string[] }>([
      {
        name: 'help',
        aliases: ['?'],
        help: 'Show help for a command.',
        run: (args, context) => {
          context.hits.push(args.join(' '))
          return 'ok'
        },
      },
      { name: 'find', help: 'Search for a name.', run: () => [] },
    ])
    expect(registry.get('?')?.name).toBe('help')
    expect(registry.all().map((c) => c.name)).toEqual(['find', 'help'])
    expect(registry.find('search').map((c) => c.name)).toEqual(['find'])
    const context = { hits: [] as string[] }
    void registry.get('help')!.run(['gravity'], context)
    expect(context.hits).toEqual(['gravity'])
  })
})
