import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createIdentityClient } from 'openvibe-sdk/identity'
import { createMockPlatform } from 'openvibe-sdk/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPlatformConfig } from '../config.js'
import {
  applyLegacyImport,
  archivedCounts,
  assertSnapshotPath,
  backupAndVerify,
  decideSubject,
  formatReport,
  isPlaceholderPlayer,
  networkSubjectLookup,
  planLegacyImport,
  refusalFor,
  subjectMapLookup,
  type ImportReport,
  type TableReport,
} from './liveLegacyImport.js'
import { createPlatformClient } from './serviceClient.js'

// Canonical subjects (Crockford base32 ULIDs).
const S1 = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56'
const S2 = 'usr_01KKBC57W8GDSNVJJDQ15PQCDG'
const S4A = 'usr_01KKBC57W8GDSNVJJDQ15PQCD4'
const S4B = 'usr_01KKBC57W8GDSNVJJDQ15PQCD5'
const S5 = 'usr_01KKBC57W8GDSNVJJDQ15PQCD6'
const S6 = 'usr_01KKBC57W8GDSNVJJDQ15PQCD8'
const S7 = 'usr_01KKBC57W8GDSNVJJDQ15PQCD9'

/**
 * A Live snapshot with Live's real column layout for the tables that matter:
 *  user 1 — Live and the Network agree (S1)
 *  user 2 — no Live record, the Network knows it (S2)
 *  user 3 — nobody knows it (held: no-subject)
 *  user 4 — Live says S4A, the Network S4B (held: subject-conflict)
 *  user 5 — Live says S5, the Network does not know it (held: subject-unconfirmed)
 *  user 6 — a placeholder game_players row Live's profile lookup made (excluded)
 *  user 7 — never acted and has no XP, but has a daily-quest row: played (S7)
 */
