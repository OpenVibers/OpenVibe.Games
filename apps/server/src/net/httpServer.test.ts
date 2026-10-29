import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConsoleLogger } from '@openvibe/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServerMetrics } from '../observability/metrics.js'
import { createReadiness } from '../observability/readiness.js'
import { createHttpServer } from './httpServer.js'
import { createWsTicketStore } from './wsTicket.js'
import { createGamesActorLimits } from './actorLimits.js'
import { escapeHtml, notFoundPage } from './notFound.js'

/**
 * Routing of the real HTTP layer over a stand-in client build: every real
 * route keeps its status, the play host serves the game at /, and a path no
 * route matches is a 404 (never the landing page with a 200).
 */

const log = createConsoleLogger({ app: 'test' }, 'error')
const APEX = 'openvibe.games'
const PLAY = 'play.openvibe.games'
const ASSET = '/assets/main-Cj5pXm1a.js'

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

let dir: string
let server: Server
let bare: Server

function listen(s: Server): Promise<number> {
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  )
}

let port = 0
let barePort = 0

/** A raw request (node:http, so the Host header and the path go out exactly as given). */
function send(
  path: string,
  opts: { host?: string; method?: string; headers?: OutgoingHttpHeaders; to?: number } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: opts.to ?? port,
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
  dir = mkdtempSync(join(tmpdir(), 'ovg-http-'))
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets', 'tex'), { recursive: true })
  // A real page has a head to carry the discovery tags into (the agent layer adds them there).
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>portal page</title></head><body><h1>portal page</h1></body></html>')
  writeFileSync(join(dist, 'play.html'), '<!doctype html><html><head><title>game page</title></head><body><h1>game page</h1></body></html>')
  writeFileSync(join(dist, 'editor.html'), '<!doctype html><title>editor page</title>')
  writeFileSync(join(dist, 'frame.js'), 'void 0')
  writeFileSync(join(dist, ASSET.slice(1)), 'export {}')
  writeFileSync(join(dist, 'assets', 'tex', 'wood_planks.jpg'), 'jpeg')
  writeFileSync(join(dist, 'assets', 'tex', 'wood_planks.ktx2'), 'ktx2')
  const mapPath = join(dir, 'data', 'map.json')
  mkdirSync(join(dir, 'data', 'map-assets'), { recursive: true })
  writeFileSync(join(dir, 'data', 'map-assets', 'tex-1700000000000.png'), 'png')

  const metrics = new ServerMetrics()
  metrics.tick = 42
  metrics.lastTickAt = Date.now()
  // /api/ready arrives through the platform hook, as main.ts wires it.
  const readiness = createReadiness({ pingDb: async () => ({ ok: true }), metrics })
  server = createHttpServer(
    dist,
    metrics,
    log,
    mapPath,
    // the legacy editor key is gone — the editor requires a Network session. The
    // test stays a "no Network" server, so the editor routes return 403
    // for everyone, which is exactly what we want to lock in.
    { networkAuthUrl: null },
    undefined,
    async () => [{ slot: 0, name: 'Ana', appearance: null }],
    null,
    { handle: (req, res) => readiness.handle(req, res) },
  )
  bare = createHttpServer(null, metrics, log)
  port = await listen(server)
  barePort = await listen(bare)
})

