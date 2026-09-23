/**
 * Import of OpenVibe.Live's legacy game data (roadmap Wave 12 migration gate,
 * docs/legacy-import.md).
 *
 * Live ran HoboQuest (a 2D tile RPG: `game_*` tables) and a pixel canvas
 * (`canvas_*`) until both were retired. Scraplandia has no equivalent for
 * HoboQuest's items, recipes, achievements or skills, so the per-player rows
 * are kept verbatim in `legacy_live_rows`, keyed by the owner's canonical
 * Network subject; world-level, expired and derived rows and the canvas are
 * excluded with a recorded reason. Nothing here touches players or the world.
 *
 * Every source row ends in exactly one bucket — imported, held or excluded —
 * and the report checks `read = imported + held + excluded` per table.
 * Rows whose Live user has no Network subject (or an ambiguous one) are held
 * and listed, never guessed. The import is idempotent: rows are keyed by the
 * source primary key and never overwritten.
 */
import { realpathSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { IdentityClient } from 'openvibe-sdk/identity'

/** A Live user's canonical subject: `usr_<ULID>`. Guest subjects never own Live rows. */
export const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/

/** The production Live data directory; the importer reads snapshots only. */
export const LIVE_PRODUCTION_DIR = '/opt/openvibe.live/'

export interface LegacyTableSpec {
  table: string
  decision: 'import' | 'exclude'
  /** Column naming the owning Live user (for exclude tables: evidence of play only). */
  userColumn?: string
  /** Primary-key columns of the source row: the idempotency key (import tables only). */
  keyColumns?: string[]
  /** Why the table is excluded, or what the archived rows are. */
  reason: string
  /** Rows of an import table that are excluded one by one, and why. */
  excludeRows?: {
    reason: string
    test: (row: Row, ownsOtherRows: boolean) => boolean
  }
}

type Row = Record<string, unknown>

/**
 * A `game_players` row nobody played: Live's profile lookup
 * (`game.getPlayer`, still called by Live's chat profile routes) inserts a
 * default row for every profile it shows. Such a row was never acted on
 * (`last_action = created_at`), has no XP, counters, equipment, sleeping bag
 * or cosmetics, and its user owns no row in any other legacy game table.
 */
export function isPlaceholderPlayer(row: Row, ownsOtherRows: boolean): boolean {
  if (ownsOtherRows) return false
  if (row.created_at == null || row.last_action !== row.created_at) return false
  for (const [col, v] of Object.entries(row)) {
    const zero = v === null || v === 0
    if (/_xp$|^total_|^battle_(wins|losses)$|^structures_built$|^resources_gathered$/.test(col)) {
      if (!zero) return false
    } else if (/^equip_|^sleeping_bag_|^name_effect$|^particle_effect$/.test(col)) {
      if (v !== null) return false
    } else if (col === 'sprite_skin' && !zero) {
      return false
    }
  }
  return true
}

/** Every legacy game and canvas table in Live, with its decision (docs/legacy-import.md). */
export const LEGACY_TABLES: readonly LegacyTableSpec[] = [
  {
    table: 'game_players',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['user_id'],
    reason: 'HoboQuest profile: skill XP, combat stats, equipment, cosmetics, lifetime counters',
    excludeRows: {
      reason: "placeholder rows Live's profile lookup created for people who never played",
      test: isPlaceholderPlayer,
    },
  },
  {
    table: 'game_inventory',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['id'],
    reason: 'HoboQuest item stacks carried by the player',
  },
  {
    table: 'game_bank',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['id'],
    reason: 'HoboQuest item stacks in the bank',
  },
  {
    table: 'game_achievements',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['user_id', 'achievement_id'],
    reason: 'HoboQuest achievements completed',
  },
  {
    table: 'game_recipes',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['id'],
    reason: 'HoboQuest recipes unlocked',
  },
  {
    table: 'game_fish_collection',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['user_id', 'fish_id'],
    reason: 'HoboQuest fish album',
  },
  {
    table: 'game_battle_stats',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['user_id'],
    reason: 'HoboQuest PvP record',
  },
  {
    table: 'game_structures',
    decision: 'import',
    userColumn: 'owner_id',
    keyColumns: ['id'],
    reason: 'HoboQuest buildings owned (a record of ownership; the tile world is gone)',
  },
  {
    table: 'game_farm_plots',
    decision: 'import',
    userColumn: 'user_id',
    keyColumns: ['id'],
    reason: 'HoboQuest farm plots',
  },
  {
    table: 'game_world_state',
    decision: 'exclude',
    reason:
      "the seed of HoboQuest's procedural 2D world; Scraplandia's world is its own definition",
  },
  {
    table: 'game_effects',
    decision: 'exclude',
    userColumn: 'user_id',
    reason: 'timed buffs; every one has expired with the game',
  },
  {
    table: 'game_dungeon_runs',
    decision: 'exclude',
    userColumn: 'leader_id',
    reason: 'in-progress dungeon sessions; there is no dungeon to resume',
  },
  {
    table: 'game_leaderboard',
    decision: 'exclude',
    userColumn: 'user_id',
    reason: 'a cache derived from game_players',
  },
  {
    table: 'game_daily_quest_progress',
    decision: 'exclude',
    userColumn: 'user_id',
    reason: 'progress on daily quests of past days (they reset daily and can no longer be claimed)',
  },
  {
    table: 'game_daily_quest_claims',
    decision: 'exclude',
    userColumn: 'user_id',
    reason: 'claims of past daily quests',
  },
  {
    table: 'canvas_tiles',
    decision: 'exclude',
    reason: "Live's pixel canvas is not a Games feature; its rows carry IP addresses",
  },
  {
    table: 'canvas_actions',
    decision: 'exclude',
    reason: 'the pixel canvas placement and moderation log (with IP addresses)',
  },
  { table: 'canvas_settings', decision: 'exclude', reason: 'pixel canvas configuration' },
  { table: 'canvas_snapshots', decision: 'exclude', reason: 'pixel canvas snapshots' },
  { table: 'canvas_bans', decision: 'exclude', reason: 'pixel canvas moderation' },
  { table: 'canvas_region_locks', decision: 'exclude', reason: 'pixel canvas moderation' },
  { table: 'canvas_user_overrides', decision: 'exclude', reason: 'pixel canvas rate limits' },
]

/** Tables that belong to the legacy game or canvas: every one must be listed above. */
const LEGACY_TABLE_PATTERN = /^(game|canvas)_/

export type HoldReason =
  | 'no-subject'
  | 'subject-unconfirmed'
  | 'subject-conflict'
  | 'no-owner'
  | 'differs-from-earlier-import'

export const HOLD_REASONS: Record<HoldReason, string> = {
  'no-subject': 'the Live user has no Network subject',
  'subject-unconfirmed': 'Live records a subject but the Network does not confirm it',
  'subject-conflict': 'Live and the Network name different subjects',
  'no-owner': 'the row names no Live user',
  'differs-from-earlier-import': 'already imported with different content (never overwritten)',
}

export interface HeldRow {
  table: string
  key: string
  liveUserId: number | null
  reason: HoldReason
}

export interface TableReport {
  table: string
  decision: 'import' | 'exclude'
  /** The table does not exist in the snapshot (counts are 0). */
  missing: boolean
  read: number
  /** Rows in world.db after the run (new plus already imported). */
  imported: number
  /** Rows this run writes (0 on a re-run). */
  written: number
  held: number
  excluded: number
  balanced: boolean
}

export interface ImportReport {
  dryRun: boolean
  subjectSource: string
  tables: TableReport[]
  totals: Omit<TableReport, 'table' | 'decision' | 'missing'>
  /** Live users owning importable rows, and how their subjects resolved. */
  users: { total: number; mapped: number; held: Record<string, number> }
  held: HeldRow[]
  /** Rows of import tables excluded one by one, per `table: reason`. */
  excludedRows: Record<string, number>
  /** Legacy-looking tables in the snapshot that no decision covers. */
  unlisted: { table: string; rows: number }[]
  /** Every table balances and nothing is unlisted. */
  reconciled: boolean
}

/** Resolves Live user ids to subjects at the Network; null = the Network does not know the user. */
export type NetworkSubjectLookup = (liveUserIds: number[]) => Promise<Map<number, string | null>>

/** Lookup through the Network identity service: `(system 'live', type 'user', id)` -> subject. */
export function networkSubjectLookup(
  identity: Pick<IdentityClient, 'resolveBatch'>,
): NetworkSubjectLookup {
  return async (ids) => {
    const out = new Map<number, string | null>()
    if (!ids.length) return out
    const results = await identity.resolveBatch({ system: 'live', type: 'user', ids })
    for (const id of ids) out.set(id, results[String(id)]?.subject?.id ?? null)
    return out
  }
}

/** Lookup from a map exported from the Network: `{ "<live user id>": "usr_…" }`. */
export function subjectMapLookup(map: unknown): NetworkSubjectLookup {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('expected a JSON object { "<live user id>": "usr_…" }')
  }
  const entries = map as Record<string, unknown>
  return async (ids) =>
    new Map(
      ids.map((id) => {
        const v = entries[String(id)]
        return [id, typeof v === 'string' ? v : null]
      }),
    )
}

