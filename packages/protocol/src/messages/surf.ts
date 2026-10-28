import { z } from 'zod'

/**
 * Surf (OpenVibe.Surf Ride) protocol. Times are integer milliseconds measured
 * by the server; a run's track and splits are server-derived, never client
 * timestamps. The schemas are the range contract: values outside a plausible
 * run (a day, 64 stages, 64 splits) are refused rather than rendered.
 */
export const SURF_MAX_TIME_MS = 86_400_000
export const SURF_MAX_STAGES = 64
export const SURF_MAX_SPLITS = 64

const timeMs = z.number().int().min(0).max(SURF_MAX_TIME_MS)
const splitList = z.array(timeMs).max(SURF_MAX_SPLITS)
const stage = z.number().int().min(0).max(SURF_MAX_STAGES)

export const ClientSurfRestartSchema = z.object({
  t: z.literal('surf_restart'),
})
export type ClientSurfRestart = z.infer<typeof ClientSurfRestartSchema>

export const SurfStateSchema = z.object({
  t: z.literal('surf_state'),
  /** The clock is running (start crossed, finish not yet). */
  running: z.boolean(),
  /** Server time since the start crossing, in ms (startTick-relative). */
  elapsedMs: timeMs,
  /** Checkpoints reached this run (0 = at the start). */
  stage: stage,
  /** Total stages on this map, including the finish. */
  stages: z.number().int().min(1).max(SURF_MAX_STAGES),
  /** Split times so far, in stage order, relative to the start. */
  splits: splitList,
  /** Personal best for this player on this map, if they have one. */
  pbMs: timeMs.nullable(),
  /** World record on this map, if one has been set. */
  wrMs: timeMs.nullable(),
  /** The PB's split times, for the per-split delta (absent until one exists). */
  pbSplits: splitList.optional(),
  /** Practice mode is on: the run clock and PB writes are off. */
  practice: z.boolean().optional(),
})
export type ServerSurfState = z.infer<typeof SurfStateSchema>

export const SurfFinishSchema = z.object({
  t: z.literal('surf_finish'),
  timeMs,
  splits: splitList,
  /** This run is the player's new PB. */
  pb: z.boolean(),
  /** This run is the map's new world record. */
  wr: z.boolean(),
  /** The result Play reported, when it accepted a `time` post. */
  rank: z.number().int().min(1).max(1_000_000).nullable(),
  pbMs: timeMs.nullable(),
  wrMs: timeMs.nullable(),
})
export type ServerSurfFinish = z.infer<typeof SurfFinishSchema>
