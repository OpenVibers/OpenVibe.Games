import { openSqliteStore } from '@openvibe/persistence/sqlite'
import type { PlayerDto } from '@openvibe/persistence'
import { createIdentityClient } from 'openvibe-sdk/identity'
import { createMockPlatform } from 'openvibe-sdk/testing'
import { describe, expect, it } from 'vitest'
import { loadPlatformConfig } from '../config.js'
import { migrateLegacyAccounts } from './identityMigration.js'
import { createPlatformClient } from './serviceClient.js'

function char(id: string, token: string, slot = 0): PlayerDto {
  return {
    id,
    token,
    name: id,
    pos: [0, 0, 0],
    yaw: 0,
    inventory: { size: 24, hotbar: 6, slots: [] },
    skills: {},
    friends: [],
    appearance: null,
    charSlot: slot,
    armor: null,
    reputation: {},
    unlocks: [],
    activeJob: null,
    stats: null,
    updatedAt: 1,
  }
}

describe('batch identity migration (games service token -> Network identity)', () => {
  it('adopts every resolvable legacy account, leaves unknown ones, and is idempotent', async () => {
    const platform = createMockPlatform({
      clients: {
        games: {
          secret: 's3cret',
          grants: [{ capability: 'identity.subject.resolve', audience: 'openvibe.network' }],
        },
      },
      users: [
        { id: 57, username: 'ana' },
        { id: 58, username: 'bo' },
      ],
    })
    const [ana, bo] = [...platform.state.users.values()]
    const pc = createPlatformClient(
      { ...loadPlatformConfig({}), clientSecret: 's3cret', networkUrl: platform.origins.network },
      platform.fetch,
    )!
    const identity = createIdentityClient(pc.client)
    const store = openSqliteStore(':memory:')
    store.players.upsertMany([
      char('a0', 'ovn:57', 0),
      char('a1', 'ovn:57', 1),
      char('b0', 'ovn:58', 0),
      char('x0', 'ovn:999', 0),
      char('g0', 'guesttoken1', 0),
    ])

    const dry = await migrateLegacyAccounts(store, identity, { dryRun: true })
    expect(dry).toMatchObject({ scanned: 3, resolved: 2, moved: 3, unresolved: ['ovn:999'] })
    expect(store.players.findById('a0')?.token).toBe('ovn:57')

    const report = await migrateLegacyAccounts(store, identity)
    expect(report).toMatchObject({ scanned: 3, resolved: 2, moved: 3, conflicts: 0 })
    expect(store.players.listByToken(ana!.subject_id).map((p) => p.id)).toEqual(['a0', 'a1'])
    expect(store.players.listByToken(bo!.subject_id).map((p) => p.id)).toEqual(['b0'])
    expect(store.players.findById('x0')?.token).toBe('ovn:999')
    expect(store.players.findById('g0')?.token).toBe('guesttoken1')

    const again = await migrateLegacyAccounts(store, identity)
    expect(again).toMatchObject({ scanned: 1, resolved: 0, moved: 0, unresolved: ['ovn:999'] })
    store.close()
  })

  it('fails loudly without the identity grant (nothing is moved)', async () => {
    const platform = createMockPlatform({ clients: { games: { secret: 's3cret', grants: [] } } })
    const pc = createPlatformClient(
      { ...loadPlatformConfig({}), clientSecret: 's3cret', networkUrl: platform.origins.network },
      platform.fetch,
    )!
    const store = openSqliteStore(':memory:')
    store.players.upsert(char('a0', 'ovn:57'))
    await expect(migrateLegacyAccounts(store, createIdentityClient(pc.client))).rejects.toThrow()
    expect(store.players.findById('a0')?.token).toBe('ovn:57')
    store.close()
  })
})
