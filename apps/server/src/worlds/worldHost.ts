import {
  compileMapFileV2,
  creatorPlaceId,
  creatorWorldOf,
  parseMapFile,
  setMapOverride,
  type MapFileV2,
} from '@openvibe/content'
import type { CreatorWorld, CreatorWorldStore } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { InstanceHub } from '../game/instanceHub.js'
import type { DynamicPlaces } from '../game/placeRouter.js'
import type { GameConnection } from '../game/systems/context.js'

/** Starts a creator world's hub (main.ts builds the room: physics, world, a sandboxed GameServer). */
export type StartWorldHub = (world: CreatorWorld, placeId: string) => Promise<InstanceHub | null>

export interface WorldHostOptions {
  store: CreatorWorldStore
  start: StartWorldHub
  log: Logger
  /** Creator worlds running at once in this process (GAMES_CREATOR_WORLDS_MAX). */
  maxRunning: number
  /** A world with nobody in it stops after this long. */
  idleMs: number
  now?: () => number
}

interface Running {
  hub: InstanceHub
  world: CreatorWorld
  /** The last join or the last time someone was seen inside. */
  activeAt: number
}

/** Who may join a world that is not published: its owner, and staff. */
export function mayJoin(world: CreatorWorld, conn: GameConnection): boolean {
  if (world.status === 'published') return true
  const identity = conn.identity
  if (!identity || !('subject' in identity)) return false
  if (identity.subject === world.ownerSubject) return world.status === 'draft'
  return identity.rank === 'owner' || identity.rank === 'admin'
}

/**
 * The creator worlds running in this process. A world starts when someone joins it (inside the router's admission
 * chain), runs as the place `world:<id>` with its own map override, and stops once it has been empty for `idleMs`.
 * At most `maxRunning` run at once: a join beyond that is refused (the client says the worlds are busy) rather than
 * slowing Scraplandia's tick.
 */
export class CreatorWorldHost implements DynamicPlaces {
  private readonly running = new Map<string, Running>()
  /** Worlds being stopped; a join waits for the stop, then starts the world again. */
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly now: () => number

  constructor(private readonly opts: WorldHostOptions) {
    this.now = opts.now ?? Date.now
  }

  claims(place: string): boolean {
    return creatorWorldOf(place) !== null
  }

  hubs(): Iterable<InstanceHub> {
    return [...this.running.values()].map((r) => r.hub)
  }

  /** Worlds running now, for /api/worlds (players inside each). */
  online(): Map<string, number> {
    return new Map([...this.running].map(([id, r]) => [id, r.hub.onlineCount]))
  }

  async open(place: string, conn: GameConnection): Promise<InstanceHub | null> {
    const id = creatorWorldOf(place)
    if (!id) return null
    await this.stopping.get(id)
    const world = await this.opts.store.get(id)
    if (!world || !mayJoin(world, conn)) return null
    const current = this.running.get(id)
    if (current) {
      current.activeAt = this.now()
      current.world = world
      void this.opts.store.countPlay(id).catch(() => undefined)
      return current.hub
    }
    if (this.running.size >= this.opts.maxRunning) {
      this.opts.log.info('creator world refused: all slots busy', { world: id })
      return null
    }
    const stored = await this.opts.store.map(id)
    const parsed = parseMapFile(stored?.map ?? null)
    if (!parsed.ok) {
      this.opts.log.warn('creator world map unreadable', { world: id })
      return null
    }
    this.applyOverride(id, parsed.map)
    const hub = await this.opts.start(world, creatorPlaceId(id))
    if (!hub) {
      setMapOverride(null, contentWorldId(id))
      return null
    }
    this.running.set(id, { hub, world, activeAt: this.now() })
    void this.opts.store.countPlay(id).catch(() => undefined)
    this.opts.log.info('creator world started', { world: id, running: this.running.size })
    return hub
  }

  /** A saved map reaches a running world at once (the editor's "save applies live"). */
  applyMap(id: string, map: MapFileV2): void {
    const current = this.running.get(id)
    if (!current) return
    this.applyOverride(id, map)
    for (const room of current.hub.activeRooms) {
      room.world.reconcileMapTerrain()
      room.world.reconcileMapStatics()
      room.world.reconcileMapZones()
      room.world.reconcileMapNodes()
      room.world.reconcileMapProps()
      room.game.broadcastMapReload()
    }
  }

  /** The world changed state (unpublished, hidden, deleted): a world nobody may join any more stops now. */
  async changed(world: CreatorWorld | null, id: string): Promise<void> {
    const current = this.running.get(id)
    if (!current) return
    if (world?.status === 'published') {
      current.world = world
      return
    }
    for (const room of current.hub.activeRooms)
      room.game.announce('This world was closed by its owner or by staff.')
    await this.stop(id)
  }

  /**
   * The world's scripts changed: a running world tells its players and stops, so the next join starts it with the new
   * scripts (main.ts drops its cached def set first).
   */
  async scriptsChanged(id: string): Promise<void> {
    const current = this.running.get(id)
    if (!current) return
    for (const room of current.hub.activeRooms)
      room.game.announce("This world's scripts were updated. Join again to play the new version.")
    await this.stop(id)
  }

  /** One pass of the idle sweep (main.ts runs it in the router's admission chain every 30 s). */
  async sweep(): Promise<void> {
    const now = this.now()
    for (const [id, current] of [...this.running]) {
      if (current.hub.onlineCount > 0) {
        current.activeAt = now
        continue
      }
      if (now - current.activeAt >= this.opts.idleMs) await this.stop(id)
    }
  }

  async stop(id: string): Promise<void> {
    const current = this.running.get(id)
    if (!current) return
    this.running.delete(id)
    const done = (async () => {
      try {
        await current.hub.shutdown()
      } catch (err) {
        this.opts.log.warn('creator world stop failed', { world: id, error: String(err) })
      } finally {
        setMapOverride(null, contentWorldId(id))
        this.stopping.delete(id)
        this.opts.log.info('creator world stopped', { world: id, running: this.running.size })
      }
    })()
    this.stopping.set(id, done)
    await done
  }

  async shutdown(): Promise<boolean> {
    const results = await Promise.all(
      [...this.running.values()].map((r) => r.hub.shutdown().catch(() => false)),
    )
    this.running.clear()
    return results.every(Boolean)
  }

  private applyOverride(id: string, map: MapFileV2): void {
    setMapOverride(compileMapFileV2(map), contentWorldId(id))
  }
}

/** The content world id of a creator world (creatorWorldPack's map id). */
export function contentWorldId(worldId: string): string {
  return `creator_${worldId}`
}
