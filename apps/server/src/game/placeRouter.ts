import type { ClientMessage } from '@openvibe/protocol'
import type { GameConnection } from './systems/context.js'
import type { InstanceHub, InstanceRoom } from './instanceHub.js'

/**
 * Places started on demand (creator worlds, worlds/worldHost.ts). The router asks for a hub inside its admission
 * chain, so starting one is serialized with every other join.
 */
export interface DynamicPlaces {
  /** Whether `place` is one of these (a creator world id), whatever its state. */
  claims(place: string): boolean
  /** The running hub for `place`, started if needed; null refuses the join (unknown, not joinable, or full). */
  open(place: string, conn: GameConnection): Promise<InstanceHub | null>
  /** Every hub running now. */
  hubs(): Iterable<InstanceHub>
  shutdown(): Promise<boolean>
}

/** A single WebSocket endpoint over independent, place-fenced M4 room hubs. */
export class PlaceRouter {
  private readonly connections = new Map<
    GameConnection,
    { hub: InstanceHub | null; key: string | null; admitted: boolean }
  >()
  private readonly closed = new WeakSet<GameConnection>()
  private admission: Promise<void> = Promise.resolve()

  constructor(
    private readonly hubs: ReadonlyMap<string, InstanceHub>,
    private readonly defaultPlace: string,
    private readonly dynamic: DynamicPlaces | null = null,
  ) {
    if (!hubs.has(defaultPlace)) throw new Error(`default place ${defaultPlace} is not hosted`)
  }

  /** Every hub: the built-in places, then the dynamic ones running now. */
  private allHubs(): InstanceHub[] {
    return [...this.hubs.values(), ...(this.dynamic ? this.dynamic.hubs() : [])]
  }

  /** Runs `fn` in the admission chain (after every join already queued, before any queued later). */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.admission.then(fn)
    this.admission = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  resolve(place: string | undefined): string {
    return place && this.hubs.has(place) ? place : this.defaultPlace
  }

  onMessage(conn: GameConnection, msg: ClientMessage): void {
    const active = this.connections.get(conn)
    if (!active) {
      if (msg.t !== 'hello') {
        conn.close(4001, 'hello_first')
        return
      }
      const dynamicPlace =
        msg.place && !this.hubs.has(msg.place) && this.dynamic?.claims(msg.place) ? msg.place : null
      const hub = dynamicPlace ? null : (this.hubs.get(this.resolve(msg.place)) ?? null)
      if (!dynamicPlace && !hub) throw new Error('default hub missing')
      const identity = conn.identity
      const key = identity
        ? `${'subject' in identity ? identity.subject : `guest:${identity.guestKeyHash}`}:${msg.slot}`
        : null
      this.connections.set(conn, { hub, key, admitted: false })
      // A character is shared between places. Finish the old room's save before the new
      // place restores that character, even when two hellos arrive in the same tick.
      this.admission = this.admission
        .then(async () => {
          if (this.closed.has(conn)) return
          if (key) {
            for (const [other, prior] of this.connections) {
              if (other === conn || prior.key !== key || !prior.admitted) continue
              other.close(4004, 'session_superseded')
              this.onDisconnect(other)
              await Promise.all((prior.hub?.activeRooms ?? []).map((room) => room.game.drain(5000)))
            }
          }
          if (this.closed.has(conn)) return
          const current = this.connections.get(conn)
          if (!current) return
          // A creator world starts here, after the superseded session's save above.
          const target =
            current.hub ?? (dynamicPlace ? await this.dynamic?.open(dynamicPlace, conn) : null)
          if (this.closed.has(conn)) return
          if (!target) {
            conn.close(4005, 'world_unavailable')
            this.onDisconnect(conn)
            return
          }
          current.hub = target
          current.admitted = true
          target.onMessage(conn, msg)
          await target.waitForConnection(conn)
        })
        .catch(() => conn.close(1011, 'instance_unavailable'))
      return
    }
    // A creator world's hub is set once it has started; nothing before the welcome needs it.
    active.hub?.onMessage(conn, msg)
  }

  onDisconnect(conn: GameConnection): void {
    this.closed.add(conn)
    this.connections.get(conn)?.hub?.onDisconnect(conn)
    this.connections.delete(conn)
  }

  get activeRooms(): readonly InstanceRoom[] {
    return this.allHubs().flatMap((hub) => hub.activeRooms)
  }

  get onlineCount(): number {
    return this.allHubs().reduce((total, hub) => total + hub.onlineCount, 0)
  }

  step(): void {
    for (const hub of this.allHubs()) hub.step()
  }

  async heartbeat(): Promise<void> {
    await Promise.all(this.allHubs().map((hub) => hub.heartbeat()))
  }

  async shutdown(): Promise<boolean> {
    await this.admission
    const drained = await Promise.all([
      ...[...this.hubs.values()].map((hub) => hub.shutdown()),
      this.dynamic ? this.dynamic.shutdown() : Promise.resolve(true),
    ])
    this.connections.clear()
    return drained.every(Boolean)
  }
}
