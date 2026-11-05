import { encodeServerMessage, type ClientHello, type ClientMessage } from '@openvibe/protocol'
import type { InstanceLease, InstanceRegistry, LeaseHeartbeat } from '@openvibe/persistence'
import { FixedTimestep, type Logger } from '@openvibe/shared'
import type { GameConnection } from './systems/context.js'
import type { GameServer } from './gameServer.js'
import type { GameWorld } from './gameWorld.js'

export interface InstanceRoom {
  lease: InstanceLease
  game: GameServer
  world: GameWorld
  dispose(): void | Promise<void>
}

/**
 * The row lease's lifetime. The heartbeat runs every 5 s (main.ts): three missed renewals and another
 * process may claim the slot.
 */
export const LEASE_TTL_MS = 15_000

/**
 * How long a room whose lease was lost to a database error keeps its world and players while it tries
 * to regain the lease before it is stopped. 60 s rides out a connection timeout or a PgBouncer
 * failover (production saw a heartbeat UPDATE wait 8.7 s), and is short enough that a frozen room does
 * not hold a slot, its players and its memory for minutes. A database outage longer than this is
 * better served by the process restarting (the tick watchdog in main.ts).
 */
export const LEASE_RECOVERY_GRACE_MS = 60_000

/**
 * First backoff between regain attempts. Retrying on every 5 s heartbeat would hammer a database that
 * is already timing out; 2 s puts the first retry on the next heartbeat.
 */
const LEASE_REGAIN_INITIAL_BACKOFF_MS = 2_000

/** Regain retries double to this cap: a short outage is caught on the first or second retry. */
const LEASE_REGAIN_MAX_BACKOFF_MS = 30_000

/**
 * After a room is stopped for good its slot is claimed again through the normal start path, even with
 * nobody waiting. The first retry comes one heartbeat later; the backoff then doubles to a minute so a
 * slot another process legitimately owns is only polled cheaply.
 */
const ROOM_RESTART_INITIAL_BACKOFF_MS = 5_000
const ROOM_RESTART_MAX_BACKOFF_MS = 60_000

/** The same experience as a deploy restart: clients reload and reconnect when /healthz answers again. */
const RECONNECT_MESSAGE = '🔄 The world is restarting: you will reconnect in a moment…'

/** A room whose lease could not be confirmed: it is neither simulated nor admitted while it retries. */
interface RecoveringRoom {
  room: InstanceRoom
  /** When the first heartbeat could not confirm the lease. */
  since: number
  attempts: number
  nextAttemptAt: number
}

/** A stopped slot the hub is claiming again through the normal start path. */
interface RestartAttempt {
  attempts: number
  nextAttemptAt: number
  inFlight: boolean
}

/** One-process room router. The socket's upgrade identity remains attached across transfers. */
export class InstanceHub {
  private readonly rooms = new Map<number, InstanceRoom>()
  /** Rooms whose lease is in doubt. They keep their world and players, but not the tick or admissions. */
  private readonly recovering = new Map<number, RecoveringRoom>()
  /** Slots stopped for good that are being claimed again with backoff. */
  private readonly restarts = new Map<number, RestartAttempt>()
  /** One accumulator per room: 100 Hz surf and 30 Hz everything else can share a hub. */
  private readonly clocks = new Map<number, FixedTimestep>()
  private readonly connections = new Map<GameConnection, { slot: number; hello: ClientHello }>()
  private readonly reservations = new Map<number, number>()
  private readonly pending = new Map<GameConnection, Promise<void>>()
  private readonly closed = new WeakSet<GameConnection>()
  private readonly transferring = new WeakSet<GameConnection>()
  private creating: Promise<void> = Promise.resolve()
  private admission: Promise<void> = Promise.resolve()
  private heartbeating = false
  private stopping = false

  constructor(
    private readonly registry: InstanceRegistry,
    primary: InstanceRoom,
    private readonly maxInstances: number,
    private readonly capacity: number,
    private readonly createRoom: (slot: number, lease: InstanceLease) => Promise<InstanceRoom>,
    private readonly log: Logger,
  ) {
    this.rooms.set(primary.lease.slot, primary)
  }

  get onlineCount(): number {
    return this.connections.size
  }
  get activeRooms(): readonly InstanceRoom[] {
    return [...this.rooms.values()]
  }

