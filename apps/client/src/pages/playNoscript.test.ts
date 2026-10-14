/**
 * The game page says what it is without JavaScript. Its body is a canvas the client draws into, so a visitor with
 * JavaScript off, and a crawler, read nothing but the title (the all-sites link sweep, 2026-10-14): the <noscript>
 * block names both games, says what they need and links the network's game pages.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const html = readFileSync(fileURLToPath(new URL('../../play.html', import.meta.url)), 'utf8')
const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'))

describe('play.html without JavaScript', () => {
  it('describes both games and what they need', () => {
    expect(noscript).toContain('<h1>Scraplandia and Salvage Rush</h1>')
    expect(noscript).toMatch(/need JavaScript and\s+WebGL/)
    expect(noscript).toContain('href="https://openvibe.games/leaderboard.html"')
  })

  it('sits before the stage, inside the body', () => {
    expect(html.indexOf('<noscript>')).toBeGreaterThan(html.indexOf('<body>'))
    expect(html.indexOf('<noscript>')).toBeLessThan(html.indexOf('<div id="stage">'))
  })
})
