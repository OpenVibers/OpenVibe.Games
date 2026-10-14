import { sql, type Db } from 'openvibe-sdk/db'
import { idList } from './sqlUtils.js'

/**
 * The casual kit's saves follow their owner (plan T22): a guest's save moves into the account that signs in on
 * that browser, a folded-in account's save moves on a merge, and both are in the export and the erasure. One save
 * per game per account: when the receiving account already has a save for a game, the other one stays where it is
 * (kept, never deleted), the way a character with no free slot is kept.
 */

/** Moves `from`'s casual saves, their ledger and their action records to `into`; returns the games moved. */
export async function moveCasualSaves(db: Db, from: string, into: string): Promise<string[]> {
  if (from === into) return []
  const games = (
    await db.many<{ game_id: string }>(sql`
      SELECT s.game_id FROM casual_saves s
      WHERE s.account_key = ${from}
        AND NOT EXISTS (
          SELECT 1 FROM casual_saves t WHERE t.game_id = s.game_id AND t.account_key = ${into}
        )
    `)
  ).map((r) => r.game_id)
  if (!games.length) return []
  await db.exec(
    sql`UPDATE casual_saves SET account_key = ${into} WHERE account_key = ${from} AND game_id IN (${idList(games)})`,
  )
  await db.exec(
    sql`UPDATE casual_ledger SET account_key = ${into} WHERE account_key = ${from} AND game_id IN (${idList(games)})`,
  )
  await db.exec(
    sql`DELETE FROM casual_actions WHERE account_key = ${from} AND game_id IN (${idList(games)})`,
  )
  return games
}

export async function exportCasual(
  db: Db,
  subject: string,
): Promise<{ saves: Record<string, unknown>[]; ledger: Record<string, unknown>[] }> {
  const saves = await db.many<Record<string, unknown>>(sql`
    SELECT game_id, state, player_name, stage, power, source, campaign, created_at, updated_at
    FROM casual_saves WHERE account_key = ${subject} ORDER BY game_id
  `)
  const ledger = await db.many<Record<string, unknown>>(sql`
    SELECT game_id, asset, delta, balance, reason, at
    FROM casual_ledger WHERE account_key = ${subject} ORDER BY id
  `)
  return { saves, ledger }
}

export async function eraseCasual(db: Db, subjects: string[]): Promise<number> {
  if (!subjects.length) return 0
  const saves = await db.exec(
    sql`DELETE FROM casual_saves WHERE account_key IN (${idList(subjects)})`,
  )
  await db.exec(sql`DELETE FROM casual_ledger WHERE account_key IN (${idList(subjects)})`)
  await db.exec(sql`DELETE FROM casual_actions WHERE account_key IN (${idList(subjects)})`)
  return saves
}
