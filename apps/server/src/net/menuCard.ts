import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreatorWorld, CreatorWorldStore } from '@openvibe/persistence'
import { MENU_PATH, menuCard, menuRoute } from 'openvibe-sdk/menu'
import type { MenuCard } from 'openvibe-sdk/menu'

/**
 * The menu's network card for OpenVibe.Games (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
 *
 * Games publishes "New worlds": the newest published creator worlds, each linking to its own page. The file is
 * public and CORS *, cached for a minute (Network refetches every five minutes). Only fields a published world
 * already shows on /worlds are copied — never the owner's subject, a draft, a hidden world or a map.
 */
export const SITE = 'games'
export const CARD_ID = 'new-worlds'
export const CARD_TTL_S = 300
const CACHE_MS = 60_000
const BASE = 'https://openvibe.games'

/** Plain words for a card: markup and control characters out, one line, within the schema's limit. */
export function plain(value: unknown, max: number): string {
  const visible = Array.from(String(value ?? ''), (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : ch
  }).join('')
  return visible
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** The card itself, newest published world first (the store's order). */
export function cardFrom(worlds: CreatorWorld[], at = Date.now()): MenuCard {
  const items = (Array.isArray(worlds) ? worlds : [])
    .filter((w) => w && w.id && w.status === 'published')
    .slice(0, 6)
    .map((w) => ({
      title: plain(w.title, 80),
      meta: `by ${plain(w.ownerName, 110)}`,
      url: `${BASE}/worlds/${encodeURIComponent(w.id)}`,
    }))
  return menuCard({
    id: CARD_ID,
    site: SITE,
    title: 'New worlds',
    kind: 'rows',
    origin: BASE,
    items,
    more: { label: 'All worlds', url: `${BASE}/worlds` },
    ttlSeconds: CARD_TTL_S,
    updatedAt: at,
  })
}

export interface MenuCardOptions {
  store: Pick<CreatorWorldStore, 'listPublished'>
  now?: () => number
}

/**
 * The route. Returns true when it answered the request (the platform handle stops there), false for any other
 * path. A database failure keeps the last good card; before one exists openvibe-sdk/menu answers [] (never a
 * 500), and Network keeps the site's previous card for its 30-minute window.
 */
export function createMenuCardHandler({ store, now = Date.now }: MenuCardOptions) {
  let cached: MenuCard | null = null
  let cachedAt = 0
  let pending: Promise<MenuCard> | null = null

  async function card(): Promise<MenuCard> {
    const at = now()
    if (cached && at - cachedAt < CACHE_MS) return cached
    if (pending) return pending
    pending = (async () => {
      try {
        cached = cardFrom(await store.listPublished(6, 0), at)
        cachedAt = at
      } catch (err) {
        if (!cached) throw err
      }
      return cached as MenuCard
    })().finally(() => {
      pending = null
    })
    return pending
  }

  const route = menuRoute(async () => [await card()], { maxAgeSeconds: 60 })
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path !== MENU_PATH) return false
    void route(req, res)
    return true
  }
}
