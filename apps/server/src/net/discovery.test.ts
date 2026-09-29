import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConsoleLogger } from '@openvibe/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServerMetrics } from '../observability/metrics.js'
import { createHttpServer } from './httpServer.js'

/**
 * The crawl artifacts of plan T11 (audit §4 items 1-2): /robots.txt, /sitemap.xml and /llms.txt,
 * plus the home page's JSON-LD, fetched from the real HTTP layer over a stand-in client build.
 * Every one is built by openvibe-shared/seo; public pages only, and no private path anywhere.
 */

const log = createConsoleLogger({ app: 'test' }, 'error')
const APEX = 'openvibe.games'
const PRIVATE = ['/auth/', '/api/', '/metrics', '/editor']
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

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
  opts: { host?: string; method?: string; headers?: OutgoingHttpHeaders } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? APEX, ...opts.headers },
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
  dir = mkdtempSync(join(tmpdir(), 'ovg-discovery-'))
  const dist = join(dir, 'dist')
  mkdirSync(dist, { recursive: true })
  // A stand-in portal build with a real </head>: the JSON-LD is injected before it as it is served.
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html><head><title>portal page</title></head><body>portal</body></html>',
  )
  writeFileSync(
    join(dist, 'play.html'),
    '<!doctype html><html><head><title>game page</title></head><body>game</body></html>',
  )
  server = createHttpServer(dist, new ServerMetrics(), log)
  port = await listen(server)
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('crawl artifacts (plan T11)', () => {
  it('serves /robots.txt: text/plain, the shared policy, the sitemap and every private path Disallowed', async () => {
    const r = await send('/robots.txt')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(r.headers['cache-control']).toBe('public, max-age=3600')
    expect(r.body).toContain('User-agent: *')
    expect(r.body).toContain('Sitemap: https://openvibe.games/sitemap.xml')
    // One real entry per private path — kept out of crawlers, never listed as a page.
    for (const p of PRIVATE) expect(r.body).toContain(`Disallow: ${p}`)
    // The shared toolkit welcomes AI and search crawlers by name.
    expect(r.body).toContain('User-agent: GPTBot')
    expect(r.body).toContain('User-agent: ClaudeBot')
  })

  it('serves /sitemap.xml: XML, the public pages, a real lastmod from the data', async () => {
    const r = await send('/sitemap.xml')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/xml; charset=utf-8')
    expect(r.body).toContain('<loc>https://openvibe.games/</loc>')
    expect(r.body).toContain('<loc>https://play.openvibe.games/</loc>')
    // The lastmod is the committed content-revision date, not the clock.
    const status = JSON.parse(readFileSync(join(ROOT, 'STATUS.json'), 'utf8')) as {
      updated: string
    }
    expect(r.body).toContain(`<lastmod>${status.updated.slice(0, 10)}</lastmod>`)
    for (const p of PRIVATE) expect(r.body).not.toContain(p)
  })

  it('serves /llms.txt: text/plain, what the site is, a real page and its machine endpoints', async () => {
    const r = await send('/llms.txt')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(r.headers['cache-control']).toBe('public, max-age=3600')
    expect(r.body).toContain('# OpenVibe.Games')
    expect(r.body).toContain('- [OpenVibe.Games home](https://openvibe.games/)')
    expect(r.body).toContain('- [Scraplandia](https://play.openvibe.games/)')
    expect(r.body).toContain('https://openvibe.games/sitemap.xml')
    expect(r.body).toContain('https://openvibe.games/robots.txt')
    expect(r.body).toContain('https://openvibe.games/map.json')
    for (const p of PRIVATE) expect(r.body).not.toContain(p)
  })

  it('injects the home page JSON-LD built by openvibe-shared/seo: WebSite + the primary type', async () => {
    const r = await send('/')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.body).toContain('<title>portal page</title>')
    const blocks = [
      ...r.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ]
    expect(blocks.map((b) => (JSON.parse(b[1] ?? '{}') as { '@type'?: string })['@type'])).toEqual([
      'WebSite',
      'WebApplication',
      'WebPage',
    ])
    const nodes = blocks.map((b) => JSON.parse(b[1] ?? '{}') as Record<string, unknown>)
    expect(nodes[0]?.['url']).toBe('https://openvibe.games')
    expect(nodes[1]?.['applicationCategory']).toBe('GameApplication')
    // Nothing private or per-user in the served nodes.
    const text = JSON.stringify(nodes)
    for (const p of PRIVATE) expect(text).not.toContain(p)
  })

  it('answers HEAD for the artifacts without a body', async () => {
    const r = await send('/sitemap.xml', { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/xml; charset=utf-8')
    expect(r.body).toBe('')
  })
})
