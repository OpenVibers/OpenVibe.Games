/* eslint-disable @typescript-eslint/no-explicit-any */
import { setMapOverride, type MapOverride, type ZoneDef } from '@openvibe/content'
import { createMoveState } from '@openvibe/gameplay'
import { vec3 } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import { SOURCE_UNIT_TO_METRES, TriggersSystem } from './triggers.js'

const world = { id: 'test-triggers', movement: 'default', zones: [] }

function zone(id: string, over: Record<string, unknown> = {}): ZoneDef {
  return {
    id,
    name: id,
    min: [0, 0, 0],
    max: [2, 2, 2],
    rules: { pvp: true, build: true, physgun: true },
    ...over,
  } as unknown as ZoneDef
}

function override(): MapOverride {
  return {
    terrains: [],
    zones: [
      zone('start', {
        min: [0, 0, 0],
        max: [2, 2, 2],
        trigger: {
          wait: 0.2,
          outputs: [
            { event: 'OnStartTouch', target: 'flag', input: 'Disable' },
            { event: 'OnEndTouch', target: 'flag', input: 'Enable' },
          ],
        },
      }),
      zone('flag', { min: [10, 0, 0], max: [12, 2, 2], trigger: { outputs: [] } }),
      zone('tp', {
        min: [20, 0, 0],
        max: [22, 2, 2],
        teleport: { to: 'dest', keepAngles: false },
      }),
      zone('boost', {
        min: [30, 0, 0],
        max: [32, 2, 2],
        push: { dir: [0, 1, 0], speed: 800, onlyFalling: false },
      }),
    ],
    points: [{ id: 'dest', pos: [5, 6, 7], yaw: 1.2, class: 'teleport_destination' }],
    logic: [],
  }
}

function sessionFor() {
  const session = {
    playerId: 'p1',
    entityId: 'e1',
    name: 'Tester',
    yaw: 0,
    pitch: 0,
    move: createMoveState(vec3(0, 1, 0)),
    moveSegments: [] as { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; yaw: number }[],
    triggerTouches: new Map<string, boolean>(),
    triggerStartTicks: new Map<string, number>(),
  }
  return session
}

function ctxFor(session: any, tick: number) {
  return {
    clock: { tick },
    config: { tickRate: 100, placeId: 'test-triggers' },
    world: {
      content: { world },
      bodyOf: () => undefined,
      physics: { setTransform: () => {} },
      entities: { get: () => undefined },
    },
    sessions: { values: () => [session][Symbol.iterator]() },
  }
}

describe('TriggersSystem', () => {
  it('fires OnStartTouch and OnEndTouch exactly once across a crossing', () => {
    setMapOverride(override(), world.id)
    try {
      const session = sessionFor()
      const system = new TriggersSystem(ctxFor(session, 0) as any)
      const flag = (system as any).graph.triggers.find((t: any) => t.id === 'flag')

      session.move.pos = vec3(0, 1, -2)
      session.moveSegments.push({ from: vec3(0, 1, -2), to: vec3(0, 1, 0), yaw: 0 })
      system.tick(ctxFor(session, 0) as any, 0.01)
      expect(flag.enabled).toBe(false)

      session.moveSegments.length = 0
      session.move.pos = vec3(0, 1, 3)
      session.moveSegments.push({ from: vec3(0, 1, 0), to: vec3(0, 1, 3), yaw: 0 })
      system.tick(ctxFor(session, 1) as any, 0.01)
      expect(flag.enabled).toBe(true)
    } finally {
      setMapOverride(null, world.id)
    }
  })

  it('teleports to a destination, zeroing velocity and setting yaw', () => {
    setMapOverride(override(), world.id)
    try {
      const session = sessionFor()
      const system = new TriggersSystem(ctxFor(session, 0) as any)
      session.move.pos = vec3(19, 1, 1)
      session.move.vel.x = 12
      session.move.vel.y = -3
      session.moveSegments.push({ from: vec3(19, 1, 1), to: vec3(21, 1, 1), yaw: 0.4 })
      system.tick(ctxFor(session, 0) as any, 0.01)
      expect(session.move.pos.x).toBeCloseTo(5)
      expect(session.move.pos.y).toBeCloseTo(6)
      expect(session.move.pos.z).toBeCloseTo(7)
      expect(session.move.vel).toEqual(vec3(0, 0, 0))
      expect(session.yaw).toBeCloseTo(1.2)
    } finally {
      setMapOverride(null, world.id)
    }
  })

  it('applies a push velocity of speed × 0.0254 m/s', () => {
    setMapOverride(override(), world.id)
    try {
      const session = sessionFor()
      const system = new TriggersSystem(ctxFor(session, 0) as any)
      session.move.pos = vec3(29, 1, 1)
      session.moveSegments.push({ from: vec3(29, 1, 1), to: vec3(31, 1, 1), yaw: 0 })
      system.tick(ctxFor(session, 0) as any, 0.01)
      expect(session.move.vel.y).toBeCloseTo(800 * SOURCE_UNIT_TO_METRES)
      expect(session.move.vel.x).toBe(0)
      expect(session.move.vel.z).toBe(0)
    } finally {
      setMapOverride(null, world.id)
    }
  })
})
