import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldBlock, pickBlock } from './shortHome.js'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * The home on a phone: the blocks of the same kind are one pick block, every block shown, and a row of chips jumps to
 * one (the owner, 2026-10-31: never hide content to shorten); the parts a reader rarely needs are folds. A wider
 * screen shows them all and no chips.
 */
describe('the home on a phone', () => {
  it('the boards are one pick block: every board shown, a chip per board that jumps to it', () => {
    const panes = [
      { id: 'board-0', label: 'Scraplandia', html: '<article class="board-card">a</article>' },
      { id: 'board-1', label: 'Salvage Rush', html: '<article class="board-card">b</article>' },
    ]
    const html = pickBlock({ key: 'boards', label: 'The boards', head: 'Top players', panes })
    expect(html).toContain('<div class="pick" id="pick-boards">')
    expect(html).toContain('<nav class="pick-row" aria-label="The boards">')
    const chips = [...html.matchAll(/<a class="pick-chip" href="#(pp-boards-[a-z0-9-]+)">([^<]+)<\/a>/g)]
    expect(chips.map((m) => m[1])).toEqual(['pp-boards-board-0', 'pp-boards-board-1'])
    for (const [, id] of chips) expect(html).toContain(`<div class="pick-pane" id="${id}">`)
    expect(html).not.toMatch(/type="radio"/)
    expect((html.match(/class="pick-pane"/g) ?? []).length).toBe(2)
    expect(html).toContain('board-card">a')
    expect(html).toContain('board-card">b')
  })

  it('a fold is open in the page and closed on a phone by its own script', () => {
    const html = foldBlock({
      id: 'home-faq',
      head: '<h2 id="home-faq">Questions</h2>',
      html: '<p>the answers</p>',
    })
    expect(html).toContain('<details class="gm-fold gm-fold-block" id="home-faq" open>')
    expect(html).toContain(
      '<summary><h2 id="home-faq">Questions</h2></summary>',
    )
    expect(html).toContain('the answers')
    expect(html).toContain('document.getElementById("home-faq")')
    expect(html).toContain("matchMedia('(max-width:640px)')")
  })

  it('the CSS: no chips where there is room, chip links on a phone, and no board is ever hidden', () => {
    const css = readFileSync(join(root, 'apps/client/index.html'), 'utf8')
    expect(css).toMatch(/\.pick-row \{ display: none; \}/)
    expect(css).toMatch(/@media \(max-width: 640px\) \{/)
    expect(css).toMatch(/\.pick-chip \{[\s\S]*?min-height: 44px/)
    expect(css).not.toMatch(/\.pick-pane \{ display: none; \}/)
  })
})
