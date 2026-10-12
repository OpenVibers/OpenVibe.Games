import type { ClientMessage } from '@openvibe/protocol'
import type { GameConnection } from './systems/context.js'
import type { InstanceHub, InstanceRoom } from './instanceHub.js'

/** A single WebSocket endpoint over independent, place-fenced M4 room hubs. */
export class PlaceRouter {
  private readonly connections = new Map<
    GameConnection,
    { hub: InstanceHub; key: string | null; admitted: boolean }
  >()
  private readonly closed = new WeakSet<GameConnection>()
  private admission: Promise<void> = Promise.resolve()

  constructor(
    private readonly hubs: ReadonlyMap<string, InstanceHub>,
    private readonly defaultPlace: string,
  ) {
    if (!hubs.has(defaultPlace)) throw new Error(`default place ${defaultPlace} is not hosted`)
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
      const hub = this.hubs.get(this.resolve(msg.place))
      if (!hub) throw new Error('default hub missing')
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
              await Promise.all(prior.hub.activeRooms.map((room) => room.game.drain(5000)))
            }
          }
          if (!this.closed.has(conn)) {
            const current = this.connections.get(conn)
            if (current) current.admitted = true
            hub.onMessage(conn, msg)
            await hub.waitForConnection(conn)
          }
        })
        .catch(() => conn.close(1011, 'instance_unavailable'))
      return
    }
    active.hub.onMessage(conn, msg)
  }

  onDisconnect(conn: GameConnection): void {
    this.closed.add(conn)
    this.connections.get(conn)?.hub.onDisconnect(conn)
    this.connections.delete(conn)
  }

  get activeRooms(): readonly InstanceRoom[] {
    return [...this.hubs.values()].flatMap((hub) => hub.activeRooms)
  }

  get onlineCount(): number {
    return [...this.hubs.values()].reduce((total, hub) => total + hub.onlineCount, 0)
  }

  step(): void {
    for (const hub of this.hubs.values()) hub.step()
  }

  async heartbeat(): Promise<void> {
    await Promise.all([...this.hubs.values()].map((hub) => hub.heartbeat()))
  }

  async shutdown(): Promise<boolean> {
    await this.admission
    const drained = await Promise.all([...this.hubs.values()].map((hub) => hub.shutdown()))
    this.connections.clear()
    return drained.every(Boolean)
  }
}
