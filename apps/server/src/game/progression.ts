import { sql, type Db } from 'openvibe-sdk/db'
import { accountKey } from '@openvibe/persistence'
import { SCRAPLANDIA_PACK } from '@openvibe/content'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import type { RoundResult } from './salvageRush.js'

export const GAMES = ['scraplandia', 'salvage-rush'] as const
export type GameId = (typeof GAMES)[number]
export function isGameId(value: string): value is GameId {
  return GAMES.some((id) => id === value)
}

const definitions = {
  scraplandia: SCRAPLANDIA_PACK.achievements ?? [],
  'salvage-rush': SALVAGE_RUSH_PACK.game?.achievements ?? [],
}

export function earnedAchievements(game: GameId, result: RoundResult): string[] {
  if (game !== 'salvage-rush') return []
  return definitions['salvage-rush']
    .filter(
      (def) =>
        (def.criterion.minScore === undefined || result.score >= def.criterion.minScore) &&
        (def.criterion.minRank === undefined || result.rank <= def.criterion.minRank),
    )
    .map((def) => def.id)
}

/** Scraplandia haul achievements, evaluated after a haul is recorded. */
export function earnedHaulAchievements(score: number, weeklyScore: number): string[] {
  return definitions.scraplandia
    .filter((def) => {
      if (def.criterion.event === 'haul_recorded') {
        return def.criterion.minScore === undefined || score >= def.criterion.minScore
      }
      if (def.criterion.event === 'haul_week') {
        return weeklyScore >= def.criterion.minScore
      }
      return false
    })
    .map((def) => def.id)
}

/** A server-confirmed step past the first haul (never a client message). */
export type Milestone =
  | { event: 'contract_completed' }
  | { event: 'crop_harvested' }
  | { event: 'skill_level'; skill: string; level: number }

/** Scraplandia achievements a milestone earns. */
export function earnedMilestoneAchievements(milestone: Milestone): string[] {
  return definitions.scraplandia
    .filter((def) => {
      const c = def.criterion
      if (c.event !== milestone.event) return false
      if (c.event === 'skill_level' && milestone.event === 'skill_level') {
        return (
          milestone.level >= c.minLevel && (c.skill === undefined || c.skill === milestone.skill)
        )
      }
      return true
    })
    .map((def) => def.id)
}

/** Record unlocked Scraplandia achievements (idempotent per account). */
export async function recordUnlocks(
  db: Db,
  key: string,
  achievements: readonly string[],
  now: number,
): Promise<void> {
  const account = accountKey(key)
  for (const achievement of achievements) {
    await db.exec(sql`
      INSERT INTO game_achievements (game_id, achievement_id, account_key, unlocked_at)
      VALUES ('scraplandia', ${achievement}, ${account}, ${now})
      ON CONFLICT (game_id, achievement_id, account_key) DO NOTHING
    `)
  }
}

function weekStartMs(now: number): number {
  const date = new Date(now)
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
  )
}

/** Server join event: once per account, regardless of how many characters or sessions join. */
export async function recordJoined(db: Db, key: string, now: number): Promise<void> {
  const account = accountKey(key)
  for (const def of definitions.scraplandia) {
    if (def.criterion.event !== 'player_joined') continue
    await db.exec(sql`
      INSERT INTO game_achievements (game_id, achievement_id, account_key, unlocked_at)
      VALUES ('scraplandia', ${def.id}, ${account}, ${now})
      ON CONFLICT (game_id, achievement_id, account_key) DO NOTHING
    `)
  }
}

/** One row of a finished round, as the round's own board shows it. */
export interface RoundRow {
  /** The account the row belongs to (hashed, never the person's id). */
  accountKey: string
  playerName: string
  score: number
  rank: number
  finishedAt: number
}

/**
 * The rows of one finished round, in rank order. These are the rows the server wrote when the round
 * ended, so the board a player sees is the round that really happened.
 */
