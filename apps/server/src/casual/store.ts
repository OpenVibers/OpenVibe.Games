/**
 * The casual kit's server economy (plan T22). A player's save is one row; every action runs in one transaction
 * that locks the save, applies the kit's reducer, writes the new state and one ledger line per currency or item
 * change, and records the action under the client's idempotency key. The same key again answers the stored result
 * and changes nothing, so a retried request can never pay twice.
 */
import { randomInt } from 'node:crypto'
import { sql, type Db } from 'openvibe-sdk/db'
import { createRng, type Rng } from '@openvibe/shared'
import { moveCasualSaves } from '@openvibe/persistence'
import {
  apply,
  newPlayer,
  Refusal,
  teamPower,
  type Action,
  type CasualPack,
  type Delta,
  type PlayerState,
} from '@openvibe/casual'

export interface SaveView {
  state: PlayerState
  version: number
  created: boolean
}

export type ActionAnswer =
  | {
      status: 200
      body: { state: PlayerState; version: number; result: Record<string, unknown>; replay?: true }
    }
  | { status: 404; body: { error: 'no_save' } }
  | { status: 422; body: { error: string; message: string } }

const IDENTITY = /^(usr|gst)_/

async function writeLedger(
  db: Db,
  game: string,
  key: string,
  actionKey: string,
  deltas: Delta[],
  now: number,
): Promise<void> {
  for (let i = 0; i < deltas.length; i += 200) {
    const rows = deltas
      .slice(i, i + 200)
      .map(
        (d) =>
          sql`(${game}, ${key}, ${actionKey}, ${d.asset}, ${d.delta}, ${d.balance}, ${d.reason}, ${now})`,
      )
    await db.exec(sql`
      INSERT INTO casual_ledger (game_id, account_key, action_key, asset, delta, balance, reason, at)
      VALUES ${sql.join(rows, sql`, `)}
    `)
  }
}

/**
 * The player's save, created on first visit. A signed-in player who still carries a guest token on this browser
 * first takes over that guest's save when they have none of their own. `source` and `campaign` (an ad link's
 * src and c) are kept only on the first visit.
 */
export async function openSave(
  db: Db,
  pack: CasualPack,
  key: string,
  opts: {
    now: number
    name?: string | null
    guestKey?: string | null
    source?: string | null
    campaign?: string | null
  },
): Promise<SaveView> {
  return db.tx(async () => {
    if (opts.guestKey && IDENTITY.test(key)) await moveCasualSaves(db, opts.guestKey, key)
    const row = await db.maybe<{ state: PlayerState; version: number; player_name: string | null }>(
      sql`SELECT state, version, player_name FROM casual_saves WHERE game_id = ${pack.id} AND account_key = ${key} FOR UPDATE`,
    )
    // Only signed-in accounts are named (and so listed on the board); guests stay anonymous.
    const name = key.startsWith('usr_') ? (opts.name ?? null) : null
    if (row) {
      if (name && name !== row.player_name) {
        await db.exec(
          sql`UPDATE casual_saves SET player_name = ${name} WHERE game_id = ${pack.id} AND account_key = ${key}`,
        )
      }
      return { state: row.state, version: row.version, created: false }
    }
    const start = newPlayer(pack, opts.now)
    await db.exec(sql`
      INSERT INTO casual_saves (game_id, account_key, state, version, player_name, stage, power, source, campaign, created_at, updated_at)
      VALUES (${pack.id}, ${key}, ${sql.json(start.state)}, 0, ${name}, 0, ${teamPower(pack, start.state)},
        ${opts.source ?? null}, ${opts.campaign ?? null}, ${opts.now}, ${opts.now})
    `)
    await writeLedger(db, pack.id, key, 'start', start.deltas, opts.now)
    return { state: start.state, version: 0, created: true }
  })
}

/** Applies one action under its idempotency key. */
export async function applyAction(
  db: Db,
  pack: CasualPack,
  key: string,
  actionKey: string,
  action: Action,
  now: number,
  rng: Rng = createRng(randomInt(2 ** 32)),
): Promise<ActionAnswer> {
  return db.tx(async (): Promise<ActionAnswer> => {
    const row = await db.maybe<{ state: PlayerState; version: number }>(
      sql`SELECT state, version FROM casual_saves WHERE game_id = ${pack.id} AND account_key = ${key} FOR UPDATE`,
    )
    if (!row) return { status: 404, body: { error: 'no_save' } }
    const done = await db.maybe<{ response: { result: Record<string, unknown> } }>(
      sql`SELECT response FROM casual_actions WHERE game_id = ${pack.id} AND account_key = ${key} AND action_key = ${actionKey}`,
    )
    if (done) {
      return {
        status: 200,
        body: {
          state: row.state,
          version: row.version,
          result: done.response.result,
          replay: true,
        },
      }
    }
    let outcome
    try {
      outcome = apply(pack, row.state, action, now, rng)
    } catch (err) {
      if (err instanceof Refusal)
        return { status: 422, body: { error: err.code, message: err.message } }
      throw err
    }
    const version = row.version + 1
    await db.exec(sql`
      UPDATE casual_saves SET state = ${sql.json(outcome.state)}, version = ${version},
        stage = ${outcome.state.stage.cleared}, power = ${teamPower(pack, outcome.state)}, updated_at = ${now}
      WHERE game_id = ${pack.id} AND account_key = ${key}
    `)
    await writeLedger(db, pack.id, key, actionKey, outcome.deltas, now)
    await db.exec(sql`
      INSERT INTO casual_actions (game_id, account_key, action_key, response, at)
      VALUES (${pack.id}, ${key}, ${actionKey}, ${sql.json({ result: outcome.result })}, ${now})
    `)
    return { status: 200, body: { state: outcome.state, version, result: outcome.result } }
  })
}