/** A row about to be written. */
export interface PlannedRow {
  table: string
  key: string
  liveUserId: number
  subjectId: string
  payload: string
}

export interface ImportPlan {
  report: ImportReport
  rows: PlannedRow[]
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  )
}

/** Deterministic JSON of a source row (sorted keys) so re-runs compare byte for byte. */
export function canonicalRow(row: Row): string {
  const out: Row = {}
  for (const key of Object.keys(row).sort()) {
    const v = row[key]
    if (typeof v === 'bigint') out[key] = Number(v)
    else if (v === null || typeof v === 'number' || typeof v === 'string') out[key] = v
    else throw new Error(`unsupported value in column ${key}: ${typeof v}`)
  }
  return JSON.stringify(out)
}

export function rowKey(row: Row, columns: readonly string[]): string {
  return columns.map((c) => String(row[c])).join('/')
}

/**
 * Refuses the production Live database: the importer reads a `.backup`
 * snapshot, never the file Live has open.
 */
export function assertSnapshotPath(path: string, productionDir = LIVE_PRODUCTION_DIR): void {
  const real = realpathSync(path)
  if (real.startsWith(productionDir)) {
    throw new Error(
      `${path} is Live's production database; take a snapshot first (sqlite3 <db> ".backup <copy>") and pass the copy`,
    )
  }
}

