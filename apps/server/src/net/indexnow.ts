import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Logger } from '@openvibe/shared'

/**
 * IndexNow (openvibe-shared/indexnow): the protocol by which a site tells search engines a URL
 * changed in one POST. Mounted once at boot; when INDEXNOW_KEY is unset nothing is served and
 * nothing is sent.
 *
 * There are no user-created public pages here — the portal and the game page are the site's only
 * public pages and they change with a deploy, not with a publish — so this site pings nothing.
 * What it does serve is the key file the protocol requires engines to fetch before trusting a
 * batch, so a future publish path can ping without touching this wiring.
 */

export interface SharedIndexNow {
  keyFile(req: IncomingMessage, res: ServerResponse, next: () => void): unknown
  enabled: boolean
}
interface IndexNowFactory {
  createIndexNow(o: { host: string; key: string | null; log: Logger }): SharedIndexNow
}
const shared = createRequire(import.meta.url)('openvibe-shared/indexnow') as IndexNowFactory

/**
 * The IndexNow instance for this site. An unset or blank key leaves it disabled, which is the
 * whole "off" state: `enabled` is false and the key file is never mounted.
 */
export function createGamesIndexNow(host: string, key: string, log: Logger): SharedIndexNow {
  const trimmed = String(key ?? '').trim()
  // createIndexNow() itself refuses a key that is not 8–128 hex/alphanumeric; an unset key is the
  // supported "off" case and is passed through as null.
  return shared.createIndexNow({ host, key: trimmed === '' ? null : trimmed, log })
}

/**
 * Answers GET /<key>.txt — the IndexNow key file, which serves itself — for a site with a key.
 * Returns true when it handled the request. With no key nothing is mounted, so the request falls
 * through to the ordinary 404 rather than leaking whether a key is configured.
 */
export function indexnowHandler(
  indexnow: SharedIndexNow,
): (rq: IncomingMessage, res: ServerResponse) => boolean {
  return (rq, res) => {
    if (!indexnow.enabled) return false
    // The shared key file is itself a middleware: it calls next() for any URL that is not its own
    // key file. Anything it did not claim is this server's to route, so hand it back to the chain.
    let fellThrough = false
    indexnow.keyFile(rq, res, () => {
      fellThrough = true
    })
    return !fellThrough
  }
}
