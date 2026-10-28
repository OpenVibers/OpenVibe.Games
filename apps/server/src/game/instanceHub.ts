import { encodeServerMessage, type ClientHello, type ClientMessage } from '@openvibe/protocol'
import type { InstanceLease, InstanceRegistry } from '@openvibe/persistence'
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

/** One-process room router. The socket's upgrade identity remains attached across transfers. */
export class InstanceHub {
  private readonly rooms = new Map<number, InstanceRoom>()
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
      for (const room of [...this.rooms.values()]) {
        let renewed: InstanceLease | null = null
        try {
          renewed = await this.registry.renew(room.lease, now, 15_000, 'running')
        } catch (error) {
          this.log.error('instance heartbeat failed', { id: room.lease.id, error: String(error) })
        }
        if (renewed) {
          room.lease = renewed
          continue
        }
        this.log.error('instance lease lost', { id: room.lease.id })
        this.rooms.delete(room.lease.slot)
        this.clocks.delete(room.lease.slot)
        for (const [conn, current] of this.connections) {
          if (current.slot === room.lease.slot) conn.close(1012, 'instance_lease_lost')
        }
        await room.dispose()
      }
    } finally {
      this.heartbeating = false
    }
  }

  async shutdown(): Promise<boolean> {
    this.stopping = true
    for (const room of this.rooms.values()) {
      const draining = await this.registry.renew(room.lease, Date.now(), 15_000, 'draining')
      if (draining) room.lease = draining
    }
    for (const room of this.rooms.values()) room.game.shutdown()
    const drained = await Promise.all([...this.rooms.values()].map((room) => room.game.drain()))
    for (const room of this.rooms.values()) {
      await this.registry.stop(room.lease)
      await room.dispose()
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
      if (!this.rooms.has(slot)) {
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
    this.creating = prior.then(async () => {
      const existing = this.rooms.get(slot)
      if (existing) {
        result = existing
        return
      }
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
        const running = await this.registry.renew(lease, Date.now(), 15_000, 'running')
        if (!running) throw new Error('lease expired during room start')
        room.lease = running
        this.rooms.set(slot, room)
        result = room
      } catch (error) {
        await this.registry.stop(lease)
        throw error
      }
    })
    await this.creating
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