export interface RunOptions {
  livePath?: string
  apply: boolean
  backupPath?: string
  subjects?: string
  /** Whether `backupPath` already exists. */
  backupExists: boolean
}

/**
 * Why a run must not start, or null. `--apply` needs a fresh `--backup`
 * path (a stale file is not a backup of now) and a Network subject source.
 */
export function refusalFor(opts: RunOptions): string | null {
  if (!opts.livePath) return '--live <snapshot of live.db> is required'
  if (opts.apply && !opts.backupPath) return '--apply requires --backup <path>'
  if (opts.apply && !opts.subjects) {
    return '--apply requires --subjects network (or an exported subject map)'
  }
  if (opts.backupPath && opts.backupExists) {
    return `--backup ${opts.backupPath} already exists; choose a new path`
  }
  return null
}

/** Subjects Live itself recorded for its users (linked_accounts, service 'network'). */
export function liveLinkedSubjects(live: Database.Database): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (!tableExists(live, 'linked_accounts')) return out
  const cols = live.prepare('PRAGMA table_info(linked_accounts)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'subject_id')) return out
  const rows = live
    .prepare(
      "SELECT user_id, subject_id FROM linked_accounts WHERE service = 'network' AND subject_id IS NOT NULL",
    )
    .all() as { user_id: number; subject_id: string }[]
  for (const r of rows) {
    if (!USER_SUBJECT.test(r.subject_id)) continue
    const list = out.get(r.user_id) ?? []
    if (!list.includes(r.subject_id)) list.push(r.subject_id)
    out.set(r.user_id, list)
  }
  return out
}

/**
 * The subject a Live user's rows go to, or why they are held. With a Network
 * answer the Network is the authority and Live's own record must agree; with
 * none (an informational dry run) Live's single recorded subject is used.
 */
export function decideSubject(
  liveUserId: number,
  linked: ReadonlyMap<number, string[]>,
  network: ReadonlyMap<number, string | null> | null,
): { subjectId: string } | { hold: HoldReason } {
  const own = linked.get(liveUserId) ?? []
  if (own.length > 1) return { hold: 'subject-conflict' }
  if (network) {
    const answer = network.get(liveUserId) ?? null
    const n = answer !== null && USER_SUBJECT.test(answer) ? answer : null
    if (!n) return { hold: own.length ? 'subject-unconfirmed' : 'no-subject' }
    if (own.length && own[0] !== n) return { hold: 'subject-conflict' }
    return { subjectId: n }
  }
  return own[0] ? { subjectId: own[0] } : { hold: 'no-subject' }
}

