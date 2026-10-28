import { gzipSync } from 'node:zlib'
import { sql, type Db } from 'openvibe-sdk/db'
import { SURF_MAPS, type SurfMapInfo } from '@openvibe/content'
import { decodeSurfTrack, encodeSurfTrack, type DecodedGhost } from '@openvibe/gameplay'
import { accountKey } from '@openvibe/persistence'
import type { SurfRecordOutcome, SurfRecords, SurfRunRecord } from '../game/surfRecords.js'
import { toPlayer } from './playSync.js'

/**
 * Games' own surf persistence (migration 0018) and the Play `time` board.
 *
 * Retention is part of the contract: one PB plus the last five runs per
 * player per map. The world record is derived, never stored twice, so it
 * cannot drift from the runs that produced it. A run is written locally
 * before Play is asked; Play being down, or not knowing the `time` kind yet,
 * can never lose or fail a run.
 */
export interface SurfMapSummary {
  id: string
  name: string
  tier: number
  stages: number
  author: string
  records: number
  wrMs: number | null
  wrHolder: string | null
}

export interface SurfRunRow {
  id: string
  name: string
  timeMs: number
  createdAt: number
  isPb: boolean
}

export interface SurfPlayPoster {
  /** Register the surf title/boards; safe to call repeatedly. */
  define(): Promise<void>
  /** Post one run's ms. Returns the rank when Play reports one. */
  post(run: SurfRunRecord): Promise<{ rank: number | null }>
}

/** The Play board id for a map: `surf` title, `<slug>` board (`surf:lagoon`). */
export function surfBoardId(mapId: string): string {
  return mapId.replace(/^surf_/, '').replace(/[^a-z0-9_-]/g, '')
}

export function surfPlayKey(mapId: string): string {
  return `surf:${surfBoardId(mapId)}`
}

function trackBytes(run: SurfRunRecord): Buffer {
  const raw = encodeSurfTrack(run.track, run.tickRate, run.startedTick)
  return gzipSync(Buffer.from(raw))
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  throw new Error('surf track is not bytes')
}

function splitArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(Number) : []
    } catch {
      return []
    }
  }
  return []
}

export function ghostOfRun(row: { track: unknown }): DecodedGhost {
  return decodeSurfTrack(new Uint8Array(toBuffer(row.track)))
}

export class PgSurfRecords implements SurfRecords {
  private playWarned = false
  private playDisabled = false

