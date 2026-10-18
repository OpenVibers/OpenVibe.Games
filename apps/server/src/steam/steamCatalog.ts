import type { Logger } from '@openvibe/shared'
import type { Db } from 'openvibe-sdk/db'

/**
 * The Steam section (the owner's valve.openvibe.games): Steam's featured lists, as OpenVibe.Sources reads them from
 * store.steampowered.com/api/featuredcategories every 3 hours (category games, contracts 0.205.0). One source per list;
 * every sync reads each source whole and replaces the list's rows (migration 0012) with the games its source saw in the
 * last WINDOW_MS, in the store's order. Sources only bumps an item's change position when the item changes (an unchanged
 * game re-seen only moves its retrieved_at), so a change cursor could not tell which games are still on a list.
 *
 *   sync()   read the three sources (the games principal's token for openvibe.sources, grant sources.item.read)
 *   lists()  { top, sale, new, observed_at }: what /steam shows
 */
export const STEAM_LISTS = Object.freeze({
  'steam-top-sellers': 'top',
  'steam-specials': 'sale',
  'steam-new-releases': 'new',
} as const)
export type SteamListName = (typeof STEAM_LISTS)[keyof typeof STEAM_LISTS]
/** Two missed 3-hour fetches drop a game from its list; one does not. */
export const WINDOW_MS = 7 * 3600 * 1000
const PAGE = 500
const MAX_PAGES = 20

export interface SteamGame {
  appid: number
  position: number
  name: string
  final_price: number | null
  original_price: number | null
  discount_percent: number
  currency: string | null
  header_image: string | null
  windows: boolean
  mac: boolean
  linux: boolean
  discount_ends_at: number | null
  observed_at: number
}

export interface SourcesItem {
  id?: string
  identity?: string
  kind?: string
  title?: string | null
  removed?: unknown
  fields?: Record<string, unknown>
  provenance?: { retrieved_at?: string }
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
/** Only Steam's own image CDN: a header image is shown straight from it. */
const STEAM_IMAGE = /^https:\/\/(?:shared\.)?(?:akamai|cloudflare|fastly)\.steamstatic\.com\/[^\s"'<>]+$|^https:\/\/cdn\.(?:akamai|cloudflare)\.steamstatic\.com\/[^\s"'<>]+$/

/** One Sources item → a list row, or null when it is not a usable game (or not seen recently). */
export function toGame(item: SourcesItem, now: number): SteamGame | null {
  if (!item || item.removed) return null
  const f = item.fields ?? {}
  const appid = int(f.appid) ?? (item.identity && /^\d{1,10}$/.test(item.identity) ? Number(item.identity) : null)
  const name = text(item.title, 200)
  const seen = Date.parse(item.provenance?.retrieved_at ?? '')
  if (!appid || appid <= 0 || !name || !Number.isFinite(seen) || now - seen > WINDOW_MS) return null
  const image = text(f.header_image, 500)
  const ends = int(f.discount_expiration)
  return {
    appid,
    position: int(f.position) ?? 999,
    name,
    final_price: int(f.final_price),
    original_price: int(f.original_price),
    discount_percent: Math.max(0, Math.min(100, int(f.discount_percent) ?? 0)),
    currency: text(f.currency, 3),
    header_image: image && STEAM_IMAGE.test(image) ? image : null,
    windows: f.windows === true,
    mac: f.mac === true,
    linux: f.linux === true,
    discount_ends_at: ends && ends > 0 ? ends * 1000 : null,
    observed_at: seen,
  }
}

export interface SteamCatalogOptions {
  db: Db
  /** Base of OpenVibe.Sources (host-internal), or null: no sync, empty lists. */
  sourcesUrl: string | null
  tokens: { getToken(ctx?: { audience?: string }): Promise<string> } | null
  fetch?: typeof fetch
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn'>
}

export function createSteamCatalog(opts: SteamCatalogOptions) {
  const now = opts.now ?? Date.now
  const doFetch = opts.fetch ?? fetch
  const enabled = !!(opts.sourcesUrl && opts.tokens)

  async function readSource(key: string): Promise<SourcesItem[]> {
    const token = await opts.tokens!.getToken({ audience: 'openvibe.sources' })
    const out: SourcesItem[] = []
    let after = 0
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${opts.sourcesUrl}/api/v1/items?source=${encodeURIComponent(key)}&category=games&after=${after}&limit=${PAGE}`
      const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`Sources answered ${res.status} for ${key}`)
      const body = (await res.json()) as { items?: SourcesItem[]; next_after?: number; more?: boolean }
      const items = Array.isArray(body.items) ? body.items : []
      out.push(...items)
      if (!body.more || typeof body.next_after !== 'number' || body.next_after <= after) break
      after = body.next_after
    }
    return out
  }

  /** One list's rows, replaced whole in one transaction (an empty read leaves the list as it was: Sources may be down). */
  async function replace(list: SteamListName, games: SteamGame[]): Promise<void> {
    await opts.db.tx(async (t) => {
      await t.exec('DELETE FROM steam_list_entries WHERE list = $1', [list])
      for (const g of games) {
        await t.exec(
          `INSERT INTO steam_list_entries (list, appid, position, name, final_price, original_price, discount_percent, currency,
             header_image, windows, mac, linux, discount_ends_at, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [list, g.appid, g.position, g.name, g.final_price, g.original_price, g.discount_percent, g.currency, g.header_image, g.windows, g.mac, g.linux, g.discount_ends_at, g.observed_at],
        )
      }
    })
  }

  async function sync(): Promise<Record<string, number> | null> {
    if (!enabled) return null
    const counts: Record<string, number> = {}
    for (const [key, list] of Object.entries(STEAM_LISTS)) {
      const at = now()
      const byApp = new Map<number, SteamGame>()
      for (const item of await readSource(key)) {
        const g = toGame(item, at)
        if (g && (!byApp.has(g.appid) || byApp.get(g.appid)!.observed_at < g.observed_at)) byApp.set(g.appid, g)
      }
      const games = [...byApp.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      if (games.length) await replace(list, games)
      counts[list] = games.length
    }
    return counts
  }

  async function lists(): Promise<{ top: SteamGame[]; sale: SteamGame[]; new: SteamGame[]; observed_at: number | null }> {
    const rows = await opts.db.many<SteamGame & { list: SteamListName }>(
      `SELECT list, appid, position, name, final_price, original_price, discount_percent, currency, header_image, windows, mac,
              linux, discount_ends_at::float8 AS discount_ends_at, observed_at::float8 AS observed_at
         FROM steam_list_entries ORDER BY list, position, name`,
    )
    const out = { top: [] as SteamGame[], sale: [] as SteamGame[], new: [] as SteamGame[], observed_at: null as number | null }
    for (const { list, ...g } of rows) {
      out[list]?.push(g)
      if (!out.observed_at || g.observed_at > out.observed_at) out.observed_at = g.observed_at
    }
    return out
  }

  let timer: NodeJS.Timeout | null = null
  return {
    enabled,
    sync,
    lists,
    /** Sync now and every `everyMs` (unref'd); failures are logged and retried at the next tick. */
    start(everyMs = 3600_000): void {
      if (!enabled || timer) return
      const run = () =>
        void sync()
          .then((c) => opts.log?.info('steam lists synced', { top: c?.top ?? 0, sale: c?.sale ?? 0, new: c?.new ?? 0 }))
          .catch((err: unknown) => opts.log?.warn('steam lists sync failed', { error: String(err) }))
      run()
      timer = setInterval(run, everyMs)
      timer.unref()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
export type SteamCatalog = ReturnType<typeof createSteamCatalog>
