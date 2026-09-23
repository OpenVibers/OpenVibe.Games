/**
 * Adopts every account still keyed by `ovn:<network user id>` into its
 * canonical openvibe.network subject (ADR-0006). Sign-in does this for each
 * account on its own; this covers the ones that have not signed in since.
 *
 *   DB_PATH=/opt/openvibe.games/data/world.db \
 *   OV_OAUTH_CLIENT_SECRET=… OV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000 \
 *   node --import tsx apps/server/scripts/migrateIdentity.ts [--dry-run]
 *
 * Needs the grant [games, identity.subject.resolve, openvibe.network].
 * Idempotent; safe to run while the game server is up (SQLite WAL).
 */
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createIdentityClient } from 'openvibe-sdk/identity'
import { loadConfig } from '../src/config.js'
import { migrateLegacyAccounts } from '../src/platform/identityMigration.js'
import { createPlatformClient } from '../src/platform/serviceClient.js'

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const platform = createPlatformClient(config.platform)
  if (!platform) {
    console.error('OV_OAUTH_CLIENT_SECRET is not set: cannot call the Network identity service')
    process.exit(2)
  }
  const store = openSqliteStore(config.dbPath)
  try {
    const report = await migrateLegacyAccounts(store, createIdentityClient(platform.client), {
      dryRun: process.argv.includes('--dry-run'),
    })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    store.close()
  }
}

main().catch((err: unknown) => {
  console.error('identity migration failed:', err)
  process.exit(1)
})
