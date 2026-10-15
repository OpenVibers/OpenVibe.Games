import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { updatesHandler } from './updatesPage.js'

function call(handler: ReturnType<typeof updatesHandler>, url: string, method = 'GET') {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => {
      status = code
      headers = h ?? {}
    },
    end: (b?: string) => {
      body = b ?? ''
    },
  } as unknown as ServerResponse
  const handled = handler({ url, method } as IncomingMessage, res)
  return { handled, status, headers, body }
}

describe('GET /updates: the shared update log', () => {
  const handler = updatesHandler()

  it('answers the log in the Frame, with one heading and its canonical address', () => {
    const r = call(handler, '/updates')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/^text\/html/)
    expect(r.headers['cache-control']).toBe('public, max-age=300')
    expect(r.body).toContain('<h1>What shipped on OpenVibe.Games</h1>')
    expect(r.body).toContain('data-ov-shipped="log" data-service="games"')
    expect((r.body.match(/<h1[\s>]/g) ?? []).length).toBe(1)
    expect(r.body).toContain('<link rel="canonical" href="https://openvibe.games/updates">')
    expect(r.body).toMatch(/<script src="\/shared\/shipped\.js\?v=[0-9a-f]+" defer><\/script>/)
  })

  it('leaves every other path alone and refuses other methods', () => {
    expect(call(handler, '/updates/x').handled).toBe(false)
    expect(call(handler, '/').handled).toBe(false)
    const post = call(handler, '/updates', 'POST')
    expect([post.handled, post.status]).toEqual([true, 405])
    const head = call(handler, '/updates?x=1', 'HEAD')
    expect([head.status, head.body]).toEqual([200, ''])
  })
})