  constructor(
    private readonly db: Db,
    private readonly play: SurfPlayPoster | null = null,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  async pbMs(mapId: string, key: string): Promise<number | null> {
    const row = await this.db.maybe<{ time_ms: number | string }>(sql`
      SELECT time_ms FROM surf_runs
      WHERE map_id = ${mapId} AND account_key = ${accountKey(key)} AND is_pb
      LIMIT 1
    `)
    return row ? Number(row.time_ms) : null
  }

  async pbRun(
    mapId: string,
    key: string,
  ): Promise<{ timeMs: number; splits: number[] } | null> {
    const row = await this.db.maybe<{ time_ms: number | string; splits: unknown }>(sql`
      SELECT time_ms, splits FROM surf_runs
      WHERE map_id = ${mapId} AND account_key = ${accountKey(key)} AND is_pb
      LIMIT 1
    `)
    if (!row) return null
    return { timeMs: Number(row.time_ms), splits: splitArray(row.splits) }
  }

  async wrMs(mapId: string): Promise<number | null> {
    const row = await this.db.maybe<{ time_ms: number | string | null }>(sql`
      SELECT MIN(time_ms) AS time_ms FROM surf_runs WHERE map_id = ${mapId}
    `)
    return row?.time_ms === null || row?.time_ms === undefined ? null : Number(row.time_ms)
  }

  async record(run: SurfRunRecord): Promise<SurfRecordOutcome> {
    const key = accountKey(run.accountKey)
    const bytes = trackBytes(run)
    let pb = false
    let wr = false
    let pbMs: number | null = null
    let wrMs: number | null = null
    await this.db.tx(async () => {
      const previousPb = await this.db.maybe<{ time_ms: number | string }>(sql`
        SELECT time_ms FROM surf_runs
        WHERE map_id = ${run.mapId} AND account_key = ${key} AND is_pb
        LIMIT 1
      `)
      const prev = previousPb ? Number(previousPb.time_ms) : null
      pb = prev === null || run.timeMs < prev
      if (pb) {
        await this.db.exec(sql`
          UPDATE surf_runs SET is_pb = false
          WHERE map_id = ${run.mapId} AND account_key = ${key} AND is_pb
        `)
      }
      await this.db.exec(sql`
        INSERT INTO surf_runs
          (id, map_id, account_key, player_name, time_ms, splits, track, is_pb, created_at)
        VALUES
          (${run.id}, ${run.mapId}, ${key}, ${run.playerName}, ${run.timeMs},
           ${JSON.stringify(run.splits)}::jsonb, ${bytes}, ${pb}, ${run.createdAt})
        ON CONFLICT (id) DO NOTHING
      `)
      // One PB plus the last five non-PB runs. "At most" is enforced here,
      // not by a reader that might forget.
      await this.db.exec(sql`
        DELETE FROM surf_runs
        WHERE id IN (
          SELECT id FROM surf_runs
          WHERE map_id = ${run.mapId} AND account_key = ${key} AND NOT is_pb
          ORDER BY created_at DESC, id DESC
          OFFSET 5
        )
      `)
      const best = await this.db.maybe<{ time_ms: number | string | null }>(sql`
        SELECT MIN(time_ms) AS time_ms FROM surf_runs WHERE map_id = ${run.mapId}
      `)
      wrMs = best?.time_ms === null || best?.time_ms === undefined ? null : Number(best.time_ms)
      wr = wrMs === run.timeMs
      const mine = await this.db.maybe<{ time_ms: number | string }>(sql`
        SELECT time_ms FROM surf_runs
        WHERE map_id = ${run.mapId} AND account_key = ${key} AND is_pb LIMIT 1
      `)
      pbMs = mine ? Number(mine.time_ms) : null
    })

    let rank: number | null = null
    if (this.play && !this.playDisabled && toPlayer(key)) {
      try {
        await this.play.define()
        rank = (await this.play.post(run)).rank
      } catch (err) {
        // Never fail a run because the platform is down or does not know
        // `time` yet. Keep the local row (already committed) and log once.
        if (!this.playWarned) {
          this.playWarned = true
          this.warn(`surf Play post skipped: ${String(err)}`)
        }
        if (/unknown|kind|400/i.test(String(err))) this.playDisabled = true
      }
    }
    return { pb, wr, rank, pbMs, wrMs }
  }

  /** Every map with its record count and derived world record. */
  async maps(): Promise<SurfMapSummary[]> {
    const rows = await this.db.many<{
      map_id: string
      records: number | string
      wr_ms: number | string | null
      wr_holder: string | null
    }>(sql`
      SELECT r.map_id,
             COUNT(*)::int AS records,
             MIN(r.time_ms) AS wr_ms,
             (SELECT player_name FROM surf_runs w
               WHERE w.map_id = r.map_id
               ORDER BY w.time_ms ASC, w.created_at ASC LIMIT 1) AS wr_holder
      FROM surf_runs r GROUP BY r.map_id
    `)
    const byMap = new Map(rows.map((r) => [r.map_id, r]))
    return SURF_MAPS.map((m: SurfMapInfo) => {
      const row = byMap.get(m.id)
      return {
        id: m.id,
        name: m.name,
        tier: m.tier,
        stages: m.stages,
        author: m.author,
        records: Number(row?.records ?? 0),
        wrMs: row?.wr_ms === null || row?.wr_ms === undefined ? null : Number(row.wr_ms),
        wrHolder: row?.wr_holder ?? null,
      }
    })
  }

  async topRuns(mapId: string, limit = 20): Promise<SurfRunRow[]> {
    const rows = await this.db.many<{
      id: string
      player_name: string
      time_ms: number | string
      created_at: number | string
      is_pb: boolean
    }>(sql`
      SELECT id, player_name, time_ms, created_at, is_pb
      FROM surf_runs WHERE map_id = ${mapId}
      ORDER BY time_ms ASC, created_at ASC
      LIMIT ${Math.max(1, Math.min(20, limit))}
    `)
    return rows.map((r) => ({
      id: r.id,
      name: r.player_name,
      timeMs: Number(r.time_ms),
      createdAt: Number(r.created_at),
      isPb: r.is_pb,
    }))
  }

  async ghost(mapId: string, of: 'wr' | 'pb', key?: string): Promise<DecodedGhost | null> {
    const bytes = await this.ghostBytes(mapId, of, key)
    return bytes ? decodeSurfTrack(new Uint8Array(bytes)) : null
  }

  /** The stored gzipped track, ready to serve with `content-encoding: gzip`. */
  async ghostBytes(mapId: string, of: 'wr' | 'pb', key?: string): Promise<Buffer | null> {
    const row =
      of === 'wr'
        ? await this.db.maybe<{ track: unknown }>(sql`
            SELECT track FROM surf_runs WHERE map_id = ${mapId}
            ORDER BY time_ms ASC, created_at ASC LIMIT 1
          `)
        : await this.db.maybe<{ track: unknown }>(sql`
            SELECT track FROM surf_runs
            WHERE map_id = ${mapId} AND account_key = ${accountKey(key ?? '')} AND is_pb
            LIMIT 1
          `)
    return row ? toBuffer(row.track) : null
  }
}

const PLAY_TIMEOUT_MS = 4_000

/** A minimal Play client for the surf time board (title `surf`, one board per map, kind `time`). */
export function createSurfPlay(opts: {
  url: string | null
  tokens: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> } | null
  fetchImpl?: typeof fetch
}): SurfPlayPoster | null {
  if (!opts.url || !opts.tokens) return null
  const doFetch = opts.fetchImpl ?? fetch
  const base = opts.url.replace(/\/+$/, '')
  let defined = false
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const token = await opts.tokens!.getToken({
      audience: 'openvibe.play',
      scope: 'play.title.manage play.result.write',
    })
    const res = await doFetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PLAY_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok)
      throw new Error(`Play ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }
  return {
    async define() {
      if (defined) return
      await call('PUT', '/titles/surf', {
        name: 'OpenVibe.Surf',
        url: 'https://openvibe.surf',
        summary: 'Counter-Strike-style surf time trials on the OpenVibe.Games engine.',
        boards: SURF_MAPS.map((m) => ({
          id: surfBoardId(m.id),
          name: `${m.name} — time`,
          kind: 'time',
        })),
      })
      defined = true
    },
    async post(run) {
      const player = toPlayer(accountKey(run.accountKey))
      if (!player) return { rank: null }
      const body = await call('POST', '/titles/surf/scores', {
        board: surfBoardId(run.mapId),
        ref: run.id,
        at: run.createdAt,
        entries: [{ player, name: run.playerName.slice(0, 40) || 'Player', score: run.timeMs }],
      })
      const rank =
        body && typeof body === 'object' && 'rank' in body
          ? Number((body as { rank: unknown }).rank)
          : null
      return { rank: Number.isSafeInteger(rank) && (rank as number) > 0 ? (rank as number) : null }
    },
  }
}
