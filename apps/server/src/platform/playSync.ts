/**
 * OpenVibe.Play (ADR-0007 decision 10): Games' titles, scores and unlocks on the platform's game services.
 *
 * At start Games registers its two titles (Scraplandia and Salvage Rush: their achievements from the packs, and one
 * board each). Every SYNC_MS it posts what the local tables recorded after its last position, stream by stream:
 *
 *   rounds    game_round_results → salvage-rush / best   (a round's id is the ref)
 *   hauls     game_hauls         → scraplandia / haul    (an extraction's id is the ref; the board sums them)
 *   unlocks   game_achievements  → the game's unlocks (only achievements the title defines)
 *   adoptions identity_adoptions (guest) → the guest's rows in Play become the person's, in both titles
 *
 * Every post is idempotent in Play, so a restart or a retry never counts twice, and the first run imports the history.
 * The position (play_sync) moves only past what Play accepted: with Play down nothing is lost. Adoptions come last in
 * a pass: a local adoption re-keys the guest's rows in the same transaction it is recorded in, so whatever Play got
 * as the guest's arrived before the adoption is read, and what is read after it already carries the person.
 *
 * Play names a player usr_… or guest:<opaque>; a Network guest (gst_…) is sent as guest:gst_…, and a key Play would
 * refuse is skipped rather than stopping the stream.
 *
 * Off unless GAMES_PLAY_URL and the client secret are set (config.platform.playUrl).
 */
import { sql, type Db } from 'openvibe-sdk/db'
import { SCRAPLANDIA_PACK } from '@openvibe/content'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'

const AUDIENCE = 'openvibe.play'
const SCOPE = 'play.title.manage play.result.write'
const SYNC_MS = 30_000
const BATCH = 500
const TIMEOUT_MS = 10_000

/** What Games registers in Play. Rounds rank each player's best; hauls sum through the week. */
export const PLAY_TITLES = {
  scraplandia: {
    name: 'Scraplandia',
    url: 'https://openvibe.games/play',
    summary:
      "Scrappy multiplayer survival-building in and around Scrap City: haul your salvage home and climb the week's haul board.",
    achievements: (SCRAPLANDIA_PACK.achievements ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
    })),
    boards: [{ id: 'haul', name: 'Haul points', kind: 'sum' as const }],
  },
  'salvage-rush': {
    name: 'Salvage Rush',
    url: 'https://openvibe.games/play?game=salvage-rush',
    summary: 'Collect scrap around a compact arena in 90-second rounds, scored by the server.',
    achievements: (SALVAGE_RUSH_PACK.game?.achievements ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
    })),
    boards: [{ id: 'best', name: 'Best round', kind: 'best' as const }],
  },
}

type Tokens = { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> }
type Cursor = { at: number; key: string }

const PLAYER_RE = /^(usr_[0-9A-HJKMNP-TV-Z]{26}|guest:[A-Za-z0-9_-]{8,128})$/
/** Games' account key as Play's player, or null when Play would refuse it. */
export function toPlayer(accountKey: string): string | null {
  const key = accountKey.startsWith('gst_') ? `guest:${accountKey}` : accountKey
  return PLAYER_RE.test(key) ? key : null
}

const KNOWN: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(PLAY_TITLES).map(([id, t]) => [id, new Set(t.achievements.map((a) => a.id))]),
)

