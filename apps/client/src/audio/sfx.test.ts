import { describe, expect, it } from 'vitest'
import { footstepSurface, materialForVisual, readVolume, saveVolume } from './sfx.js'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
}

describe('footstepSurface', () => {
  const WATER = -0.42
  it('is grass on the terrain', () => {
    expect(footstepSurface(3.02, 3, WATER)).toBe('grass')
  })
  it('is stone on anything standing above the terrain (a pavement slab, a floor)', () => {
    expect(footstepSurface(2.4, 2.2, WATER)).toBe('stone')
  })
  it('is water wading where the ground is below the waterline', () => {
    expect(footstepSurface(-0.5, -0.5, WATER)).toBe('water')
  })
  it('is not water on a pier or deck over the water', () => {
    expect(footstepSurface(0.6, -1.2, WATER)).toBe('stone')
  })
})

describe('materialForVisual', () => {
  it('maps node looks to what they sound like when hit', () => {
    expect(materialForVisual('tree')).toBe('wood')
    expect(materialForVisual('branches')).toBe('wood')
    expect(materialForVisual('rock')).toBe('stone')
    expect(materialForVisual('stones')).toBe('stone')
    expect(materialForVisual('scrap')).toBe('metal')
    expect(materialForVisual(undefined)).toBe('plant')
  })
})

describe('volume', () => {
  it('defaults to 60% and keeps what was saved, clamped to 0..1', () => {
    const storage = new MemoryStorage()
    expect(readVolume(storage)).toBe(0.6)
    saveVolume(0.25, storage)
    expect(readVolume(storage)).toBe(0.25)
    saveVolume(4, storage)
    expect(readVolume(storage)).toBe(1)
    storage.setItem('scraplandia:volume', 'loud')
    expect(readVolume(storage)).toBe(0.6)
  })
  it('keeps 0 (sound off) rather than falling back to the default', () => {
    const storage = new MemoryStorage()
    saveVolume(0, storage)
    expect(readVolume(storage)).toBe(0)
  })
})
