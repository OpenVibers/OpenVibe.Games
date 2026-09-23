/**
 * Imports OpenVibe.Live's legacy HoboQuest rows into world.db
 * (`legacy_live_rows`) and reconciles every legacy game and canvas table:
 * read = imported + held + excluded. See docs/legacy-import.md.
 *
 *   # dry run (default): prints the reconciliation, writes nothing
 *   DB_PATH=/opt/openvibe.games/data/world.db \
 *   OV_OAUTH_CLIENT_SECRET=… OV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000 \
 *   node --import tsx apps/server/scripts/importLiveLegacy.ts \
 *     --live /path/to/live-snapshot.db --subjects network
 *
 *   # apply: snapshot world.db to --backup, verify it, then import in one transaction
 *   … importLiveLegacy.ts --live … --subjects network --apply --backup /path/world-before.db
 *
 * Options:
 *   --live <path>       a `.backup` snapshot of Live's live.db (never the production file)
 *   --world <path>      world.db (default DB_PATH, else data/world.db)
 *   --subjects network  resolve Live user ids at the Network identity service
 *                       (games principal, grant identity.subject.resolve)
 *   --subjects <file>   or a JSON object { "<live user id>": "usr_…" } exported from it
 *                       (omitted: Live's own linked_accounts record only; dry run only)
 *   --apply             write; requires --backup and --subjects
 *   --backup <path>     where world.db is copied first (must not exist); verified with integrity_check
 *   --json              print the report as JSON (includes every held row)
 *
 * Exit: 0 reconciled, 1 error, 2 refused (usage), 3 not reconciled.
 * Idempotent: a re-run writes nothing (written = 0) and reports the same counts.
 */
import { existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createIdentityClient } from 'openvibe-sdk/identity'
import { loadConfig } from '../src/config.js'
import {
  applyLegacyImport,
  archivedCounts,
  assertSnapshotPath,
  backupAndVerify,
  formatReport,
  networkSubjectLookup,
  planLegacyImport,
  refusalFor,
  subjectMapLookup,
  type NetworkSubjectLookup,
} from '../src/platform/liveLegacyImport.js'
import { createPlatformClient } from '../src/platform/serviceClient.js'

class Refusal extends Error {}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Refusal(`${name} needs a value`)
  return v
}

function subjectLookup(
  source: string | undefined,
  config: ReturnType<typeof loadConfig>,
): NetworkSubjectLookup | null {
  if (!source) return null
  if (source === 'network') {
    const platform = createPlatformClient(config.platform)
    if (!platform) throw new Refusal('--subjects network needs OV_OAUTH_CLIENT_SECRET')
    return networkSubjectLookup(createIdentityClient(platform.client))
  }
  try {
    return subjectMapLookup(JSON.parse(readFileSync(source, 'utf8')))
  } catch (err) {
    throw new Refusal(`${source}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<number> {
  const config = loadConfig(process.env)
  const livePath = arg('--live')
  const worldPath = arg('--world') ?? config.dbPath
  const subjects = arg('--subjects')
  const backupPath = arg('--backup')
  const apply = process.argv.includes('--apply')
  const json = process.argv.includes('--json')

  const refusal = refusalFor({
    livePath,
    apply,
    backupPath,
    subjects,
    backupExists: backupPath !== undefined && existsSync(backupPath),
  })
  if (refusal || !livePath) throw new Refusal(refusal ?? '--live is required')
  try {
    assertSnapshotPath(livePath)
  } catch (err) {
    throw new Refusal(err instanceof Error ? err.message : String(err))
  }
  if (!existsSync(worldPath)) throw new Refusal(`world database ${worldPath} does not exist`)

  const lookup = subjectLookup(subjects, config)
  const subjectSource = !subjects
    ? "Live's linked_accounts only"
    : subjects === 'network'
      ? 'the Network identity service'
      : `subject map ${subjects}`
  const live = new Database(livePath, { readonly: true, fileMustExist: true })
  try {
    if (!apply) {
      const world = new Database(worldPath, { readonly: true, fileMustExist: true })
      try {
        const plan = await planLegacyImport(live, world, {
          network: lookup,
          subjectSource,
          dryRun: true,
        })
        console.log(json ? JSON.stringify(plan.report, null, 2) : formatReport(plan.report))
        return plan.report.reconciled ? 0 : 3
      } finally {
        world.close()
      }
    }

    // Apply: back up world.db before anything (including the schema upgrade) writes to it.
    const raw = new Database(worldPath, { fileMustExist: true })
    try {
      await backupAndVerify(raw, backupPath as string, (p) => new Database(p, { readonly: true }))
    } finally {
      raw.close()
    }
    console.error(`backup written and verified (integrity_check ok): ${backupPath}`)

    const store = openSqliteStore(worldPath) // upgrades to the schema with legacy_live_rows
    try {
      const plan = await planLegacyImport(live, store.db, {
        network: lookup,
        subjectSource,
        dryRun: false,
      })
      if (!plan.report.reconciled) {
        console.log(json ? JSON.stringify(plan.report, null, 2) : formatReport(plan.report))
        console.error('not reconciled: nothing written')
        return 3
      }
      const written = applyLegacyImport(store.db, plan, Date.now())
      const after = archivedCounts(store.db)
      for (const t of plan.report.tables) {
        if (t.decision === 'import' && (after.get(t.table) ?? 0) < t.imported) {
          throw new Error(`post-apply check: ${t.table} holds fewer rows than imported`)
        }
      }
      console.log(json ? JSON.stringify(plan.report, null, 2) : formatReport(plan.report))
      console.error(`wrote ${written} rows to legacy_live_rows`)
      return 0
    } finally {
      store.close()
    }
  } finally {
    live.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof Refusal) {
      console.error(`refused: ${err.message}`)
      process.exit(2)
    }
    console.error('live legacy import failed:', err)
    process.exit(1)
  },
)
