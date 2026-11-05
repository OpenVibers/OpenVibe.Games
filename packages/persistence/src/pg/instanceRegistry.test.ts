import { beforeAll, describe, expect, it } from 'vitest'
import { openTestDb } from '../testing.js'
import { sql, type Db } from 'openvibe-sdk/db'
import {
  HEARTBEAT_STATEMENT_TIMEOUT_MS,
  InstanceRegistry,
  type InstanceLease,
} from './instanceRegistry.js'
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

  it('regains a lease whose TTL lapsed while the database missed heartbeats', async () => {
    const registry = new InstanceRegistry(db, 'arena')
    const claim = await registry.claim(2, 2, 'holder-a', 100, 50)
    if (!claim) throw new Error('claim failed')
    const running = await registry.renew(claim, 110, 50, 'running')
    if (!running) throw new Error('renew failed')

    // The database was unreachable past lease_until (160) and nobody claimed the slot meanwhile:
    // a plain renew is fenced by lease_until, but the same holder and version may take the row back.
    expect(await registry.renew(running, 300, 50)).toBeNull()
    const regained = await registry.heartbeat(running, 300, 50, 'running')
    expect(regained?.regained).toBe(true)
    expect(regained?.lease).toMatchObject({
      id: 'arena:2',
      holder: 'holder-a',
      version: running.version,
      leaseUntil: 350,
    })
    if (!regained) throw new Error('regain failed')
    // The lease guard kept working without a version bump: queued writes can land after the regain.
    await db.tx(async () => registry.assertHeld(regained.lease, 301))
  })

  it('does not regain a lease another holder claimed while the database was unreachable', async () => {
    const registry = new InstanceRegistry(db, 'arena')
    const claim = await registry.claim(3, 2, 'holder-b', 500, 50)
    if (!claim) throw new Error('claim failed')
    const running = await registry.renew(claim, 510, 50, 'running')
    if (!running) throw new Error('renew failed')
    const stolen = await registry.claim(3, 2, 'holder-c', 600, 50)
    expect(stolen).not.toBeNull()

    expect(await registry.heartbeat(running, 601, 50, 'running')).toBeNull()
  })

  it('sets a short statement timeout on the heartbeat transaction', async () => {
    const executed: string[] = []
    const current: InstanceLease = {
      id: 'arena:4',
      placeId: 'arena',
      slot: 4,
      capacity: 2,
      state: 'running',
      holder: 'holder-d',
      version: 7,
      heartbeatAt: 10,
      leaseUntil: 10_000,
    }
    const row = {
      id: current.id,
      place_id: current.placeId,
      slot: current.slot,
      capacity: current.capacity,
      state: 'running',
      holder: current.holder,
      lease_version: current.version,
      heartbeat_at: 20,
      lease_until: 20_000,
    }
    const tx = {
      exec: async (q: { parts: string[] }) => {
        executed.push(q.parts.join('?'))
        return 0
      },
      // The renew matches (`lease_until > now`); the regain fallback is not reached.
      maybe: async (q: { parts: string[] }) =>
        q.parts.join('?').includes('lease_until >') ? row : null,
    }
    const stub = {
      store: 'postgresql',
      tx: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    } as unknown as Db
    const registry = new InstanceRegistry(stub, 'arena')

    const result = await registry.heartbeat(current, 20, 15_000, 'running')
    expect(result?.regained).toBe(false)
    expect(executed).toEqual([`SET LOCAL statement_timeout = ${HEARTBEAT_STATEMENT_TIMEOUT_MS}`])
  })
})