function makeLive(path: string): void {
  const db = new Database(path)
  db.pragma('synchronous = OFF')
  db.exec(`
    BEGIN;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE linked_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, service TEXT NOT NULL,
      service_user_id TEXT NOT NULL, service_username TEXT, linked_at DATETIME, subject_id TEXT,
      UNIQUE(service, service_user_id)
    );
    CREATE TABLE game_players (
      user_id INTEGER PRIMARY KEY, display_name TEXT, x REAL DEFAULT 4096, y REAL DEFAULT 4096,
      mining_xp INTEGER DEFAULT 0, woodcut_xp INTEGER DEFAULT 0, hp INTEGER DEFAULT 100,
      equip_pickaxe TEXT, sleeping_bag_x REAL, created_at DATETIME, last_action DATETIME
    );
    CREATE TABLE game_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, item_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1, UNIQUE(user_id, item_id)
    );
    CREATE TABLE game_bank (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, item_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1, UNIQUE(user_id, item_id)
    );
    CREATE TABLE game_achievements (
      user_id INTEGER NOT NULL, achievement_id TEXT NOT NULL, completed_at DATETIME,
      PRIMARY KEY (user_id, achievement_id)
    );
    CREATE TABLE game_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, recipe_id TEXT NOT NULL,
      unlocked_at DATETIME, UNIQUE(user_id, recipe_id)
    );
    CREATE TABLE game_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, type TEXT NOT NULL,
      tile_x INTEGER NOT NULL, tile_y INTEGER NOT NULL
    );
    CREATE TABLE game_world_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE game_daily_quest_progress (
      user_id INTEGER NOT NULL, quest_date TEXT NOT NULL, stat_key TEXT NOT NULL, value REAL,
      PRIMARY KEY (user_id, quest_date, stat_key)
    );
    CREATE TABLE canvas_tiles (
      x INTEGER NOT NULL, y INTEGER NOT NULL, color_index INTEGER NOT NULL, user_id INTEGER,
      ip_address TEXT, PRIMARY KEY (x, y)
    );
    CREATE TABLE canvas_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT NOT NULL, x INTEGER, y INTEGER,
      user_id INTEGER, ip_address TEXT
    );
    INSERT INTO users (id, username) VALUES
      (1, 'ana'), (2, 'bo'), (3, 'cy'), (4, 'di'), (5, 'ed'), (6, 'fi'), (7, 'gu');
    INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES
      (1, 'network', '101', '${S1}'),
      (2, 'network', '102', NULL),
      (4, 'network', '104', '${S4A}'),
      (5, 'network', '105', '${S5}'),
      (3, 'google', 'g-3', NULL);
    INSERT INTO game_players (user_id, display_name, mining_xp, woodcut_xp, equip_pickaxe, created_at, last_action) VALUES
      (1, 'Ana', 1200, 30, 'pick_iron', '2026-03-01 10:00:00', '2026-09-01 10:00:00'),
      (2, 'Bo', 0, 0, NULL, '2026-03-01 10:00:00', '2026-09-02 10:00:00'),
      (3, 'Cy', 5, 5, NULL, '2026-03-01 10:00:00', '2026-09-03 10:00:00'),
      (4, 'Di', 7, 0, NULL, '2026-03-01 10:00:00', '2026-09-04 10:00:00'),
      (5, 'Ed', 9, 0, NULL, '2026-03-01 10:00:00', '2026-09-05 10:00:00'),
      (6, NULL, 0, 0, NULL, '2026-09-19 17:52:12', '2026-09-19 17:52:12'),
      (7, NULL, 0, 0, NULL, '2026-03-10 09:00:00', '2026-03-10 09:00:00');
    INSERT INTO game_inventory (user_id, item_id, quantity) VALUES
      (1, 'ore_copper', 40), (1, 'pick_iron', 1), (2, 'fish_bass', 3), (3, 'loot_lint', 2),
      (4, 'gem_ruby', 1);
    INSERT INTO game_bank (user_id, item_id, quantity) VALUES (1, 'raw_stone', 900), (3, 'raw_stick', 12);
    INSERT INTO game_achievements (user_id, achievement_id, completed_at) VALUES
      (1, 'first_gather', '2026-03-10'), (1, 'level_10_any', '2026-03-11'), (5, 'first_blood', '2026-03-12');
    INSERT INTO game_recipes (user_id, recipe_id) VALUES (2, 'recipe_plank'), (3, 'recipe_iron_bar');
    INSERT INTO game_structures (owner_id, type, tile_x, tile_y) VALUES (1, 'furnace', 4, 190), (NULL, 'ruin', 5, 5);
    INSERT INTO game_world_state VALUES ('world_seed', '1510266867');
    INSERT INTO game_daily_quest_progress VALUES
      (1, '2026-03-10', 'gathered', 5), (2, '2026-03-10', 'caught', 1), (7, '2026-03-10', 'walked', 3);
    INSERT INTO canvas_tiles VALUES (0, 0, 3, 1, '203.0.113.9'), (0, 1, 4, 2, '203.0.113.9');
    INSERT INTO canvas_actions (action_type, x, y, user_id, ip_address) VALUES
      ('place', 0, 0, 1, '203.0.113.9'), ('blocked', 0, 1, 2, '203.0.113.9'), ('place', 0, 1, 2, '203.0.113.9');
    COMMIT;
  `)
  db.close()
}

/** The Network's answers for the fixture users. */
const NETWORK: Record<number, string> = { 1: S1, 2: S2, 4: S4B, 6: S6, 7: S7 }
const network = subjectMapLookup(NETWORK)

let dir: string
let livePath: string
let worldPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-legacy-'))
  livePath = join(dir, 'live-snapshot.db')
  worldPath = join(dir, 'world.db')
  makeLive(livePath)
  openSqliteStore(worldPath).close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const table = (r: ImportReport, name: string): TableReport => {
  const t = r.tables.find((x) => x.table === name)
  if (!t) throw new Error(`no ${name} in report`)
  return t
}

