/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { createMoveState, normalizeStats } from '@openvibe/gameplay'
import { vec3 } from '@openvibe/shared'
import { loadSurfOverride } from './surfMaps.js'
import { setMapOverride } from '@openvibe/content'
import { EnvironmentSystem } from './systems/environment.js'
import { MovementSystem } from './systems/movement.js'
import { SurfSystem } from './systems/surf.js'

/**
 * Place-rule proof: in a surf place there is no fall damage, no void rescue,
 * and a join puts the capsule at the start line. These are the three hooks the
 * inventory names as conflicting with a time trial; the tests drive the real
 * systems with a minimal context so a rule cannot regress silently.
 */
function surfWorld() {
  const override = loadSurfOverride('surf_lagoon')
  const world = { id: 'surf_lagoon', movement: 'surf', zones: [], spawnPoint: [0, 2, 0], spawnYaw: 0 }
  setMapOverride(override, world.id)
  return { world, override }
}

function sessionFor(override: ReturnType<typeof loadSurfOverride>) {
  const spawn = override.spawn!
  return {
    playerId: 'p1',
    entityId: 'e1',
    token: 'guest:abc',
    subjectId: null,
    name: 'Tester',
    driving: null,
    lastInput: null,
    starvedTicks: 0,
    inputCredit: 0,
    inputQueue: [],
    lastProcessedSeq: 0,
    move: createMoveState(vec3(spawn[0], spawn[1], spawn[2])),
    yaw: 0,
    pitch: 0,
    buttons: 0,
    bodyStance: 0,
    moveSegments: [],
    surf: null as null | SurfSystem['tick'] extends never ? never : any,
    surfPb: null as number | null,
    surfWr: null as number | null,
    surfPbSplits: [] as number[],
    fallVy: 0,
    stats: normalizeStats(undefined),
    statsDirty: false,
    dirty: false,
  }
}

function ctxFor(session: any, respawns: string[], sent: unknown[]) {
  return {
    clock: { tick: 30 },
    config: { tickRate: 30, snapshotEvery: 2, placeId: 'surf-lagoon', instanceSlot: 0 },
    env: {},
    regions: { update() {} },
    sessions: {
      values: () => [session][Symbol.iterator](),
      all: () => [session],
      bodyOf: () => undefined,
    },
    world: {
      content: { world: { id: 'surf_lagoon', movement: 'surf', zones: [] } },
      physics: { addBody: () => 1, removeBody() {}, setTransform() {}, sweepCapsule: () => null },
      entities: { get: () => undefined },
      spatial: { move() {}, forEachInRadius() {} },
      bodyOf: () => undefined,
    },
    systems: {
      vehicles: { driveVehicle() {} },
      combat: { respawn: (_s: unknown, died: boolean) => respawns.push(died ? 'died' : 'void') },
    },
    net: {
      send: (_s: unknown, msg: unknown) => sent.push(msg),
      broadcastAll() {},
      timeWire: () => ({ t: 'time', frac: 0.3, weather: 'clear' }),
      statsWire: () => ({}),
    },
    integrations: {
      surf: {
        async pbRun() {
          return null
        },
        async pbMs() {
          return null
        },
        async wrMs() {
          return null
        },
        async record() {
          return { pb: true, wr: false, rank: null, pbMs: 1000, wrMs: 1000 }
        },
      },
    },
    log: { info() {}, warn() {} },
  }
}

describe('surf place rules', () => {
  it('does not apply fall damage in a surf place (but does in the default style)', () => {
    const { world } = surfWorld()
    const surfSession = sessionFor(loadSurfOverride('surf_lagoon'))
    surfSession.move.grounded = true
    surfSession.fallVy = -30
    const surfRespawns: string[] = []
    const surf = new MovementSystem(ctxFor(surfSession, surfRespawns, []) as any)
    surf.tick(ctxFor(surfSession, surfRespawns, []) as any, 1 / 30)
    expect(surfRespawns).toEqual([])
    expect(surfSession.fallVy).toBe(0)

    setMapOverride({ terrains: [], movement: 'default' }, world.id)
    const defaultSession = sessionFor(loadSurfOverride('surf_lagoon'))
    defaultSession.move.grounded = true
    defaultSession.fallVy = -300
    const defaultRespawns: string[] = []
    const movement = new MovementSystem(ctxFor(defaultSession, defaultRespawns, []) as any)
    movement.tick(ctxFor(defaultSession, defaultRespawns, []) as any, 1 / 30)
    expect(defaultRespawns).toEqual(['died'])
  })

  it('does not void-rescue a falling surf player, even below y = -25', () => {
    const { world } = surfWorld()
    const session = sessionFor(loadSurfOverride('surf_lagoon'))
    session.move.pos.y = -100
    const respawns: string[] = []
    const ctx = ctxFor(session, respawns, []) as any
    ctx.env = { timeOfDay: 0.3, weather: 'clear' }
    new EnvironmentSystem(ctx).tick(ctx, 1 / 30)
    expect(respawns).toEqual([])
    setMapOverride({ terrains: [], movement: 'default' }, world.id)
    const session2 = sessionFor(loadSurfOverride('surf_lagoon'))
    session2.move.pos.y = -100
    const respawns2: string[] = []
    const ctx2 = ctxFor(session2, respawns2, []) as any
    ctx2.env = { timeOfDay: 0.3, weather: 'clear' }
    new EnvironmentSystem(ctx2).tick(ctx2, 1 / 30)
    expect(respawns2).toContain('void')
  })

  it('spawns a surf join at the start line, never at a saved position', () => {
    const { override } = surfWorld()
    const session = sessionFor(override)
    // Pretend the character was saved half-way through the map.
    session.move.pos = vec3(123, 456, 789)
    const sent: any[] = []
    const surf = new SurfSystem(ctxFor(session, [], sent) as any)
    surf.onJoin(session as any)
    expect(session.surf).not.toBeNull()
    expect(session.move.pos.x).toBeCloseTo(override.spawn![0])
    expect(session.move.pos.y).toBeCloseTo(override.spawn![1])
    expect(session.move.pos.z).toBeCloseTo(override.spawn![2])
    expect(session.move.vel).toEqual(vec3(0, 0, 0))
    const state = sent.find((m) => m.t === 'surf_state')
    expect(state).toMatchObject({ running: false, stage: 0 })
  })
})
