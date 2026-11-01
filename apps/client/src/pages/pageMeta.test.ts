/**
 * The pages outside the game client's router are still read by search engines and share cards:
 * each names a one-line meta description of 120–160 characters, and the leaderboard (linked from
 * the game and the portal) names its own canonical URL and the site's og:image, the card the home
 * uses. The description is one line so a plain line-based crawler sees it too.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const client = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
const html = (page: string) => readFileSync(client(page), 'utf8')
const description = (page: string) =>
  /<meta name="description" content="([^"]*)" \/>/.exec(html(page))?.[1] ?? ''

describe('page metadata', () => {
  it.each(['play.html', 'worlds.html', 'leaderboard.html'])(
    '%s has a one-line description of 120 to 160 characters',
    (page) => {
      const d = description(page)
      expect(d).not.toBe('')
      expect(d.length).toBeGreaterThanOrEqual(120)
      expect(d.length).toBeLessThanOrEqual(160)
      expect(html(page)).toContain(`<meta name="description" content="${d}" />`)
    },
  )

  it('leaderboard.html names its canonical URL and the site card', () => {
    const page = html('leaderboard.html')
    expect(page).toContain('<link rel="canonical" href="https://openvibe.games/leaderboard.html" />')
    expect(page).toContain('<meta property="og:image" content="https://openvibe.games/og-image.png" />')
  })
})
