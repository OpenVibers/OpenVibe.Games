import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TICK_STALL_MS, createReadiness } from './readiness.js'

const T0 = 1_750_000_000_000

type PingDb = () => Promise<{ ok: boolean; error?: string }>

const up: PingDb = async () => ({ ok: true })

/** The same wiring main.ts uses, over a controllable database ping and a controllable clock. */
function setup(
  metrics: { tick: number; lastTickAt: number },
  clock = { now: T0 },
  pingDb: PingDb = up,
) {
  return createReadiness({ pingDb, metrics, now: () => clock.now })
}

describe('/api/ready', () => {
  it('is ready when the database answers and the tick is recent', async () => {
    const body = await setup({ tick: 120, lastTickAt: T0 - 40 }).check()
    expect(body).toMatchObject({
      ready: true,
      status: 'ready',
      service: 'games',
      failed: [],
      degraded: [],
    })
    expect(body.checks.db).toMatchObject({ status: 'ok', required: true })
    expect(body.checks.tick).toMatchObject({
      status: 'ok',
      required: true,
      detail: { tick: 120, age_ms: 40, threshold_ms: TICK_STALL_MS },
    })
  })

  it('reports the players online as a non-required sessions check (for the host protected probe)', async () => {
    let online = 3
    const r = createReadiness({
      pingDb: up,
      metrics: { tick: 5, lastTickAt: T0 - 10 },
      now: () => T0,
      online: () => online,
    })
    let body = await r.check()
    expect(body.checks.sessions).toMatchObject({
      status: 'ok',
      required: false,
      detail: { online: 3 },
    })
    expect(body.status).toBe('ready')
    online = 0
    body = await r.check()
    expect(body.checks.sessions?.detail).toEqual({ online: 0 })
    expect((await setup({ tick: 5, lastTickAt: T0 - 10 }).check()).checks.sessions).toBeUndefined()
  })

  it('is not ready before the first tick', async () => {
    const body = await setup({ tick: 0, lastTickAt: 0 }).check()
    expect(body.status).toBe('not_ready')
    expect(body.failed).toEqual(['tick'])
    expect(body.checks.tick?.error).toBe('simulation has not ticked yet')
  })

  it('is not ready once the tick stops advancing', async () => {
    const metrics = { tick: 300, lastTickAt: T0 }
    const clock = { now: T0 + TICK_STALL_MS }
    const ready = setup(metrics, clock)
    expect((await ready.check()).ready).toBe(true)
    clock.now = T0 + TICK_STALL_MS + 1
    const body = await ready.check()
    expect(body.ready).toBe(false)
    expect(body.failed).toEqual(['tick'])
    expect(body.checks.tick?.error).toMatch(/no simulation tick for \d+ ms/)
    // The tick moves again: ready again.
    metrics.tick = 301
    metrics.lastTickAt = clock.now
    expect((await ready.check()).ready).toBe(true)
  })

  it('is not ready when the database stops answering', async () => {
    let dbUp = true
    const ready = setup({ tick: 5, lastTickAt: T0 }, { now: T0 }, async () =>
      dbUp ? { ok: true } : { ok: false, error: 'connection refused' },
    )
    dbUp = false
    const body = await ready.check()
    expect(body.status).toBe('not_ready')
    expect(body.failed).toEqual(['db'])
    expect(body.checks.db?.status).toBe('fail')
    expect(body.checks.db?.error).toMatch(/connection refused/)
  })

  it('is not ready when the ping fails without a reason', async () => {
    const body = await setup({ tick: 5, lastTickAt: T0 }, { now: T0 }, async () => ({
      ok: false,
    })).check()
    expect(body.failed).toEqual(['db'])
    expect(body.checks.db?.error).toBe('database did not answer')
  })

  describe('over HTTP', () => {
    let server: Server
    let base: string
    const metrics = { tick: 10, lastTickAt: T0 }
    const clock = { now: T0 }

    beforeEach(async () => {
      const ready = setup(metrics, clock)
      server = createServer((req, res) => {
        if (ready.handle(req, res)) return
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()))
    })

    it('answers 200 with the JSON body, uncached', async () => {
      clock.now = T0
      const res = await fetch(`${base}/api/ready`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toMatchObject({ ready: true, status: 'ready' })
    })

    it('answers 503 with the reason when not ready', async () => {
      clock.now = T0 + TICK_STALL_MS + 1000
      const res = await fetch(`${base}/api/ready?probe=1`)
      expect(res.status).toBe(503)
      const body = (await res.json()) as { failed: string[]; checks: { tick: { error: string } } }
      expect(body.failed).toEqual(['tick'])
      expect(body.checks.tick.error).toMatch(/no simulation tick/)
    })

    it('answers 503 rather than hanging when the probe itself rejects', async () => {
      const broken = createReadiness({
        pingDb: up,
        metrics: { tick: 10, lastTickAt: T0 },
        // checked_at is assembled outside run()'s try, so a throwing clock rejects check() outright.
        now: () => {
          throw new Error('clock broke')
        },
      })
      await expect(broken.check()).rejects.toThrow('clock broke')
      const probe = createServer((req, res) => {
        if (broken.handle(req, res)) return
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
      try {
        const res = await fetch(
          `http://127.0.0.1:${(probe.address() as AddressInfo).port}/api/ready`,
        )
        expect(res.status).toBe(503)
        expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.json()).toEqual({ error: 'probe_failed' })
      } finally {
        await new Promise<void>((r) => probe.close(() => r()))
      }
    })

    it('leaves other paths alone and refuses writes', async () => {
      expect((await fetch(`${base}/api/readyz`)).status).toBe(404)
      expect((await fetch(`${base}/api/ready`, { method: 'POST' })).status).toBe(405)
    })
  })
})
