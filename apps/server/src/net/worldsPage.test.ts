import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const client = fileURLToPath(new URL('../../../client/', import.meta.url))
const page = readFileSync(`${client}worlds.html`, 'utf8')

/**
 * The creator worlds list follows the reader's theme: a fixed dark panel under the theme's secondary text read
 * 2.1:1 on Daylight. The card takes the theme's card and border; the dark look is only the fallback.
 */
describe('the creator worlds list on a light theme', () => {
  it('draws its cards on the theme, not a fixed dark panel', () => {
    expect(page).toMatch(/\.card \{[^}]*background: var\(--bg-card, #101828\);/)
    expect(page).toMatch(/\.card \{[^}]*border: 1px solid var\(--border, #1f2d47\);/)
    expect(page).not.toMatch(/\.card \{[^}]*background: var\(--bg-raised\)/)
  })

  it('takes its page and text colours from the theme too, so a light theme never leaves a dark page behind', () => {
    const root = /:root \{([^}]*)\}/.exec(page)?.[1] ?? ''
    expect(root).toMatch(/--bg: var\(--bg-primary, #0a0f1c\);/)
    expect(root).toMatch(/--bg-raised: var\(--bg-secondary, #101828\);/)
    expect(root).toMatch(/--text: var\(--text-primary, #e6edf7\);/)
    expect(root).toMatch(/--good: var\(--success-text, #34d399\);/)
    expect(root).toMatch(/--warn: var\(--warning-text, #fbbf24\);/)
    expect(root).toMatch(/--bad: var\(--danger-text, #f87171\);/)
    expect(root).toMatch(/color-scheme: var\(--color-scheme, dark\);/)
  })
})
