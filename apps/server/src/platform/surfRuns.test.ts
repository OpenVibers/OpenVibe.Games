/* eslint-disable @typescript-eslint/no-explicit-any */
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { openTestDb } from '@openvibe/persistence/testing'
import { decodeSurfTrack, type SurfTrackSample } from '@openvibe/gameplay'
import { PgSurfRecords, createSurfPlay, surfBoardId, surfPlayKey } from './surfRuns.js'
import type { SurfRunRecord } from '../game/surfRecords.js'

/** A made-up person (Network subject). */
const PERSON = 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV'

const MAP = 'surf_lagoon'

function track(n = 8): SurfTrackSample[] {
  return Array.from({ length: n }, (_, i) => ({
    tick: 100 + i,
    x: i * 0.5,
    y: 5 - i * 0.1,
    z: -i * 0.25,
    yaw: (i / n) * Math.PI,
  }))
}

function run(partial: Partial<SurfRunRecord> = {}): SurfRunRecord {
  return {
    id: crypto.randomUUID(),
    mapId: MAP,
    accountKey: PERSON,
    playerName: 'Tester',
    timeMs: 12_345,
    splits: [4_000, 8_000, 12_345],
    track: track(),
    tickRate: 30,
    startedTick: 100,
    finishedTick: 500,
    startFrac: 0.25,
    finishFrac: 0.75,
    fails: 0,
    createdAt: Date.now(),
    ...partial,
  }
}

function fakePlay() {
  const defined: string[] = []
  const posted: { board: string; time: number; ref: string }[] = []
  return {
    defined,
    posted,
    poster: {
      async define() {
        defined.push('surf')
      },
      async post(r: SurfRunRecord) {
        posted.push({ board: surfBoardId(r.mapId), time: r.timeMs, ref: r.id })
        return { rank: null }
      },
    },
  }
}

describe('surf runs persistence', () => {
  it('keeps the PB and the last five runs, derives the WR, and round-trips the ghost', async () => {
    const db = await openTestDb()
    const records = new PgSurfRecords(db)
    const key = PERSON
    const times = [20_000, 18_000, 16_000, 15_000, 14_000, 13_000, 12_000]
    for (const [i, timeMs] of times.entries())
      await records.record(run({ timeMs, createdAt: 1_000 + i, splits: [timeMs] }))
    const leaderboard = await records.topRuns(MAP, 20)
    expect(leaderboard[0]!.timeMs).toBe(12_000)
    // One PB + five non-PB runs: the two slowest are gone.
    const rows = await db.many<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM surf_runs WHERE map_id = $1 AND account_key = $2`,
      [MAP, key],
    )
    expect(Number(rows[0]!.n)).toBe(6)
    const pbs = await db.many(
      `SELECT time_ms FROM surf_runs WHERE map_id = $1 AND account_key = $2 AND is_pb`,
      [MAP, key],
    )
    expect(pbs).toHaveLength(1)
    expect((pbs[0] as { time_ms: number }).time_ms).toBe(12_000)
    expect(await records.pbMs(MAP, key)).toBe(12_000)
    expect(await records.wrMs(MAP)).toBe(12_000)
    expect((await records.pbRun(MAP, key))?.splits).toEqual([12_000])
    const summary = (await records.maps()).find((m) => m.id === MAP)!
    expect(summary.records).toBe(6)
    expect(summary.wrMs).toBe(12_000)
    expect(summary.wrHolder).toBe('Tester')

    const ghost = await records.ghostBytes(MAP, 'wr')
    expect(ghost).not.toBeNull()
    const decoded = decodeSurfTrack(new Uint8Array(gunzipSync(ghost!)))
    expect(decoded.samples[0]!.x).toBeCloseTo(0)
    expect(decoded.samples[7]!.z).toBeCloseTo(-1.75)
    expect((await records.ghostBytes(MAP, 'pb', key))).not.toBeNull()
    expect(await records.ghostBytes(MAP, 'pb', 'guest:unknown')).toBeNull()
  })

  it('play: defines and posts the `time` board with the run ms', async () => {
    const db = await openTestDb()
    const play = fakePlay()
    const records = new PgSurfRecords(db, play.poster)
    const outcome = await records.record(run({ id: 'run-1', timeMs: 9_876 }))
    expect(outcome.pb).toBe(true)
    expect(play.defined).toEqual(['surf'])
    expect(play.posted).toEqual([{ board: 'lagoon', time: 9_876, ref: 'run-1' }])
    expect(surfPlayKey('surf_lagoon')).toBe('surf:lagoon')
  })

  it('an unknown-kind Play answer leaves the run saved and reports no rank', async () => {
    const db = await openTestDb()
    const warnings: string[] = []
    const records = new PgSurfRecords(
      db,
      {
        async define() {},
        async post() {
          throw new Error('Play POST /titles/surf/scores answered 400: {"code":"play.bad_definitions","message":"boards[0].kind is best or sum"}')
        },
      },
      (m) => warnings.push(m),
    )
    const outcome = await records.record(run({ timeMs: 7_000 }))
    expect(outcome.pb).toBe(true)
    expect(outcome.rank).toBeNull()
    const rows = await db.many(`SELECT time_ms FROM surf_runs WHERE map_id = $1`, [MAP])
    expect(rows).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    // The disabled publisher is not asked again, and the run still saves.
    await records.record(run({ timeMs: 8_000 }))
    expect(warnings).toHaveLength(1)
  })

  it('defines the surf time boards and posts milliseconds through Play', async () => {
    const calls: { method: string; path: string; body: any }[] = []
    const poster = createSurfPlay({
      url: 'https://play.test',
      tokens: { getToken: async () => 'token' },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({
          method: String(init?.method),
          path: new URL(url).pathname,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        return new Response('{"recorded":1,"rank":2}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })!
    await poster.define()
    expect(calls[0]!.path).toBe('/api/v1/titles/surf')
    expect(calls[0]!.body.boards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lagoon', kind: 'time' }),
        expect.objectContaining({ id: 'canyon', kind: 'time' }),
        expect.objectContaining({ id: 'orbit', kind: 'time' }),
      ]),
    )
    const result = await poster.post(run({ id: 'run-9', timeMs: 4_321 }))
    expect(calls[1]!.path).toBe('/api/v1/titles/surf/scores')
    expect(calls[1]!.body).toMatchObject({
      board: 'lagoon',
      ref: 'run-9',
      entries: [{ score: 4_321 }],
    })
    expect(result.rank).toBe(2)
  })

  it('builds a Play poster only when URL and tokens exist', () => {
    expect(createSurfPlay({ url: null, tokens: null })).toBeNull()
    expect(createSurfPlay({ url: 'https://play.openvibe.games', tokens: null })).toBeNull()
  })
})