/** Rows already in world.db's archive, keyed `table\u0000key` -> payload. */
function existingArchive(world: Database.Database | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!world || !tableExists(world, 'legacy_live_rows')) return out
  const rows = world
    .prepare('SELECT source_table, source_key, payload FROM legacy_live_rows')
    .all() as { source_table: string; source_key: string; payload: string }[]
  for (const r of rows) out.set(`${r.source_table}\u0000${r.source_key}`, r.payload)
  return out
}

export interface PlanOptions {
  /** The Network's answer for each Live user id, or null to rely on Live's own record only. */
  network: NetworkSubjectLookup | null
  subjectSource: string
  dryRun: boolean
}

/**
 * Reads the Live snapshot and decides every row. `world` may be null (a
 * fresh world with nothing imported yet) and is only read here.
 */
export async function planLegacyImport(
  live: Database.Database,
  world: Database.Database | null,
  opts: PlanOptions,
): Promise<ImportPlan> {
  const sourceRows = new Map<string, Row[]>()
  const excludedCounts = new Map<string, number>()
  const missing = new Set<string>()
  /** Live user id -> the legacy tables that hold a row of theirs. */
  const activity = new Map<number, Set<string>>()
  const owner = (row: Row, spec: LegacyTableSpec): number | null => {
    const uid = spec.userColumn ? row[spec.userColumn] : null
    return typeof uid === 'number' && Number.isInteger(uid) ? uid : null
  }

  for (const spec of LEGACY_TABLES) {
    if (!tableExists(live, spec.table)) {
      missing.add(spec.table)
      continue
    }
    if (spec.userColumn) {
      const col = quoteIdent(spec.userColumn)
      const owners = live
        .prepare(
          `SELECT DISTINCT ${col} AS uid FROM ${quoteIdent(spec.table)} WHERE ${col} IS NOT NULL`,
        )
        .all() as { uid: unknown }[]
      for (const { uid } of owners) {
        if (typeof uid !== 'number') continue
        activity.set(uid, (activity.get(uid) ?? new Set()).add(spec.table))
      }
    }
    if (spec.decision === 'exclude') {
      const n = live.prepare(`SELECT count(*) AS n FROM ${quoteIdent(spec.table)}`).get() as {
        n: number
      }
      excludedCounts.set(spec.table, n.n)
      continue
    }
    const order = (spec.keyColumns ?? []).map(quoteIdent).join(', ')
    const rows = live
      .prepare(`SELECT * FROM ${quoteIdent(spec.table)} ORDER BY ${order}`)
      .all() as Row[]
    sourceRows.set(spec.table, rows)
  }

  // Row-level exclusions, then the users whose rows are left to import.
  const excludedRow = new Set<Row>()
  const excludedRows: Record<string, number> = {}
  const userIds = new Set<number>()
  for (const spec of LEGACY_TABLES) {
    for (const row of sourceRows.get(spec.table) ?? []) {
      const uid = owner(row, spec)
      const tables = uid === null ? undefined : activity.get(uid)
      const ownsOtherRows = [...(tables ?? [])].some((t) => t !== spec.table)
      if (spec.excludeRows?.test(row, ownsOtherRows)) {
        excludedRow.add(row)
        const k = `${spec.table}: ${spec.excludeRows.reason}`
        excludedRows[k] = (excludedRows[k] ?? 0) + 1
        continue
      }
      if (uid !== null) userIds.add(uid)
    }
  }

  const listed = new Set(LEGACY_TABLES.map((t) => t.table))
  const unlisted = (
    live.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string
    }[]
  )
    .map((r) => r.name)
    .filter((name) => LEGACY_TABLE_PATTERN.test(name) && !listed.has(name))
    .map((table) => ({
      table,
      rows: (live.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number })
        .n,
    }))

  const ids = [...userIds].sort((a, b) => a - b)
  const linked = liveLinkedSubjects(live)
  const network = opts.network ? await opts.network(ids) : null
  const verdicts = new Map(ids.map((id) => [id, decideSubject(id, linked, network)]))
  const usersHeld: Record<string, number> = {}
  let mapped = 0
  for (const v of verdicts.values()) {
    if ('subjectId' in v) mapped++
    else usersHeld[v.hold] = (usersHeld[v.hold] ?? 0) + 1
  }

  const archive = existingArchive(world)
  const held: HeldRow[] = []
  const planned: PlannedRow[] = []
  const tables: TableReport[] = []

  for (const spec of LEGACY_TABLES) {
    const t: TableReport = {
      table: spec.table,
      decision: spec.decision,
      missing: missing.has(spec.table),
      read: 0,
      imported: 0,
      written: 0,
      held: 0,
      excluded: 0,
      balanced: true,
    }
    if (spec.decision === 'exclude') {
      t.read = excludedCounts.get(spec.table) ?? 0
      t.excluded = t.read
    } else {
      for (const row of sourceRows.get(spec.table) ?? []) {
        t.read++
        if (excludedRow.has(row)) {
          t.excluded++
          continue
        }
        const key = rowKey(row, spec.keyColumns ?? [])
        const liveUserId = owner(row, spec)
        const verdict = liveUserId === null ? null : verdicts.get(liveUserId)
        if (!verdict || !('subjectId' in verdict)) {
          held.push({
            table: spec.table,
            key,
            liveUserId,
            reason: verdict ? verdict.hold : 'no-owner',
          })
          t.held++
          continue
        }
        const payload = canonicalRow(row)
        const earlier = archive.get(`${spec.table}\u0000${key}`)
        if (earlier !== undefined && earlier !== payload) {
          held.push({ table: spec.table, key, liveUserId, reason: 'differs-from-earlier-import' })
          t.held++
          continue
        }
        t.imported++
        if (earlier === undefined) {
          t.written++
          planned.push({
            table: spec.table,
            key,
            liveUserId: liveUserId as number,
            subjectId: verdict.subjectId,
            payload,
          })
        }
      }
    }
    t.balanced = t.read === t.imported + t.held + t.excluded
    tables.push(t)
  }

  const totals = tables.reduce(
    (acc, t) => ({
      read: acc.read + t.read,
      imported: acc.imported + t.imported,
      written: acc.written + t.written,
      held: acc.held + t.held,
      excluded: acc.excluded + t.excluded,
      balanced: acc.balanced && t.balanced,
    }),
    { read: 0, imported: 0, written: 0, held: 0, excluded: 0, balanced: true },
  )
  totals.balanced =
    totals.balanced && totals.read === totals.imported + totals.held + totals.excluded

  return {
    rows: planned,
    report: {
      dryRun: opts.dryRun,
      subjectSource: opts.subjectSource,
      tables,
      totals,
      users: { total: ids.length, mapped, held: usersHeld },
      held,
      excludedRows,
      unlisted,
      reconciled: totals.balanced && unlisted.length === 0,
    },
  }
}

