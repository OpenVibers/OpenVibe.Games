import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CreatorWorld } from '@openvibe/persistence'
import type { SteamGame } from '../steam/steamCatalog.js'
import { portalPage } from './httpServer.js'
import {
  HOME_FAQ,
  createPortalHome,
  readPlayTitles,
  renderHome,
  steamSection,
  renderStats,
  yourStuffSection,
  type HomeData,
  type HomeSources,
} from './portalHome.js'

const NOW = Date.parse('2026-10-22T12:00:00Z')

const empty = (): HomeData => ({
  online: { scraplandia: 0, salvageRush: 0, worlds: 0 },
  titles: [],
  boards: { haulWeek: [], haulAll: [], rushWeek: [], rushAll: [] },
  heroes: [],
  worlds: [],
  steam: null,
})

const game = (appid: number, name: string, extra: Partial<SteamGame> = {}): SteamGame => ({
  appid,
  position: 0,
  name,
  final_price: 1999,
  original_price: 1999,
  discount_percent: 0,
  currency: 'USD',
  header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
  windows: true,
  mac: false,
  linux: false,
  discount_ends_at: null,
  observed_at: NOW - 2 * 3600_000,
  ...extra,
})

const world = (id: string, plays: number, publishedAt: number): CreatorWorld => ({
  id,
  ownerSubject: `usr_${id}`,
  ownerName: 'Builder <b>',
  title: `World ${id}`,
  summary: 'A floating island',
  status: 'published',
  revision: 'r1',
  plays,
  createdAt: publishedAt,
  updatedAt: publishedAt,
  publishedAt,
  remixedFrom: null,
  remixes: 0,
  view: '3d',
})

