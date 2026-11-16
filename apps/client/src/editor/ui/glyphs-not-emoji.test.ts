import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The editor's icons are OpenVibe glyphs, never emoji (2026-11-16; the owner: emoji are fine in chat, but item and button
// icons drawn as emoji look cheap). The Issues panel's severities, its all-clear and the co-editors label were emoji.
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('editor icons are glyphs, not emoji', () => {
  it('kindGlyphs draws the severities, the all-clear and the co-editors', () => {
    const glyphs = read('./kindGlyphs.ts')
    for (const name of ['error', 'warning', 'info', 'check', 'eye']) expect(glyphs).toMatch(new RegExp(`\\n  ${name}: \\[`))
  })

  it('the Issues panel and the co-editors label draw them', () => {
    const issues = read('./issuesPanel.ts')
    expect(issues).not.toMatch(/[⛔⚠ℹ✓]/u)
    expect(issues).toMatch(/kindGlyph\(ICON\[issue\.severity\]\)/)
    expect(issues).toMatch(/kindGlyph\(issues\.length === 0 \? 'check' : ICON\.error\)/)
    const peers = read('../collaboration/peerAvatars.ts')
    expect(peers).not.toMatch(/👁/u)
    expect(peers).toMatch(/kindGlyph\('eye'\)/)
  })
})
