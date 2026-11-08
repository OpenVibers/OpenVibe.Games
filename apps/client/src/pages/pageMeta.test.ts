/**
 * The pages outside the game client's router are still read by search engines and share cards:
 * each names a one-line meta description of 120–160 characters, and every page that had the old
 * share image names the site's content-hashed card (openvibe-shared/social), with its size and the
 * Twitter mirror. The description is one line so a plain line-based crawler sees it too.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const client = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
const html = (page: string) => readFileSync(client(page), 'utf8')
const description = (page: string) =>
  /<meta name="description" content="([^"]*)" \/>/.exec(html(page))?.[1] ?? ''
// The server already depends on the pinned openvibe-shared; its social helper is what names the card.
const req = createRequire(new URL('../../../server/package.json', import.meta.url))
const social = req('openvibe-shared/social') as { url(service: string): string | null }
const CARD = `https://openvibe.games${social.url('games')}`

describe('page metadata', () => {
  it.each(['play.html', 'worlds.html', 'achievements.html', 'leaderboards.html', 'developers.html'])(
    '%s has a one-line description of 120 to 160 characters',
    (page) => {
      const d = description(page)
      expect(d).not.toBe('')
      expect(d.length).toBeGreaterThanOrEqual(120)
      expect(d.length).toBeLessThanOrEqual(160)
      expect(html(page)).toContain(`<meta name="description" content="${d}" />`)
    },
  )

  it('leaderboards.html names its canonical URL', () => {
    const page = html('leaderboards.html')
    expect(page).toContain('<link rel="canonical" href="https://openvibe.games/leaderboards" />')
  })

  it.each(['index.html', 'play.html', 'worlds.html', 'editor.html', 'achievements.html', 'leaderboards.html', 'developers.html'])(
    '%s shares the content-hashed site card',
    (page) => {
      const doc = html(page)
      expect(doc).toContain(`<meta property="og:image" content="${CARD}" />`)
      expect(doc).toContain('<meta property="og:image:width" content="1200" />')
      expect(doc).toContain('<meta property="og:image:height" content="630" />')
      expect(doc).toContain(`<meta name="twitter:image" content="${CARD}" />`)
    },
  )
})
