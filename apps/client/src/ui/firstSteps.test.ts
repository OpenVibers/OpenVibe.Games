// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { FIRST_STEPS, FirstSteps, progress } from './firstSteps.js'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
}

let items: Record<string, number>
let levels: Record<string, number>
const read = () => ({ count: (i: string) => items[i] ?? 0, level: (s: string) => levels[s] ?? 1 })
let root: HTMLElement
let storage: MemoryStorage

beforeEach(() => {
  items = {}
  levels = {}
  document.body.innerHTML = '<div id="ui"></div>'
  root = document.getElementById('ui')!
  storage = new MemoryStorage()
})
const steps = () => [...root.querySelectorAll('.first-steps li')]
const current = () => root.querySelector('.first-steps li.current')?.textContent ?? ''

describe('first steps', () => {
  it('starts on gathering, with the hint for that step only', () => {
    new FirstSteps(root, read, storage as unknown as Storage)
    expect(steps()).toHaveLength(FIRST_STEPS.length)
    expect(current()).toContain('Gather branches and stones')
    expect(current()).toContain('inside every city gate')
    expect(root.querySelectorAll('.first-steps .hint')).toHaveLength(1)
  })

  it('moves on as the player gathers, crafts and levels, and never goes back', () => {
    const fs = new FirstSteps(root, read, storage as unknown as Storage)
    items = { wood_log: 2, stone: 3 }
    fs.update()
    expect(current()).toContain('Craft a Stone Axe')
    items = { stone_axe: 1 }
    fs.update()
    expect(current()).toContain('Chop an oak')
    levels = { woodcutting: 2 }
    fs.update()
    expect(current()).toContain('Mine at the quarry')
    items = {} // dropped everything: progress stays
    levels = {}
    fs.update()
    expect(current()).toContain('Mine at the quarry')
    expect(root.querySelector('.first-steps-head')?.textContent).toContain('3/6')
  })

  it('finishes with a haul and then hides', () => {
    const fs = new FirstSteps(root, read, storage as unknown as Storage)
    items = { stone_axe: 1, scrap_metal: 5 }
    levels = { woodcutting: 3, mining: 2 }
    fs.update()
    expect(current()).toContain('Extract a haul')
    fs.onAnnounce('🚁 Extracted! 0 stacks secured · 0 haul points.')
    expect(current()).toContain('Extract a haul')
    fs.onAnnounce('🚁 Extracted! 2 stacks secured · 140 haul points.')
    expect((root.querySelector('.first-steps') as HTMLElement).hidden).toBe(true)
  })

  it('keeps progress in the browser and stays closed once closed', () => {
    const fs = new FirstSteps(root, read, storage as unknown as Storage)
    items = { wood_log: 1, stone: 1 }
    fs.update()
    root.innerHTML = ''
    new FirstSteps(root, read, storage as unknown as Storage)
    expect(current()).toContain('Craft a Stone Axe')
    ;(root.querySelector('[data-first-steps-close]') as HTMLButtonElement).click()
    expect((root.querySelector('.first-steps') as HTMLElement).hidden).toBe(true)
    root.innerHTML = ''
    new FirstSteps(root, read, storage as unknown as Storage)
    expect((root.querySelector('.first-steps') as HTMLElement).hidden).toBe(true)
  })

  it('progress() unions what was done with what is done now', () => {
    const view = { count: () => 0, level: (s: string) => (s === 'mining' ? 2 : 1), hauled: false }
    expect(progress(view, { done: ['gather'] })).toEqual(['gather', 'mine'])
  })
})
