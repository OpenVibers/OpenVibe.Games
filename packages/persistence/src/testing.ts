import { PGlite } from '@electric-sql/pglite'
import { createDb, type Db } from 'openvibe-sdk/db'
import { openPgStore, type PgPersistenceStore } from './pg/pgStore.js'
import { MIGRATIONS_DIR } from './migrations.js'

/**
 * Test helpers: one in-memory PGlite database per test process, with the Games migrations applied
 * once, so what the tests exercise is the real PostgreSQL schema and the real openvibe-sdk/db layer.
 * Starting PGlite (WASM) is expensive, so the instance is shared and emptied between tests instead of
 * recreated; each `openTestStore()` sees an empty schema.
 */
export { MIGRATIONS_DIR }

const TABLES = [
  'places',
  'world_meta',
  'world_entities',
  'world_constraints',
  'characters',
  'mods',
  'mod_grants',
  'mod_placements',
  'mod_audit',
  'media_mirrors',
  'identity_adoptions',
  'account_data_events',
  'event_outbox',
  'token_revocations',
].join(', ')

let shared: Db | null = null

async function ensureDb(): Promise<Db> {
  if (!shared) {
    const pg = new PGlite()
    const db = createDb({ pglite: pg, service: 'games-test' })
    await db.migrate({ dir: MIGRATIONS_DIR })
    shared = db
  }
  await shared.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`)
  return shared
}

/** The shared, freshly emptied in-memory database (do not close it). */
export async function openTestDb(): Promise<Db> {
  return ensureDb()
}

/** A store over the shared, freshly emptied database; its `close()` is a no-op (the instance is shared). */
export async function openTestStore(opts: { placeId?: string } = {}): Promise<PgPersistenceStore> {
  const db = await ensureDb()
  const store = openPgStore(db, opts)
  await store.ensurePlace()
  return { ...store, close: async () => {} }
}
