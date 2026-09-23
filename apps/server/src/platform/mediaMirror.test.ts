import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createConsoleLogger } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import { loadPlatformConfig } from '../config.js'
import { MediaMirror } from './mediaMirror.js'
import { createPlatformClient } from './serviceClient.js'

const NETWORK = 'http://network.test'
const MEDIA = 'http://media.test'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const log = createConsoleLogger({ app: 'test' }, 'error')

function fakeJwt(claims: Record<string, unknown>): string {
  const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${b({ alg: 'RS256' })}.${b(claims)}.sig`
}

/**
 * Network's token endpoint + Media's object API v2, in memory. Media checks
 * the bearer's audience and grants like the real tenant auth does.
 */
function fakePlatform(opts: { failPuts?: number; completeStatus?: number } = {}) {
  const objects = new Map<string, { bytes: Buffer | null; hash: string; status: string }>()
  const calls: string[] = []
  let failPuts = opts.failPuts ?? 0
  let n = 0
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.origin === NETWORK && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(String(init?.body ?? ''))
      expect(form.get('grant_type')).toBe('client_credentials')
      const audience = form.get('audience')
      return reply(200, {
        access_token: fakeJwt({
          sub: 'svc:games',
          aud: [audience],
          cap: audience === 'openvibe.media' ? ['media.object.upload'] : [],
          ns: ['games'],
        }),
        token_type: 'Bearer',
        expires_in: 3600,
      })
    }
    if (url.origin !== MEDIA) return reply(404, {})
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const claims = JSON.parse(
      Buffer.from(auth.replace('Bearer ', '').split('.')[1] ?? '', 'base64url').toString(),
    ) as { aud: string[]; cap: string[] }
    if (!claims.aud.includes('openvibe.media') || !claims.cap.includes('media.object.upload')) {
      return reply(403, { code: 'capability.denied' })
    }
    const m = /^\/api\/v2\/games\/objects(?:\/([^/]+)\/(content|complete))?$/.exec(url.pathname)
    if (!m) return reply(404, {})
    if (method === 'POST' && !m[1]) {
      const body = JSON.parse(String(init?.body)) as { content_hash: string; kind: string }
      expect(body.kind).toBe('asset')
      const id = `med_${String(++n).padStart(26, '0')}`
      objects.set(id, { bytes: null, hash: body.content_hash, status: 'uploading' })
      return reply(201, { id })
    }
    const obj = objects.get(m[1] ?? '')
    if (!obj) return reply(404, {})
    if (m[2] === 'content') {
      if (failPuts > 0) {
        failPuts--
        return reply(503, { code: 'media.unavailable' })
      }
      if (obj.status !== 'uploading') return reply(409, { code: 'media.object.not_uploading' })
      obj.bytes = Buffer.from(init?.body as Uint8Array)
      return reply(200, { id: m[1] })
    }
    if (opts.completeStatus)
      return reply(opts.completeStatus, { code: 'media.object.hash_mismatch' })
    const actual = createHash('sha256')
      .update(obj.bytes ?? Buffer.alloc(0))
      .digest('hex')
    if (actual !== obj.hash) return reply(422, { code: 'media.object.hash_mismatch' })
    obj.status = 'ready'
    return reply(200, { id: m[1], public_url: `https://openvibe.media/o/${m[1]}` })
  }
  return { fetchImpl, objects, calls }
}

function setup(platform: ReturnType<typeof fakePlatform>) {
  const dir = mkdtempSync(join(tmpdir(), 'openvibe-mirror-'))
  const assetsDir = join(dir, 'map-assets')
  mkdirSync(assetsDir)
  const hash = `sha256-${createHash('sha256').update(PNG).digest('hex')}`
  const fileName = `${hash}.png`
  writeFileSync(join(assetsDir, fileName), PNG)
  const store = openSqliteStore(':memory:')
  let now = 1_000
  const pc = createPlatformClient(
    {
      ...loadPlatformConfig({}),
      clientSecret: 's3cret',
      networkUrl: NETWORK,
      mediaUrl: MEDIA,
    },
    platform.fetchImpl as never,
  )!
  const mirror = new MediaMirror({
    client: pc.client,
    store,
    namespace: 'games',
    assetsDir,
    log,
    now: () => now,
  })
  return {
    store,
    mirror,
    hash,
    asset: { hash, url: `/map-assets/${fileName}`, bytes: PNG.length, mime: 'image/png' },
    advance: (ms: number) => (now += ms),
  }
}

describe('map assets → Media objects (games service token)', () => {
  it('mirrors a stored asset with init, content and a hash-verified complete', async () => {
    const platform = fakePlatform()
    const { store, mirror, hash, asset } = setup(platform)
    mirror.enqueue(asset)
    mirror.stop()
    await mirror.runOnce()
    const row = store.mediaMirrors.get(hash)!
    expect(row).toMatchObject({ status: 'mirrored', attempts: 1 })
    expect(row.mediaId).toMatch(/^med_/)
    expect(row.publicUrl).toBe(`https://openvibe.media/o/${row.mediaId}`)
    expect(platform.objects.get(row.mediaId!)?.bytes?.equals(PNG)).toBe(true)
    expect(platform.calls.filter((c) => c.startsWith('POST /oauth'))).toHaveLength(1)
    // Enqueueing again is a no-op: one object per asset.
    mirror.enqueue(asset)
    mirror.stop()
    await mirror.runOnce()
    expect(platform.objects.size).toBe(1)
  })

  it('backfills assets already on disk', async () => {
    const platform = fakePlatform()
    const { store, mirror, hash } = setup(platform)
    expect(await mirror.backfill()).toBe(1)
    expect(await mirror.backfill()).toBe(0)
    await mirror.runOnce()
    expect(store.mediaMirrors.get(hash)?.status).toBe('mirrored')
  })

  it('resumes the same object after a failure instead of creating another', async () => {
    const platform = fakePlatform({ failPuts: 1 })
    const { store, mirror, hash, asset, advance } = setup(platform)
    mirror.enqueue(asset)
    mirror.stop()
    await mirror.runOnce()
    const failed = store.mediaMirrors.get(hash)!
    expect(failed).toMatchObject({ status: 'pending', attempts: 1 })
    expect(failed.lastError).toMatch(/503|unavailable/)
    await mirror.runOnce() // not due yet
    expect(store.mediaMirrors.get(hash)?.attempts).toBe(1)
    advance(60_000)
    await mirror.runOnce()
    expect(store.mediaMirrors.get(hash)).toMatchObject({
      status: 'mirrored',
      mediaId: failed.mediaId,
    })
    expect(platform.objects.size).toBe(1)
  })

  it('gives up on refusals retrying cannot fix', async () => {
    const platform = fakePlatform({ completeStatus: 422 })
    const { store, mirror, hash, asset } = setup(platform)
    mirror.enqueue(asset)
    mirror.stop()
    await mirror.runOnce()
    expect(store.mediaMirrors.get(hash)?.status).toBe('failed')
  })
})
