import { sql, type Sql } from 'openvibe-sdk/db'

/** Multi-row INSERT … ON CONFLICT chunks stay at or below this many rows. */
export const BATCH_CHUNK = 500

/** `($1, $2, …)` from a list of values, for IN clauses. Never call with an empty list. */
export function idList(values: readonly string[]): Sql {
  return sql.join(values.map((v) => sql`${v}`))
}

export function* chunks<T>(rows: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size)
}