describe('the home page live sections', () => {
  it('with no data, only the sections that need none: how it works and the questions', () => {
    const parts = renderHome(empty(), NOW)
    expect(parts.stats).toBe('')
    expect(parts.sections).toContain('id="home-how"')
    expect(parts.sections).toContain('id="home-faq"')
    for (const id of ['home-boards', 'home-achievements', 'home-worlds', 'home-steam'])
      expect(parts.sections).not.toContain(id)
    // The FAQPage carries exactly the questions the page shows.
    const faq = parts.jsonLd.find((n) => (n as { '@type': string })['@type'] === 'FAQPage') as {
      mainEntity: { name: string }[]
    }
    expect(faq.mainEntity.map((q) => q.name)).toEqual(HOME_FAQ.map((f) => f.q))
    for (const f of HOME_FAQ) expect(parts.sections).toContain(f.q.replace(/'/g, '&#39;'))
  })

  it('shows the real counts, boards, achievements, worlds and Steam lists, escaped', () => {
    const d = empty()
    d.online = { scraplandia: 2, salvageRush: 1, worlds: 0 }
    d.titles = [
      {
        id: 'scraplandia',
        name: 'Scraplandia',
        players: 25,
        achievements: [
          {
            id: 'first-visit',
            name: 'First Visit',
            description: 'Join Scraplandia.',
            unlockedBy: 25,
          },
          { id: 'big-haul', name: 'Big Haul', description: 'Score 500.', unlockedBy: 0 },
        ],
      },
    ]
    d.boards.rushAll = [{ rank: 1, name: '<script>x</script>', score: 12 }]
    d.heroes = [{ rank: 1, name: 'Ana', stage: 7, power: 900 }]
    // Newest first (as the store lists them); the seventh is older but the most visited.
    d.worlds = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => world(id, 0, NOW - 3600_000 * (i + 1))),
      world('old', 40, NOW - 86400_000 * 3),
    ]
    d.steam = {
      top: [game(1, 'Top One')],
      sale: [game(2, 'Half Off', { discount_percent: 50, final_price: 999 })],
      new: [],
      observed_at: NOW - 2 * 3600_000,
    }
    const parts = renderHome(d, NOW)
    expect(parts.stats).toContain('<b>3</b><span>players online now</span>')
    expect(parts.stats).toContain('<b>25</b><span>players have played Scraplandia</span>')
    expect(parts.stats).toContain('<b>25</b><span>achievements earned</span>')
    expect(parts.sections).toContain('best round, all time')
    expect(parts.sections).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(parts.sections).not.toContain('<script>x')
    expect(parts.sections).toContain('stage 7')
    expect(parts.sections).toContain('Earned by 25 players')
    expect(parts.sections).toContain('Nobody has earned it yet')
    expect(parts.sections).toContain('Gives the Golden Name')
    expect(parts.sections).toContain('href="/worlds/a"')
    expect(parts.sections).toContain('Builder &lt;b&gt;')
    expect(parts.sections).toContain('Most visited')
    expect(parts.sections).toContain('40 visits')
    expect(parts.stats).toContain('<b>7</b><span>creator worlds published</span>')
    // The strip scrolls sideways on a phone, so it is reachable by keyboard (WCAG sweep, 2026-11-01).
    expect(parts.stats).toContain('<ul class="home-stats" aria-label="OpenVibe.Games in numbers" tabindex="0">')
    // The Steam lists left the home (2026-10-29: the "On Steam right now" card links them); they render on their own.
    expect(parts.sections).not.toContain('store.steampowered.com')
    const steam = steamSection(d, NOW)
    expect(steam).toContain('https://store.steampowered.com/app/2/')
    expect(steam).toContain('−50%')
    expect(steam).toContain('checked 2 hours ago')
    expect(steam).not.toContain('home-steam-new')
  })

  it('a stat with nothing to say is left out', () => {
    const d = empty()
    d.titles = [{ id: 'salvage-rush', name: 'Salvage Rush', players: 0, achievements: [] }]
    expect(renderStats(d)).toBe('')
  })

  it('reads Play titles defensively', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          titles: [
            {
              id: 'scraplandia',
              name: 'Scraplandia',
              players: 3,
              achievements: [{ id: 'x', name: 'X', description: 'Do x', unlocked_by: 2 }],
            },
            { id: 7 },
          ],
        }),
      )) as unknown as typeof globalThis.fetch
    const titles = await readPlayTitles('http://play.test', fetch)
    expect(titles).toEqual([
      {
        id: 'scraplandia',
        name: 'Scraplandia',
        players: 3,
        achievements: [{ id: 'x', name: 'X', description: 'Do x', unlockedBy: 2 }],
      },
    ])
  })

  it('a failing source drops its section, and a build is reused for a minute', async () => {
    let now = NOW
    let calls = 0
    const src: HomeSources = {
      online: () => ({ scraplandia: 1, salvageRush: 0, worlds: 0 }),
      titles: async () => {
        calls += 1
        throw new Error('play down')
      },
      board: async () => [],
      heroes: async () => [],
      worlds: async () => [],
      steam: async () => ({ top: [game(5, 'Five')], sale: [], new: [], observed_at: NOW }),
    }
    const warnings: string[] = []
    const home = createPortalHome(src, { now: () => now, log: { warn: (m) => warnings.push(m) } })
    const first = await home()
    expect(first.stats).toContain('player online now')
    expect(first.sections).toContain('id="home-how"')
    expect(first.sections).not.toContain('id="home-steam"')
    expect(first.sections).not.toContain('home-achievements')
    now += 30_000
    await home()
    expect(calls).toBe(1)
    expect(warnings).toEqual(['home section unavailable'])
  })

  it('the portal page swaps the markers and adds the JSON-LD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-'))
    const file = join(dir, 'index.html')
    writeFileSync(
      file,
      '<html><head><title>t</title></head><body><header><!--ov:home-stats--></header><!--ov:home-sections--></body></html>',
    )
    const html = portalPage(file, {
      stats: '<ul class="home-stats"></ul>',
      sections: '<section id="s">$&</section>',
      jsonLd: [{ '@type': 'FAQPage' }],
    })
    expect(html).toContain('<header><ul class="home-stats"></ul></header>')
    expect(html).toContain('<section id="s">$&</section>')
    expect(html).toContain('"@type":"FAQPage"')
    expect(html).not.toContain('<!--ov:home')
  })
})

describe('your stuff across OpenVibe', () => {
  it('is a hidden section the shared profile panel fills for whoever is signed in', () => {
    const html = yourStuffSection(true)
    expect(html).toContain('id="your-stuff" data-ov-profile-section hidden')
    expect(html).toContain('<div data-ov-profile="me">')
    expect(html).toContain('src="/shared/profile-panel.js')
    expect(html).toContain('href="/shared/profile-panel.css')
  })
  it('is left out until the pinned openvibe-shared serves the panel', () => {
    expect(yourStuffSection(false)).toBe('')
  })
})
