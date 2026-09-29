import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsoleLogger } from '@openvibe/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServerMetrics } from '../observability/metrics.js'
import { createHttpServer } from './httpServer.js'

/**
 * The site's own legal pages (plan T11 decision 6): /terms, /privacy and /dmca are rendered by
 * openvibe-shared/legal with the Games profile, fetched from the real HTTP layer over a stand-in
 * client build. An unknown /legal-ish path is still a real 404 (notFound.ts), never the landing page.
 */

const log = createConsoleLogger({ app: 'test' }, 'error')
const APEX = 'openvibe.games'
const PAGES: readonly (readonly [string, string])[] = [
  ['/terms', 'Terms of Service'],
  ['/privacy', 'Privacy Policy'],
  ['/dmca', 'DMCA &amp; Copyright'],
]

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

let dir: string
let server: Server
let port = 0

function listen(s: Server): Promise<number> {
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  )
}

function send(
  path: string,
  opts: { method?: string; headers?: OutgoingHttpHeaders } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: APEX, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovg-legal-'))
  const dist = join(dir, 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>portal page</title>')
  writeFileSync(join(dist, 'play.html'), '<!doctype html><title>game page</title>')
  server = createHttpServer(dist, new ServerMetrics(), log)
  port = await listen(server)
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('legal pages (plan T11 decision 6)', () => {
  it('serves each path as its own page: text/html, the title and a canonical on openvibe.games', async () => {
    for (const [path, title] of PAGES) {
      const r = await send(path)
      expect(r.status).toBe(200)
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(r.body).toContain(`<title>${title} — OpenVibe.Games</title>`)
      expect(r.body).toContain(`<link rel="canonical" href="https://openvibe.games${path}">`)
      expect(r.body).toContain(`<h1>${title}</h1>`)
    }
  })

  it('answers HEAD like GET, headers only', async () => {
    for (const [path] of PAGES) {
      const r = await send(path, { method: 'HEAD' })
      expect(r.status).toBe(200)
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(r.body).toBe('')
    }
  })

  it('still 404s a legal-ish path it does not own, through notFound.ts', async () => {
    for (const path of ['/legal', '/terms/extra', '/tos', '/privacy.html']) {
      const r = await send(path)
      expect(r.status).toBe(404)
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(r.body).toContain('Page not found')
    }
  })
})