async function plan(
  opts: { network?: typeof network | null; world?: Database.Database | null } = {},
) {
  const live = new Database(livePath, { readonly: true })
  const world = opts.world === undefined ? new Database(worldPath, { readonly: true }) : opts.world
  try {
    return await planLegacyImport(live, world, {
      network: opts.network === undefined ? network : opts.network,
      subjectSource: 'test',
      dryRun: true,
    })
  } finally {
    live.close()
    if (opts.world === undefined) world?.close()
  }
}

function dumpArchive(): unknown[] {
  const db = new Database(worldPath, { readonly: true })
  try {
    return db.prepare('SELECT * FROM legacy_live_rows ORDER BY source_table, source_key').all()
  } finally {
    db.close()
  }
}

async function applyOnce(): Promise<number> {
  const live = new Database(livePath, { readonly: true })
  const world = new Database(worldPath)
  try {
    const p = await planLegacyImport(live, world, {
      network,
      subjectSource: 'test',
      dryRun: false,
    })
    return applyLegacyImport(world, p, 1_790_000_000_000)
  } finally {
    live.close()
    world.close()
  }
}

describe('subject mapping', () => {
  it('uses the Network as the authority and never guesses', () => {
    const linked = new Map<number, string[]>([
      [1, [S1]],
      [4, [S4A]],
      [5, [S5]],
      [6, [S1, S2]],
    ])
    const net = new Map<number, string | null>([
      [1, S1],
      [2, S2],
      [3, null],
      [4, S4B],
      [5, null],
      [7, 'usr_not-a-ulid'],
    ])
    expect(decideSubject(1, linked, net)).toEqual({ subjectId: S1 })
    expect(decideSubject(2, linked, net)).toEqual({ subjectId: S2 })
    expect(decideSubject(3, linked, net)).toEqual({ hold: 'no-subject' })
    expect(decideSubject(4, linked, net)).toEqual({ hold: 'subject-conflict' })
    expect(decideSubject(5, linked, net)).toEqual({ hold: 'subject-unconfirmed' })
    expect(decideSubject(6, linked, net)).toEqual({ hold: 'subject-conflict' })
    expect(decideSubject(7, linked, net)).toEqual({ hold: 'no-subject' })
    // Without a Network answer only Live's single recorded subject counts.
    expect(decideSubject(1, linked, null)).toEqual({ subjectId: S1 })
    expect(decideSubject(2, linked, null)).toEqual({ hold: 'no-subject' })
    expect(decideSubject(6, linked, null)).toEqual({ hold: 'subject-conflict' })
  })

  it('keys every imported row by the mapped subject and holds the rest', async () => {
    const { report, rows } = await plan()
    expect(report.users).toEqual({
      total: 6,
      mapped: 3,
      held: { 'no-subject': 1, 'subject-conflict': 1, 'subject-unconfirmed': 1 },
    })
    const players = rows.filter((r) => r.table === 'game_players')
    expect(players.map((r) => [r.liveUserId, r.subjectId])).toEqual([
      [1, S1],
      [2, S2],
      [7, S7],
    ])
    expect(new Set(rows.map((r) => r.liveUserId))).toEqual(new Set([1, 2, 7]))
    const heldUsers = new Set(report.held.map((h) => h.liveUserId))
    expect(heldUsers).toEqual(new Set([3, 4, 5, null]))
    expect(report.held).toContainEqual({
      table: 'game_structures',
      key: '2',
      liveUserId: null,
      reason: 'no-owner',
    })
    expect(report.held).toContainEqual({
      table: 'game_achievements',
      key: '5/first_blood',
      liveUserId: 5,
      reason: 'subject-unconfirmed',
    })
    // The payload is the whole source row, canonical JSON.
    const ana = players.find((r) => r.liveUserId === 1)
    expect(JSON.parse(ana?.payload ?? '{}')).toEqual({
      created_at: '2026-03-01 10:00:00',
      display_name: 'Ana',
      equip_pickaxe: 'pick_iron',
      hp: 100,
      last_action: '2026-09-01 10:00:00',
      mining_xp: 1200,
      sleeping_bag_x: null,
      user_id: 1,
      woodcut_xp: 30,
      x: 4096,
      y: 4096,
    })
  })

  it('resolves through the Network identity service with the games principal', async () => {
    const platform = createMockPlatform({
      clients: {
        games: {
          secret: 's3cret',
          grants: [{ capability: 'identity.subject.resolve', audience: 'openvibe.network' }],
        },
      },
      users: [
        { id: 101, username: 'ana', subject_id: S1, legacy: [{ system: 'live', id: 1 }] },
        { id: 102, username: 'bo', subject_id: S2, legacy: [{ system: 'live', id: 2 }] },
      ],
    })
    const pc = createPlatformClient(
      { ...loadPlatformConfig({}), clientSecret: 's3cret', networkUrl: platform.origins.network },
      platform.fetch,
    )
    if (!pc) throw new Error('no platform client')
    const lookup = networkSubjectLookup(createIdentityClient(pc.client))
    const answers = await lookup([1, 2, 3])
    expect(answers).toEqual(
      new Map([
        [1, S1],
        [2, S2],
        [3, null],
      ]),
    )
    const { report } = await plan({ network: lookup })
    expect(report.users.mapped).toBe(2)
  })

  it('without a Network source relies on Live’s own record only', async () => {
    const { report } = await plan({ network: null })
    // user 1 (S1), user 4 (S4A) and user 5 (S5) have a Live record; 2, 3 and 7 do not.
    expect(report.users).toEqual({ total: 6, mapped: 3, held: { 'no-subject': 3 } })
  })
})