afterAll(() => {
  server.close()
  bare.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('real routes on the apex', () => {
  it.each([
    ['/', 'portal page'],
    ['/play', 'game page'],
    ['/play?sso=none', 'game page'],
    ['/editor', 'editor page'],
    ['/index.html', 'portal page'],
  ])('%s answers 200 with its page', async (path, marker) => {
    const r = await send(path)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers['cache-control']).toBe('no-cache')
    expect(r.body).toContain(marker)
  })

  it('serves hashed build assets as immutable, and public files', async () => {
    const asset = await send(ASSET)
    expect(asset.status).toBe(200)
    expect(asset.headers['content-type']).toBe('text/javascript')
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await send('/frame.js')).status).toBe(200)
    const tex = await send('/assets/tex/wood_planks.jpg')
    expect(tex.status).toBe(200)
    expect(tex.headers['cache-control']).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    )
    const ktx2 = await send('/assets/tex/wood_planks.ktx2')
    expect([ktx2.status, ktx2.headers['content-type']]).toEqual([200, 'image/ktx2'])
  })

  it('answers health, readiness, metrics and the API', async () => {
    const health = await send('/healthz')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ ok: true, tick: 42 })
    expect((await send('/api/ready')).status).toBe(200)
    expect((await send('/metrics')).status).toBe(200)
    const chars = await send('/api/characters?token=guest-token-1234')
    expect(chars.status).toBe(200)
    expect(JSON.parse(chars.body)).toEqual([{ slot: 0, name: 'Ana', appearance: null }])
    const map = await send('/map.json')
    expect(map.status).toBe(200)
    expect(map.headers.etag).toBeTruthy()
    const tex = await send('/map-assets/tex-1700000000000.png')
    expect(tex.status).toBe(200)
    expect(tex.headers['content-type']).toBe('image/png')
  })

  it('answers the SSO routes', async () => {
    const me = await send('/auth/me')
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body)).toEqual({ user: null })
    const out = await send('/auth/logout')
    expect(out.status).toBe(200)
    expect(out.body).toContain('location.replace("/play")')
  })

  it.each([
    ['/play.html', '/play'],
    ['/editor.html', '/editor'],
    ['/play/', '/play'],
    ['/editor/', '/editor'],
  ])('%s redirects to %s', async (path, location) => {
    const r = await send(path)
    expect(r.status).toBe(301)
    expect(r.headers.location).toBe(location)
  })

  it('serves the canonical surf page and the embed route', async () => {
    for (const path of ['/surf/surf_lagoon', '/surf/embed?map=surf_lagoon']) {
      const r = await send(path)
      expect(r.status).toBe(200)
      expect(r.body).toContain('game page')
    }
    const embed = await send('/surf/embed?map=surf_lagoon')
    expect(embed.headers['content-security-policy']).toBe(
      "frame-ancestors https://openvibe.surf 'self'",
    )
  })

  it.each([
    ['/surf/surf-lagoon', '/surf/surf_lagoon'],
    ['/surf/surf-lagoon/', '/surf/surf_lagoon'],
    ['/surf/embed?map=surf-lagoon&embed=1', '/surf/embed?map=surf_lagoon&embed=1'],
    ['/play?game=surf-lagoon', '/surf/surf_lagoon'],
    ['/play?game=surf-lagoon&src=ad', '/surf/surf_lagoon?src=ad'],
    ['/play?game=surf&map=surf-canyon', '/surf/surf_canyon'],
  ])('%s redirects to %s', async (path, location) => {
    const r = await send(path)
    expect(r.status).toBe(301)
    expect(r.headers.location).toBe(location)
  })

  it('answers an unknown surf map with 404, not the game page', async () => {
    const r = await send('/surf/surf-missing')
    expect(r.status).toBe(404)
    expect(r.body).not.toContain('game page')
  })

  it('answers HEAD like GET, without a body', async () => {
    const r = await send('/', { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(r.body).toBe('')
  })
})

