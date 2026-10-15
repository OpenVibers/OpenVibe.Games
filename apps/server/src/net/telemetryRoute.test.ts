import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsoleLogger } from '@openvibe/shared'
import { telemetry } from 'openvibe-sdk/service'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServerMetrics } from '../observability/metrics.js'
import { createHttpServer } from './httpServer.js'
import { telemetryRoute } from './telemetryRoute.js'

describe('request telemetry labels (plan T1)', () => {
  it('keeps the API resource, the first segment of a page, and turns the rest into :param', () => {
    expect(telemetryRoute('/')).toBe('/')
    expect(telemetryRoute('/play')).toBe('/play')
    expect(telemetryRoute('/play/vibe-heroes')).toBe('/play/:param')
    expect(telemetryRoute('/api/v1/games/salvage-rush/leaderboard')).toBe('/api/v1/games/:param/:param')
    expect(telemetryRoute('/auth/callback')).toBe('/auth/callback')
    expect(telemetryRoute('/@some.player')).toBe('/:param')
  })

  it('never counts static files, /shared, health, readiness, metrics or the release manifest', () => {
    for (const p of ['/assets/game.js', '/shared/navbar.js', '/maps/scraplandia.glb', '/api/health', '/api/ready', '/metrics', '/release.json', '/leaderboard.html.map']) {
      expect(telemetryRoute(p)).toBeNull()
    }
  })

  it('main.ts starts the collector and the 14-day retention and flushes before the store closes', () => {
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
    expect(main).toContain('const telemetrySink = createPgTelemetrySink({ db, log: console })')
    expect(main).toContain("telemetry.init({ service: 'games', sink: (samples) => telemetrySink(")
    expect(main).toContain('startTelemetryRetention({ db, log: console, olderThanDays: 14 })')
    expect(main.indexOf('await telemetry.stop()')).toBeLessThan(main.indexOf('await store.close()'))
  })
})

describe('request telemetry through the HTTP server', () => {
  let dir: string
  let server: Server
  let base: string
  const samples: Record<string, unknown>[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ovg-telemetry-'))
    const dist = join(dir, 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>portal page</title>')
    writeFileSync(join(dist, 'play.html'), '<!doctype html><title>game page</title>')
    server = createHttpServer(dist, new ServerMetrics(), createConsoleLogger({ app: 'test' }, 'error'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    telemetry.init({ service: 'games', sink: async (batch) => { samples.push(...(batch as unknown as Record<string, unknown>[])) }, intervalMs: 3600e3 })
  })

  afterAll(async () => {
    await telemetry.stop()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('five hits on one page flush as one http.request sample; a 404 is unmatched, never its path', async () => {
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/terms`)).status).toBe(200)
    expect((await fetch(`${base}/wp-admin/setup.php`)).status).toBe(404)
    await telemetry.flush()
    const requests = samples.filter((s) => s.operation === 'http.request')
    const terms = requests.filter((s) => s.resource === '/terms' && s.status === '2xx')
    expect(terms).toHaveLength(1)
    expect((terms[0]!.extra as { count: number }).count).toBe(5)
    expect(requests.some((s) => s.resource === 'unmatched')).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('wp-admin')
  })
})
