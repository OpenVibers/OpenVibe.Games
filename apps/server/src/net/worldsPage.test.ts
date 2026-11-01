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
})
