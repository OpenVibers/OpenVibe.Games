import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createGamesActorLimits } from './actorLimits.js'

/**
 * Per-actor limits on Games' HTTP writes (roadmap WS-R task 4): one actor past its limit gets 429 problem+json
 * rate_limited with Retry-After before the handler reads anything, another actor still passes, the window reopens;
 * an editor credential becomes a short hash, never the credential itself.
 */
let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

describe('Games per-actor limits', () => {
  it('refuses one actor past the limit, lets another through, and reopens', async () => {
    let t = Date.UTC(2026, 8, 28, 3, 0, 0)
    const refused: string[] = []
    const limits = createGamesActorLimits({
      env: {},
      now: () => t,
      onLimited: (name) => refused.push(name),
    })
    let handled = 0
    server = createServer((req, res) => {
      const actor = String(req.headers['x-actor'] ?? '')
      void limits.mapSave(req, res, actor).then((ok) => {
        if (!ok) return
        handled++
        res.writeHead(200).end('{}')
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/map`
    const save = (actor: string) => fetch(url, { method: 'POST', headers: { 'x-actor': actor } })
    for (let i = 0; i < 30; i++) expect((await save('editor:a')).status).toBe(200)
    const r = await save('editor:a')
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBeTruthy()
    expect(((await r.json()) as { code: string }).code).toBe('rate_limited')
    expect(handled).toBe(30)
    expect((await save('editor:b')).status).toBe(200)
    expect(refused).toEqual(['games.map.save'])
    t += 60_000
    expect((await save('editor:a')).status).toBe(200)
  })

  it('names an editor by a hash of its credential', () => {
    const limits = createGamesActorLimits({ env: {} })
    const id = limits.editorActor('secret-editor-key')
    expect(id).toMatch(/^editor:[0-9a-f]{16}$/)
    expect(id).not.toContain('secret')
    expect(limits.editorActor('secret-editor-key')).toBe(id)
  })
})