/**
 * Writes the planned rows in one transaction. Existing keys are never
 * touched (ON CONFLICT DO NOTHING); the write count must equal the plan or
 * the transaction rolls back.
 */
export function applyLegacyImport(world: Database.Database, plan: ImportPlan, now: number): number {
  if (!plan.report.reconciled) throw new Error('refusing to apply: the plan does not reconcile')
  const insert = world.prepare(`
    INSERT INTO legacy_live_rows (source_table, source_key, live_user_id, subject_id, payload, imported_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_table, source_key) DO NOTHING
  `)
  return world.transaction(() => {
    let written = 0
    for (const r of plan.rows) {
      written += insert.run(r.table, r.key, r.liveUserId, r.subjectId, r.payload, now).changes
    }
    if (written !== plan.rows.length) {
      throw new Error(`wrote ${written} rows, planned ${plan.rows.length}: rolled back`)
    }
    return written
  })()
}

/** Archived row counts per source table (post-apply verification). */
export function archivedCounts(world: Database.Database): Map<string, number> {
  const out = new Map<string, number>()
  if (!tableExists(world, 'legacy_live_rows')) return out
  const rows = world
    .prepare('SELECT source_table, count(*) AS n FROM legacy_live_rows GROUP BY source_table')
    .all() as { source_table: string; n: number }[]
  for (const r of rows) out.set(r.source_table, r.n)
  return out
}

