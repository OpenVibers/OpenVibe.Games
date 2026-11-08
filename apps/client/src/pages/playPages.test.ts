/**
 * The Play pages that moved into Games (Achievements, Leaderboards, Developers) are real
 * OpenVibe.Games pages: the shared Frame mounts on them, they carry the Games stylesheet, and
 * they load their own script from the build. The old /leaderboard.html is gone; /leaderboards
 * is the address, and the server redirects the old one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const html = (page: string) =>
  readFileSync(fileURLToPath(new URL(`../../${page}`, import.meta.url)), 'utf8')

const PAGES = [
  ['achievements.html', '/src/pages/achievements.ts'],
  ['leaderboards.html', '/src/pages/leaderboards.ts'],
  ['developers.html', null],
] as const

describe('the Play pages on OpenVibe.Games', () => {
  it.each(PAGES)('%s mounts the OpenVibe Frame and the Games stylesheet', (page, script) => {
    const doc = html(page)
    for (const tag of [
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '<link rel="stylesheet" href="/src/pages/play-pages.css" />',
      '<script src="/shared/theme-loader.js" defer></script>',
      '<script src="/shared/navbar.js" defer></script>',
      '<script src="/shared/footer.js" defer></script>',
      '<script src="/frame.js" defer></script>',
      '<div id="navbar-mount"></div>',
      '<footer id="ov-footer" class="ovf"></footer>',
    ])
      expect(doc).toContain(tag)
    if (script) expect(doc).toContain(`<script type="module" src="${script}"></script>`)
    expect(doc).not.toContain('leaderboard.html')
  })
})