describe('placeholder players', () => {
  const base = {
    user_id: 9,
    mining_xp: 0,
    total_deaths: 0,
    battle_wins: 0,
    equip_axe: null,
    sleeping_bag_x: null,
    sprite_skin: 0,
    hp: 100,
    chat_color: '#e8e6e3',
    created_at: '2026-09-19 17:52:12',
    last_action: '2026-09-19 17:52:12',
  }
  it('excludes only rows nobody played', () => {
    expect(isPlaceholderPlayer(base, false)).toBe(true)
    expect(isPlaceholderPlayer(base, true)).toBe(false) // owns other legacy rows
    expect(isPlaceholderPlayer({ ...base, last_action: '2026-09-20 00:00:00' }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, mining_xp: 1 }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, total_deaths: 1 }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, battle_wins: 2 }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, equip_axe: 'axe_stone' }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, sleeping_bag_x: 12 }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, sprite_skin: 3 }, false)).toBe(false)
    expect(isPlaceholderPlayer({ ...base, created_at: null }, false)).toBe(false)
  })
})

describe('reconciliation', () => {
  it('accounts for every source row: read = imported + held + excluded', async () => {
    const { report } = await plan()
    for (const t of report.tables) {
      expect(t.read, t.table).toBe(t.imported + t.held + t.excluded)
      expect(t.balanced).toBe(true)
    }
    expect(table(report, 'game_players')).toMatchObject({
      read: 7,
      imported: 3,
      written: 3,
      held: 3,
      excluded: 1,
    })
    expect(report.excludedRows).toEqual({
      "game_players: placeholder rows Live's profile lookup created for people who never played": 1,
    })
    expect(table(report, 'game_inventory')).toMatchObject({ read: 5, imported: 3, held: 2 })
    expect(table(report, 'game_bank')).toMatchObject({ read: 2, imported: 1, held: 1 })
    expect(table(report, 'game_achievements')).toMatchObject({ read: 3, imported: 2, held: 1 })
    expect(table(report, 'game_recipes')).toMatchObject({ read: 2, imported: 1, held: 1 })
    expect(table(report, 'game_structures')).toMatchObject({ read: 2, imported: 1, held: 1 })
    expect(table(report, 'game_world_state')).toMatchObject({ read: 1, excluded: 1, imported: 0 })
    expect(table(report, 'game_daily_quest_progress')).toMatchObject({ read: 3, excluded: 3 })
    expect(table(report, 'canvas_tiles')).toMatchObject({ read: 2, excluded: 2 })
    expect(table(report, 'canvas_actions')).toMatchObject({ read: 3, excluded: 3 })
    // Tables the snapshot does not have are reported, with zero rows.
    expect(table(report, 'game_fish_collection')).toMatchObject({ missing: true, read: 0 })
    expect(report.totals).toEqual({
      read: 30,
      imported: 11,
      written: 11,
      held: 9,
      excluded: 10,
      balanced: true,
    })
    expect(report.unlisted).toEqual([])
    expect(report.reconciled).toBe(true)
    const text = formatReport(report)
    expect(text).toContain('read 30 = imported 11 + held 9 + excluded 10: balanced')
    expect(text).toContain(
      'live user 3 (no-subject): game_players[3] game_inventory[4] game_bank[2]',
    )
    expect(text).toContain('RECONCILED')
  })

  it('refuses to apply when a legacy table has no recorded decision', async () => {
    const db = new Database(livePath)
    db.exec(
      "CREATE TABLE game_pets (user_id INTEGER, pet TEXT); INSERT INTO game_pets VALUES (1, 'rat');",
    )
    db.close()
    const p = await plan()
    expect(p.report.unlisted).toEqual([{ table: 'game_pets', rows: 1 }])
    expect(p.report.reconciled).toBe(false)
    expect(formatReport(p.report)).toContain('NOT RECONCILED')
    const world = new Database(worldPath)
    try {
      expect(() => applyLegacyImport(world, p, 1)).toThrow(/does not reconcile/)
    } finally {
      world.close()
    }
    expect(dumpArchive()).toEqual([])
  })
})

