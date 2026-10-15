import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleGameRead } from './gameRoutes.js'
import { BoardUnavailable } from '../platform/playBoards.js'

describe('game read routes', () => {
  it('returns 404 for an unknown game before touching persistence', () => {
    let status = 0
    let body = ''
    const req = {
      method: 'GET',
      url: '/api/v1/games/unknown/leaderboard?period=all',
    } as IncomingMessage
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: (value: string) => {
        body = value
      },
    } as ServerResponse
    expect(
      handleGameRead(req, res, {
        db: null as never,
        boards: null as never,
        networkAuthUrl: null,
        limits: null as never,
        address: () => 'test',
      }),
    ).toBe(true)
    expect(status).toBe(404)
    expect(JSON.parse(body)).toEqual({ error: 'unknown_game' })
  })

  const call = async (url: string, boards: unknown) => {
    let status = 0
    let body = ''
    const req = { method: 'GET', url } as IncomingMessage
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: (value: string) => {
        body = value
      },
      headersSent: false,
    } as unknown as ServerResponse
    handleGameRead(req, res, {
      db: null as never,
      boards: boards as never,
      networkAuthUrl: null,
      limits: { publicRead: async () => true } as never,
      address: () => '203.0.113.9',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { status, body: JSON.parse(body) as Record<string, unknown> }
  }

  it("answers a leaderboard from Play's board, with the viewer's address", async () => {
    const asked: unknown[] = []
    const boards = async (...args: unknown[]) => {
      asked.push(args)
      return {
        game: 'scraplandia',
        period: 'week',
        page: 1,
        pageSize: 25,
        pages: 1,
        total: 1,
        entries: [{ rank: 1, name: 'A', score: 120, signedIn: true }],
      }
    }
    const { status, body } = await call(
      '/api/v1/games/scraplandia/leaderboard?period=week&page=1',
      boards,
    )
    expect(status).toBe(200)
    expect(asked).toEqual([['scraplandia', 'week', 1, '203.0.113.9']])
    expect(body).toMatchObject({
      game: 'scraplandia',
      period: 'week',
      entries: [{ rank: 1, name: 'A', score: 120 }],
    })
  })

  it('answers 503 when Play cannot be read', async () => {
    const boards = async () => {
      throw new BoardUnavailable('play 502')
    }
    const { status, body } = await call('/api/v1/games/salvage-rush/leaderboard?period=all', boards)
    expect(status).toBe(503)
    expect(body).toEqual({ error: 'boards_unavailable' })
  })

  it('refuses a bad period before asking Play', async () => {
    const boards = async () => {
      throw new Error('not asked')
    }
    expect((await call('/api/v1/games/salvage-rush/leaderboard?period=month', boards)).status).toBe(
      400,
    )
  })
})
