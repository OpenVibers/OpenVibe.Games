import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqlitePersistenceStore } from '@openvibe/persistence/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TICK_STALL_MS, createReadiness } from './readiness.js'

const T0 = 1_750_000_000_000

let dir: string
let store: SqlitePersistenceStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovg-ready-'))
  store = openSqliteStore(join(dir, 'world.db'))
})

afterEach(() => {
  try {
    store.close()
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true })
})

/** The same wiring main.ts uses, over a real world.db and a controllable clock. */
function setup(metrics: { tick: number; lastTickAt: number }, clock = { now: T0 }) {
  const stmt = store.db.prepare('SELECT value FROM meta WHERE key = ?')
  return createReadiness({
    pingDb: () => stmt.get('schema_version') !== undefined,
    metrics,
    now: () => clock.now,
  })
}

describe('/api/ready', () => {
  it('is ready when world.db answers and the tick is recent', () => {
    const body = setup({ tick: 120, lastTickAt: T0 - 40 }).check()
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

  it('is not ready before the first tick', () => {
    const body = setup({ tick: 0, lastTickAt: 0 }).check()
    expect(body.status).toBe('not_ready')
    expect(body.failed).toEqual(['tick'])
    expect(body.checks.tick?.error).toBe('simulation has not ticked yet')
  })

  it('is not ready once the tick stops advancing', () => {
    const metrics = { tick: 300, lastTickAt: T0 }
    const clock = { now: T0 + TICK_STALL_MS }
    const ready = setup(metrics, clock)
    expect(ready.check().ready).toBe(true)
    clock.now = T0 + TICK_STALL_MS + 1
    const body = ready.check()
    expect(body.ready).toBe(false)
    expect(body.failed).toEqual(['tick'])
    expect(body.checks.tick?.error).toMatch(/no simulation tick for \d+ ms/)
    // The tick moves again: ready again.
    metrics.tick = 301
    metrics.lastTickAt = clock.now
    expect(ready.check().ready).toBe(true)
  })

  it('is not ready when world.db stops answering', () => {
    const ready = setup({ tick: 5, lastTickAt: T0 })
    store.close()
    const body = ready.check()
    expect(body.status).toBe('not_ready')
    expect(body.failed).toEqual(['db'])
    expect(body.checks.db?.status).toBe('fail')
    expect(body.checks.db?.error).toMatch(/not open/)
  })

  it('is not ready when the query returns nothing', () => {
    store.db.prepare('DELETE FROM meta').run()
    const body = setup({ tick: 5, lastTickAt: T0 }).check()
    expect(body.failed).toEqual(['db'])
    expect(body.checks.db?.error).toBe('world.db query returned nothing')
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

    it('leaves other paths alone and refuses writes', async () => {
      expect((await fetch(`${base}/api/readyz`)).status).toBe(404)
      expect((await fetch(`${base}/api/ready`, { method: 'POST' })).status).toBe(405)
    })
  })
})