describe('apply and idempotency', () => {
  it('writes the plan in one transaction and a re-run changes nothing', async () => {
    expect(await applyOnce()).toBe(11)
    const first = dumpArchive()
    expect(first).toHaveLength(11)
    const world = new Database(worldPath, { readonly: true })
    try {
      expect(Object.fromEntries(archivedCounts(world))).toEqual({
        game_achievements: 2,
        game_bank: 1,
        game_inventory: 3,
        game_players: 3,
        game_recipes: 1,
        game_structures: 1,
      })
    } finally {
      world.close()
    }

    // Re-run: same counts, nothing written, archive byte-identical.
    const again = await plan()
    expect(again.rows).toEqual([])
    expect(again.report.totals).toEqual({
      read: 30,
      imported: 11,
      written: 0,
      held: 9,
      excluded: 10,
      balanced: true,
    })
    expect(await applyOnce()).toBe(0)
    expect(dumpArchive()).toEqual(first)
  })

  it('picks up rows whose subject appears later, without touching earlier ones', async () => {
    await applyOnce()
    const first = dumpArchive()
    const later = subjectMapLookup({ ...NETWORK, 3: 'usr_01KKBC57W8GDSNVJJDQ15PQCD7' })
    const p = await plan({ network: later })
    expect(p.report.totals.written).toBe(4) // user 3: player, inventory, bank and recipe rows
    expect(p.rows.every((r) => r.liveUserId === 3)).toBe(true)
    const world = new Database(worldPath)
    try {
      expect(applyLegacyImport(world, p, 2)).toBe(4)
    } finally {
      world.close()
    }
    const after = dumpArchive()
    expect(after).toHaveLength(15)
    for (const row of first) expect(after).toContainEqual(row)
  })

  it('holds a row that changed since it was imported and never overwrites it', async () => {
    await applyOnce()
    const before = dumpArchive()
    const db = new Database(livePath)
    db.exec("UPDATE game_inventory SET quantity = 41 WHERE user_id = 1 AND item_id = 'ore_copper'")
    db.close()
    const p = await plan()
    expect(p.report.held).toContainEqual({
      table: 'game_inventory',
      key: '1',
      liveUserId: 1,
      reason: 'differs-from-earlier-import',
    })
    expect(table(p.report, 'game_inventory')).toMatchObject({ read: 5, imported: 2, held: 3 })
    expect(p.report.reconciled).toBe(true)
    const world = new Database(worldPath)
    try {
      expect(applyLegacyImport(world, p, 3)).toBe(0)
    } finally {
      world.close()
    }
    expect(dumpArchive()).toEqual(before)
  })

  it('plans against a world that has no archive table yet (schema 12)', async () => {
    const legacyWorld = new Database(':memory:')
    const p = await plan({ world: legacyWorld })
    expect(p.report.totals.written).toBe(11)
    legacyWorld.close()
  })
})

