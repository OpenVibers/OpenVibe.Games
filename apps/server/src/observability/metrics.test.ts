import { describe, expect, it } from 'vitest'
import { ServerMetrics, type RoomGauges } from './metrics.js'

const gauges = (over: Partial<RoomGauges> = {}): RoomGauges => ({
  entities: 0,
  constraints: 0,
  constraintIslands: 0,
  activeRegions: 0,
  occupiedRegions: 0,
  npcsFull: 0,
  npcsAbstract: 0,
  mapStatics: 0,
  mapTerrains: 0,
  mapZones: 0,
  mapRebuilds: 0,
  ...over,
})

describe('ServerMetrics room gauges', () => {
  it('sums every room instead of letting the last room to tick win', () => {
    const m = new ServerMetrics()
    // Scraplandia's room holds the saved static; Salvage Rush's room (same process) has none and ticks after it.
    m.sampleRoom('scraplandia:0', gauges({ mapStatics: 1, entities: 4 }), 1_000)
    m.sampleRoom('salvage-rush:0', gauges({ mapStatics: 0, entities: 2 }), 1_010)
    expect(m.mapStatics).toBe(1)
    expect(m.entities).toBe(6)
    expect(m.snapshot()['rooms']).toBe(2)
    // A room's next sample replaces its own, never another room's.
    m.sampleRoom('scraplandia:0', gauges({ mapStatics: 2, entities: 4 }), 1_050)
    expect(m.mapStatics).toBe(2)
    expect(m.snapshot()['mapStatics']).toBe(2)
  })

  it('drops a room that stopped ticking', () => {
    const m = new ServerMetrics()
    m.sampleRoom('scraplandia:1', gauges({ mapZones: 3 }), 0)
    m.sampleRoom('scraplandia:0', gauges({ mapZones: 1 }), 10_000)
    expect(m.mapZones).toBe(1)
    expect(m.roomCount).toBe(1)
  })
})
