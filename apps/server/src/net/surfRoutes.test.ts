import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestDb } from '@openvibe/persistence/testing'
import { handleSurfRead } from './surfRoutes.js'

/**
 * The public surf reads: the map id is the Source map name (`surf_lagoon`), the
 * old hyphenated id is a 308 alias (with its ghost and query string), and the
 * catalogue only ever names the canonical form.
 */

let server: Server | null = null

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function serve(): Promise<string> {
  const db = await openTestDb()
  server = createServer((req, res) => {
    if (!handleSurfRead(req, res, { db, networkAuthUrl: null })) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not_found"}')
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('surf map reads', () => {
  it('lists the canonical map ids and names', async () => {
    const base = await serve()
    const res = await fetch(`${base}/api/surf/maps`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { maps: { id: string; name: string }[] }
    expect(body.maps.map((m) => m.id)).toEqual(['surf_lagoon', 'surf_canyon', 'surf_orbit'])
    expect(body.maps.every((m) => m.name === m.id)).toBe(true)
  })

  it('answers the canonical map id', async () => {
    const base = await serve()
    const res = await fetch(`${base}/api/surf/maps/surf_lagoon`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { map: { id: string; name: string } }
    expect(body.map).toMatchObject({ id: 'surf_lagoon', name: 'surf_lagoon' })
  })

  it.each([
    ['/api/surf/maps/surf-lagoon', '/api/surf/maps/surf_lagoon'],
    ['/api/surf/maps/surf-lagoon/ghost', '/api/surf/maps/surf_lagoon/ghost'],
  ])('%s is a 308 to %s', async (path, location) => {
    const base = await serve()
    const res = await fetch(`${base}${path}`, { redirect: 'manual' })
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(location)
  })

  it('keeps the query string through the API redirect', async () => {
    const base = await serve()
    const res = await fetch(`${base}/api/surf/maps/surf-lagoon/ghost?of=wr`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('/api/surf/maps/surf_lagoon/ghost?of=wr')
  })

  it('answers an unknown map with 404, never the old id', async () => {
    const base = await serve()
    const res = await fetch(`${base}/api/surf/maps/surf-missing`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown_map' })
  })
})