  onMessage(conn: GameConnection, msg: ClientMessage): void {
    if (this.transferring.has(conn)) return
    const active = this.connections.get(conn)
    if (active && msg.t === 'transfer') this.transferring.add(conn)
    if (active && msg.t !== 'hello' && msg.t !== 'transfer' && !this.pending.has(conn)) {
      this.rooms.get(active.slot)?.game.onMessage(conn, msg)
      return
    }
    const previous = this.pending.get(conn) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        if (this.closed.has(conn)) return
        if (msg.t === 'hello') {
          if (this.connections.has(conn)) return
          const previousAdmission = this.admission
          let releaseAdmission: () => void = () => {}
          this.admission = new Promise<void>((resolve) => {
            releaseAdmission = resolve
          })
          await previousAdmission
          let room: InstanceRoom | null = null
          try {
            const key = this.characterKey(conn, msg.slot)
            if (key) {
              for (const [other, state] of this.connections) {
                if (other === conn || this.characterKey(other, state.hello.slot) !== key) continue
                const former = this.rooms.get(state.slot)
                other.close(4004, 'session_superseded')
                this.onDisconnect(other)
                await former?.game.drain(5000)
              }
            }
            room = await this.choose()
            if (room && !this.closed.has(conn))
              this.connections.set(conn, { slot: room.lease.slot, hello: msg })
          } finally {
            releaseAdmission()
          }
          if (!room || this.closed.has(conn)) {
            // A slot being regained cannot take players: close like a restart so the client retries
            // instead of reading "server full" and giving up on this place.
            if (!this.closed.has(conn) && this.recovering.size > 0) {
              conn.close(1012, 'instance_recovering')
              return
            }
            conn.send(encodeServerMessage({ t: 'reject', reason: 'server_full' }))
            conn.close(4003, 'server_full')
            return
          }
          const joined = await room.game.join(conn, msg)
          if (!joined || this.closed.has(conn)) {
            room.game.onDisconnect(conn)
            this.connections.delete(conn)
          }
          return
        }
        const current = this.connections.get(conn)
        if (!current) {
          conn.close(4001, 'hello_first')
          return
        }
        if (msg.t === 'transfer') {
          await this.transfer(conn, current, msg.instanceId)
          return
        }
        this.rooms.get(current.slot)?.game.onMessage(conn, msg)
      })
      .catch((error: unknown) => {
        this.log.error('instance route failed', { error: String(error) })
        conn.close(1011, 'instance_unavailable')
      })
    this.pending.set(conn, next)
    void next.finally(() => {
      if (this.pending.get(conn) === next) this.pending.delete(conn)
    })
  }

  onDisconnect(conn: GameConnection): void {
    this.closed.add(conn)
    const current = this.connections.get(conn)
    if (current) this.rooms.get(current.slot)?.game.onDisconnect(conn)
    this.connections.delete(conn)
  }

  /** Wait for an in-flight join before another place supersedes this character. */
  async waitForConnection(conn: GameConnection): Promise<void> {
    await this.pending.get(conn)
  }

  /**
   * Advance every room by its own fixed steps. `elapsedSeconds` is the scheduler
   * slice (one 100 Hz slot in main.ts); each room's accumulator turns it into
   * 0–N steps of its configured rate, so a 30 Hz room takes one step roughly
   * every third slice while a 100 Hz surf room takes one every slice.
   *
   * Without an argument this keeps the old test/manual contract: exactly one
   * step per room per call, regardless of its rate.
   *
   * Rooms whose lease is in doubt are not in `rooms`: a place that cannot save must not simulate.
   */
  step(elapsedSeconds?: number): void {
    if (elapsedSeconds === undefined) {
      for (const room of this.rooms.values()) room.game.step()
      return
    }
    for (const room of this.rooms.values()) {
      const rate = room.game.tickRate
      let clock = this.clocks.get(room.lease.slot)
      if (!clock || clock.dt !== 1 / rate) {
        clock = new FixedTimestep(1 / rate)
        this.clocks.set(room.lease.slot, clock)
      }
      const steps = clock.consume(elapsedSeconds)
      for (let i = 0; i < steps; i++) room.game.step()
    }
  }

  async heartbeat(now = Date.now()): Promise<void> {
    if (this.heartbeating || this.stopping) return
    this.heartbeating = true
    try {
      // Every room heartbeats at once: one slow query (bounded by the registry's own statement
      // timeout) must not delay the next room's renewal past its deadline.
      await Promise.all([
        ...[...this.rooms.values()].map((room) => this.renewRoom(room, now)),
        ...[...this.recovering.values()].map((rec) => this.regainRoom(rec, now)),
      ])
      // Starting a room can take seconds (world restore); it must never keep the lease renewals
      // above waiting, so restarts run beside the heartbeat and schedule themselves.
      for (const [slot, attempt] of this.restarts) this.runRestart(slot, attempt, now)
    } finally {
      this.heartbeating = false
    }
  }

  private async renewRoom(room: InstanceRoom, now: number): Promise<void> {
    if (this.stopping) return
    let result: LeaseHeartbeat | null
    try {
      result = await this.registry.heartbeat(room.lease, now, LEASE_TTL_MS, 'running')
    } catch (error) {
      // The lease may still be ours, but nothing may touch the world until that is confirmed.
      this.log.error('instance heartbeat failed', { id: room.lease.id, error: String(error) })
      this.suspend(room, now)
      return
    }
    if (result) {
      room.lease = result.lease
      if (result.regained) this.log.info('instance lease regained', { id: room.lease.id })
      return
    }
    // The row no longer carries this holder and version: another process owns it. Nothing can be
    // regained, so stop at once instead of simulating a place this process cannot save.
    this.log.error('instance lease lost to another holder', { id: room.lease.id })
    await this.stopRoom(room, 'instance_lease_lost')
  }

  /** Stop the tick and admissions, keep the players, and retry the lease with backoff. */
  private suspend(room: InstanceRoom, now: number): void {
    const slot = room.lease.slot
    if (this.recovering.has(slot)) return
    this.rooms.delete(slot)
    this.clocks.delete(slot)
    this.recovering.set(slot, {
      room,
      since: now,
      attempts: 0,
      nextAttemptAt: now + LEASE_REGAIN_INITIAL_BACKOFF_MS,
    })
    this.log.error('instance lease lost', { id: room.lease.id, graceMs: LEASE_RECOVERY_GRACE_MS })
  }

  /** One regain attempt inside the grace; a success puts the room back into the tick. */
  private async regainRoom(rec: RecoveringRoom, now: number): Promise<void> {
    if (this.stopping) return
    const { room } = rec
    const slot = room.lease.slot
    if (now - rec.since >= LEASE_RECOVERY_GRACE_MS) {
      this.recovering.delete(slot)
      this.log.error('instance lease not regained in time: stopping room', {
        id: room.lease.id,
        graceMs: LEASE_RECOVERY_GRACE_MS,
      })
      await this.stopRoom(room, 'instance_lease_lost')
      this.scheduleRestart(slot, now)
      return
    }
    if (now < rec.nextAttemptAt) return
    let result: LeaseHeartbeat | null
    try {
      result = await this.registry.heartbeat(room.lease, now, LEASE_TTL_MS, 'running')
    } catch (error) {
      this.log.error('instance lease regain failed', { id: room.lease.id, error: String(error) })
      this.backoffRegain(rec, now)
      return
    }
    if (!result) {
      // Another holder claimed the row while the database was unreachable: this room cannot return.
      this.recovering.delete(slot)
      this.log.error('instance lease lost to another holder', { id: room.lease.id })
      await this.stopRoom(room, 'instance_lease_lost')
      this.scheduleRestart(slot, now)
      return
    }
    room.lease = result.lease
    this.recovering.delete(slot)
    this.rooms.set(slot, room)
    this.log.info('instance lease regained', {
      id: room.lease.id,
      afterMs: now - rec.since,
      reclaimed: result.regained,
    })
  }

  private backoffRegain(rec: RecoveringRoom, now: number): void {
    rec.attempts++
    rec.nextAttemptAt =
      now +
      Math.min(
        LEASE_REGAIN_INITIAL_BACKOFF_MS * 2 ** (rec.attempts - 1),
        LEASE_REGAIN_MAX_BACKOFF_MS,
      )
  }

  private scheduleRestart(slot: number, now: number): void {
    if (this.stopping) return
    this.restarts.set(slot, {
      attempts: 0,
      nextAttemptAt: now + ROOM_RESTART_INITIAL_BACKOFF_MS,
      inFlight: false,
    })
  }

  private runRestart(slot: number, attempt: RestartAttempt, now: number): void {
    if (this.stopping || attempt.inFlight || now < attempt.nextAttemptAt) return
    if (this.rooms.has(slot) || this.recovering.has(slot)) {
      this.restarts.delete(slot)
      return
    }
    attempt.inFlight = true
    void this.start(slot)
      .then((room) => {
        if (room) {
          this.restarts.delete(slot)
          this.log.info('instance restarted', { id: room.lease.id })
          return
        }
        this.backoffRestart(attempt)
      })
      .catch((error: unknown) => {
        this.log.error('instance restart failed', { slot, error: String(error) })
        this.backoffRestart(attempt)
      })
      .finally(() => {
        attempt.inFlight = false
      })
  }

  /** Back off from the moment the attempt ended: world restore can take seconds. */
  private backoffRestart(attempt: RestartAttempt): void {
    attempt.attempts++
    attempt.nextAttemptAt =
      Date.now() +
      Math.min(
        ROOM_RESTART_INITIAL_BACKOFF_MS * 2 ** (attempt.attempts - 1),
        ROOM_RESTART_MAX_BACKOFF_MS,
      )
  }

  /** Announce the reconnect, close the room's players with 1012 and release its memory. */
  private async stopRoom(room: InstanceRoom, reason: string): Promise<void> {
    const slot = room.lease.slot
    this.rooms.delete(slot)
    this.clocks.delete(slot)
    room.game.announce(RECONNECT_MESSAGE)
    for (const [conn, current] of [...this.connections]) {
      if (current.slot !== slot) continue
      this.connections.delete(conn)
      conn.close(1012, reason)
    }
    try {
      await room.dispose()
    } catch (error) {
      // The room is already gone from every map; a failing dispose must not abort the heartbeat.
      this.log.warn('instance room dispose failed', { id: room.lease.id, error: String(error) })
    }
  }

  async shutdown(): Promise<boolean> {
    this.stopping = true
    const rooms = [...this.rooms.values(), ...[...this.recovering.values()].map((rec) => rec.room)]
    this.recovering.clear()
    this.restarts.clear()
    const draining = new Set<InstanceRoom>()
    for (const room of rooms) {
      try {
        const renewed = await this.registry.renew(room.lease, Date.now(), LEASE_TTL_MS, 'draining')
        if (renewed) {
          room.lease = renewed
          draining.add(room)
        }
      } catch (error) {
        // A database too slow to answer must not make the shutdown throw before the sockets close.
        this.log.warn('instance lease renewal failed during shutdown', {
          id: room.lease.id,
          error: String(error),
        })
      }
    }
    // A room whose lease cannot be renewed is fenced: its writes would be refused, so do not wait
    // through the write-behind retries. It is disposed below like the rest.
    for (const room of draining) room.game.shutdown()
    const drained = await Promise.all([...draining].map((room) => room.game.drain()))
    for (const room of rooms) {
      if (draining.has(room)) {
        try {
          await this.registry.stop(room.lease)
        } catch (error) {
          this.log.warn('instance lease stop failed during shutdown', {
            id: room.lease.id,
            error: String(error),
          })
        }
      }
      try {
        await room.dispose()
      } catch (error) {
        this.log.warn('instance room dispose failed during shutdown', {
          id: room.lease.id,
          error: String(error),
        })
      }
    }
    this.rooms.clear()
    this.clocks.clear()
    return drained.every(Boolean)
  }

  private async choose(): Promise<InstanceRoom | null> {
    for (const room of this.rooms.values()) {
      if (room.lease.state === 'running' && this.occupancy(room.lease.slot) < this.capacity)
        return room
    }
    for (let slot = 0; slot < this.maxInstances; slot++) {
      // A recovering slot still owns its row: claiming it now would fence the room we are trying to save.
      if (!this.rooms.has(slot) && !this.recovering.has(slot)) {
        const room = await this.start(slot)
        if (room) return room
      }
    }
    return null
  }

  private occupancy(slot: number): number {
    let count = this.reservations.get(slot) ?? 0
    for (const current of this.connections.values()) if (current.slot === slot) count++
    return count
  }

  private async start(slot: number): Promise<InstanceRoom | null> {
    let result: InstanceRoom | null = null
    const prior = this.creating
    const run = prior.then(async () => {
      const existing = this.rooms.get(slot)
      if (existing) {
        result = existing
        return
      }
      if (this.recovering.has(slot)) return
      if (this.stopping) return
      const lease = await this.registry.claim(
        slot,
        this.capacity,
        crypto.randomUUID(),
        Date.now(),
        60_000,
      )
      if (!lease) return
      try {
        const room = await this.createRoom(slot, lease)
        if (this.stopping) {
          // Shutdown already snapshotted the rooms: do not leave one running (and leased) behind.
          try {
            await this.registry.stop(lease)
          } catch (stopError) {
            this.log.warn('instance lease stop failed for a room started during shutdown', {
              id: lease.id,
              error: String(stopError),
            })
          }
          await room.dispose()
          return
        }
        const running = await this.registry.renew(lease, Date.now(), LEASE_TTL_MS, 'running')
        if (!running) throw new Error('lease expired during room start')
        room.lease = running
        this.rooms.set(slot, room)
        result = room
      } catch (error) {
        try {
          await this.registry.stop(lease)
        } catch (stopError) {
          this.log.warn('instance lease stop failed after a room start failure', {
            id: lease.id,
            error: String(stopError),
          })
        }
        throw error
      }
    })
    // One failed start must not poison every later one: the restart backoff and the next join both
    // call start again, and the serialization chain has to keep running after this caller's error.
    this.creating = run.then(
      () => undefined,
      () => undefined,
    )
    await run
    return result
  }

  private async transfer(
    conn: GameConnection,
    current: { slot: number; hello: ClientHello },
    id: string,
  ): Promise<void> {
    this.transferring.add(conn)
    try {
      const reject = (
        reason: 'same_instance' | 'unknown_instance' | 'instance_full' | 'unavailable',
      ) =>
        conn.send(
          encodeServerMessage({ t: 'transfer_result', accepted: false, instanceId: id, reason }),
        )
      const match = /^(.+):([0-9]+)$/.exec(id)
      const slot = match && match[1] === this.registry.placeId ? Number(match[2]) : -1
      if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.maxInstances) {
        reject('unknown_instance')
        return
      }
      if (slot === current.slot) {
        reject('same_instance')
        return
      }
      let target = this.rooms.get(slot)
      if (!target) target = (await this.start(slot)) ?? undefined
      if (!target || target.lease.state !== 'running') {
        reject('unavailable')
        return
      }
      if (current.hello.contentDigest !== target.game.contentDigest) {
        // A live definition change requires a fresh client before it can enter a room.
        reject('unavailable')
        return
      }
      if (this.occupancy(slot) >= this.capacity) {
        reject('instance_full')
        return
      }
      this.reservations.set(slot, (this.reservations.get(slot) ?? 0) + 1)
      const source = this.rooms.get(current.slot)
      if (!source) {
        this.reservations.set(slot, (this.reservations.get(slot) ?? 1) - 1)
        reject('unavailable')
        return
      }
      try {
        source.game.checkpoint()
        if (!(await source.game.drain(5000))) {
          reject('unavailable')
          return
        }
        source.game.onDisconnect(conn)
        if (!(await source.game.drain(5000))) {
          await source.game.join(conn, current.hello)
          reject('unavailable')
          return
        }
        const joined = await target.game.join(conn, current.hello)
        if (!joined || this.closed.has(conn)) {
          target.game.onDisconnect(conn)
          await source.game.join(conn, current.hello)
          reject('unavailable')
          return
        }
        this.connections.set(conn, { slot, hello: current.hello })
        conn.send(encodeServerMessage({ t: 'transfer_result', accepted: true, instanceId: id }))
      } finally {
        this.reservations.set(slot, (this.reservations.get(slot) ?? 1) - 1)
      }
    } finally {
      this.transferring.delete(conn)
    }
  }

  private characterKey(conn: GameConnection, slot: number): string | null {
    const identity = conn.identity
    if (!identity) return null
    return `${'subject' in identity ? identity.subject : `guest:${identity.guestKeyHash}`}:${slot}`
  }
}
