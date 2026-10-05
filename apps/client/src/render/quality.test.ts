/**
 * Quality-tier resolution and persistence, with no DOM and no GPU: the whole
 * point of keeping those two pure is that the browser bootstrap is the only
 * place allowed to make device-specific mistakes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import {
  applyEngineQuality,
  applySceneQuality,
  getQualityOverride,
  isLowEnd,
  parseQualityOverride,
  QUALITY_STORAGE_KEY,
  qualityForTier,
  readDeviceSignals,
  resolveQualityTier,
  resolveStartupQuality,
  setQualityOverride,
  type DeviceSignals,
  type QualityStorage,
} from './quality.js'

/** In-memory Storage stand-in — the tests must not need jsdom. */
class MemoryStorage implements QualityStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

/** Ordinary desktop defaults; override one field per test. */
const signals = (over: Partial<DeviceSignals> = {}): DeviceSignals => ({
  coarsePointer: false,
  hardwareConcurrency: 8,
  deviceMemory: 8,
  ...over,
})

describe('resolveQualityTier', () => {
  it('lets the player override win over every device signal', () => {
    const weakTouch = signals({ coarsePointer: true, hardwareConcurrency: 2, deviceMemory: 2 })
    expect(resolveQualityTier('high', weakTouch)).toBe('high')
    expect(resolveQualityTier('medium', signals({ hardwareConcurrency: 16 }))).toBe('medium')
    expect(resolveQualityTier('low', signals())).toBe('low')
  })

  it('defaults a touch device with no other evidence to medium', () => {
    // A phone is not a "weak desktop": medium, not high.
    expect(resolveQualityTier('auto', signals({ coarsePointer: true }))).toBe('medium')
  })

  it('drops genuinely weak hardware to low', () => {
    expect(resolveQualityTier('auto', signals({ hardwareConcurrency: 2 }))).toBe('low')
    expect(resolveQualityTier('auto', signals({ deviceMemory: 2 }))).toBe('low')
  })

  it('treats a weak touch device as low, not medium', () => {
    // The touch default is a default: concrete low-end evidence overrides it,
    // otherwise the weakest devices — mostly phones — would never reach low.
    expect(resolveQualityTier('auto', signals({ coarsePointer: true, deviceMemory: 2 }))).toBe(
      'low',
    )
  })

  it('leaves an ordinary machine on high', () => {
    expect(resolveQualityTier('auto', signals())).toBe('high')
  })

  it('does not mistake an ordinary 4-core / 4 GB machine for low-end', () => {
    expect(resolveQualityTier('auto', signals({ hardwareConcurrency: 4, deviceMemory: 4 }))).toBe(
      'high',
    )
  })

  it('treats unknown device facts as capable rather than weak', () => {
    const unknown = signals({ hardwareConcurrency: undefined, deviceMemory: undefined })
    expect(resolveQualityTier('auto', unknown)).toBe('high')
  })
})

describe('isLowEnd', () => {
  it('ignores absent or nonsensical values instead of failing into low', () => {
    expect(isLowEnd({ hardwareConcurrency: undefined, deviceMemory: undefined })).toBe(false)
    expect(isLowEnd({ hardwareConcurrency: 0, deviceMemory: 0 })).toBe(false)
    expect(isLowEnd({ hardwareConcurrency: Number.NaN, deviceMemory: Number.NaN })).toBe(false)
  })
})

describe('parseQualityOverride', () => {
  it('accepts exactly the four valid values', () => {
    expect(parseQualityOverride('high')).toBe('high')
    expect(parseQualityOverride('medium')).toBe('medium')
    expect(parseQualityOverride('low')).toBe('low')
    expect(parseQualityOverride('auto')).toBe('auto')
  })

  it('falls back to auto for anything else', () => {
    expect(parseQualityOverride(null)).toBe('auto')
    expect(parseQualityOverride('')).toBe('auto')
    expect(parseQualityOverride('ultra')).toBe('auto')
    expect(parseQualityOverride('HIGH')).toBe('auto')
    expect(parseQualityOverride('{"tier":"low"}')).toBe('auto')
  })
})