export class PlaySync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private defined = false

  constructor(
    private readonly opts: {
      db: Db
      url: string | null
      tokens: Tokens | null
      fetchImpl?: typeof fetch
      warn?: (message: string) => void
    },
  ) {}

  get enabled(): boolean {
    return !!this.opts.url && !!this.opts.tokens
  }

  private async call(method: string, path: string, body: unknown): Promise<unknown> {
    const token = await this.opts.tokens!.getToken({ audience: AUDIENCE, scope: SCOPE })
    const res = await (this.opts.fetchImpl ?? fetch)(
      `${this.opts.url!.replace(/\/+$/, '')}/api/v1${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    const text = await res.text()
    if (!res.ok)
      throw new Error(`Play ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }

  /** Register both titles (an unchanged document changes nothing in Play). */
  async defineTitles(): Promise<void> {
    for (const [id, doc] of Object.entries(PLAY_TITLES))
      await this.call('PUT', `/titles/${id}`, doc)
    this.defined = true
  }

  private async cursor(stream: string): Promise<Cursor> {
    const row = await this.opts.db.maybe<{ at: number | string; key: string }>(
      sql`SELECT at, key FROM play_sync WHERE stream = ${stream}`,
    )
    return row ? { at: Number(row.at), key: row.key } : { at: -1, key: '' }
  }

  private async advance(stream: string, to: Cursor): Promise<void> {
    await this.opts.db.exec(sql`
      INSERT INTO play_sync (stream, at, key) VALUES (${stream}, ${to.at}, ${to.key})
      ON CONFLICT (stream) DO UPDATE SET at = excluded.at, key = excluded.key
    `)
  }

  /** Salvage Rush rounds → salvage-rush/best, one post per round (more of a round may follow in the next batch). */
  private async syncRounds(): Promise<number> {
    const c = await this.cursor('rounds')
    const rows = await this.opts.db.many<{
      game_id: string
      round_id: string
      account_key: string
      player_name: string
      score: number
      finished_at: number | string
      k: string
    }>(sql`
      SELECT game_id, round_id, account_key, player_name, score, finished_at, game_id || '|' || round_id || '|' || account_key AS k
      FROM game_round_results
      WHERE finished_at > ${c.at} OR (finished_at = ${c.at} AND game_id || '|' || round_id || '|' || account_key > ${c.key})
      ORDER BY finished_at, k LIMIT ${BATCH}
    `)
    let posted = 0
    for (let i = 0; i < rows.length;) {
      const first = rows[i]!
      let j = i
      while (
        j < rows.length &&
        rows[j]!.round_id === first.round_id &&
        rows[j]!.game_id === first.game_id
      )
        j++
      const group = rows.slice(i, j)
      const entries = group.flatMap((r) => {
        const player = toPlayer(r.account_key)
        return player
          ? [{ player, name: r.player_name.slice(0, 40) || 'Player', score: Number(r.score) }]
          : []
      })
      if (first.game_id === 'salvage-rush' && entries.length) {
        await this.call('POST', '/titles/salvage-rush/scores', {
          board: 'best',
          ref: first.round_id,
          at: Number(first.finished_at),
          entries,
        })
      }
      const last = group[group.length - 1]!
      await this.advance('rounds', { at: Number(last.finished_at), key: last.k })
      posted += group.length
      i = j
    }
    return posted
  }

  /** Scraplandia extractions → scraplandia/haul, one post per extraction. */
  private async syncHauls(): Promise<number> {
    const c = await this.cursor('hauls')
    const rows = await this.opts.db.many<{
      account_key: string
      extraction_id: string
      player_name: string
      score: number
      finished_at: number | string
      k: string
    }>(sql`
      SELECT account_key, extraction_id, player_name, score, finished_at, extraction_id || '|' || account_key AS k
      FROM game_hauls
      WHERE finished_at > ${c.at} OR (finished_at = ${c.at} AND extraction_id || '|' || account_key > ${c.key})
      ORDER BY finished_at, k LIMIT ${BATCH}
    `)
    for (const r of rows) {
      const player = toPlayer(r.account_key)
      if (player) {
        await this.call('POST', '/titles/scraplandia/scores', {
          board: 'haul',
          ref: r.extraction_id,
          at: Number(r.finished_at),
          entries: [
            { player, name: r.player_name.slice(0, 40) || 'Player', score: Number(r.score) },
          ],
        })
      }
      await this.advance('hauls', { at: Number(r.finished_at), key: r.k })
    }
    return rows.length
  }

  /** Unlocked achievements of both games. */
  private async syncUnlocks(): Promise<number> {
    const c = await this.cursor('unlocks')
    const rows = await this.opts.db.many<{
      game_id: string
      achievement_id: string
      account_key: string
      unlocked_at: number | string
      k: string
    }>(sql`
      SELECT game_id, achievement_id, account_key, unlocked_at, game_id || '|' || achievement_id || '|' || account_key AS k
      FROM game_achievements
      WHERE unlocked_at > ${c.at} OR (unlocked_at = ${c.at} AND game_id || '|' || achievement_id || '|' || account_key > ${c.key})
      ORDER BY unlocked_at, k LIMIT ${BATCH}
    `)
    for (const r of rows) {
      const player = toPlayer(r.account_key)
      if (player && KNOWN[r.game_id]?.has(r.achievement_id)) {
        await this.call('POST', `/titles/${r.game_id}/unlocks`, {
          player,
          achievements: [r.achievement_id],
          at: Number(r.unlocked_at),
        })
      }
      await this.advance('unlocks', { at: Number(r.unlocked_at), key: r.k })
    }
    return rows.length
  }

  /** Guests adopted by a person (local guest conversion; merges reach Play from Network itself). */
  private async syncAdoptions(): Promise<number> {
    const c = await this.cursor('adoptions')
    const rows = await this.opts.db.many<{
      adoption_key: string
      subject_id: string
      adopted_at: number | string
    }>(sql`
      SELECT adoption_key, subject_id, adopted_at FROM identity_adoptions
      WHERE source = 'guest' AND (adopted_at > ${c.at} OR (adopted_at = ${c.at} AND adoption_key > ${c.key}))
      ORDER BY adopted_at, adoption_key LIMIT ${BATCH}
    `)
    for (const r of rows) {
      const guest = toPlayer(r.adoption_key)
      if (guest?.startsWith('guest:') && toPlayer(r.subject_id)?.startsWith('usr_')) {
        for (const id of Object.keys(PLAY_TITLES)) {
          await this.call('POST', `/titles/${id}/players/${encodeURIComponent(guest)}/adopt`, {
            person: r.subject_id,
          })
        }
      }
      await this.advance('adoptions', { at: Number(r.adopted_at), key: r.adoption_key })
    }
    return rows.length
  }

  /** One pass over the four streams; a failure stops the pass where it was (the next tick resumes there). */
  async syncOnce(): Promise<{ rounds: number; hauls: number; unlocks: number; adoptions: number }> {
    if (!this.defined) await this.defineTitles()
    const rounds = await this.syncRounds()
    const hauls = await this.syncHauls()
    const unlocks = await this.syncUnlocks()
    return { rounds, hauls, unlocks, adoptions: await this.syncAdoptions() }
  }

  start(): void {
    if (!this.enabled || this.timer) return
    const tick = async (): Promise<void> => {
      if (this.running) return
      this.running = true
      try {
        await this.syncOnce()
      } catch (err) {
        this.opts.warn?.(`[play] sync paused: ${String((err as Error).message ?? err)}`)
      } finally {
        this.running = false
      }
    }
    this.timer = setInterval(() => void tick(), SYNC_MS)
    this.timer.unref?.()
    void tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
