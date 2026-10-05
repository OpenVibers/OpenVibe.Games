/**
 * Interest hysteresis (replication tick). A body only ENTERS a client's
 * interest inside `radius`, but an already-known body is retained out to
 * `radius * (1 + INTEREST_HYSTERESIS)` — so a body loitering on the boundary
 * cannot churn spawn/despawn every snapshot.
 *
 * updateInterest touches only world.spatial, world.entities and the session's
 * position/known set, so the world and session here are minimal stand-ins.
 */
import { EntityStore, SpatialHash, type GameEntity } from '@openvibe/gameplay'
import { quat, vec3, type EntityId } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import type { GameWorld } from './gameWorld.js'
import type { PlayerSession } from './playerSession.js'
import { INTEREST_HYSTERESIS, updateInterest } from './replication.js'

const RADIUS = 80
const EXIT = RADIUS * (1 + INTEREST_HYSTERESIS)

function makeWorld(): GameWorld {
  return {
    spatial: new SpatialHash<EntityId>(16),
    entities: new EntityStore(),
  } as unknown as GameWorld
}

function makeSession(): PlayerSession {
  return {
    entityId: 'p1' as EntityId,
    move: { pos: vec3(0, 0, 0) },
    known: new Set<EntityId>(),
  } as unknown as PlayerSession
}

let nextId = 0
/** A static prop at (x, 0); moveTo keeps the spatial hash in step. */
function addBody(world: GameWorld, x: number): { id: EntityId; moveTo: (x: number) => void } {
  const id = `e${++nextId}` as EntityId
  const entity: GameEntity = {
    id,
    kind: 'prop',
    transform: { pos: vec3(x, 0, 0), rot: quat() },
    persistent: false,
    dirty: false,
  }
  world.entities.add(entity)
  world.spatial.insert(id, x, 0)
  return {
    id,
    moveTo: (nx: number) => {
      entity.transform.pos.x = nx
      world.spatial.move(id, nx, 0)
    },
  }
}

describe('interest hysteresis', () => {
  it('enters inside the radius and is retained past it up to the exit radius', () => {
    const world = makeWorld()
    const session = makeSession()
    const body = addBody(world, 0.9 * RADIUS)

    const entering = updateInterest(session, world, RADIUS)
    expect(entering.entered.map((e) => e.id)).toEqual([body.id])
    expect(entering.left).toEqual([])
    expect(session.known.has(body.id)).toBe(true)

    // Inside the hysteresis band: no re-spawn and no despawn.
    body.moveTo(1.05 * RADIUS)
    const retained = updateInterest(session, world, RADIUS)
    expect(retained.entered).toEqual([])
    expect(retained.left).toEqual([])
    expect(session.known.has(body.id)).toBe(true)

    // Exactly at the exit radius is still retained.
    body.moveTo(EXIT)
    const atEdge = updateInterest(session, world, RADIUS)
    expect(atEdge.entered).toEqual([])
    expect(atEdge.left).toEqual([])
    expect(session.known.has(body.id)).toBe(true)
  })

  it('leaves only past the exit radius', () => {
    const world = makeWorld()
    const session = makeSession()
    const body = addBody(world, 0.9 * RADIUS)
    updateInterest(session, world, RADIUS)

    body.moveTo(EXIT + 1)
    const leaving = updateInterest(session, world, RADIUS)
    expect(leaving.entered).toEqual([])
    expect(leaving.left).toEqual([body.id])
    expect(session.known.has(body.id)).toBe(false)
  })

  it('does not spawn/despawn a body oscillating in the band', () => {
    const world = makeWorld()
    const session = makeSession()
    const body = addBody(world, 0.9 * RADIUS)
    const first = updateInterest(session, world, RADIUS)
    expect(first.entered.map((e) => e.id)).toEqual([body.id])

    let spawns = 0
    let despawns = 0
    for (let i = 0; i < 12; i++) {
      // Cross back and forth over the enter radius, never past the exit one.
      body.moveTo(i % 2 === 0 ? 1.02 * RADIUS : 0.98 * RADIUS)
      const diff = updateInterest(session, world, RADIUS)
      spawns += diff.entered.length
      despawns += diff.left.length
    }
    expect(spawns).toBe(0)
    expect(despawns).toBe(0)
    expect(session.known.has(body.id)).toBe(true)
  })

  it('exports the enter radius framing as INTEREST_HYSTERESIS', () => {
    expect(INTEREST_HYSTERESIS).toBeGreaterThan(0)
  })
})