describe('quality persistence', () => {
  it('defaults to auto with nothing stored', () => {
    expect(getQualityOverride(new MemoryStorage())).toBe('auto')
  })

  it('round-trips each tier through storage', () => {
    const storage = new MemoryStorage()
    for (const tier of ['high', 'medium', 'low'] as const) {
      setQualityOverride(tier, storage)
      expect(storage.getItem(QUALITY_STORAGE_KEY)).toBe(tier)
      expect(getQualityOverride(storage)).toBe(tier)
    }
  })

  it('clears the key when set back to auto', () => {
    const storage = new MemoryStorage()
    setQualityOverride('low', storage)
    setQualityOverride('auto', storage)
    expect(storage.getItem(QUALITY_STORAGE_KEY)).toBeNull()
    expect(getQualityOverride(storage)).toBe('auto')
  })

  it('ignores corrupt stored values rather than breaking boot', () => {
    const storage = new MemoryStorage()
    storage.setItem(QUALITY_STORAGE_KEY, '{not json')
    expect(getQualityOverride(storage)).toBe('auto')
    storage.setItem(QUALITY_STORAGE_KEY, 'ultra')
    expect(getQualityOverride(storage)).toBe('auto')
  })

  it('survives a storage that throws on every access', () => {
    const hostile: QualityStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(getQualityOverride(hostile)).toBe('auto')
    expect(() => setQualityOverride('low', hostile)).not.toThrow()
  })
  it('keeps the choice for the session when the default storage cannot hold it', () => {
    // No localStorage here (Node), as in a browser that blocks it: the choice still sticks until reload.
    setQualityOverride('medium')
    expect(getQualityOverride()).toBe('medium')
    setQualityOverride('auto')
    expect(getQualityOverride()).toBe('auto')
  })
})

describe('resolveStartupQuality', () => {
  it('uses the persisted override over the device heuristic', () => {
    const storage = new MemoryStorage()
    setQualityOverride('high', storage)
    const settings = resolveStartupQuality(
      storage,
      signals({ coarsePointer: true, deviceMemory: 2 }),
    )
    expect(settings.tier).toBe('high')
    expect(settings.antialias).toBe(true)
  })

  it('defaults a touch device to medium settings', () => {
    const settings = resolveStartupQuality(new MemoryStorage(), signals({ coarsePointer: true }))
    expect(settings.tier).toBe('medium')
    expect(settings.antialias).toBe(false)
    expect(settings.shadows).toBe(true)
  })

  it('drops a low-end desktop to low settings with shadows off', () => {
    const settings = resolveStartupQuality(new MemoryStorage(), signals({ hardwareConcurrency: 2 }))
    expect(settings.tier).toBe('low')
    expect(settings.shadows).toBe(false)
  })

  it('leaves a capable desktop at full resolution with AA and shadows', () => {
    const settings = resolveStartupQuality(new MemoryStorage(), signals())
    expect(settings.tier).toBe('high')
    expect(settings.hardwareScalingLevel).toBe(1)
    expect(settings.antialias).toBe(true)
    expect(settings.shadows).toBe(true)
  })
})

describe('qualityForTier', () => {
  it('renders progressively fewer pixels as the tier falls', () => {
    const { high, medium, low } = {
      high: qualityForTier('high'),
      medium: qualityForTier('medium'),
      low: qualityForTier('low'),
    }
    expect(high.hardwareScalingLevel).toBe(1)
    expect(medium.hardwareScalingLevel).toBeGreaterThan(high.hardwareScalingLevel)
    expect(low.hardwareScalingLevel).toBeGreaterThan(medium.hardwareScalingLevel)
  })

  it('turns antialiasing off below high and shadows off at low', () => {
    expect(qualityForTier('high')).toMatchObject({ antialias: true, shadows: true })
    expect(qualityForTier('medium')).toMatchObject({ antialias: false, shadows: true })
    expect(qualityForTier('low')).toMatchObject({ antialias: false, shadows: false })
  })
})

describe('readDeviceSignals', () => {
  it('reads the coarse-pointer query and the navigator facts', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' }))
    const result = readDeviceSignals({
      matchMedia,
      navigator: { hardwareConcurrency: 4, deviceMemory: 2 },
    })
    expect(result).toEqual({
      coarsePointer: true,
      hardwareConcurrency: 4,
      deviceMemory: 2,
    })
    expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)')
  })

  it('tolerates a browser missing matchMedia or navigator entirely', () => {
    expect(readDeviceSignals({})).toEqual({
      coarsePointer: false,
      hardwareConcurrency: undefined,
      deviceMemory: undefined,
    })
  })
})

describe('applying settings', () => {
  it('sets the engine hardware scaling level', () => {
    const setHardwareScalingLevel = vi.fn()
    const engine = { setHardwareScalingLevel } as unknown as AbstractEngine
    applyEngineQuality(engine, qualityForTier('medium'))
    expect(setHardwareScalingLevel).toHaveBeenCalledWith(1.25)
  })

  it('toggles the scene shadow switch', () => {
    const scene = { shadowsEnabled: true }
    applySceneQuality(scene, qualityForTier('low'))
    expect(scene.shadowsEnabled).toBe(false)
  })
})