describe('unknown paths answer 404', () => {
  it.each(['/nope', '/play/extra', '/editor/some-map', '/assets', '/assets/', '/old-page.html'])(
    '%s is a 404 page, not the portal',
    async (path) => {
      const r = await send(path)
      expect(r.status).toBe(404)
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(r.headers['cache-control']).toBe('no-store')
      expect(r.body).toContain('<title>Page not found · OpenVibe.Games</title>')
      expect(r.body).not.toContain('portal page')
      expect(r.body).toContain('<a href="/">OpenVibe.Games home</a>')
      expect(r.body).toContain('<a href="/play">Play Scraplandia</a>')
      expect(r.body).toContain('<a href="/editor">Map editor</a>')
      expect(r.body).not.toMatch(/<script\b/)
      // Names the client's icon, so the browser does not ask /favicon.ico (a second 404).
      expect(r.body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">')
    },
  )

  it('echoes the requested path escaped', async () => {
    const r = await send(`/x<script>alert("1")</script>&'y`)
    expect(r.status).toBe(404)
    expect(r.body).not.toContain('<script>alert')
    expect(r.body).toContain(
      '<code>/x&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;&amp;&#39;y</code>',
    )
    const encoded = await send('/%3Cimg%20src%3Dx%3E')
    expect(encoded.body).toContain('<code>/%3Cimg%20src%3Dx%3E</code>')
  })

  it('gives HEAD and POST the same status', async () => {
    const head = await send('/nope', { method: 'HEAD' })
    expect(head.status).toBe(404)
    expect(head.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(head.body).toBe('')
    expect((await send('/nope', { method: 'POST' })).status).toBe(404)
  })

  it('answers a missing asset with a plain-text 404', async () => {
    for (const path of ['/assets/main-Missing1.js', '/favicon.ico', '/assets/tex/nope.jpg']) {
      const r = await send(path)
      expect(r.status).toBe(404)
      expect(r.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(r.body).toBe('not found\n')
    }
    expect((await send('/map-assets/tex-1.png')).status).toBe(404)
  })

  it('answers unknown API paths and JSON clients with the JSON 404', async () => {
    for (const path of ['/api/nope', '/api', '/api/map', '/auth/nope']) {
      const r = await send(path)
      expect(r.status).toBe(404)
      expect(r.headers['content-type']).toBe('application/json')
      expect(JSON.parse(r.body)).toEqual({ error: 'not_found' })
    }
    const json = await send('/nope', { headers: { accept: 'application/json' } })
    expect(json.status).toBe(404)
    expect(JSON.parse(json.body)).toEqual({ error: 'not_found' })
  })
})

describe('play.openvibe.games', () => {
  it('serves the game at /', async () => {
    const r = await send('/', { host: PLAY })
    expect(r.status).toBe(200)
    expect(r.body).toContain('game page')
  })

  it.each(['/play', '/play/', '/play.html'])('%s redirects to /', async (path) => {
    const r = await send(path, { host: PLAY })
    expect(r.status).toBe(301)
    expect(r.headers.location).toBe('/')
  })

  it('serves the editor, assets, map and health like the apex', async () => {
    expect((await send('/editor', { host: PLAY })).body).toContain('editor page')
    expect((await send(ASSET, { host: PLAY })).status).toBe(200)
    expect((await send('/map.json', { host: PLAY })).status).toBe(200)
    expect((await send('/healthz', { host: PLAY })).status).toBe(200)
  })

  it('answers an unknown path with 404, not the game', async () => {
    const r = await send('/nope', { host: PLAY })
    expect(r.status).toBe(404)
    expect(r.body).not.toContain('game page')
    expect(r.body).toContain('<a href="/">Play Scraplandia</a>')
    expect(r.body).toContain('<a href="https://openvibe.games/">OpenVibe.Games home</a>')
    expect((await send('/assets/nope.js', { host: PLAY })).status).toBe(404)
  })
})

describe('without a client build (API/WS only)', () => {
  it('still answers health, and 404 for pages', async () => {
    expect((await send('/healthz', { to: barePort })).status).toBe(200)
    const r = await send('/', { to: barePort })
    expect(r.status).toBe(404)
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
  })
})

describe('404 page', () => {
  it('escapes every link and cuts a very long path', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
    const page = notFoundPage(`/${'a'.repeat(500)}`, [{ href: '/?a=1&b="2"', label: '<b>' }])
    expect(page).toContain('<a href="/?a=1&amp;b=&quot;2&quot;">&lt;b&gt;</a>')
    expect(page).toContain(`/${'a'.repeat(199)}…</code>`)
    expect(page).not.toContain('a'.repeat(201))
  })

  it('names the icon the client pages use, and that file ships with the client', () => {
    const page = notFoundPage('/nope', [])
    expect(page).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">')
    const icon = fileURLToPath(new URL('../../../client/public/favicon.svg', import.meta.url))
    expect(existsSync(icon)).toBe(true)
  })
})

describe('/api/ws-ticket is rate limited per address', () => {
  it('refuses a flood from one address with 429, and spoofed X-Forwarded-For does not help', async () => {
    const metrics = new ServerMetrics()
    const limits = createGamesActorLimits({})
    const tickets = createWsTicketStore()
    const server = createHttpServer(
      null,
      metrics,
      log,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      {
        handle: () => false,
        limits,
        // Trust nothing: forwarded headers must not create fresh buckets.
        clientAddress: (req) => req.socket.remoteAddress ?? 'unknown',
      },
      tickets,
    )
    const ticketPort = await listen(server)
    try {
      // The per-address cap is 60/minute: the first 60 succeed, the next is 429.
      let status = 0
      for (let i = 0; i < 61; i++) {
        const r = await send('/api/ws-ticket', {
          to: ticketPort,
          method: 'POST',
          headers: { 'x-guest-token': 'guesttoken1234', 'x-forwarded-for': `203.0.113.${i}` },
        })
        status = r.status
        if (status === 429) break
      }
      expect(status).toBe(429)
    } finally {
      server.close()
    }
  })
})

describe('the agent layer', () => {
  it('serves the manifest on the apex and on the play host', async () => {
    for (const host of [APEX, PLAY]) {
      const r = await send('/.well-known/agent.json', { host })
      expect(r.status).toBe(200)
      expect(r.headers['content-type']).toBe('application/json; charset=utf-8')
      const d = JSON.parse(r.body)
      expect(d).toMatchObject({ id: 'games', site: 'openvibe.games', home: 'https://openvibe.games' })
      expect(d.api).toBe('https://openvibe.games/api')
      expect(d.policy.auth).toEqual(['none', 'Network OIDC'])
    }
  })

  it('twins the portal, the game and a world page', async () => {
    const index = await send('/index.md')
    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(index.headers.link).toContain('rel="alternate"')
    expect(index.body).toContain('canonical: "https://openvibe.games/"')
    expect(index.body).toContain('# portal page')
    // The game's canonical home is the play host's root (play.html names it), so its twin does too,
    // wherever the twin is asked for.
    const play = await send('/play.md')
    expect(play.status).toBe(200)
    expect(play.body).toContain('canonical: "https://play.openvibe.games/"')
    expect(play.body).toContain('# game page')
    // The play host's root IS the game.
    const root = await send('/index.md', { host: PLAY })
    expect(root.status).toBe(200)
    expect(root.body).toContain('canonical: "https://play.openvibe.games/"')
    expect(root.body).toContain('# game page')
  })

  it('names the twin on the HTML page, and answers a markdown preference', async () => {
    // The portal names its twin: the stub pages carry no canonical, so the apex root is the fallback.
    const page = await send('/')
    expect(page.headers.link).toContain('<https://openvibe.games/index.md>; rel="alternate"; type="text/markdown"')
    expect(page.body).toContain('<link rel="alternate" type="text/markdown" href="https://openvibe.games/index.md">')
    expect(page.body).toContain('<link rel="describedby" href="https://openvibe.games/llms.txt">')
    const md = await send('/play', { headers: { accept: 'text/markdown' } })
    expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(md.body).toContain('# game page')
    // A browser's request is the page itself, never the twin.
    const browser = await send('/play', { headers: { accept: 'text/html,application/xhtml+xml' } })
    expect(browser.headers['content-type']).toBe('text/html; charset=utf-8')
  })

  it('has no twin for a page that is not public', async () => {
    const r = await send('/nothing.md')
    expect(r.status).toBe(404)
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(r.body).toBe('# Not found\n')
  })
})
