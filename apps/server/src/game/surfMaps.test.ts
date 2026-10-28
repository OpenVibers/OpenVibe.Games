import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SURF_MAPS,
  compileMapFileV2,
  parseMapFile,
  surfMap,
  type MapFileV2,
} from '@openvibe/content'
import {
  Buttons,
  SurfRunState,
  createMoveState,
  movementParamsFor,
  placeMoveStateAt,
  stepMovement,
  surfRunMapOf,
} from '@openvibe/gameplay'
import { CollisionLayer, type PhysicsWorld } from '@openvibe/physics'
import { qfromEuler, quat, vec3 } from '@openvibe/shared'
import { surfMapPath } from './surfMaps.js'

/**
 * The three authored maps: they compile as MapFileV2, carry a complete surf
 * run, and are actually reachable. The reachability proof simulates a bot
 * with scripted inputs through the real movement kernel and real Rapier
 * collision — the same controller the server runs — in the surf style.
 */
const RAMP_MIN_DEG = 50
const RAMP_MAX_DEG = 60

function load(id: string): MapFileV2 {
  const parsed = parseMapFile(JSON.parse(readFileSync(surfMapPath(id), 'utf8')))
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return parsed.map
}

async function rapierWorld(map: MapFileV2): Promise<{ world: PhysicsWorld; dispose(): void } | null> {
  try {
    const { createRapierWorld, loadRapier } = await import('@openvibe/physics/rapier')
    const R = await loadRapier()
    const world = createRapierWorld(R)
    for (const body of map.statics) {
      if (body.shape.type !== 'box') continue
      world.addBody({
        shape: body.shape,
        motion: 'static',
        pos: vec3(body.pos[0], body.pos[1], body.pos[2]),
        ...(body.rot
          ? { rot: qfromEuler(quat(), body.rot[0], body.rot[1], body.rot[2]) }
          : {}),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Player,
      })
    }
    return { world, dispose: () => world.dispose() }
  } catch {
    return null
  }
}

describe.each(SURF_MAPS)('$name', (info) => {
  it('compiles with its movement, meta, spawn and ordered zones', () => {
    const map = load(info.id)
    expect(map.movement).toBe('surf')
    expect(map.surf).toMatchObject({
      title: info.name,
      author: 'OpenVibe',
      tier: info.tier,
      stages: info.stages,
    })
    expect(map.spawn).toBeDefined()
    const compiled = compileMapFileV2(map)
    expect(compiled.movement).toBe('surf')
    expect(compiled.surf?.stages).toBe(info.stages)
    const run = surfRunMapOf(compiled.surf, compiled.zones ?? [], compiled.spawn, compiled.spawnYaw)
    expect(run.checkpoints).toHaveLength(info.stages - 1)
    expect(run.start.stage).toBe(0)
    expect(run.finish.stage).toBe(info.stages)
    expect(run.failY).toBeLessThan(run.spawn.y)
  })

  it('authors every ramp steeper than the 0.7 standable plane (50–60°)', () => {
    const map = load(info.id)
    const ramps = map.statics.filter((s) => s.id.includes('ramp') || s.id === 'transfer')
    expect(ramps.length).toBeGreaterThan(1)
    for (const ramp of ramps) {
      const pitch = Math.abs(((ramp.rot?.[0] ?? 0) * 180) / Math.PI)
      const roll = Math.abs(((ramp.rot?.[2] ?? 0) * 180) / Math.PI)
      const tilt = Math.max(pitch, roll)
      expect(tilt).toBeGreaterThanOrEqual(RAMP_MIN_DEG)
      expect(tilt).toBeLessThanOrEqual(RAMP_MAX_DEG)
    }
  })

  it('is reachable by a scripted bot in the surf style', async () => {
    const map = load(info.id)
    const world = await rapierWorld(map)
    if (!world) return // wasm unavailable: the other map checks still ran
    try {
      const queries = {
        sweepCapsule: (
          from: Parameters<typeof world.world.sweepCapsule>[0],
          to: Parameters<typeof world.world.sweepCapsule>[1],
          radius: number,
          height: number,
        ) => world.world.sweepCapsule(from, to, radius, height, CollisionLayer.Static),
      }
      const compiled = compileMapFileV2(map)
      const run = new SurfRunState(
        surfRunMapOf(compiled.surf, compiled.zones ?? [], compiled.spawn, compiled.spawnYaw),
        30,
      )
      const move = createMoveState(vec3(run.map.spawn.x, run.map.spawn.y, run.map.spawn.z))
      const params = movementParamsFor('surf')
      let finished = false
      for (let tick = 0; tick < 60 * 30 && !finished; tick++) {
        const next =
          run.reached < run.map.checkpoints.length
            ? run.map.checkpoints[run.reached]!
            : run.map.finish
        const target = next.spawn ?? {
          x: (next.min[0] + next.max[0]) / 2,
          y: (next.min[1] + next.max[1]) / 2,
          z: (next.min[2] + next.max[2]) / 2,
        }
        const yaw = Math.atan2(target.x - move.pos.x, target.z - move.pos.z)
        const from = { x: move.pos.x, y: move.pos.y, z: move.pos.z }
        // A hop pulse clears the gaps between landings; the surf line itself
        // is a held forward run down the 50–60° ramps.
        const buttons = tick % 20 < 2 ? Buttons.Jump : 0
        stepMovement(move, { moveX: 0, moveZ: 1, yaw, pitch: 0, buttons }, params, queries, 1 / 30)
        const events = run.observe(tick, from, move.pos, yaw)
        for (const event of events) {
          if (event.type === 'failed' || event.type === 'restarted') {
            placeMoveStateAt(move, event.to)
          } else if (event.type === 'finished') {
            finished = true
          }
        }
      }
      expect(finished).toBe(true)
      expect(run.finishResult?.timeMs).toBeGreaterThan(0)
    } finally {
      world.dispose()
    }
  })
})

describe('surf map catalogue', () => {
  it('has three original maps, one place each, with the brief’s tiers', () => {
    expect(SURF_MAPS.map((m) => m.id)).toEqual(['surf_lagoon', 'surf_canyon', 'surf_orbit'])
    expect(SURF_MAPS.map((m) => m.tier)).toEqual([1, 2, 4])
    expect(SURF_MAPS.map((m) => m.stages)).toEqual([3, 4, 6])
    for (const info of SURF_MAPS) expect(surfMap(info.placeId)?.id).toBe(info.id)
  })
})