describe('safety rails', () => {
  it('refuses --apply without --backup, a reused backup path and a missing subject source', () => {
    const base = { livePath: 'x.db', apply: true, backupExists: false }
    expect(refusalFor({ ...base, subjects: 'network' })).toBe('--apply requires --backup <path>')
    expect(refusalFor({ ...base, backupPath: 'b.db' })).toMatch(/requires --subjects/)
    expect(
      refusalFor({ ...base, backupPath: 'b.db', subjects: 'network', backupExists: true }),
    ).toMatch(/already exists/)
    expect(refusalFor({ ...base, backupPath: 'b.db', subjects: 'network' })).toBeNull()
    expect(refusalFor({ apply: false, backupExists: false })).toMatch(/--live/)
    expect(refusalFor({ livePath: 'x.db', apply: false, backupExists: false })).toBeNull()
  })

  it('the script exits 2 on --apply without --backup and writes nothing', () => {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../scripts/importLiveLegacy.ts',
    )
    const before = readFileSync(worldPath)
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        script,
        '--live',
        livePath,
        '--world',
        worldPath,
        '--apply',
        '--subjects',
        'network',
      ],
      { encoding: 'utf8', env: { ...process.env, OV_OAUTH_CLIENT_SECRET: '' } },
    )
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('refused: --apply requires --backup <path>')
    expect(readFileSync(worldPath).equals(before)).toBe(true)
  })

  it('the script dry-runs with an exported subject map and prints the reconciliation', () => {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../scripts/importLiveLegacy.ts',
    )
    const mapPath = join(dir, 'subjects.json')
    writeFileSync(mapPath, JSON.stringify(NETWORK))
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, '--live', livePath, '--world', worldPath, '--subjects', mapPath],
      { encoding: 'utf8' },
    )
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('DRY RUN')
    expect(run.stdout).toContain('read 30 = imported 11 + held 9 + excluded 10: balanced')
    expect(dumpArchive()).toEqual([])
  })

  it('backs up world.db and verifies the copy with integrity_check', async () => {
    const world = new Database(worldPath)
    const backup = join(dir, 'world-before.db')
    try {
      await backupAndVerify(world, backup, (p) => new Database(p, { readonly: true }))
      expect(existsSync(backup)).toBe(true)
      // A copy that does not verify is refused.
      const bad = join(dir, 'world-bad.db')
      await expect(
        backupAndVerify(world, bad, (p) => {
          const buf = readFileSync(p)
          buf.fill(0x5a, 100, buf.length) // garble every page after the header
          writeFileSync(p, buf)
          return new Database(p, { readonly: true })
        }),
      ).rejects.toThrow()
    } finally {
      world.close()
    }
  })

  it('refuses to read the production Live database', () => {
    const prod = join(dir, 'opt-live')
    mkdirSync(prod)
    const file = join(prod, 'live.db')
    writeFileSync(file, '')
    expect(() => assertSnapshotPath(file, `${prod}/`)).toThrow(/production database/)
    expect(() => assertSnapshotPath(livePath, `${prod}/`)).not.toThrow()
  })
})
