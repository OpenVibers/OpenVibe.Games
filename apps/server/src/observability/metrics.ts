import type { Logger } from '@openvibe/shared'

/** One room's world gauges, sampled by its tick loop (GameServer). */
export interface RoomGauges {
  entities: number
  constraints: number
  constraintIslands: number
  activeRegions: number
  occupiedRegions: number
  npcsFull: number
  npcsAbstract: number
  mapStatics: number
  mapTerrains: number
  mapZones: number
  mapRebuilds: number
}
const ROOM_GAUGES: readonly (keyof RoomGauges)[] = [
  'entities', 'constraints', 'constraintIslands', 'activeRegions', 'occupiedRegions',
  'npcsFull', 'npcsAbstract', 'mapStatics', 'mapTerrains', 'mapZones', 'mapRebuilds',
]
/** A room that has not ticked for this long (its lease was lost, it was disposed) no longer counts. */
const ROOM_STALE_MS = 5_000

/**
 * Development observability: cheap counters sampled by the tick loop,
 * exposed as JSON on /metrics and summarized to the structured log
 * periodically. A real metrics backend can consume the same object later.
 *
 * One process hosts several places and rooms, all sharing this object. The world gauges (entities, regions, NPCs,
 * map layers, …) are each room's own: every room reports them through sampleRoom() and the fields hold the sum over
 * the rooms that ticked recently. (They used to be plain fields each room overwrote, so the last room to tick won:
 * Salvage Rush's empty map hid every static saved to Scraplandia's.)
 */
export class ServerMetrics {
  tick = 0
  /** When the last simulation tick completed (epoch ms; 0 = none yet). /api/ready reads it. */
  lastTickAt = 0
  tickDurationMs = 0
  physicsMs = 0
  sessions = 0
  entities = 0
  awakeBodies = 0
  settledBodies = 0
  bytesOut = 0
  messagesOut = 0
  snapshotBytes = 0
  /** Write-behind flusher: jobs queued or running, rows written, duration and failure counters. */
  dbDirtyQueue = 0
  persistRowsWritten = 0
  persistFlushMs = 0
  persistFlushFailures = 0
  persistCoalesced = 0
  /** Live constraints and the multi-prop structures they form. */
  constraints = 0
  constraintIslands = 0
  /** Coarse world regions: active = player ±1 ring; occupied = has players. */
  activeRegions = 0
  occupiedRegions = 0
  /** NPC simulation LOD population. */
  npcsFull = 0
  npcsAbstract = 0
  /**
   * Live map layers, by stable id. These make "Save is live" checkable from
   * outside the process: a static added in the editor must show up here on
   * the next tick, and an identical repeated save must not change the count.
   */
  mapStatics = 0
  mapTerrains = 0
  mapZones = 0
  /** Cumulative map-layer body rebuilds; identical saves must not move it. */
  mapRebuilds = 0
  /** games-quickjs@1 script mods: running, disabled for this instance, and failed calls (all reasons). */
  scriptModsRunning = 0
  scriptModsDisabled = 0
  scriptModFailures = 0

  private emaAlpha = 0.05
  private readonly rooms = new Map<string, { at: number; gauges: RoomGauges }>()

  /** One room's world gauges this tick (`room` is "<place>:<slot>"); the gauge fields become the sum over rooms. */
  sampleRoom(room: string, gauges: RoomGauges, now = Date.now()): void {
    this.rooms.set(room, { at: now, gauges })
    const totals = Object.fromEntries(ROOM_GAUGES.map((k) => [k, 0])) as Record<keyof RoomGauges, number>
    for (const [key, r] of this.rooms) {
      if (now - r.at > ROOM_STALE_MS) {
        this.rooms.delete(key)
        continue
      }
      for (const k of ROOM_GAUGES) totals[k] += r.gauges[k]
    }
    for (const k of ROOM_GAUGES) this[k] = totals[k]
  }

  /** How many rooms reported recently. */
  get roomCount(): number {
    return this.rooms.size
  }

  recordTick(totalMs: number, physicsMs: number): void {
    this.tickDurationMs += (totalMs - this.tickDurationMs) * this.emaAlpha
    this.physicsMs += (physicsMs - this.physicsMs) * this.emaAlpha
  }

  snapshot(): Record<string, number> {
    return {
      tick: this.tick,
      tickDurationMs: round2(this.tickDurationMs),
      physicsMs: round2(this.physicsMs),
      sessions: this.sessions,
      entities: this.entities,
      awakeBodies: this.awakeBodies,
      settledBodies: this.settledBodies,
      bytesOut: this.bytesOut,
      messagesOut: this.messagesOut,
      snapshotBytes: this.snapshotBytes,
      dbDirtyQueue: this.dbDirtyQueue,
      persistRowsWritten: this.persistRowsWritten,
      persistFlushMs: round2(this.persistFlushMs),
      persistFlushFailures: this.persistFlushFailures,
      persistCoalesced: this.persistCoalesced,
      constraints: this.constraints,
      constraintIslands: this.constraintIslands,
      activeRegions: this.activeRegions,
      occupiedRegions: this.occupiedRegions,
      npcsFull: this.npcsFull,
      npcsAbstract: this.npcsAbstract,
      mapStatics: this.mapStatics,
      mapTerrains: this.mapTerrains,
      mapZones: this.mapZones,
      mapRebuilds: this.mapRebuilds,
      scriptModsRunning: this.scriptModsRunning,
      scriptModsDisabled: this.scriptModsDisabled,
      scriptModFailures: this.scriptModFailures,
      rooms: this.rooms.size,
      memRssMb: round2(process.memoryUsage.rss() / 1024 / 1024),
    }
  }

  logSummary(log: Logger): void {
    log.info('metrics', this.snapshot())
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
