import { describe, expect, it } from 'vitest'
import { BoardUnavailable, createPlayBoards } from './playBoards.js'

const board = (entries: unknown[]) =>
  new Response(JSON.stringify({ page: 1, pages: 2, total: 26, entries }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe("in-game boards from Play's public board read", () => {
  it("asks each game's own board, maps the entries and forwards the viewer's address", async () => {
    const asked: { url: string; headers: Record<string, string> }[] = []
    const read = createPlayBoards({
      url: 'http://127.0.0.1:5040',
      fetch: (async (url: string, init: RequestInit) => {
        asked.push({ url, headers: init.headers as Record<string, string> })
        return board([{ rank: 1, name: 'A', score: 150, signed_in: true }])
      }) as typeof fetch,
    })
    const haul = await read('scraplandia', 'week', 1, '203.0.113.9')
    await read('salvage-rush', 'all', 2, '203.0.113.9')
    expect(asked.map((a) => a.url)).toEqual([
      'http://127.0.0.1:5040/api/v1/titles/scraplandia/boards/haul?period=week&page=1',
      'http://127.0.0.1:5040/api/v1/titles/salvage-rush/boards/best?period=all&page=2',
    ])
    expect(asked[0]?.headers['x-forwarded-for']).toBe('203.0.113.9')
    expect(haul).toEqual({
      game: 'scraplandia',
      period: 'week',
      page: 1,
      pageSize: 25,
      pages: 2,
      total: 26,
      entries: [{ rank: 1, name: 'A', score: 150, signedIn: true }],
    })
  })

  it('keeps a page for 15 seconds', async () => {
    let calls = 0
    let now = 1_000
    const read = createPlayBoards({
      url: 'http://play',
      now: () => now,
      fetch: (async () => {
        calls += 1
        return board([])
      }) as unknown as typeof fetch,
    })
    await read('salvage-rush', 'all', 1, 'a')
    now += 14_000
    await read('salvage-rush', 'all', 1, 'b')
    expect(calls).toBe(1)
    await read('salvage-rush', 'week', 1, 'b')
    expect(calls).toBe(2)
    now += 2_000
    await read('salvage-rush', 'all', 1, 'c')
    expect(calls).toBe(3)
  })

  it('is unavailable without Play, when Play refuses, and when it cannot be reached', async () => {
    await expect(
      createPlayBoards({ url: null })('salvage-rush', 'all', 1, 'a'),
    ).rejects.toBeInstanceOf(BoardUnavailable)
    const refused = createPlayBoards({
      url: 'http://play',
      fetch: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(refused('salvage-rush', 'all', 1, 'a')).rejects.toBeInstanceOf(BoardUnavailable)
    const down = createPlayBoards({
      url: 'http://play',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(down('salvage-rush', 'all', 1, 'a')).rejects.toBeInstanceOf(BoardUnavailable)
  })
})