/**
 * Snapshot of world.db to `path` taken before anything is written, then
 * verified: PRAGMA integrity_check must answer `ok` and the snapshot must
 * hold the same players and archive rows as the source.
 */
export async function backupAndVerify(
  world: Database.Database,
  path: string,
  open: (path: string) => Database.Database,
): Promise<void> {
  await world.backup(path)
  const copy = open(path)
  try {
    const check = copy.pragma('integrity_check') as { integrity_check: string }[]
    if (check.length !== 1 || check[0]?.integrity_check !== 'ok') {
      throw new Error(`backup ${path} failed integrity_check: ${JSON.stringify(check)}`)
    }
    const count = (db: Database.Database, table: string): number =>
      tableExists(db, table)
        ? (db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n
        : 0
    for (const table of ['players', 'world_entities', 'legacy_live_rows']) {
      if (count(copy, table) !== count(world, table)) {
        throw new Error(`backup ${path} does not match world.db (${table} row count)`)
      }
    }
  } finally {
    copy.close()
  }
}

/** The reconciliation report as text. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = []
  const mode = report.dryRun ? 'DRY RUN (nothing written)' : 'APPLIED'
  lines.push(`Live legacy import: ${mode}; subjects from ${report.subjectSource}`)
  lines.push('')
  const head = ['table', 'decision', 'read', 'imported', 'written', 'held', 'excluded', 'check']
  const body = report.tables.map((t) => [
    t.table + (t.missing ? ' (absent)' : ''),
    t.decision,
    String(t.read),
    String(t.imported),
    String(t.written),
    String(t.held),
    String(t.excluded),
    t.balanced ? 'ok' : 'MISMATCH',
  ])
  const tot = report.totals
  body.push([
    'TOTAL',
    '',
    String(tot.read),
    String(tot.imported),
    String(tot.written),
    String(tot.held),
    String(tot.excluded),
    tot.balanced ? 'ok' : 'MISMATCH',
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)))
  const fmt = (r: string[]): string =>
    r.map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join('  ')
  lines.push(fmt(head))
  for (const r of body) lines.push(fmt(r))
  lines.push('')
  lines.push(
    `read ${tot.read} = imported ${tot.imported} + held ${tot.held} + excluded ${tot.excluded}: ${
      tot.balanced ? 'balanced' : 'NOT BALANCED'
    }`,
  )
  const heldUsers = Object.entries(report.users.held)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
  lines.push(
    `Live users owning importable rows: ${report.users.total}; mapped to a subject: ${report.users.mapped}; held: ${heldUsers || 'none'}`,
  )
  for (const [what, n] of Object.entries(report.excludedRows)) {
    lines.push(`Excluded rows of import tables: ${what}: ${n}`)
  }
  if (report.unlisted.length) {
    lines.push('')
    lines.push('UNLISTED legacy tables (no decision recorded; apply is refused):')
    for (const u of report.unlisted) lines.push(`  ${u.table}: ${u.rows} rows`)
  }
  if (report.held.length) {
    lines.push('')
    lines.push('Held rows (by Live user; table[source keys]):')
    const byUser = new Map<string, HeldRow[]>()
    for (const h of report.held) {
      const k = `${h.liveUserId ?? 'none'}\u0000${h.reason}`
      byUser.set(k, [...(byUser.get(k) ?? []), h])
    }
    const sorted = [...byUser.entries()].sort(
      ([a], [b]) => Number(a.split('\u0000')[0]) - Number(b.split('\u0000')[0]),
    )
    for (const [k, rows] of sorted) {
      const [uid, reason] = k.split('\u0000')
      const perTable = new Map<string, string[]>()
      for (const r of rows) perTable.set(r.table, [...(perTable.get(r.table) ?? []), r.key])
      const detail = [...perTable.entries()].map(([t, keys]) => `${t}[${keys.join(',')}]`).join(' ')
      lines.push(`  live user ${uid} (${reason}): ${detail}`)
    }
    const reasons = [...new Set(report.held.map((h) => h.reason))]
    for (const r of reasons) lines.push(`  ${r}: ${HOLD_REASONS[r]}`)
  }
  lines.push('')
  lines.push(report.reconciled ? 'RECONCILED' : 'NOT RECONCILED')
  return lines.join('\n')
}
