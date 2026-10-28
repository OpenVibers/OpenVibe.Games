import { describe, expect, it } from 'vitest'
import { decodeClientMessage, encodeClientMessage } from '../codec.js'
import { SurfFinishSchema, SurfStateSchema } from './surf.js'

const state = {
  t: 'surf_state' as const,
  running: true,
  elapsedMs: 12_345,
  stage: 2,
  stages: 6,
  splits: [3_000, 7_000],
  pbMs: 11_000,
  wrMs: 9_500,
  pbSplits: [2_900, 6_900],
}

const finish = {
  t: 'surf_finish' as const,
  timeMs: 10_000,
  splits: [3_000, 7_000, 10_000],
  pb: true,
  wr: false,
  rank: 4,
  pbMs: 10_000,
  wrMs: 9_500,
}

describe('surf protocol', () => {
  it('accepts the client reset and round-trips it', () => {
    const msg = { t: 'surf_restart' as const }
    expect(decodeClientMessage(encodeClientMessage(msg))).toEqual(msg)
  })

  it('validates surf_state ranges', () => {
    expect(SurfStateSchema.safeParse(state).success).toBe(true)
    expect(SurfStateSchema.safeParse({ ...state, elapsedMs: -1 }).success).toBe(false)
    expect(SurfStateSchema.safeParse({ ...state, elapsedMs: 86_400_001 }).success).toBe(false)
    expect(SurfStateSchema.safeParse({ ...state, stage: 65 }).success).toBe(false)
    expect(SurfStateSchema.safeParse({ ...state, stages: 0 }).success).toBe(false)
    expect(SurfStateSchema.safeParse({ ...state, splits: [-1] }).success).toBe(false)
    expect(SurfStateSchema.safeParse({ ...state, splits: new Array(65).fill(1) }).success).toBe(false)
    expect(SurfStateSchema.safeParse({ ...state, pbMs: 86_400_001 }).success).toBe(false)
  })

  it('validates surf_finish ranges and accepts a Play-less finish', () => {
    expect(SurfFinishSchema.safeParse(finish).success).toBe(true)
    expect(SurfFinishSchema.safeParse({ ...finish, rank: null }).success).toBe(true)
    expect(SurfFinishSchema.safeParse({ ...finish, timeMs: -5 }).success).toBe(false)
    expect(SurfFinishSchema.safeParse({ ...finish, rank: 0 }).success).toBe(false)
    expect(SurfFinishSchema.safeParse({ ...finish, splits: [-5] }).success).toBe(false)
  })
})
