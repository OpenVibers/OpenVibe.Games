// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTOEXEC_CONFIG,
  Bindings,
  ConfigStore,
  CvarRegistry,
  CLIENT_CVARS,
  SOURCE_MOVEMENT_CVARS,
  type KeyValueStorage,
} from '@openvibe/shared'
import { movementCvarValues, SURF_MOVEMENT } from '@openvibe/gameplay'
import { GameConsole } from './console.js'

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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function makeConsole(options: { readOnly?: boolean } = {}) {
  const storage = new MemoryStorage()
  const cvars = new CvarRegistry([...SOURCE_MOVEMENT_CVARS, ...CLIENT_CVARS])
  cvars.apply(movementCvarValues(SURF_MOVEMENT))
  const bindings = new Bindings({ storage })
  const configs = new ConfigStore({ storage })
  const console = new GameConsole({
    parent: document.body,
    cvars,
    bindings,
    configs,
    storage,
    ...(options.readOnly ? { readOnly: true } : {}),
  })
  const input = console.root.querySelector('.console-input') as HTMLInputElement
  const log = console.root.querySelector('.console-log') as HTMLElement
  const key = (target: EventTarget, code: string, value = '') =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        code,
        key: value || code,
        bubbles: true,
        cancelable: true,
      }),
    )
  const run = async (line: string) => {
    input.value = line
    key(input, 'Enter', 'Enter')
    await flush()
  }
  return { console, storage, cvars, bindings, configs, input, log, key, run }
}

let mounted: GameConsole | null = null
afterEach(() => {
  mounted?.destroy()
  mounted = null
  document.body.innerHTML = ''
})

describe('developer console overlay', () => {
  it('opens with ~, accepts typed commands and closes with Escape', async () => {
    const { console, root } = (() => {
      const made = makeConsole()
      mounted = made.console
      return { console: made.console, root: made.console.root }
    })()
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Backquote',
        key: '`',
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(root.hidden).toBe(false)
    expect(console.isOpen).toBe(true)
    await flush()
    const input = root.querySelector('.console-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)

    input.value = 'help sv_gravity'
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Enter',
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    )
    await flush()
    expect(root.querySelector('.console-log')?.textContent).toContain('sv_gravity = 800')

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Escape',
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(root.hidden).toBe(true)
    expect(console.isOpen).toBe(false)
  })

  it('keeps history and completes names with Tab', async () => {
    const { console, root, input, key, run } = (() => {
      const made = makeConsole()
      mounted = made.console
      return { ...made, root: made.console.root }
    })()
    console.open()
    await run('help')
    await run('sv_gravity')
    key(input, 'ArrowUp', 'ArrowUp')
    expect(input.value).toBe('sv_gravity')
    key(input, 'ArrowUp', 'ArrowUp')
    expect(input.value).toBe('help')
    key(input, 'ArrowDown', 'ArrowDown')
    expect(input.value).toBe('sv_gravity')

    input.value = 'sv_grav'
    input.setSelectionRange(input.value.length, input.value.length)
    key(input, 'Tab', 'Tab')
    expect(input.value).toBe('sv_gravity')
    expect(root.querySelector('.console-completions')?.childElementCount).toBeGreaterThan(0)
  })

  it('never changes a server cvar without permission or an authoritative reply', async () => {
    const { console, cvars } = (() => {
      const made = makeConsole()
      mounted = made.console
      return made
    })()
    const requests: { name: string; value: number | boolean; requestId: number }[] = []
    console.onCvarRequest = (name, value, requestId) => requests.push({ name, value, requestId })
    const values = movementCvarValues(SURF_MOVEMENT)
    console.applyServerCvars(values, [])

    await console.executeLine('sv_gravity 500')
    expect(requests).toEqual([])
    expect(cvars.get('sv_gravity')).toBe(800)
    expect(console.root.querySelector('.console-log')?.textContent).toContain('server-controlled')

    console.applyServerCvars(values, ['sv_gravity'])
    await console.executeLine('sv_gravity 500')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ name: 'sv_gravity', value: 500 })
    // Still 800: a request is not a value.
    expect(cvars.get('sv_gravity')).toBe(800)

    console.applyServerCvars({ ...values, sv_gravity: 500 }, ['sv_gravity'], {
      requestId: requests[0]!.requestId,
    })
    expect(cvars.get('sv_gravity')).toBe(500)
  })

  it('applies exec practice.cfg and autoexec after welcome', async () => {
    const { console, bindings, configs } = (() => {
      const made = makeConsole()
      mounted = made.console
      return made
    })()
    expect(configs.write('practice', 'bind space +duck').ok).toBe(true)
    await console.executeLine('exec practice.cfg')
    expect(bindings.commandForCode('Space')).toBe('+duck')
    expect(console.root.querySelector('.console-log')?.textContent).toContain(
      'Executing practice.cfg',
    )

    expect(configs.write(AUTOEXEC_CONFIG, 'bind space +jump').ok).toBe(true)
    await console.runAutoexec()
    expect(bindings.commandForCode('Space')).toBe('+jump')
  })

  it('is read-only in the casual mount', async () => {
    const { console, cvars, bindings } = (() => {
      const made = makeConsole({ readOnly: true })
      mounted = made.console
      return made
    })()
    console.applyServerCvars(movementCvarValues(SURF_MOVEMENT), ['sv_gravity'])
    await console.executeLine('sv_gravity 500')
    expect(cvars.get('sv_gravity')).toBe(800)
    expect(console.root.querySelector('.console-log')?.textContent).toContain('read-only')
    await console.executeLine('bind space +duck')
    expect(bindings.commandForCode('Space')).toBe('+jump')
    await console.executeLine('cvarlist sv_gravity')
    expect(console.root.querySelector('.console-log')?.textContent).toContain('sv_gravity = 800')
  })
})
