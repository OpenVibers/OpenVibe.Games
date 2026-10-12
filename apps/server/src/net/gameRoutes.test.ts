import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleGameRead } from './gameRoutes.js'

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
        networkAuthUrl: null,
        limits: null as never,
        address: () => 'test',
      }),
    ).toBe(true)
    expect(status).toBe(404)
    expect(JSON.parse(body)).toEqual({ error: 'unknown_game' })
  })

  it('answers the Scraplandia haul leaderboard', async () => {
    let status = 0
    let body = ''
    const req = {
      method: 'GET',
      url: '/api/v1/games/scraplandia/leaderboard?period=week&page=1',
    } as IncomingMessage
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: (value: string) => {
        body = value
      },
    } as ServerResponse
    const db = {
      many: async () => [{ account_key: 'a', player_name: 'A', score: 120, finished_at: 100 }],
    }
    const limits = { publicRead: async () => true }
    handleGameRead(req, res, {
      db: db as never,
      networkAuthUrl: null,
      limits: limits as never,
      address: () => 'test',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({
      game: 'scraplandia',
      period: 'week',
      entries: [{ rank: 1, name: 'A', score: 120, finishedAt: 100 }],
    })
  })
})
