import type { IncomingMessage, ServerResponse } from 'node:http'
import { SURF_MAPS, surfMap, type SurfMapInfo } from '@openvibe/content'
import type { Db } from 'openvibe-sdk/db'
import { isGuestToken } from '../platform/accounts.js'
import { PgSurfRecords } from '../platform/surfRuns.js'
import { resolveNetworkUser } from './networkAuth.js'
import { hashGuestKey } from './guestIdentity.js'

/**
 * Public surf reads. Mounted through the same `platform.handle` seam as the
 * other public APIs (main.ts), before the static/SPA fallback:
 *
 *   GET /api/surf/maps
 *   GET /api/surf/maps/:id
 *   GET /api/surf/maps/:id/ghost?of=wr|pb
 *
 * Maps and the WR ghost are briefly public-cached; a PB ghost is private.
 * `pb` needs the caller's identity: a Network bearer or a guest token (the
 * same identity the WebSocket upgrade uses, never a query parameter).
 */
export interface SurfRoutesOptions {
  db: Db
  networkAuthUrl: string | null
  /** Optional Play board read for the map page; local runs are the fallback. */
  playBoard?: (mapId: string) => Promise<{
    entries: { rank: number; name: string; score: number }[]
  } | null>
  log?: (message: string) => void
}

const JSON_CACHE = 'public, max-age=15'
const GHOST_CACHE = 'public, max-age=60'

function send(res: ServerResponse, status: number, body: unknown, cache: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
  })
  res.end(JSON.stringify(body))
}

function noStore(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, body, 'no-store')
}

/** A permanent redirect that keeps the query string (the canonical API id). */
function movedPermanently(res: ServerResponse, path: string, query: string): void {
  res.writeHead(308, { location: `${path}${query}`, 'cache-control': 'no-store' })
  res.end()
}

function mapInfo(id: string): SurfMapInfo | undefined {
  return SURF_MAPS.find((m) => m.id === id)
}

export function handleSurfRead(
  req: IncomingMessage,
  res: ServerResponse,
  options: SurfRoutesOptions,
): boolean {
  if (req.method !== 'GET') return false
  const url = new URL(req.url ?? '/', 'http://games.local')
  if (!url.pathname.startsWith('/api/surf/')) return false
  const parts = url.pathname.split('/').filter(Boolean) // api surf maps <id> ghost
  if (parts[0] !== 'api' || parts[1] !== 'surf' || parts[2] !== 'maps') return false
  const records = new PgSurfRecords(options.db, null, options.log ?? (() => {}))
  const id = parts[3]
  const ghost = parts[4]

  if (!id) {
    if (parts.length !== 3) return false
    void records
      .maps()
      .then((maps) =>
        send(
          res,
          200,
          {
            maps: maps.map((m) => ({
              id: m.id,
              name: m.name,
              tier: m.tier,
              stages: m.stages,
              author: m.author,
              records: m.records,
              wrMs: m.wrMs,
              wrHolder: m.wrHolder,
            })),
          },
          JSON_CACHE,
        ),
      )
      .catch(() => noStore(res, 503, { error: 'surf_unavailable' }))
    return true
  }

  const info = mapInfo(id)
  if (!info) {
    // The old `surf-lagoon` API names are aliases only: a permanent redirect to
    // the Source-form id, ghost suffix and all.
    const legacy = surfMap(id)
    if (legacy) {
      movedPermanently(
        res,
        url.pathname.replace(/^(\/api\/surf\/maps\/)[^/]+/, `$1${legacy.id}`),
        url.search,
      )
      return true
    }
    noStore(res, 404, { error: 'unknown_map' })
    return true
  }

  if (ghost) {
    if (ghost !== 'ghost' || parts.length !== 5) return false
    const of = url.searchParams.get('of') ?? 'wr'
    if (of !== 'wr' && of !== 'pb') {
      noStore(res, 400, { error: 'invalid_query' })
      return true
    }
    void (async () => {
      let key: string | undefined
      if (of === 'pb') {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
        const guest = req.headers['x-guest-token']
        if (bearer && options.networkAuthUrl) {
          const user = await resolveNetworkUser(options.networkAuthUrl, bearer)
          key = user?.subjectId ?? undefined
        } else if (typeof guest === 'string' && isGuestToken(guest)) {
          key = `guest:${hashGuestKey(guest)}`
        }
        if (!key) {
          noStore(res, 401, { error: 'unauthorized' })
          return
        }
      }
      const bytes = await records.ghostBytes(id, of, key)
      if (!bytes) {
        noStore(res, 404, { error: 'no_ghost' })
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
        'cache-control': of === 'wr' ? GHOST_CACHE : 'private, no-store',
        'content-length': String(bytes.length),
      })
      res.end(bytes)
    })().catch(() => {
      if (!res.headersSent) noStore(res, 503, { error: 'surf_unavailable' })
    })
    return true
  }

  if (parts.length !== 4) return false
  void (async () => {
    const maps = await records.maps()
    const summary = maps.find((m) => m.id === id)!
    const local = await records.topRuns(id, 20)
    let entries: { rank: number; name: string; timeMs: number; runId: string | null }[] = local.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      timeMs: r.timeMs,
      runId: r.id,
    }))
    // Prefer Play's board when the platform is reachable; local runs are the
    // honest fallback when it is not.
    if (options.playBoard) {
      try {
        const board = await options.playBoard(id)
        if (board?.entries.length)
          entries = board.entries.map((e) => ({
            rank: e.rank,
            name: e.name,
            timeMs: e.score,
            runId: null,
          }))
      } catch {
        // keep local
      }
    }
    send(
      res,
      200,
      {
        map: {
          id: summary.id,
          name: summary.name,
          tier: summary.tier,
          stages: summary.stages,
          author: summary.author,
          records: summary.records,
          wrMs: summary.wrMs,
          wrHolder: summary.wrHolder,
        },
        top: entries,
      },
      JSON_CACHE,
    )
  })().catch(() => noStore(res, 503, { error: 'surf_unavailable' }))
  return true
}
