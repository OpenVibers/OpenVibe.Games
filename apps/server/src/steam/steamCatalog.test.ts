import { openTestDb } from '@openvibe/persistence/testing'
import { describe, expect, it } from 'vitest'
import { createSteamCatalog, toGame, WINDOW_MS, type SourcesItem } from './steamCatalog.js'
import { steamPageHtml } from './steamPage.js'

const NOW = Date.parse('2026-10-18T23:00:00Z')
const seen = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()
const img = (id: number) => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`
const item = (id: number, name: string, fields: Record<string, unknown> = {}, hoursAgo = 1): SourcesItem => ({
  id: `itm_${id}`,
  identity: String(id),
  title: name,
  fields: { appid: id, position: 0, final_price: 2999, original_price: 2999, discount_percent: 0, currency: 'USD', header_image: img(id), windows: true, mac: false, linux: true, ...fields },
  provenance: { retrieved_at: seen(hoursAgo) },
})

describe('Steam lists from OpenVibe.Sources', () => {
  it('a game is what the store showed, seen in the last 7 hours, with a Steam CDN image only', () => {
    const g = toGame(item(413150, 'Stardew Valley', { position: 2, final_price: 749, original_price: 1499, discount_percent: 50, discount_expiration: 1792800000 }), NOW)
    expect(g).toMatchObject({ appid: 413150, position: 2, name: 'Stardew Valley', final_price: 749, original_price: 1499, discount_percent: 50, currency: 'USD', windows: true, linux: true, mac: false, discount_ends_at: 1792800000000 })
    expect(toGame(item(1, 'Old', {}, WINDOW_MS / 3600_000 + 1), NOW)).toBeNull()
    expect(toGame({ ...item(2, 'Gone'), removed: { at: seen(0) } }, NOW)).toBeNull()
    expect(toGame(item(3, 'Elsewhere', { header_image: 'https://evil.example/x.jpg' }), NOW)?.header_image).toBeNull()
  })

  it('sync replaces each list with what its source saw, in the store order; an empty read keeps the list', async () => {
    const db = await openTestDb()
    const bySource: Record<string, SourcesItem[]> = {
      'steam-top-sellers': [item(4435490, 'Call of Duty', { position: 1, final_price: 6999, original_price: 6999 }), item(730, 'Counter-Strike 2', { position: 0, final_price: 0, original_price: 0 }), item(99, 'Was on the list', { position: 3 }, 30)],
      'steam-specials': [item(413150, 'Stardew Valley', { final_price: 749, original_price: 1499, discount_percent: 50 })],
      'steam-new-releases': [item(3527290, 'A <New> Game')],
    }
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(url)
      const source = new URL(url).searchParams.get('source') ?? ''
      return new Response(JSON.stringify({ items: bySource[source] ?? [], next_after: 1, more: false }), { status: 200 })
    }) as unknown as typeof fetch
    const catalog = createSteamCatalog({ db, sourcesUrl: 'http://sources.test', tokens: { getToken: async () => 'tok' }, fetch: fakeFetch, now: () => NOW })
    expect(await catalog.sync()).toEqual({ top: 2, sale: 1, new: 1 })
    expect(calls.every((u) => u.includes('category=games'))).toBe(true)
    const lists = await catalog.lists()
    expect(lists.top.map((g) => g.name)).toEqual(['Counter-Strike 2', 'Call of Duty'])
    expect(lists.sale[0]).toMatchObject({ appid: 413150, discount_percent: 50 })
    expect(lists.observed_at).toBe(NOW - 3600_000)

    // Sources answers nothing for a list (down, or not fetched yet): the list stays as it was.
    bySource['steam-top-sellers'] = []
    await catalog.sync()
    expect((await catalog.lists()).top).toHaveLength(2)
  })

  it('without a Sources URL or a token there is no sync and the lists are empty', async () => {
    const db = await openTestDb()
    const catalog = createSteamCatalog({ db, sourcesUrl: null, tokens: null })
    expect(catalog.enabled).toBe(false)
    expect(await catalog.sync()).toBeNull()
    expect((await catalog.lists()).top).toEqual([])
  })

  it('the page ranks top sellers, shows a deal with its old price, escapes names and links every game to its store page', () => {
    const shell = { page: (o: Record<string, unknown>) => `${String(o.title)}\n${String(o.body)}` }
    const g = (appid: number, name: string, extra: Record<string, unknown> = {}) => ({ ...toGame(item(appid, name, extra), NOW)! })
    const html = steamPageHtml({ top: [g(730, 'Counter-Strike 2', { final_price: 0, original_price: 0 })], sale: [g(413150, 'Stardew Valley', { final_price: 749, original_price: 1499, discount_percent: 50 })], new: [g(3527290, 'A <New> Game')], observed_at: NOW - 3600_000 }, 'https://openvibe.games', shell, NOW)
    expect(html).toContain('Steam top sellers, deals and new releases')
    expect(html).toContain('<span class="rank" aria-label="Number 1">1</span>')
    // Steam's list repeats games (one id at positions 0 and 1): ranks count the games shown, 1, 2, 3 with no gaps.
    const gappy = steamPageHtml({ top: [g(1, 'First', { position: 0 }), g(2, 'Second', { position: 2 })], sale: [], new: [], observed_at: NOW }, 'https://openvibe.games', shell, NOW)
    expect(gappy).toContain('<span class="rank" aria-label="Number 2">2</span>')
    expect(gappy).not.toContain('aria-label="Number 3"')
    expect(html).toContain('<span>Free</span>')
    expect(html).toMatch(/<span class="off">−50%<\/span><span>\$7\.49<\/span><span class="was">\$14\.99<\/span>/)
    expect(html).toContain('A &lt;New&gt; Game')
    expect(html).toContain('href="https://store.steampowered.com/app/413150/"')
    expect(html).toContain('checked 1 hour ago')
    expect(html).not.toMatch(/coming soon|not yet/i)
  })
})
