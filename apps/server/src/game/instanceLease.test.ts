import type { InstanceLease, InstanceRegistry, LeaseHeartbeat } from '@openvibe/persistence'
import { PROTOCOL_VERSION, defaultAppearance, type ClientHello } from '@openvibe/protocol'
import type { LogFields, Logger } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import type { GameServer } from './gameServer.js'
import { InstanceHub, LEASE_RECOVERY_GRACE_MS, type InstanceRoom } from './instanceHub.js'
import type { GameConnection } from './systems/context.js'

function makeLease(overrides: Partial<InstanceLease> = {}): InstanceLease {
  return {
    id: 'lease-test:0',
    placeId: 'lease-test',
    slot: 0,
    capacity: 1,
    state: 'running',
    holder: 'holder-a',
    version: 1,
    heartbeatAt: 0,
    leaseUntil: 15_000,
    ...overrides,
  }
}

/** The registry surface InstanceHub uses; the database behaviour is scripted per test. */
class FakeRegistry {
  readonly heartbeatCalls: number[] = []
  readonly claimCalls: number[] = []
  readonly stopCalls: string[] = []
  error: Error | null = null
  /** 'renew' | 'regain' | 'lost' */
  outcome: 'renew' | 'regain' | 'lost' = 'renew'
  claimError: Error | null = null
  claimResult: InstanceLease | null = null

  async heartbeat(current: InstanceLease, now: number): Promise<LeaseHeartbeat | null> {
    this.heartbeatCalls.push(now)
    if (this.error) throw this.error
    if (this.outcome === 'lost') return null
    return {
      lease: { ...current, heartbeatAt: now, leaseUntil: now + 15_000 },
      regained: this.outcome === 'regain',
    }
  }

  async claim(slot: number): Promise<InstanceLease | null> {
    this.claimCalls.push(slot)
    if (this.claimError) throw this.claimError
    return this.claimResult
  }

  async renew(current: InstanceLease): Promise<InstanceLease | null> {
    return current
  }

  async stop(current: InstanceLease): Promise<boolean> {
    this.stopCalls.push(current.id)
    return true
  }
}

interface RoomProbe {
  room: InstanceRoom
  steps: number
  joins: number
  announced: string[]
  disposed: number
}

function makeRoom(lease: InstanceLease): RoomProbe {
  const probe: RoomProbe = {
    room: null as unknown as InstanceRoom,
    steps: 0,
    joins: 0,
    announced: [],
    disposed: 0,
  }
  const game = {
    tickRate: 30,
    step: () => probe.steps++,
    join: async () => {
      probe.joins++
      return true
    },
    onMessage: () => {},
    onDisconnect: () => {},
    checkpoint: () => {},
    drain: async () => true,
    shutdown: () => {},
    announce: (text: string) => probe.announced.push(text),
    contentDigest: 'digest',
    onlineCount: () => 0,
  }
  probe.room = {
    lease,
    game: game as unknown as GameServer,
    world: {} as InstanceRoom['world'],
    dispose: () => {
      probe.disposed++
    },
  }
  return probe
}

