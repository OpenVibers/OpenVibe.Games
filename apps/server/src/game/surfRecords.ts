import type { SurfTrackSample } from '@openvibe/gameplay'

/** One server-authoritative finished run, before persistence. */
export interface SurfRunRecord {
  id: string
  mapId: string
  accountKey: string
  playerName: string
  /** Server-derived milliseconds, sub-tick crossing included. */
  timeMs: number
  /** Split times relative to the start, finish last. */
  splits: number[]
  track: SurfTrackSample[]
  tickRate: number
  startedTick: number
  finishedTick: number
  startFrac: number
  finishFrac: number
  fails: number
  createdAt: number
}

export interface SurfRecordOutcome {
  /** This run became the player's personal best. */
  pb: boolean
  /** This run became the map's world record. */
  wr: boolean
  /** Play's rank for the run when it answered, else null. */
  rank: number | null
  pbMs: number | null
  wrMs: number | null
}

/**
 * The persistence/ranking seam the surf system writes runs through. Games'
 * implementation is platform/surfRuns.ts; tests use a fake. The server never
 * accepts a time from a client, so this is the only writer.
 */
export interface SurfRecords {
  pbMs(mapId: string, accountKey: string): Promise<number | null>
  /** The PB's total and splits, for the HUD's per-split delta. */
  pbRun(
    mapId: string,
    accountKey: string,
  ): Promise<{ timeMs: number; splits: number[] } | null>
  wrMs(mapId: string): Promise<number | null>
  record(run: SurfRunRecord): Promise<SurfRecordOutcome>
}
