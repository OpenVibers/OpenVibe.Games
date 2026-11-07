import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreatorWorld, CreatorWorldStore } from '@openvibe/persistence'

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
export function cardFrom(worlds: CreatorWorld[], at = Date.now()) {
  const items = (Array.isArray(worlds) ? worlds : [])
    .filter((w) => w && w.id && w.status === 'published')
    .slice(0, 6)
    .map((w) => ({
      title: plain(w.title, 80),
      meta: `by ${plain(w.ownerName, 110)}`,
      url: `${BASE}/worlds/${encodeURIComponent(w.id)}`,
    }))
  return {
    id: CARD_ID,
    site: SITE,
    title: 'New worlds',
    kind: 'rows',
    items,
    more: { label: 'All worlds', url: `${BASE}/worlds` },
    updated_at: new Date(at).toISOString(),
    ttl_s: CARD_TTL_S,
  }
}

export interface MenuCardOptions {
  store: Pick<CreatorWorldStore, 'listPublished'>
  now?: () => number
}

/**
 * The route. Returns true when it answered the request (the platform handle stops there), false for any other
 * path. A database failure keeps the last good card; before one exists it answers 503 and Network keeps the
 * site's previous card for its 30-minute window.
 */
export function createMenuCardHandler({ store, now = Date.now }: MenuCardOptions) {
  let cached: ReturnType<typeof cardFrom> | null = null
  let cachedAt = 0
  let pending: Promise<ReturnType<typeof cardFrom>> | null = null

  async function card(): Promise<ReturnType<typeof cardFrom>> {
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
      return cached as ReturnType<typeof cardFrom>
    })().finally(() => {
      pending = null
    })
    return pending
  }

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path !== '/.well-known/openvibe-menu.json') return false
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' })
      res.end('{"error":"method_not_allowed"}')
      return true
    }
    void card()
      .then((body) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=60',
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
        })
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify([body]))
      })
      .catch(() => {
        res.writeHead(503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        res.end('{"error":"menu_unavailable"}')
      })
    return true
  }
}
