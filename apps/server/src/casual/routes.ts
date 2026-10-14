/**
 * The casual games' HTTP API (plan T22). The page talks to it with small JSON requests: no WebSocket, so a
 * phone in an in-app browser starts in one round trip.
 *
 *   POST /api/v1/casual/:game/session      the player's save (created on first visit; `src`/`c` kept then)
 *   POST /api/v1/casual/:game/actions      { key, action } → the new state, under the idempotency key
 *   GET  /api/v1/casual/:game/leaderboard  the furthest signed-in players
 *   GET  /api/v1/casual/:game/ledger       the player's own currency and item history
 *
 * Identity: a Network session (Authorization: Bearer) or the browser's Games guest token (X-Guest-Token), the
 * same two the 3D games use. A signed-in request that still carries the guest token takes over that guest's save.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from 'openvibe-sdk/db'
import type { Logger } from '@openvibe/shared'
import { CASUAL_GAMES, packDigest, parseAction, type CasualPack } from '@openvibe/casual'
import { isGuestToken } from '../platform/accounts.js'
import { hashGuestKey } from '../net/guestIdentity.js'
import { resolveNetworkUser, type NetworkUser } from '../net/networkAuth.js'
import type { GamesActorLimits } from '../net/actorLimits.js'
import { applyAction, casualLeaderboard, casualLedger, openSave } from './store.js'

export interface CasualRouteOptions {
  db: Db
  networkAuthUrl: string | null
  limits: GamesActorLimits
  address: (req: IncomingMessage) => string
  log: Logger
  now?: () => number
  /** Test seam for the Network session check. */
  resolveUser?: (url: string | null, token: string) => Promise<NetworkUser | null>
}

interface Who {
  key: string
  signedIn: boolean
  name: string | null
  guestKey: string | null
}

const PATH = /^\/api\/v1\/casual\/([a-z0-9-]{1,40})\/(session|actions|leaderboard|ledger)$/
const ACTION_KEY = /^[A-Za-z0-9_-]{8,64}$/
const TAG = /^[A-Za-z0-9_-]{1,32}$/
const MAX_BODY = 4096
const SESSION_TTL_MS = 60_000
const MAX_SESSIONS = 10_000

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (v: unknown) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        finish(undefined)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        finish(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
    req.on('close', () => finish(undefined))
  })
}

export function createCasualRoutes(
  opts: CasualRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const now = opts.now ?? Date.now
  const resolveUser = opts.resolveUser ?? resolveNetworkUser
  const digests = new Map(Object.values(CASUAL_GAMES).map((p) => [p.id, packDigest(p)]))
  // A Network session is checked once a minute per token (by its hash), not on every tap.
  const sessions = new Map<string, { user: NetworkUser | null; at: number }>()

  async function who(req: IncomingMessage): Promise<Who | 'expired' | null> {
    const guest = req.headers['x-guest-token']
    const guestKey =
      typeof guest === 'string' && isGuestToken(guest) ? `guest:${hashGuestKey(guest)}` : null
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (bearer) {
      const h = createHash('sha256').update(bearer).digest('hex')
      let hit = sessions.get(h)
      if (!hit || now() - hit.at > SESSION_TTL_MS) {
        hit = { user: await resolveUser(opts.networkAuthUrl, bearer), at: now() }
        if (sessions.size >= MAX_SESSIONS) sessions.clear()
        sessions.set(h, hit)
      }
      const user = hit.user
      if (!user?.subjectId) return 'expired'
      return { key: user.subjectId, signedIn: true, name: user.name, guestKey }
    }
    if (guestKey) return { key: guestKey, signedIn: false, name: null, guestKey: null }
    return null
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://games.local')
    const m = PATH.exec(url.pathname)
    if (!m) return false
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
        ...headers,
      })
      res.end(JSON.stringify(body))
    }
    const pack: CasualPack | undefined = CASUAL_GAMES[m[1] ?? '']
    const route = m[2]
    const method = route === 'leaderboard' || route === 'ledger' ? 'GET' : 'POST'
    if (req.method !== method) {
      send(405, { error: 'method_not_allowed' }, { allow: method })
      return true
    }
    if (!pack) {
      send(404, { error: 'unknown_game' })
      return true
    }
    void (async () => {
      if (route === 'leaderboard') {
        if (!(await opts.limits.publicRead(req, res, `ip:${opts.address(req)}`))) return
        send(200, { entries: await casualLeaderboard(opts.db, pack.id) })
        return
      }
      if (method === 'POST') {
        const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
        if (type !== 'application/json') {
          send(415, { error: 'invalid_request', message: 'Send application/json.' })
          return
        }
      }
      const id = await who(req)
      if (id === 'expired') {
        send(401, {
          error: 'session_expired',
          message: 'Your OpenVibe sign-in expired. Sign in again.',
        })
        return
      }
      if (!id) {
        send(401, { error: 'unauthorized', message: 'Missing a guest token or a sign-in.' })
        return
      }
      if (route === 'ledger') {
        if (!(await opts.limits.publicRead(req, res, `casual:${id.key}`))) return
        const before = Number(url.searchParams.get('before') ?? '')
        send(
          200,
          await casualLedger(
            opts.db,
            pack.id,
            id.key,
            Number.isSafeInteger(before) && before > 0 ? before : null,
          ),
        )
        return
      }
      if (route === 'session') {
        if (!(await opts.limits.casualSession(req, res, `ip:${opts.address(req)}`))) return
        const body = (await readJson(req)) as { src?: unknown; c?: unknown } | undefined
        if (!body || typeof body !== 'object') {
          send(400, { error: 'invalid_request', message: 'Expected a JSON object.' })
          return
        }
        const tag = (v: unknown) => (typeof v === 'string' && TAG.test(v) ? v.toLowerCase() : null)
        const t = now()
        const save = await openSave(opts.db, pack, id.key, {
          now: t,
          name: id.name,
          guestKey: id.guestKey,
          source: tag(body.src),
          campaign: tag(body.c),
        })
        send(200, {
          state: save.state,
          version: save.version,
          created: save.created,
          now: t,
          digest: digests.get(pack.id),
          player: { signedIn: id.signedIn, name: id.name },
        })
        return
      }
      if (!(await opts.limits.casualAction(req, res, `casual:${id.key}`))) return
      if (req.headers['x-casual-digest'] !== digests.get(pack.id)) {
        send(409, {
          error: 'content_changed',
          message: 'The game was updated. Reload to play the new version.',
        })
        return
      }
      const body = (await readJson(req)) as { key?: unknown; action?: unknown } | undefined
      const action = parseAction(body?.action)
      if (!body || typeof body.key !== 'string' || !ACTION_KEY.test(body.key) || !action) {
        send(400, { error: 'invalid_request', message: 'Expected { key, action }.' })
        return
      }
      const t = now()
      const answer = await applyAction(opts.db, pack, id.key, body.key, action, t)
      send(answer.status, answer.status === 200 ? { ...answer.body, now: t } : answer.body)
    })().catch((err: unknown) => {
      opts.log.warn('casual request failed', {
        route: route ?? '',
        error: err instanceof Error ? err.message : String(err),
      })
      send(503, { error: 'unavailable', message: 'The game server is busy. Try again.' })
    })
    return true
  }
}