export async function roundRows(
  db: Db,
  game: GameId,
  roundId: string,
): Promise<RoundRow[]> {
  const rows = await db.many<{
    account_key: string
    player_name: string
    score: number
    rank: number
    finished_at: number
  }>(sql`
    SELECT account_key, player_name, score, rank, finished_at
    FROM game_round_results
    WHERE game_id = ${game} AND round_id = ${roundId}
    ORDER BY rank ASC, score DESC, player_name ASC
  `)
  return rows.map((row) => ({
    accountKey: row.account_key,
    playerName: row.player_name,
    score: Number(row.score) || 0,
    rank: Number(row.rank) || 0,
    finishedAt: Number(row.finished_at) || 0,
  }))
}

/**
 * The player's own best round for a game, from the row we keep. Null when they have no round on
 * record: not measured yet is said plainly rather than shown as a zero.
 */
export async function playerBestScore(
  db: Db,
  game: GameId,
  key: string,
): Promise<number | null> {
  const account = accountKey(key)
  const rows = await db.many<{ score: number }>(sql`
    SELECT score FROM game_best_scores WHERE game_id = ${game} AND account_key = ${account}
  `)
  const score = Number(rows[0]?.score)
  return Number.isFinite(score) ? score : null
}

/** The player's own best row for a game: the score and the name the board shows. */
export async function playerBest(
  db: Db,
  game: GameId,
  key: string,
): Promise<{ score: number; name: string } | null> {
  const account = accountKey(key)
  const rows = await db.many<{ score: number; player_name: string }>(sql`
    SELECT score, player_name FROM game_best_scores
    WHERE game_id = ${game} AND account_key = ${account}
  `)
  const row = rows[0]
  if (!row) return null
  const score = Number(row.score)
  if (!Number.isFinite(score)) return null
  return { score, name: String(row.player_name ?? '') }
}

/**
 * The place a score of this size sits on the board: one more than the number of players with a better
 * best. Counted from the rows we keep, so it is the rank of the same board the page shows.
 */
export async function playerBestRank(
  db: Db,
  game: GameId,
  score: number,
): Promise<number> {
  const rows = await db.many<{ better: number }>(sql`
    SELECT COUNT(*)::bigint AS better FROM game_best_scores
    WHERE game_id = ${game} AND score > ${score}
  `)
  return (Number(rows[0]?.better) || 0) + 1
}

/** The only writer for scores; called by the server's completed-round hook. */
export async function recordRound(
  db: Db,
  game: GameId,
  roundId: string,
  results: readonly RoundResult[],
  now: number,
): Promise<void> {
  await db.tx(async () => {
    for (const result of results) {
      const key = accountKey(result.key)
      await db.exec(sql`
        INSERT INTO game_round_results (game_id, round_id, account_key, player_name, score, rank, finished_at)
        VALUES (${game}, ${roundId}, ${key}, ${result.name}, ${result.score}, ${result.rank}, ${now})
        ON CONFLICT (game_id, round_id, account_key) DO NOTHING
      `)
      await db.exec(sql`
        INSERT INTO game_best_scores (game_id, account_key, player_name, score, finished_at)
        VALUES (${game}, ${key}, ${result.name}, ${result.score}, ${now})
        ON CONFLICT (game_id, account_key) DO UPDATE SET
          player_name = excluded.player_name, score = excluded.score, finished_at = excluded.finished_at
        WHERE excluded.score > game_best_scores.score
      `)
      for (const achievement of earnedAchievements(game, result)) {
        await db.exec(sql`
          INSERT INTO game_achievements (game_id, achievement_id, account_key, unlocked_at)
          VALUES (${game}, ${achievement}, ${key}, ${now})
          ON CONFLICT (game_id, achievement_id, account_key) DO NOTHING
        `)
      }
    }
  })
}

/** Record one successful extraction haul (Scraplandia); zero-value extractions are not recorded. */
export async function recordHaul(
  db: Db,
  key: string,
  extractionId: string,
  name: string,
  score: number,
  now: number,
): Promise<void> {
  if (score <= 0) return
  await db.tx(async () => {
    const account = accountKey(key)
    await db.exec(sql`
      INSERT INTO game_hauls (account_key, extraction_id, player_name, score, finished_at)
      VALUES (${account}, ${extractionId}, ${name}, ${score}, ${now})
      ON CONFLICT (account_key, extraction_id) DO NOTHING
    `)
    const weekStart = weekStartMs(now)
    const rows = await db.many<{ total: number }>(sql`
      SELECT COALESCE(SUM(score), 0)::bigint AS total FROM game_hauls
      WHERE account_key = ${account} AND finished_at >= ${weekStart}
    `)
    const weeklyScore = Number(rows[0]?.total ?? 0)
    for (const achievement of earnedHaulAchievements(score, weeklyScore)) {
      await db.exec(sql`
        INSERT INTO game_achievements (game_id, achievement_id, account_key, unlocked_at)
        VALUES ('scraplandia', ${achievement}, ${account}, ${now})
        ON CONFLICT (game_id, achievement_id, account_key) DO NOTHING
      `)
    }
  })
}

