// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { _resetTheme, calm, motionScale, onCalmChange, themeColor } from './theme.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("the player's OpenVibe display preferences in the engine", () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-ov-motion')
    document.documentElement.style.removeProperty('--accent')
    _resetTheme()
  })

  it('keeps all the motion unless calm motion is on, and follows it as it changes', async () => {
    expect(calm()).toBe(false)
    expect(motionScale()).toBe(1)
    const seen: boolean[] = []
    onCalmChange((c) => seen.push(c))
    document.documentElement.setAttribute('data-ov-motion', 'reduced') // the theme loader, after a change on any site
    await flush()
    expect(calm()).toBe(true)
    expect(motionScale()).toBe(0.2)
    window.dispatchEvent(new Event('ov:display'))
    document.documentElement.removeAttribute('data-ov-motion')
    await flush()
    expect(motionScale()).toBe(1)
    expect(seen).toEqual([true, false])
  })

  it("reads the theme's colours for canvas-drawn UI, with a fallback", () => {
    expect(themeColor('--accent', '#f0b040')).toBe('#f0b040')
    document.documentElement.style.setProperty('--accent', '#ff7a1a')
    expect(themeColor('--accent', '#f0b040')).toBe('#ff7a1a')
  })
})
