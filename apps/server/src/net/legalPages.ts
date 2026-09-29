import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'

/**
 * GET /terms, /privacy and /dmca (plan T11 decision 6): the site answers its own legal pages with
 * openvibe-shared/legal, as every other product does. openvibe.games used to be answered by the
 * OpenVibe.Sites placeholder (nginx served /opt/openvibe.sites/dist/openvibe.games for them); Sites
 * is going away, so the pages move here.
 *
 * The profile is 'games': legal.js switches clauses by profile, and 'games' is the one that fits a
 * game with accounts, chat and user-made maps — it adds the Games section (in development, play
 * fair, no cheats, game-chat rules), the user-content licence (user-made maps) and, in the privacy
 * document, the Game data bullet. The account clauses are included for every non-'info' profile.
 *
 * legal.handler is Express-shaped (this server is plain node:http, like sharedAssets.ts), so a tiny
 * req/res shim stands in for Express: req.path and res.set/res.send are all it touches.
 */
interface LegalSite {
  id: string
  service: string
  host: string
  name: string
  profile: string
}
interface LegalReq {
  path: string
}
interface LegalRes {
  set(name: string, value: string): void
  send(body: string): void
}
interface LegalModule {
  PATHS: string[]
  handler(site: LegalSite): (req: LegalReq, res: LegalRes, next: () => void) => void
}

const SITE: LegalSite = {
  id: 'games',
  service: 'games',
  host: 'openvibe.games',
  name: 'OpenVibe.Games',
  profile: 'games',
}

export function legalHandler(req: NodeRequire = createRequire(import.meta.url)) {
  const legal = req('openvibe-shared/legal') as LegalModule
  const paths = new Set(legal.PATHS)
  // One handler for the process: openvibe-shared caches each rendered page after the first request.
  const handle = legal.handler(SITE)
  return (rq: IncomingMessage, res: ServerResponse): boolean => {
    const url = (rq.url ?? '/').split('?')[0] ?? '/'
    if (!paths.has(url)) return false
    if (rq.method !== 'GET' && rq.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return true
    }
    const headers: Record<string, string> = {}
    handle(
      { path: url },
      {
        set: (name, value) => {
          headers[name.toLowerCase()] = value
        },
        send: (body) => {
          res.writeHead(200, headers)
          // node:http writes no body for HEAD; the headers are the same.
          res.end(rq.method === 'HEAD' ? undefined : body)
        },
      },
      () => {
        // legal.PATHS and the shared handler's documents are the same list; unreachable, but a
        // path it does not know must not fall through as a 200.
        res.writeHead(404)
        res.end()
      },
    )
    return true
  }
}