/** Write-behind for completed rounds. Failed writes stay queued for retry and shutdown drain. */
export class GameProgressWriter {
  private readonly pending = new Map<string, { results: RoundResult[]; finishedAt: number }>()
  private readonly joined = new Map<string, number>()
  private readonly hauls = new Map<
    string,
    { key: string; name: string; score: number; extractionId: string; finishedAt: number }
  >()
  /** Achievement unlocks from milestones, one entry per account and achievement. */
  private readonly unlocks = new Map<string, { key: string; achievement: string; at: number }>()
  private inFlight: Promise<void> | null = null
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly db: Db,
    private readonly onError: (error: unknown) => void,
    private readonly afterCommit?: (subject: string) => void,
  ) {
    this.timer = setInterval(() => void this.flush().catch(onError), 2000)
    this.timer.unref()
  }

  submit(roundId: string, results: RoundResult[]): void {
    this.pending.set(roundId, { results, finishedAt: Date.now() })
    void this.flush().catch(this.onError)
  }

  submitJoined(key: string): void {
    if (!this.joined.has(key)) this.joined.set(key, Date.now())
    void this.flush().catch(this.onError)
  }

  submitHaul(extractionId: string, key: string, name: string, score: number): void {
    if (score <= 0) return
    this.hauls.set(`${accountKey(key)}\u0000${extractionId}`, {
      key,
      name,
      score,
      extractionId,
      finishedAt: Date.now(),
    })
    void this.flush().catch(this.onError)
  }

  submitMilestone(key: string, milestone: Milestone): void {
    const earned = earnedMilestoneAchievements(milestone)
    if (earned.length === 0) return
    const now = Date.now()
    for (const achievement of earned) {
      const id = `${accountKey(key)}\u0000${achievement}`
      if (!this.unlocks.has(id)) this.unlocks.set(id, { key, achievement, at: now })
    }
    void this.flush().catch(this.onError)
  }

  async flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      while (
        this.pending.size > 0 ||
        this.joined.size > 0 ||
        this.hauls.size > 0 ||
        this.unlocks.size > 0
      ) {
        for (const [roundId, entry] of this.pending) {
          await recordRound(this.db, 'salvage-rush', roundId, entry.results, entry.finishedAt)
          this.pending.delete(roundId)
          for (const result of entry.results) this.afterCommit?.(result.key)
        }
        for (const [id, haul] of this.hauls) {
          await recordHaul(
            this.db,
            haul.key,
            haul.extractionId,
            haul.name,
            haul.score,
            haul.finishedAt,
          )
          this.hauls.delete(id)
          this.afterCommit?.(haul.key)
        }
        for (const [key, at] of this.joined) {
          await recordJoined(this.db, key, at)
          this.joined.delete(key)
          this.afterCommit?.(key)
        }
        for (const [id, unlock] of this.unlocks) {
          await recordUnlocks(this.db, unlock.key, [unlock.achievement], unlock.at)
          this.unlocks.delete(id)
          this.afterCommit?.(unlock.key)
        }
      }
    })()
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.flush()
  }
}

export async function playerAchievements(db: Db, token: string) {
  const key = accountKey(token)
  const unlocked = await db.many<{
    game_id: string
    achievement_id: string
    unlocked_at: number
  }>(sql`
    SELECT game_id, achievement_id, unlocked_at FROM game_achievements
    WHERE account_key = ${key} ORDER BY unlocked_at, game_id, achievement_id
  `)
  return GAMES.map((game) => ({
    game,
    achievements: definitions[game].map((def) => ({
      ...def,
      unlockedAt:
        unlocked.find((row) => row.game_id === game && row.achievement_id === def.id)
          ?.unlocked_at ?? null,
    })),
  }))
}
