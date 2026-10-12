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

/** Write-behind for completed rounds. Failed writes stay queued for retry and shutdown drain. */
export class GameProgressWriter {
  private readonly pending = new Map<string, { results: RoundResult[]; finishedAt: number }>()
  private readonly joined = new Map<string, number>()
  private inFlight: Promise<void> | null = null
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly db: Db,
    private readonly onError: (error: unknown) => void,
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

  async flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      while (this.pending.size > 0 || this.joined.size > 0) {
        for (const [roundId, entry] of this.pending) {
          await recordRound(this.db, 'salvage-rush', roundId, entry.results, entry.finishedAt)
          this.pending.delete(roundId)
        }
        for (const [key, at] of this.joined) {
          await recordJoined(this.db, key, at)
          this.joined.delete(key)
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

interface BoardRow {
  account_key: string
  player_name: string
  score: number
  finished_at: number
}
export async function leaderboard(
  db: Db,
  game: GameId,
  period: 'all' | 'week',
  page: number,
  now: number,
) {
  const date = new Date(now)
  const weekStart = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
  )
  const since = period === 'week' ? weekStart : 0
  const limit = 20
  const offset = (page - 1) * limit
  const rows =
    period === 'all'
      ? await db.many<BoardRow>(sql`
    SELECT account_key, player_name, score, finished_at FROM game_best_scores
    WHERE game_id = ${game}
    ORDER BY score DESC, finished_at ASC, account_key ASC
    LIMIT ${limit} OFFSET ${offset}
  `)
      : await db.many<BoardRow>(sql`
    SELECT account_key, player_name, score, finished_at FROM (
      SELECT account_key, player_name, score, finished_at,
        ROW_NUMBER() OVER (PARTITION BY account_key ORDER BY score DESC, finished_at ASC) AS own_rank
      FROM game_round_results WHERE game_id = ${game} AND finished_at >= ${since}
    ) best WHERE own_rank = 1
    ORDER BY score DESC, finished_at ASC, account_key ASC
    LIMIT ${limit} OFFSET ${offset}
  `)
  return {
    game,
    period,
    page,
    pageSize: limit,
    entries: rows.map((row, i) => ({
      rank: offset + i + 1,
      name: row.player_name,
      score: Number(row.score),
      finishedAt: Number(row.finished_at),
    })),
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
