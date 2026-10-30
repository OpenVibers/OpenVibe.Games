import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldBlock, pickBlock, pickRules, pickStyle } from './shortHome.js'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the blocks of the same kind are one pick block,
 * a row of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script
 * for the chips; every block stays in the page for crawlers; a wider screen shows them all and no chips.
 */
describe('the home on a phone', () => {
  it('the boards are one pick block: a chip per board, the first one picked', () => {
    const panes = [
      { id: 'board-0', label: 'Scraplandia', html: '<article class="board-card">a</article>' },
      { id: 'board-1', label: 'Salvage Rush', html: '<article class="board-card">b</article>' },
    ]
    const html = pickBlock({ key: 'boards', label: 'The boards', head: 'Top players', panes })
    expect(html).toContain('<div class="pick" id="pick-boards">')
    expect(html).toContain('<div class="pick-row" role="radiogroup" aria-label="The boards">')
    const chips = [
      ...html.matchAll(
        /<input type="radio" name="pick-boards" id="pk-boards-([a-z0-9-]+)" value="\1"( checked)?><label for="pk-boards-\1">([^<]+)<\/label>/g,
      ),
    ]
    expect(chips.map((m) => m[1])).toEqual(['board-0', 'board-1'])
    expect(chips.filter((m) => m[2]).map((m) => m[1])).toEqual(['board-0'])
    expect((html.match(/class="pick-pane"/g) ?? []).length).toBe(2)
    // Every board stays in the page for the crawlers.
    expect(html).toContain('board-card">a')
    expect(html).toContain('board-card">b')
    // The rule that shows the picked board is written for this page.
    expect(pickRules('boards', ['board-0', 'board-1'])).toBe(
      '.pick:has(#pk-boards-board-0:checked) #pp-boards-board-0{display:block}.pick:has(#pk-boards-board-1:checked) #pp-boards-board-1{display:block}',
    )
    expect(pickStyle([pickRules('boards', ['board-0'])])).toContain('@media (max-width:640px)')
  })

  it('a fold is open in the page and closed on a phone by its own script', () => {
    const html = foldBlock({
      id: 'home-faq',
      head: '<h2 id="home-faq">Questions</h2>',
      html: '<p>the answers</p>',
    })
    expect(html).toContain('<details class="gm-fold gm-fold-block" id="home-faq" open>')
    expect(html).toContain(
      '<summary><h2 id="home-faq">Questions</h2><span>tap to open</span></summary>',
    )
    expect(html).toContain('the answers')
    expect(html).toContain('document.getElementById("home-faq")')
    expect(html).toContain("matchMedia('(max-width:640px)')")
  })

  it('the CSS guard: the chips are hidden and the blocks all show until 640 px and where :has() is understood', () => {
    const css = readFileSync(join(root, 'apps/client/index.html'), 'utf8')
    expect(css).toMatch(/\.pick-row \{ display: none; \}/)
    expect(css).toMatch(/@supports selector\(:has\(\*\)\) \{/)
    expect(css).toMatch(/@media \(max-width: 640px\) \{/)
    expect(css).toMatch(/\.pick-row label \{[\s\S]*?min-height: 44px/)
    expect(css).toMatch(/\.pick-pane \{ display: none; \}/)
  })
})
