import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sharedAssetsHandler } from './sharedAssets.js'

// D42 (roadmap WS-P task 4): the game server serves its own pinned OpenVibe Frame files at /shared, and the
// client pages load them from there, never from openvibe.network.
const req = createRequire(import.meta.url)
const serve = req('openvibe-shared/serve') as { hashOf(n: string): string }
let server: Server
let base = ''

beforeAll(async () => {
  const handle = sharedAssetsHandler()
  server = createServer((rq, res) => {
    if (handle(rq, res)) return
    res.writeHead(404)
    res.end('not shared')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('/shared (D42)', () => {
  it('serves the pinned navbar, content-addressed, with an ETag', async () => {
    const hash = serve.hashOf('navbar.js')
    let r = await fetch(`${base}/shared/navbar.js?v=${hash}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/javascript/)
    expect(r.headers.get('cache-control')).toMatch(/immutable/)
    expect((await r.text()).length).toBeGreaterThan(1000)
    r = await fetch(`${base}/shared/navbar.js`)
    expect(r.headers.get('cache-control')).toMatch(/max-age=300/)
    r = await fetch(`${base}/shared/navbar.js`, { headers: { 'if-none-match': `"${hash}"` } })
    expect(r.status).toBe(304)
  })

  it('serves a stylesheet as text/css (the profile panel drew unstyled when its CSS went out as JavaScript)', async () => {
    const r = await fetch(`${base}/shared/profile-panel.css`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/^text\/css/)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await fetch(`${base}/shared/profile-panel.js`)).headers.get('content-type')).toMatch(/javascript/)
  })

  it('serves the web app manifest and touch icon the shared page shell links (/steam, /updates, world pages)', async () => {
    const shell = req('openvibe-shared/serve') as { manifestUrl(s: string): string | null }
    const url = shell.manifestUrl('games')
    expect(url).toMatch(/^\/shared\/manifest\/games\.webmanifest\?v=/)
    const r = await fetch(base + url)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/manifest\+json/)
    expect(r.headers.get('cache-control')).toMatch(/immutable/)
    const m = (await r.json()) as { name?: string; icons?: { src: string }[] }
    expect(m.name).toBeTruthy()
    const icon = m.icons?.[0]?.src ?? ''
    expect(icon).toMatch(/^\/shared\/icons\//)
    const ir = await fetch(base + icon)
    expect(ir.status).toBe(200)
    expect(ir.headers.get('content-type')).toMatch(/image\/png/)
    expect((await fetch(`${base}/shared/manifest/no-such-site.webmanifest`)).status).toBe(404)
  })

  it('serves only the browser files openvibe-shared lists', async () => {
    for (const p of [
      '/shared/serve.js',
      '/shared/../package.json',
      '/shared/',
      '/other/navbar.js',
    ]) {
      expect((await fetch(base + p)).status).toBe(404)
    }
    expect((await fetch(`${base}/shared/navbar.js`, { method: 'POST' })).status).toBe(404)
  })

  it('the client pages load the frame from /shared, not openvibe.network', () => {
    const client = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'client')
    for (const page of ['index.html', 'play.html', 'editor.html']) {
      const html = readFileSync(join(client, page), 'utf8')
      expect(html).not.toMatch(/https:\/\/openvibe\.network\/shared\/[\w.-]+\.js/)
      expect(html).toMatch(/src="\/shared\/navbar\.js"/)
    }
  })
})
