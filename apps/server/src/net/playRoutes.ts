/**
 * The Play reads the new OpenVibe.Games pages use (Achievements, Leaderboards, Developers).
 *
 * The pages live here now; the service and its API stay at play.openvibe.network. This module is
 * Games' server-side bridge to Play's public reads, so the browser never talks to Play directly
 * and the site keeps one origin for its own JSON:
 *
 *   GET /api/v1/play/titles                                     every game, its achievements and boards
 *   GET /api/v1/play/titles/:title/boards/:board?period=&page=  one board, this week or all time
 *   GET /api/v1/play/achievements                               the signed-in person's unlocks
 *
 * Titles and boards are public and cached briefly. The person's unlocks forward the ovg_sso
 * session (or a bearer token) to Play's /api/v1/me/achievements; no player id is ever put in a
 * page URL, and the token is never logged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GamesActorLimits } from './actorLimits.js'
import { SESSION_COOKIE, parseCookies } from './sso.js'

const TITLE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
const BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TIMEOUT_MS = 5_000
const TITLES_CACHE_MS = 20_000
const BOARD_CACHE_MS = 15_000
const CACHE_MAX = 200

export interface PlayProxyOptions {
  /** Play's base URL (GAMES_PLAY_URL, host-internal in production); null = the pages show no data. */
  url: string | null
  /** Per-address limits; absent in tests that do not need them. */
  limits?: GamesActorLimits
  /** The viewer's address, forwarded so Play's own per-address limits count the viewer. */
  address: (req: IncomingMessage) => string
  fetchImpl?: typeof fetch
  now?: () => number
  log?: { warn(message: string, meta?: Record<string, unknown>): void }
}

interface Cached {
  at: number
  body: string
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: string,
  cache: string,
  req: IncomingMessage,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** The person's token: the browser's session cookie, or an Authorization header from a client. */
function personToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : null
  if (bearer) return bearer
  const cookie = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE]
  return cookie || null
}

export function createPlayProxy(
  opts: PlayProxyOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const titlesCache: { value: Cached | null } = { value: null }
  const boardCache = new Map<string, Cached>()
  const base = opts.url ? opts.url.replace(/\/+$/, '') : null

  async function playGet(path: string, token?: string, address?: string): Promise<Response> {
    if (!base) throw new Error('GAMES_PLAY_URL is not set')
    return await doFetch(`${base}${path}`, {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(address ? { 'x-forwarded-for': address } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  function cacheGet(res: ServerResponse, req: IncomingMessage, cached: Cached | null): boolean {
    if (!cached) return false
    sendJson(res, 200, cached.body, 'public, max-age=15, stale-while-revalidate=60', req)
    return true
  }

  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const url = new URL(req.url ?? '/', 'http://games.local')
    const titles = url.pathname === '/api/v1/play/titles'
    const achievements = url.pathname === '/api/v1/play/achievements'
    const board = /^\/api\/v1\/play\/titles\/([^/]+)\/boards\/([^/]+)$/.exec(url.pathname)
    if (!titles && !achievements && !board) return false

    const fail = (status: number, error: string, detail?: string): void => {
      sendJson(
        res,
        status,
        JSON.stringify({ error, ...(detail ? { detail } : {}) }),
        'no-store',
        req,
      )
    }
    const reader = opts.limits?.publicRead
    if (reader) {
      void reader(req, res, `ip:${opts.address(req)}`)
        .then((ok) => {
          if (ok) run()
        })
        .catch(() => fail(503, 'read_unavailable'))
    } else run()

    function run(): void {
      void (async () => {
        if (titles) {
          if (
            cacheGet(
              res,
              req,
              titlesCache.value && now() - titlesCache.value.at < TITLES_CACHE_MS
                ? titlesCache.value
                : null,
            )
          )
            return
          const r = await playGet('/api/v1/titles', undefined, opts.address(req))
          if (!r.ok) return fail(503, 'play_unavailable')
          const body = await r.text()
          titlesCache.value = { at: now(), body }
          return sendJson(res, 200, body, 'public, max-age=15, stale-while-revalidate=60', req)
        }
        if (achievements) {
          const token = personToken(req)
          // No session (or a session Play no longer accepts) is a signed-out page, not an error: the page draws
          // every game's achievements instead, and the browser console stays clean on a first visit.
          if (!token)
            return sendJson(res, 200, JSON.stringify({ signedIn: false }), 'private, no-store', req)
          const r = await playGet('/api/v1/me/achievements', token, opts.address(req))
          const body = await r.text()
          if (r.status === 401)
            return sendJson(res, 200, JSON.stringify({ signedIn: false }), 'private, no-store', req)
          if (!r.ok) return fail(503, 'play_unavailable')
          return sendJson(res, 200, body, 'private, no-store', req)
        }
        if (board) {
          const title = decodeURIComponent(board[1] ?? '')
          const boardId = decodeURIComponent(board[2] ?? '')
          if (!TITLE_RE.test(title) || !BOARD_RE.test(boardId)) return fail(404, 'unknown_board')
          const period = url.searchParams.get('period') ?? 'all'
          const page = Number(url.searchParams.get('page') ?? '1')
          if (
            (period !== 'all' && period !== 'week') ||
            !Number.isSafeInteger(page) ||
            page < 1 ||
            page > 10_000
          ) {
            return fail(400, 'invalid_query')
          }
          const key = `${title}\u0000${boardId}\u0000${period}\u0000${page}`
          const hit = boardCache.get(key)
          if (cacheGet(res, req, hit && now() - hit.at < BOARD_CACHE_MS ? hit : null)) return
          const query = new URLSearchParams({ period, page: String(page) })
          const r = await playGet(
            `/api/v1/titles/${encodeURIComponent(title)}/boards/${encodeURIComponent(boardId)}?${query}`,
            undefined,
            opts.address(req),
          )
          const body = await r.text()
          if (!r.ok)
            return fail(
              r.status === 404 ? 404 : 503,
              r.status === 404 ? 'unknown_board' : 'play_unavailable',
            )
          boardCache.delete(key)
          boardCache.set(key, { at: now(), body })
          if (boardCache.size > CACHE_MAX)
            boardCache.delete(boardCache.keys().next().value as string)
          return sendJson(res, 200, body, 'public, max-age=15, stale-while-revalidate=60', req)
        }
      })().catch((err: unknown) => {
        opts.log?.warn('play read unavailable', {
          error: err instanceof Error ? err.message : String(err),
        })
        if (!res.headersSent) fail(503, 'play_unavailable')
      })
    }
    return true
  }
}

export { personToken }
