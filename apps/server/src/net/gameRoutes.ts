import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from 'openvibe-sdk/db'
import { isGuestToken } from '../platform/accounts.js'
import { hashGuestKey } from './guestIdentity.js'
import { resolveNetworkUser } from './networkAuth.js'
import type { GamesActorLimits } from './actorLimits.js'
import { isGameId, playerAchievements } from '../game/progression.js'
import { BoardUnavailable, type PlayBoards } from '../platform/playBoards.js'

interface Options {
  db: Db
  /** The boards, read from OpenVibe.Play. */
  boards: PlayBoards
  networkAuthUrl: string | null
  limits: GamesActorLimits
  address: (req: IncomingMessage) => string
}

export function handleGameRead(
  req: IncomingMessage,
  res: ServerResponse,
  options: Options,
): boolean {
  if (req.method !== 'GET') return false
  const url = new URL(req.url ?? '/', 'http://games.local')
  const match = /^\/api\/v1\/games\/([^/]+)\/leaderboard$/.exec(url.pathname)
  const achievements = url.pathname === '/api/v1/players/me/achievements'
  if (!match && !achievements) return false
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (match && !isGameId(match[1] ?? '')) {
    send(404, { error: 'unknown_game' })
    return true
  }
  void (async () => {
    if (!(await options.limits.publicRead(req, res, `ip:${options.address(req)}`))) return
    if (match) {
      const period = url.searchParams.get('period') ?? 'all'
      const page = Number(url.searchParams.get('page') ?? '1')
      if (
        (period !== 'all' && period !== 'week') ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 10_000
      ) {
        send(400, { error: 'invalid_query' })
        return
      }
      try {
        send(
          200,
          await options.boards(
            match[1] as 'scraplandia' | 'salvage-rush',
            period,
            page,
            options.address(req),
          ),
        )
      } catch (err) {
        if (!(err instanceof BoardUnavailable)) throw err
        send(503, { error: 'boards_unavailable' })
      }
      return
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const guest = req.headers['x-guest-token']
    let key: string | null = null
    if (bearer && options.networkAuthUrl) {
      const user = await resolveNetworkUser(options.networkAuthUrl, bearer)
      key = user?.subjectId ?? null
    } else if (typeof guest === 'string' && isGuestToken(guest)) {
      key = `guest:${hashGuestKey(guest)}`
    }
    if (!key) {
      send(401, { error: 'unauthorized' })
      return
    }
    send(200, { games: await playerAchievements(options.db, key) })
  })().catch(() => {
    if (!res.headersSent) send(503, { error: 'read_unavailable' })
  })
  return true
}
