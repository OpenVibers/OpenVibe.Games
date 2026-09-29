import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDb, type Db } from 'openvibe-sdk/db'
import type { Logger } from '@openvibe/shared'
import type { DbConfig } from './config.js'

/**
 * The serving handle (ADR-0007 decision 5, ADR-035): DATABASE_URL through PgBouncer, or an embedded
 * PGlite database under DATABASE_DIR in development. Migrations run first, as the owner
 * (DATABASE_DIRECT_URL) against real PostgreSQL, or on the embedded handle.
 */
export async function openDb(config: DbConfig, log: Logger): Promise<Db> {
  const sdkLog = {
    warn: (m: string) => log.warn(m),
    error: (m: string) => log.error(m),
    log: (m: string) => log.info(m),
  }
  if (!config.url) {
    if (config.isProduction) {
      throw new Error('DATABASE_URL is not set: production serves from PostgreSQL')
    }
    const dir = join(config.dataDir, 'pglite')
    log.warn('DATABASE_URL unset: embedded PGlite database (development only, one process)', {
      dir,
    })
    mkdirSync(dir, { recursive: true })
    const db = createDb({ pglite: dir, service: 'games', log: sdkLog })
    await db.migrate({ dir: config.migrationsDir, log: sdkLog })
    return db
  }
  if (!config.directUrl) {
    throw new Error(
      'DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection',
    )
  }
  const owner = createDb({ url: config.directUrl, service: 'games-migrate', max: 1, log: sdkLog })
  try {
    await owner.migrate({ dir: config.migrationsDir, log: sdkLog })
  } finally {
    await owner.close()
  }
  return createDb({ url: config.url, service: 'games', log: sdkLog })
}
