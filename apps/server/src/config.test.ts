import { existsSync, readFileSync } from 'node:fs'
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

const REPO_DIR = join(SERVER_DIR, '..', '..')

describe('production client address', () => {
  // Behind nginx every TCP peer is 127.0.0.1: without TRUST_PROXY the per-address limits collapse into one
  // global bucket, and trusting nginx is only safe while nginx overwrites every client-address header.
  it('trusts the local nginx in the unit', () => {
    const unit = readFileSync(join(REPO_DIR, 'deploy/openvibe-games.service'), 'utf8')
    expect(unit).toMatch(/^Environment=HOST=127\.0\.0\.1$/m)
    expect(unit).toMatch(/^Environment=TRUST_PROXY=127\.0\.0\.1$/m)
    expect(loadConfig({ TRUST_PROXY: '127.0.0.1' }).trustProxy).toEqual(['127.0.0.1'])
  })
  it('has nginx overwrite every client-address header it proxies', () => {
    const conf = readFileSync(join(REPO_DIR, 'deploy/nginx-openvibe-games.conf'), 'utf8')
    const proxies = conf.match(/proxy_pass /g) ?? []
    expect(proxies.length).toBeGreaterThan(0)
    for (const header of ['X-Real-IP', 'X-Forwarded-For', 'CF-Connecting-IP']) {
      const set = conf.match(new RegExp(`proxy_set_header ${header} \\$remote_addr;`, 'g')) ?? []
      expect(set.length, header).toBe(proxies.length)
    }
  })
})

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

describe('loadConfig scriptMods', () => {
  it('is off unless the place enables it', () => {
    expect(loadConfig({}).scriptMods).toBe(false)
    expect(loadConfig({ GAMES_SCRIPT_MODS: '0' }).scriptMods).toBe(false)
    expect(loadConfig({ GAMES_SCRIPT_MODS: '1' }).scriptMods).toBe(true)
    expect(loadConfig({ GAMES_SCRIPT_MODS: 'true' }).scriptMods).toBe(true)
  })
})
