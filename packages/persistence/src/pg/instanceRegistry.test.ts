import { beforeAll, describe, expect, it } from 'vitest'
import { openTestDb } from '../testing.js'
import { sql, type Db } from 'openvibe-sdk/db'
import { InstanceRegistry } from './instanceRegistry.js'
import { openPgStore } from './pgStore.js'

let db: Db
beforeAll(async () => {
  db = await openTestDb()
  await db.exec(sql`INSERT INTO places (id, name) VALUES ('arena', 'Arena')`)
})

describe('PostgreSQL instance leases', () => {
  it('claims, renews, expires, and fences the old holder', async () => {
    const registry = new InstanceRegistry(db, 'arena')
    const first = await registry.claim(0, 2, 'process-a', 100, 50)
    expect(first).toMatchObject({ id: 'arena:0', state: 'starting', version: 1 })
    if (!first) throw new Error('claim failed')
    expect(await registry.claim(0, 2, 'process-b', 120, 50)).toBeNull()
    const running = await registry.renew(first, 120, 50, 'running')
    expect(running?.state).toBe('running')
    if (!running) throw new Error('renew failed')
    await db.tx(async () => registry.assertHeld(running, 130))
    const second = await registry.claim(0, 2, 'process-b', 171, 50)
    expect(second?.version).toBe(first.version + 1)
    expect(await registry.renew(running, 172, 50)).toBeNull()
    await expect(db.tx(async () => registry.assertHeld(running, 172))).rejects.toThrow('lease lost')
    if (!second) throw new Error('reclaim failed')
    expect(await registry.stop(second)).toBe(true)
    expect(await registry.claim(0, 2, 'process-c', 173, 50)).not.toBeNull()
  })

  it('refuses a world-state write after its lease version is stolen', async () => {
    const registry = new InstanceRegistry(db, 'arena')
    let now = 1000
    const claim = await registry.claim(1, 2, 'writer-a', now, 100)
    if (!claim) throw new Error('claim failed')
    const running = await registry.renew(claim, now + 1, 100, 'running')
    if (!running) throw new Error('renew failed')
    const store = openPgStore(db, {
      placeId: 'arena',
      instanceSlot: 1,
      leaseGuard: () => registry.assertHeld(running, now),
    })
    await store.ensurePlace()
    await store.meta.set('clock', 1)
    now = 1102
    expect(await registry.claim(1, 2, 'writer-b', now, 100)).not.toBeNull()
    await expect(store.meta.set('clock', 2)).rejects.toThrow('lease lost')
    expect(await store.meta.get('clock')).toBe(1)
  })
})
