import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'

/**
 * GET /shared/<file>: this server's own pinned copy of the OpenVibe Frame's browser files (navbar,
 * footer, theme loader…), roadmap WS-P task 4 / D42. The pages run what Games pins (openvibe-shared in
 * apps/server/package.json), not whatever openvibe.network happens to run, and keep their frame while
 * the Network is down. Only the files openvibe-shared/files lists; a request carrying the file's content
 * hash (?v=) is cached for a year, anything else for five minutes; ETag = the hash. Same rules as
 * openvibe-shared/serve, which is Express-shaped (this server is plain node:http).
 */
interface SharedFiles {
  isBrowserFile(name: string): boolean
  path(name: string): string
}
interface SharedServe {
  hashOf(name: string): string
}

export function sharedAssetsHandler(req: NodeRequire = createRequire(import.meta.url)) {
  const files = req('openvibe-shared/files') as SharedFiles
  const serve = req('openvibe-shared/serve') as SharedServe
  return (rq: IncomingMessage, res: ServerResponse): boolean => {
    if (rq.method !== 'GET' && rq.method !== 'HEAD') return false
    const url = new URL(rq.url ?? '/', 'http://games.local')
    if (!url.pathname.startsWith('/shared/')) return false
    const name = url.pathname.slice('/shared/'.length)
    if (!files.isBrowserFile(name)) return false
    const hash = serve.hashOf(name)
    const headers = {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control':
        url.searchParams.get('v') === hash
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300, stale-while-revalidate=60',
      etag: `"${hash}"`,
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    }
    if (rq.headers['if-none-match'] === `"${hash}"`) {
      res.writeHead(304, headers)
      res.end()
      return true
    }
    res.writeHead(200, headers)
    if (rq.method === 'HEAD') {
      res.end()
      return true
    }
    createReadStream(files.path(name))
      .on('error', () => res.destroy())
      .pipe(res)
    return true
  }
}
