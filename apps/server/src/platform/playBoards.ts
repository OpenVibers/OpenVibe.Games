/**
 * The in-game boards, read from OpenVibe.Play (ADR-0007 decision 10). Play keeps every title's boards; Games posts to
 * them (playSync.ts) and answers `GET /api/v1/games/:game/leaderboard` from Play's public board read:
 *
 *   scraplandia   → board `haul` (sum of haul points)
 *   salvage-rush  → board `best` (each player's best round)
 *
 * A page is kept for CACHE_MS, so a busy leaderboard page asks Play at most once per game, period and page in that
 * time. The viewer's address goes along as X-Forwarded-For (Games and Play are both behind the host's nginx), so
 * Play's per-address limits count the viewer and not Games. Play's board shows a name, a score and whether the player was signed in, never a player id. A result reaches
 * the board once the sync has posted it (every 30 s).
 */
import type { GameId } from '../game/progression.js'
import { PLAY_TITLES } from './playSync.js'

const CACHE_MS = 15_000
const CACHE_MAX = 200
const TIMEOUT_MS = 5_000
/** Play's board page (its PER_PAGE). */
const PLAY_PAGE = 25

export interface BoardPage {
  game: GameId
  period: 'all' | 'week'
  page: number
  pageSize: number
  pages: number
  total: number
  entries: { rank: number; name: string; score: number; signedIn: boolean }[]
}

interface PlayBoard {
  page: number
  pages: number
  total: number
  entries: { rank: number; name: string; score: number; signed_in: boolean }[]
}

export class BoardUnavailable extends Error {}

export function createPlayBoards(opts: {
  url: string | null
  fetch?: typeof fetch
  now?: () => number
}) {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const cache = new Map<string, { at: number; value: BoardPage }>()

  return async function read(
    game: GameId,
    period: 'all' | 'week',
    page: number,
    address: string,
  ): Promise<BoardPage> {
    if (!opts.url) throw new BoardUnavailable('GAMES_PLAY_URL is not set')
    const key = `${game}\u0000${period}\u0000${page}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_MS) return hit.value
    const board = PLAY_TITLES[game].boards[0]!.id
    const query = new URLSearchParams({ period, page: String(page) })
    const res = await doFetch(`${opts.url}/api/v1/titles/${game}/boards/${board}?${query}`, {
      headers: { accept: 'application/json', 'x-forwarded-for': address },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err: unknown) => {
      throw new BoardUnavailable(err instanceof Error ? err.message : String(err))
    })
    if (!res.ok) throw new BoardUnavailable(`play ${res.status}`)
    const body = (await res.json()) as PlayBoard
    const value: BoardPage = {
      game,
      period,
      page,
      pageSize: PLAY_PAGE,
      pages: Number(body.pages) || 1,
      total: Number(body.total) || 0,
      entries: (body.entries ?? []).map((e) => ({
        rank: Number(e.rank),
        name: String(e.name),
        score: Number(e.score),
        signedIn: e.signed_in === true,
      })),
    }
    cache.delete(key)
    cache.set(key, { at: now(), value })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return value
  }
}

export type PlayBoards = ReturnType<typeof createPlayBoards>
