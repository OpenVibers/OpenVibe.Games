/**
 * Client quality tiers and hardware scaling.
 *
 * The client ships one renderer for every device: WebGPU when available,
 * WebGL otherwise. It used to be created with antialiasing on and no
 * resolution scaling — the right choice only for the fastest half of the
 * hardware it runs on. This module resolves a single tier (high/medium/low)
 * from the player's persisted choice plus a coarse, conservative read of the
 * device (touch screen, very few cores, very little memory) and maps it to the
 * small, testable table of renderer consequences the bootstrap applies.
 *
 * Nothing here touches the DOM at module load: tier resolution and persistence
 * are pure functions over plain data, so they are unit-tested without a
 * browser. The live device read is injectable for the same reason.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'

export const QUALITY_TIERS = ['high', 'medium', 'low'] as const
export type QualityTier = (typeof QUALITY_TIERS)[number]

/** 'auto' = no player override, use the hardware heuristic. */
export type QualityOverride = QualityTier | 'auto'

export const QUALITY_STORAGE_KEY = 'openvibe.quality'

export interface QualitySettings {
  tier: QualityTier
  /**
   * Babylon hardware scaling: 1 renders at full canvas resolution, higher
   * values render fewer pixels. This is the lever that degrades most
   * gracefully, so every non-high tier raises it.
   */
  hardwareScalingLevel: number
  antialias: boolean
  shadows: boolean
}

/**
 * Consequences per tier. Antialiasing and shadow maps are per-pixel costs a
 * weak GPU cannot recover, so they go first; medium keeps shadows (the
 * scene's authored lighting) but drops AA and renders at 80% resolution.
 */
const QUALITY_SETTINGS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  high: { hardwareScalingLevel: 1, antialias: true, shadows: true },
  medium: { hardwareScalingLevel: 1.25, antialias: false, shadows: true },
  low: { hardwareScalingLevel: 1.5, antialias: false, shadows: false },
}

/** The full renderer settings for a tier. Pure — safe to unit-test. */
export function qualityForTier(tier: QualityTier): QualitySettings {
  return { tier, ...QUALITY_SETTINGS[tier] }
}

/** Device facts the heuristic cares about, already read from the browser. */
export interface DeviceSignals {
  coarsePointer: boolean
  hardwareConcurrency: number | undefined
  deviceMemory: number | undefined
}

/** The slice of `window`/`navigator` this module reads; injectable for tests. */
export interface SignalSource {
  matchMedia?: (query: string) => { matches: boolean }
  navigator?: { hardwareConcurrency?: number; deviceMemory?: number }
}

/** Read live device signals, tolerating a browser that lacks any of them. */
export function readDeviceSignals(
  source: SignalSource = globalThis as unknown as SignalSource,
): DeviceSignals {
  const nav = source.navigator
  return {
    coarsePointer: source.matchMedia?.('(pointer: coarse)')?.matches ?? false,
    hardwareConcurrency:
      typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    deviceMemory: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined,
  }
}

// Deliberately conservative: a device has to be genuinely small to be called
// low-end. `hardwareConcurrency` counts logical cores and 4 is an ordinary
// laptop or phone, so the bar is 2 cores / 2 GB — "below average" is not
// evidence that medium settings are unaffordable.
const LOW_END_MAX_CORES = 2
const LOW_END_MAX_MEMORY_GB = 2

/** Conservative low-end read: only clearly small devices qualify. */
export function isLowEnd(
  signals: Pick<DeviceSignals, 'hardwareConcurrency' | 'deviceMemory'>,
): boolean {
  const cores = signals.hardwareConcurrency
  const memory = signals.deviceMemory
  return (
    (typeof cores === 'number' && cores > 0 && cores <= LOW_END_MAX_CORES) ||
    (typeof memory === 'number' && memory > 0 && memory <= LOW_END_MAX_MEMORY_GB)
  )
}

/**
 * The player's override always wins. Otherwise weak hardware goes to low —
 * including a weak touch device, where medium would still be too much — and a
 * touch device with no such evidence defaults to medium rather than high.
 */
export function resolveQualityTier(override: QualityOverride, signals: DeviceSignals): QualityTier {
  if (override !== 'auto') return override
  if (isLowEnd(signals)) return 'low'
  if (signals.coarsePointer) return 'medium'
  return 'high'
}

/**
 * Minimal storage surface. Structural on purpose: tests pass an in-memory
 * object and boot survives a hostile `localStorage` without a DOM.
 */
export interface QualityStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Tolerant of anything on disk: only an exact tier (or 'auto') is valid. */
export function parseQualityOverride(raw: string | null): QualityOverride {
  return raw === 'high' || raw === 'medium' || raw === 'low' || raw === 'auto' ? raw : 'auto'
}

/**
 * The choice made this session (default storage only): it wins over what storage says, so a browser that cannot
 * store it (private mode, a blocked localStorage) still shows and applies the player's choice until reload.
 */
let sessionOverride: QualityOverride | null = null

/** The persisted player override; 'auto' when unset, corrupt or unreadable. */
export function getQualityOverride(storage?: QualityStorage): QualityOverride {
  if (!storage && sessionOverride) return sessionOverride
  try {
    return parseQualityOverride((storage ?? localStorage).getItem(QUALITY_STORAGE_KEY))
  } catch {
    return 'auto'
  }
}

/** Persist the player's choice; 'auto' clears it, returning to the heuristic. */
export function setQualityOverride(override: QualityOverride, storage?: QualityStorage): void {
  if (!storage) sessionOverride = override
  try {
    const store = storage ?? localStorage
    if (override === 'auto') store.removeItem(QUALITY_STORAGE_KEY)
    else store.setItem(QUALITY_STORAGE_KEY, override)
  } catch {
    // Private mode / quota: a quality preference is a convenience, never a
    // blocker. The next resolution simply falls back to the device heuristic.
  }
}

/** Resolve the settings to boot with: player override first, device second. */
export function resolveStartupQuality(
  storage?: QualityStorage,
  signals: DeviceSignals = readDeviceSignals(),
): QualitySettings {
  return qualityForTier(resolveQualityTier(getQualityOverride(storage), signals))
}

/**
 * Apply the parts of a tier an existing engine can change. Resolution scaling
 * takes effect immediately; antialiasing is fixed at construction, so a change
 * to it only lands on the next load. Shadow maps go through the Scene below.
 */
export function applyEngineQuality(engine: AbstractEngine, settings: QualitySettings): void {
  engine.setHardwareScalingLevel(settings.hardwareScalingLevel)
}

/** Shadow maps are a Scene concern, not an engine one. */
export function applySceneQuality(
  scene: { shadowsEnabled: boolean },
  settings: QualitySettings,
): void {
  scene.shadowsEnabled = settings.shadows
}