export interface BoardEntry {
  rank: number
  name: string
  stage: number
  power: number
}

/** The furthest signed-in players: highest stage cleared, then team power, then who got there first. */
export async function casualLeaderboard(db: Db, game: string, limit = 50): Promise<BoardEntry[]> {
  const rows = await db.many<{ player_name: string; stage: number; power: number }>(sql`
    SELECT player_name, stage, power FROM casual_saves
    WHERE game_id = ${game} AND player_name IS NOT NULL AND stage > 0
    ORDER BY stage DESC, power DESC, updated_at ASC
    LIMIT ${limit}
  `)
  return rows.map((r, i) => ({ rank: i + 1, name: r.player_name, stage: r.stage, power: r.power }))
}

export interface LedgerLine {
  id: number
  asset: string
  delta: number
  balance: number
  reason: string
  at: number
}

/** The player's own ledger, newest first, 100 lines a page. */
export async function casualLedger(
  db: Db,
  game: string,
  key: string,
  before: number | null,
): Promise<{ lines: LedgerLine[]; next: number | null }> {
  const lines = await db.many<LedgerLine>(sql`
    SELECT id, asset, delta, balance, reason, at FROM casual_ledger
    WHERE game_id = ${game} AND account_key = ${key} ${before ? sql`AND id < ${before}` : sql``}
    ORDER BY id DESC LIMIT 101
  `)
  const more = lines.length > 100
  const page = lines.slice(0, 100)
  return { lines: page, next: more ? (page[page.length - 1]?.id ?? null) : null }
}

/** Idempotency records are needed only while a client may retry: a day is plenty. */
export async function pruneCasualActions(db: Db, now: number): Promise<number> {
  return db.exec(sql`DELETE FROM casual_actions WHERE at < ${now - 86_400_000}`)
}

export interface CampaignRow {
  source: string
  campaign: string
  /** Saves first opened in the window. */
  players: number
  /** Of those: fought at least one battle. */
  battled: number
  /** Reached stage 5. */
  stage5: number
  signedIn: number
  /** Played again the next UTC day (a ledger line that day), of the players old enough to have had one. */
  d1: number
  d1Eligible: number
  /** Played again seven days later. */
  d7: number
  d7Eligible: number
}

/**
 * The numbers an ad campaign is judged by (plan T22), per ad source and campaign, for saves first opened since
 * `since`: how many came, fought, got going and came back. Returning is read from the ledger (any currency or item
 * change that day), which every session that plays writes.
 */
export async function casualNumbers(
  db: Db,
  game: string,
  since: number,
  now: number,
): Promise<{ game: string; since: number; rows: CampaignRow[] }> {
  const DAY = 86_400_000
  const today = Math.floor(now / DAY)
  const rows = await db.many<CampaignRow>(sql`
    SELECT coalesce(s.source, '') AS source, coalesce(s.campaign, '') AS campaign,
      count(*)::int AS players,
      count(*) FILTER (WHERE coalesce((s.state->'stats'->>'battles')::int, 0) > 0)::int AS battled,
      count(*) FILTER (WHERE s.stage >= 5)::int AS stage5,
      count(*) FILTER (WHERE s.account_key LIKE 'usr_%')::int AS "signedIn",
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM casual_ledger l WHERE l.game_id = s.game_id AND l.account_key = s.account_key
          AND l.at >= (s.created_at / ${DAY} + 1) * ${DAY} AND l.at < (s.created_at / ${DAY} + 2) * ${DAY}
      ))::int AS d1,
      count(*) FILTER (WHERE s.created_at / ${DAY} + 1 < ${today})::int AS "d1Eligible",
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM casual_ledger l WHERE l.game_id = s.game_id AND l.account_key = s.account_key
          AND l.at >= (s.created_at / ${DAY} + 7) * ${DAY} AND l.at < (s.created_at / ${DAY} + 8) * ${DAY}
      ))::int AS d7,
      count(*) FILTER (WHERE s.created_at / ${DAY} + 7 < ${today})::int AS "d7Eligible"
    FROM casual_saves s
    WHERE s.game_id = ${game} AND s.created_at >= ${since}
    GROUP BY 1, 2
    ORDER BY players DESC, source, campaign
    LIMIT 200
  `)
  return { game, since, rows }
}
