import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreatorWorldStore } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { NetworkUser } from '../net/networkAuth.js'
import type { ResourceRef, Shares, Viewer } from 'openvibe-sdk/share'
import { describeWorldRef, shareUser, type WorldSharing } from './sharing.js'

/**
 * The uniform share API for creator worlds (openvibe-sdk/share): `/api/v1/world/<id>/share`, its
 * requests and transfer endpoints, `/api/v1/share/people?name=` and `/api/v1/shared-with-me`.
 *
 * The SDK router answers only its own paths, so it sits before the worlds API and hands everything
 * else back. A person is the signed-in Games account (Bearer token, or the ovg_sso cookie the site
 * leaves); a guest is nobody here, as with every other share operation.
 */
export function createWorldShareRoutes(opts: {
  sharing: WorldSharing
  store: CreatorWorldStore
  resolveUser: (token: string) => Promise<NetworkUser | null>
  publicUrl: string
  log: Logger
}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const routed: Shares = Object.create(opts.sharing.shares) as Shares
  routed.getWithRevision = async (viewer: Viewer, ref: ResourceRef) => {
    await opts.sharing.ensure(ref.id)
    return await opts.sharing.shares.getWithRevision(viewer, ref)
  }
  routed.update = async (viewer: Viewer, ref: ResourceRef, body: Parameters<Shares['update']>[2], extra: Parameters<Shares['update']>[3]) => {
    await opts.sharing.ensure(ref.id)
    return await opts.sharing.shares.update(viewer, ref, body, extra)
  }
  routed.requestAccess = async (viewer: Viewer, ref: ResourceRef) => {
    await opts.sharing.ensure(ref.id)
    return await opts.sharing.shares.requestAccess(viewer, ref)
  }
  const handler = opts.sharing.shares.router({
    service: 'games',
    authenticate: async (req: IncomingMessage) => {
      const user = await shareUser(req, opts.resolveUser)
      return opts.sharing.viewer(user)
    },
    describe: describeWorldRef(opts.store, opts.publicUrl),
  })
  const matches = (path: string) => path === '/api/v1/shared-with-me' || path === '/api/v1/share/people'
    || /^\/api\/v1\/world\/[^/]+\/share(?:\/|$)/.test(path)
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (!matches(path)) return false
    handler(req, res).catch((err: unknown) => {
      opts.log.warn('world share request failed', { error: String((err as Error | undefined)?.message ?? err) })
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{"code":"share.internal","error":"Sharing unavailable"}')
      }
    })
    return true
  }
}
