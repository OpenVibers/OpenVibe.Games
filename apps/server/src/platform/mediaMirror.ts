/**
 * Durable copies of map assets in OpenVibe.Media (roadmap Wave 12, ADR-006).
 *
 * The only user-uploaded files Games has today are the map editor's assets
 * (textures, paint masks, glb models; see net/mapAssetStore.ts). They stay
 * served from local disk — the map must load when Media is down — and every
 * one is also copied into a Media object (`kind: asset`, public, namespace
 * MEDIA_NAMESPACE) so it has a platform Media id and an off-host copy.
 * Scraplandia has no screenshots or shareable blueprint files; blueprints are
 * per-player recipe unlocks, not documents.
 *
 * Flow per asset, all with the `games` service token (capability
 * media.object.upload, audience openvibe.media):
 *   POST /api/v2/<ns>/objects                 init (declares size + sha256)
 *   PUT  /api/v2/<ns>/objects/<id>/content    the bytes
 *   POST /api/v2/<ns>/objects/<id>/complete   Media verifies the hash
 *
 * A queue row per asset (`media_mirrors`) makes it restart-safe: the object
 * id is remembered after init, so a retry resumes rather than starting over.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaMirrorDto, PersistenceStore } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { OpenVibeClient } from 'openvibe-sdk/core'

const CONTENT_ADDRESSED = /^(sha256-[0-9a-f]{64})\.(png|jpg|webp|glb)$/
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  glb: 'model/gltf-binary',
}
/** Retry schedule; after the last step the row is marked failed. */
const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]
const MAX_ATTEMPTS = 10
/** Refusals that retrying cannot fix (the bytes or the request are wrong). */
const TERMINAL_STATUS = new Set([400, 413, 415, 422])

interface ObjectBody {
  id: string
  public_url?: string | null
  lifecycle_status?: string
}

interface HttpError {
  status?: number
  code?: string
  message?: string
}

export interface MediaMirrorOptions {
  client: OpenVibeClient
  store: PersistenceStore
  namespace: string
  assetsDir: string
  log: Logger
  now?: () => number
  intervalMs?: number
}

export class MediaMirror {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly opts: MediaMirrorOptions) {
    this.now = opts.now ?? Date.now
  }

  /** Queues one stored asset (idempotent) and wakes the worker. */
  enqueue(asset: { hash: string; url: string; bytes: number; mime: string }): void {
    const fileName = asset.url.split('/').pop() ?? ''
    if (!CONTENT_ADDRESSED.test(fileName)) return
    const added = this.opts.store.mediaMirrors.enqueue(
      { assetHash: asset.hash, fileName, mime: asset.mime, bytes: asset.bytes },
      this.now(),
    )
    if (added) this.kick()
  }

  /** Queues every content-addressed asset already on disk (a no-op for known ones). */
  async backfill(): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.opts.assetsDir)
    } catch {
      return 0
    }
    let added = 0
    for (const name of names) {
      const m = CONTENT_ADDRESSED.exec(name)
      if (!m) continue
      const bytes = (await readFile(join(this.opts.assetsDir, name))).length
      const queued = this.opts.store.mediaMirrors.enqueue(
        { assetHash: m[1] ?? '', fileName: name, mime: MIME_BY_EXT[m[2] ?? ''] ?? '', bytes },
        this.now(),
      )
      if (queued) added++
    }
    return added
  }

  start(): void {
    this.schedule(0)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  kick(): void {
    this.schedule(0)
  }

  /** Mirrors every due row once. Concurrent callers share the pass. */
  runOnce(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runOnce().finally(() => this.schedule(this.opts.intervalMs ?? 60_000))
    }, ms)
    this.timer.unref()
  }

  private async pass(): Promise<void> {
    for (const row of this.opts.store.mediaMirrors.due(this.now(), 20)) {
      try {
        await this.mirror(row)
      } catch (err) {
        this.fail(row, err as HttpError)
      }
    }
  }

  private base(): string {
    return `/api/v2/${encodeURIComponent(this.opts.namespace)}/objects`
  }

  private async mirror(row: MediaMirrorDto): Promise<void> {
    const { client, store } = this.opts
    let bytes: Buffer
    try {
      bytes = await readFile(join(this.opts.assetsDir, row.fileName))
    } catch {
      store.mediaMirrors.markFailed(
        row.assetHash,
        'local file missing',
        this.now(),
        true,
        this.now(),
      )
      return
    }
    const sha256 = row.assetHash.slice('sha256-'.length)
    let id = row.mediaId
    if (!id) {
      const init = await client.json<{ id: string }>({
        service: 'media',
        method: 'POST',
        path: this.base(),
        json: {
          kind: 'asset',
          visibility: 'public',
          size_bytes: bytes.length,
          mime_type: row.mime,
          content_hash: sha256,
          filename: row.fileName,
          metadata: { source: 'games.map-asset', asset_hash: row.assetHash },
        },
        idempotencyKey: false,
      })
      id = init.id
      store.mediaMirrors.noteObject(row.assetHash, id, this.now())
    }
    try {
      await client.request({
        service: 'media',
        method: 'PUT',
        path: `${this.base()}/${encodeURIComponent(id)}/content`,
        body: bytes,
        headers: { 'content-type': row.mime },
        idempotent: true,
      })
    } catch (err) {
      // 409: the bytes already arrived on an earlier attempt — go on to complete.
      if ((err as HttpError).status !== 409) throw err
    }
    const done = await client.json<ObjectBody>({
      service: 'media',
      method: 'POST',
      path: `${this.base()}/${encodeURIComponent(id)}/complete`,
      json: { content_hash: sha256 },
      idempotent: true,
    })
    store.mediaMirrors.markMirrored(row.assetHash, done.id, done.public_url ?? null, this.now())
    this.opts.log.info('map asset mirrored to media', { asset: row.assetHash, media: done.id })
  }

  private fail(row: MediaMirrorDto, err: HttpError): void {
    const status = err.status ?? 0
    const attempts = row.attempts + 1
    const terminal = TERMINAL_STATUS.has(status) || attempts >= MAX_ATTEMPTS
    const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)] ?? 60_000
    const message = `${err.code ?? `http.${status}`}: ${err.message ?? 'failed'}`
    this.opts.store.mediaMirrors.markFailed(
      row.assetHash,
      message,
      this.now() + wait,
      terminal,
      this.now(),
    )
    this.opts.log.warn('media mirror failed', {
      asset: row.assetHash,
      status,
      terminal,
      error: message,
    })
  }
}