function makeLogger(): {
  log: Logger
  entries: { level: string; msg: string; fields?: LogFields }[]
} {
  const entries: { level: string; msg: string; fields?: LogFields }[] = []
  const log: Logger = {
    debug: (msg, fields) => entries.push({ level: 'debug', msg, ...(fields ? { fields } : {}) }),
    info: (msg, fields) => entries.push({ level: 'info', msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => entries.push({ level: 'error', msg, ...(fields ? { fields } : {}) }),
    child: () => log,
  }
  return { log, entries }
}

function makeConnection(
  hub: InstanceHub,
  closes: { code: number; reason: string }[],
): GameConnection {
  const conn: GameConnection = {
    identity: { guestKeyHash: 'a'.repeat(64) },
    send: () => {},
    close: (code, reason) => {
      closes.push({ code, reason })
      hub.onDisconnect(conn)
    },
  }
  return conn
}

function hello(): ClientHello {
  return {
    t: 'hello',
    v: PROTOCOL_VERSION,
    contentDigest: 'digest',
    slot: 0,
    name: 'guest',
    appearance: defaultAppearance(),
  }
}

function makeHub(registry: FakeRegistry, room: InstanceRoom, log: Logger): InstanceHub {
  return new InstanceHub(
    registry as unknown as InstanceRegistry,
    room,
    1,
    1,
    async () => {
      throw new Error('unexpected room creation')
    },
    log,
  )
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached')
}

describe('instance lease recovery', () => {
  it('stops the tick and admissions while the lease is unconfirmed, then regains it with backoff', async () => {
    const lease = makeLease()
    const registry = new FakeRegistry()
    const probe = makeRoom(lease)
    const { log, entries } = makeLogger()
    const hub = makeHub(registry, probe.room, log)
    const closes: { code: number; reason: string }[] = []
    const conn = makeConnection(hub, closes)

    // One database error: the heartbeat can no longer confirm the lease.
    registry.error = new Error('Query read timeout')
    await hub.heartbeat(1_000)
    expect(hub.activeRooms).toHaveLength(0)
    expect(entries.some((e) => e.msg === 'instance heartbeat failed')).toBe(true)
    expect(entries.some((e) => e.msg === 'instance lease lost')).toBe(true)

    // No simulation while the lease is in doubt.
    hub.step()
    expect(probe.steps).toBe(0)

    // Not accepting players: the client is told to reconnect (1012), not that the server is full.
    hub.onMessage(conn, hello())
    await hub.waitForConnection(conn)
    expect(closes).toEqual([{ code: 1012, reason: 'instance_recovering' }])
    expect(probe.joins).toBe(0)

    // The first regain attempt is scheduled 2 s after the loss; a heartbeat before that does nothing.
    await hub.heartbeat(2_000)
    expect(registry.heartbeatCalls).toEqual([1_000])
    // The database answers again; the row is still this holder's, so the room comes back.
    registry.error = null
    registry.outcome = 'regain'
    await hub.heartbeat(3_100)
    expect(entries.some((e) => e.msg === 'instance lease regained')).toBe(true)
    expect(hub.activeRooms).toHaveLength(1)

    // The tick resumes and the regained room takes players.
    hub.step()
    expect(probe.steps).toBe(1)
    const rejoining = makeConnection(hub, [])
    hub.onMessage(rejoining, hello())
    await hub.waitForConnection(rejoining)
    expect(probe.joins).toBe(1)
  })

  it('stops a room that cannot regain its lease inside the grace and starts it again on the next join', async () => {
    const lease = makeLease()
    const registry = new FakeRegistry()
    const probe = makeRoom(lease)
    const { log, entries } = makeLogger()
    let created = 0
    const fresh = makeRoom(makeLease({ holder: 'holder-b', version: 2, leaseUntil: 30_000 }))
    const hub = new InstanceHub(
      registry as unknown as InstanceRegistry,
      probe.room,
      1,
      1,
      async () => {
        created++
        return fresh.room
      },
      log,
    )
    const closes: { code: number; reason: string }[] = []
    const connected = makeConnection(hub, closes)
    hub.onMessage(connected, hello())
    await hub.waitForConnection(connected)
    expect(probe.joins).toBe(1)

    registry.error = new Error('Connection terminated due to connection timeout')
    await hub.heartbeat(10_000)
    expect(hub.activeRooms).toHaveLength(0)

    // The grace expires: the old room announces a reconnect, closes its players with 1012 and is disposed.
    await hub.heartbeat(10_000 + LEASE_RECOVERY_GRACE_MS)
    expect(
      entries.some((e) => e.msg === 'instance lease not regained in time: stopping room'),
    ).toBe(true)
    expect(closes).toEqual([{ code: 1012, reason: 'instance_lease_lost' }])
    expect(probe.announced[0]).toMatch(/reconnect/i)
    expect(probe.disposed).toBe(1)
    expect(probe.steps).toBe(0)

    // The next join claims the freed slot through the normal start path and serves a fresh room.
    registry.error = null
    registry.claimResult = fresh.room.lease
    const next = makeConnection(hub, [])
    hub.onMessage(next, hello())
    await hub.waitForConnection(next)
    expect(registry.claimCalls).toEqual([0])
    expect(created).toBe(1)
    expect(fresh.joins).toBe(1)
    expect(hub.activeRooms).toHaveLength(1)
  })

  it('claims a stopped slot again through the normal start path even with nobody waiting', async () => {
    const lease = makeLease()
    const registry = new FakeRegistry()
    const probe = makeRoom(lease)
    const { log, entries } = makeLogger()
    const fresh = makeRoom(makeLease({ holder: 'holder-b', version: 2 }))
    const hub = new InstanceHub(
      registry as unknown as InstanceRegistry,
      probe.room,
      1,
      1,
      async () => fresh.room,
      log,
    )

    registry.error = new Error('Query read timeout')
    await hub.heartbeat(0)
    await hub.heartbeat(LEASE_RECOVERY_GRACE_MS)
    expect(probe.disposed).toBe(1)
    expect(hub.activeRooms).toHaveLength(0)

    // The restart backoff (5 s) is part of the normal claim path; once it passes the hub starts the
    // room again with no join and no player waiting.
    registry.error = null
    registry.claimResult = fresh.room.lease
    await hub.heartbeat(LEASE_RECOVERY_GRACE_MS)
    expect(registry.claimCalls).toEqual([])
    await hub.heartbeat(LEASE_RECOVERY_GRACE_MS + 5_001)
    await until(() => hub.activeRooms.length === 1)
    expect(registry.claimCalls).toEqual([0])
    expect(entries.some((e) => e.msg === 'instance restarted')).toBe(true)
  })

  it('keeps the start chain usable after a failed claim', async () => {
    const lease = makeLease()
    const registry = new FakeRegistry()
    registry.outcome = 'lost'
    const probe = makeRoom(lease)
    const { log } = makeLogger()
    const fresh = makeRoom(makeLease({ holder: 'holder-b', version: 2 }))
    const hub = new InstanceHub(
      registry as unknown as InstanceRegistry,
      probe.room,
      1,
      1,
      async () => fresh.room,
      log,
    )
    await hub.heartbeat(1_000)
    expect(hub.activeRooms).toHaveLength(0)

    // The slot's first re-claim fails (the database is still coming back)...
    registry.claimError = new Error('Query read timeout')
    const failed: { code: number; reason: string }[] = []
    hub.onMessage(makeConnection(hub, failed), hello())
    await until(() => failed.length > 0)
    expect(failed[0]?.code).toBe(1011)

    // ...and the next join still starts a room: the failed attempt did not poison the chain.
    registry.claimError = null
    registry.claimResult = fresh.room.lease
    const accepted: { code: number; reason: string }[] = []
    hub.onMessage(makeConnection(hub, accepted), hello())
    await until(() => fresh.joins === 1)
    expect(registry.claimCalls).toHaveLength(2)
    expect(hub.activeRooms).toHaveLength(1)
    expect(accepted).toEqual([])
  })

  it('stops at once when another holder owns the lease (nothing can be regained)', async () => {
    const lease = makeLease()
    const registry = new FakeRegistry()
    registry.outcome = 'lost'
    const probe = makeRoom(lease)
    const { log, entries } = makeLogger()
    const hub = makeHub(registry, probe.room, log)
    const closes: { code: number; reason: string }[] = []
    const conn = makeConnection(hub, closes)
    hub.onMessage(conn, hello())
    await hub.waitForConnection(conn)

    await hub.heartbeat(1_000)
    expect(entries.some((e) => e.msg === 'instance lease lost to another holder')).toBe(true)
    expect(probe.disposed).toBe(1)
    expect(closes).toEqual([{ code: 1012, reason: 'instance_lease_lost' }])
    expect(hub.activeRooms).toHaveLength(0)
    // No revive: the heartbeat is not retried as a regain for a row another holder owns.
    expect(entries.some((e) => e.msg === 'instance lease regained')).toBe(false)
  })
})
