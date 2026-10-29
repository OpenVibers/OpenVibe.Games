import { randomUUID } from 'node:crypto'
import { sql, type Db } from 'openvibe-sdk/db'
import type { BenchClient } from 'openvibe-sdk/bench'
import { playMatch, type Generate, type MatchResult, type Offer } from './game.js'
import { submitMatch } from './services.js'

export interface MatchJobConfig { enabled: boolean; dailyCap: number; gamesPerMatch: number; offers: [Offer, Offer]; publicBase: string }

/** Reserve a daily slot in SQL before making any billable AI calls. */
export async function reserveMatch(db: Db, cap: number, id: string = randomUUID()): Promise<string | null> {
  if (!Number.isSafeInteger(cap) || cap < 1) return null
  return db.tx(async (tx) => {
    await tx.exec(sql`SELECT pg_advisory_xact_lock(102030405)`)
    const row = await tx.maybe<{ id: string }>(sql`
      INSERT INTO ai_matches (id, status)
      SELECT ${id}, 'running'
      WHERE (SELECT COUNT(*) FROM ai_matches WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') < ${cap}
      RETURNING id
    `)
    return row?.id ?? null
  })
}

export async function runMatchJob(db: Db, bench: BenchClient, generate: Generate, config: MatchJobConfig): Promise<MatchResult | null> {
  if (!config.enabled) return null
  const id = await reserveMatch(db, config.dailyCap)
  if (!id) return null
  try {
    const match = await playMatch(id, config.offers, config.gamesPerMatch, generate, Math.floor(Math.random() * 2 ** 31))
    await db.exec(sql`UPDATE ai_matches SET status = 'submitting', result = ${JSON.stringify(match)}::jsonb WHERE id = ${id}`)
    const receipt = await submitMatch(bench, match, config.publicBase)
    await db.exec(sql`UPDATE ai_matches SET status = 'complete', bench = ${JSON.stringify(receipt)}::jsonb WHERE id = ${id}`)
    return match
  } catch (error) {
    await db.exec(sql`UPDATE ai_matches SET status = 'failed', error = ${String(error).slice(0, 500)} WHERE id = ${id}`)
    throw error
  }
}

export async function loadMatch(db: Db, id: string): Promise<{ result: MatchResult; bench: { rounds: string[]; funRound: string; funEntries: [string, string] } } | null> {
  const row = await db.maybe<{ result: unknown; bench: unknown }>(sql`SELECT result, bench FROM ai_matches WHERE id = ${id} AND status = 'complete'`)
  return row ? { result: row.result as MatchResult, bench: row.bench as { rounds: string[]; funRound: string; funEntries: [string, string] } } : null
}
