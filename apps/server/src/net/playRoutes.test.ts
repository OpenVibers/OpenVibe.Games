import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPlayProxy } from './playRoutes.js'

/** A stand-in for Play: records every call and answers the public reads the pages use. */
function playServer(): {
  server: Server
  calls: { url: string; headers: IncomingMessage['headers'] }[]
} {
  const calls: { url: string; headers: IncomingMessage['headers'] }[] = []
  const server = createServer((req, res) => {
    calls.push({ url: req.url ?? '', headers: req.headers })
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/api/v1/titles') {
      return json(200, {
        titles: [
          {
            id: 'salvage-rush',
            name: 'Salvage Rush',
            boards: [{ id: 'best', name: 'Best round', kind: 'best' }],
            achievements: [],
          },
        ],
      })
    }
    if (req.url === '/api/v1/me/achievements') {
      if (!/^Bearer .+/.test(String(req.headers.authorization ?? '')))
        return json(401, { code: 'token.required' })
      return json(200, {
        titles: [
          {
            title: 'salvage-rush',
            name: 'Salvage Rush',
            achievements: [{ id: 'first', name: 'First' }],
          },
        ],
      })
    }
    if (req.url?.startsWith('/api/v1/titles/salvage-rush/boards/best?')) {
      return json(200, {
        title: 'salvage-rush',
        title_name: 'Salvage Rush',
        board: 'best',
        name: 'Best round',
        kind: 'best',
        period: 'week',
        page: 1,
        pages: 2,
        total: 30,
        entries: [{ rank: 1, name: 'Kim', score: 9, signed_in: true }],
      })
    }
    return json(404, { code: 'route.not_found' })
  })
  return { server, calls }
}

let play: ReturnType<typeof playServer>
let proxy: Server
let playPort = 0
let proxyPort = 0

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
}

function request(
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}> {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers, redirect: 'manual' })
      .then(async (r) =>
        resolve({ status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() }),
      )
      .catch(reject)
  })
}

beforeAll(async () => {
  play = playServer()
  playPort = await listen(play.server)
  let handle: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null
  proxy = createServer((req, res) => {
    if (handle?.(req, res)) return
    res.writeHead(404)
    res.end()
  })
  handle = createPlayProxy({
    url: `http://127.0.0.1:${playPort}`,
    address: () => '203.0.113.7',
    now: (() => {
      let t = 1_000
      return () => (t += 1_000)
    })(),
  })
  proxyPort = await listen(proxy)
})

afterAll(() => {
  play.server.close()
  proxy.close()
})

describe('the Games read bridge to Play', () => {
  it('passes the public titles through and keeps them for a moment', async () => {
    const a = await request('/api/v1/play/titles')
    expect(a.status).toBe(200)
    expect(JSON.parse(a.text).titles[0].id).toBe('salvage-rush')
    expect(a.headers['cache-control']).toContain('max-age=15')
    await request('/api/v1/play/titles')
    expect(play.calls.filter((c) => c.url === '/api/v1/titles')).toHaveLength(1)
    expect(play.calls[0]?.headers['x-forwarded-for']).toBe('203.0.113.7')
  })

  it('forwards a board page and its period, and refuses a bad query', async () => {
    const r = await request('/api/v1/play/titles/salvage-rush/boards/best?period=week&page=1')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text).entries[0].name).toBe('Kim')
    expect(
      play.calls.some(
        (c) => c.url === '/api/v1/titles/salvage-rush/boards/best?period=week&page=1',
      ),
    ).toBe(true)
    expect(
      (await request('/api/v1/play/titles/salvage-rush/boards/best?period=month')).status,
    ).toBe(400)
    expect((await request('/api/v1/play/titles/..%2Fetc/boards/best')).status).toBe(404)
  })

  it("answers the person's own achievements from the ovg_sso session, and signedIn:false without one", async () => {
    const anon = await request('/api/v1/play/achievements')
    expect(anon.status).toBe(200)
    expect(JSON.parse(anon.text)).toEqual({ signedIn: false })
    const r = await request('/api/v1/play/achievements', { cookie: 'ovg_sso=person-token' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text).titles[0].achievements[0].name).toBe('First')
    expect(r.headers['cache-control']).toBe('private, no-store')
    expect(play.calls.find((c) => c.url === '/api/v1/me/achievements')?.headers.authorization).toBe(
      'Bearer person-token',
    )
  })

  it('says 503, never a page, when Play is not configured or down', async () => {
    const off = createServer((req, res) => {
      const handled = createPlayProxy({ url: null, address: () => '127.0.0.1' })(req, res)
      if (!handled) res.writeHead(404).end()
    })
    const port = await listen(off)
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/play/titles`)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'play_unavailable' })
    off.close()
  })
})
