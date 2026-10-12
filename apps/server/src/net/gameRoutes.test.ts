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
})
