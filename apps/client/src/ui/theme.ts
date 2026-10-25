/**
 * The player's OpenVibe display preferences in the engine.
 *
 * Every page runs the shared theme loader (theme-loader.js), which paints the theme someone picked on any OpenVibe site
 * onto <html> (the HUD's CSS reads those tokens: styles.css :root --g-*) and keeps their display preferences: text size
 * (--ov-text-scale, also read by the CSS) and calm motion (html[data-ov-motion=reduced]). This module is what CSS cannot
 * reach: how much of the engine's own decorative motion to keep (the weapon's bob and sway, the hit wobble), current as
 * the person changes it in another tab or on another site, and the theme's colours for anything drawn on a canvas.
 */

let calmNow = false
let started = false
const listeners = new Set<(calm: boolean) => void>()

function read(): boolean {
  if (typeof document === 'undefined') return false
  if (document.documentElement.getAttribute('data-ov-motion') === 'reduced') return true
  try {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

function refresh(): void {
  const c = read()
  if (c === calmNow) return
  calmNow = c
  listeners.forEach((fn) => fn(c))
}

function start(): void {
  if (started) return
  started = true
  calmNow = read()
  if (typeof window === 'undefined') return
  window.addEventListener('ov:display', refresh)
  try {
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', refresh)
  } catch {
    /* no media queries */
  }
  try {
    new MutationObserver(refresh).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ov-motion'],
    })
  } catch {
    /* no DOM */
  }
}

/** Calm motion is on (the OpenVibe setting or the system's reduced-motion setting). */
export function calm(): boolean {
  start()
  return calmNow
}

/** How much of the engine's decorative motion to keep: 1, or 0.2 when calm. */
export function motionScale(): number {
  return calm() ? 0.2 : 1
}

/** Called with the new value whenever calm motion turns on or off; returns a function that stops it. */
export function onCalmChange(fn: (calm: boolean) => void): () => void {
  start()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** One of the theme's colours (a CSS custom property on <html>, like '--accent'), or the fallback. */
export function themeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Tests only: forget what was read. */
export function _resetTheme(): void {
  started = false
  calmNow = false
  listeners.clear()
}
