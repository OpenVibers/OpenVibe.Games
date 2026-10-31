import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import { applyCardFacts, cardFacts } from './portalHome.js'

const client = fileURLToPath(new URL('../../../client/', import.meta.url))

/**
 * The home page's cards: the length of a round is the content pack's own number, so the card cannot
 * drift from the game it describes, and the number is never a sentence someone typed.
 */
describe('the game cards of the home page', () => {
  it('states the length of a Salvage Rush round from the pack', () => {
    const seconds = SALVAGE_RUSH_PACK.game?.roundSeconds
    expect(seconds).toBeGreaterThan(0)
    const facts = cardFacts()
    expect(facts['salvage-rush-round-tag']).toBe(`<span>${seconds}-second rounds</span>`)
  })

  it('puts the fact where the card asks for it', () => {
    const html = applyCardFacts(
      '<div class="tags"><!--ov:card-salvage-rush-round-tag--><span>on-foot</span></div>',
    )
    expect(html).not.toContain('<!--ov:card-')
    expect(html).toContain(`<span>${SALVAGE_RUSH_PACK.game?.roundSeconds}-second rounds</span>`)
    expect(html).toContain('<span>on-foot</span>')
  })

  it('writes no round length into the pages by hand', () => {
    // The length of a round is the pack's number; a sentence that carries one by hand would
    // drift from the game the day the pack changes.
    for (const file of ['index.html', 'play.html', 'leaderboard.html']) {
      const html = readFileSync(join(client, file), 'utf8')
      expect(html).not.toMatch(/\d+-second round/)
    }
  })

  it('leaves a page without the marker alone', () => {
    expect(applyCardFacts('<p>nothing here</p>')).toBe('<p>nothing here</p>')
  })
})
