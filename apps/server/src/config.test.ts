import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from '@openvibe/persistence'
import { loadConfig } from './config.js'

/**
 * `pnpm dev:server` runs with cwd apps/server, so a cwd-relative migrations default applied 0
 * migrations there and the server died on the first query. The default is the persistence package's
 * absolute directory; GAMES_MIGRATIONS_DIR still overrides it.
 */

/** apps/server (the dev cwd), from this test file's location. */
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const originalCwd = process.cwd()
afterEach(() => process.chdir(originalCwd))

describe('loadConfig migrationsDir', () => {
  it('defaults to the persistence package absolute migrations dir', () => {
    const { migrationsDir } = loadConfig({}).db
    expect(migrationsDir).toBe(MIGRATIONS_DIR)
    expect(isAbsolute(migrationsDir)).toBe(true)
    expect(migrationsDir.endsWith('migrations')).toBe(true)
  })

  it('lets GAMES_MIGRATIONS_DIR win', () => {
    const { migrationsDir } = loadConfig({ GAMES_MIGRATIONS_DIR: '/somewhere/else' }).db
    expect(migrationsDir).toBe('/somewhere/else')
  })

  it('resolves from any cwd, like apps/server as the dev cwd', () => {
    process.chdir(SERVER_DIR)
    const { migrationsDir } = loadConfig({}).db
    expect(migrationsDir).toBe(MIGRATIONS_DIR)
    expect(existsSync(join(migrationsDir, '0001_initial.sql'))).toBe(true)
  })
})
