import { getMapOverride } from '@openvibe/content'
import { SurfRunState, placeMoveStateAt, surfRunMapOf, type SurfRunResult } from '@openvibe/gameplay'
import { newEntityId, qfromYaw, vec3 } from '@openvibe/shared'
import type { ClientSurfRestart } from '@openvibe/protocol'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

/**
 * Surf (OpenVibe.Surf Ride): the run clock, ordered checkpoints, fail
 * teleports, ghosts and the finish card's data.
 *
 * It is inserted AFTER MovementSystem and BEFORE ReplicationSystem, so it
 * sees this tick's authoritative positions and its `surf_state`/`surf_finish`
 * messages travel in the same tick. Every movement segment MovementSystem
 * simulated is fed to the run state machine, including catch-up inputs; no
 * client time or position is involved.
 */
export class SurfSystem implements System {
  readonly name = 'surf'
  private readonly warned = new Set<string>()

  readonly handlers: HandlerMap = {
    surf_restart: (session, _msg: ClientSurfRestart) => {
      if (!session.surf) return
      const event = session.surf.restart(this.ctx.clock.tick)
      if (event.type === 'restarted') this.teleport(session, event.to, event.yaw)
      this.sendState(session)
    },
  }

  /** True only where the loaded map authored surf metadata; the common place skips this system. */
  private readonly enabled: boolean

  constructor(private readonly ctx: ServerContext) {
    this.enabled = getMapOverride(ctx.world.content.world)?.surf !== undefined
  }

  onJoin(session: PlayerSession): void {
    const map = this.runMap()
    if (!map) return
    session.surf = new SurfRunState(map, this.ctx.config.tickRate)
    session.surfPb = null
    session.surfWr = null
    session.surfPbSplits = []
    this.teleport(session, map.spawn, map.spawnYaw)
    void this.loadRecords(session)
    this.sendState(session)
  }

  tick(ctx: ServerContext, _dt: number): void {
    if (!this.enabled) return
    for (const session of ctx.sessions.values()) {
      const run = session.surf
      if (!run) continue
      for (const segment of session.moveSegments) {
        const events = run.observe(ctx.clock.tick, segment.from, segment.to, segment.yaw)
        for (const event of events) {
          if (event.type === 'failed' || event.type === 'restarted') {
            this.teleport(session, event.to, event.yaw)
            this.sendState(session)
          } else if (event.type === 'checkpoint') {
            this.sendState(session)
          } else if (event.type === 'finished') {
            void this.finish(session, event.result)
          }
        }
      }
      if (ctx.clock.tick % ctx.config.snapshotEvery === 0) this.sendState(session)
    }
  }

  private runMap() {
    const override = getMapOverride(this.ctx.world.content.world)
    if (!override?.surf) return null
    return surfRunMapOf(
      override.surf,
      override.zones ?? [],
      override.spawn ?? [0, 2, 0],
      override.spawnYaw ?? 0,
      this.ctx.world.content.world.id,
    )
  }

  private teleport(session: PlayerSession, to: { x: number; y: number; z: number }, yaw: number): void {
    placeMoveStateAt(session.move, to)
    session.yaw = yaw
    session.surf?.teleport(to)
    const body = this.ctx.world.bodyOf(session.entityId)
    if (body !== undefined)
      this.ctx.world.physics.setTransform(body, vec3(to.x, to.y + 0.15, to.z))
    const entity = this.ctx.world.entities.get(session.entityId)
    if (entity) qfromYaw(entity.transform.rot, yaw)
  }

  private async loadRecords(session: PlayerSession): Promise<void> {
    const records = this.ctx.integrations.surf
    const map = this.runMap()
    if (!records || !map) return
    const key = session.subjectId ?? session.token
    try {
      const [pbRun, wr] = await Promise.all([
        records.pbRun(map.id, key),
        records.wrMs(map.id),
      ])
      session.surfPb = pbRun?.timeMs ?? null
      session.surfPbSplits = pbRun?.splits ?? []
      session.surfWr = wr
      this.sendState(session)
    } catch (err) {
      this.warnOnce('load', `surf records load failed: ${String(err)}`)
    }
  }

  private async finish(session: PlayerSession, result: SurfRunResult): Promise<void> {
    const records = this.ctx.integrations.surf
    let pb = session.surfPb === null || result.timeMs < session.surfPb
    let wr = session.surfWr === null || result.timeMs < session.surfWr
    let rank: number | null = null
    if (records) {
      try {
        const outcome = await records.record({
          id: newEntityId(),
          mapId: result.mapId,
          accountKey: session.subjectId ?? session.token,
          playerName: session.name,
          timeMs: result.timeMs,
          splits: result.splits,
          track: result.track,
          tickRate: this.ctx.config.tickRate,
          startedTick: result.startedTick,
          finishedTick: result.finishedTick,
          startFrac: result.startFrac,
          finishFrac: result.finishFrac,
          fails: result.fails,
          createdAt: Date.now(),
        })
        pb = outcome.pb
        wr = outcome.wr
        rank = outcome.rank
        session.surfPb = outcome.pbMs
        session.surfWr = outcome.wrMs
        if (pb) session.surfPbSplits = result.splits
      } catch (err) {
        // The run is already authoritative; a storage/Play failure must not
        // turn a finish into an error. Keep the local PB comparison.
        this.warnOnce('record', `surf run record failed: ${String(err)}`)
        if (pb) {
          session.surfPb = result.timeMs
          session.surfPbSplits = result.splits
        }
        if (wr) session.surfWr = result.timeMs
      }
    } else {
      if (pb) {
        session.surfPb = result.timeMs
        session.surfPbSplits = result.splits
      }
      if (wr) session.surfWr = result.timeMs
    }
    this.ctx.net.send(session, {
      t: 'surf_finish',
      timeMs: result.timeMs,
      splits: result.splits,
      pb,
      wr,
      rank,
      pbMs: session.surfPb,
      wrMs: session.surfWr,
    })
    this.sendState(session)
    this.ctx.log.info('surf run finished', {
      playerId: session.playerId,
      map: result.mapId,
      timeMs: result.timeMs,
      pb,
      wr,
      fails: result.fails,
    })
    session.dirty = true
  }

  private sendState(session: PlayerSession): void {
    const run = session.surf
    if (!run) return
    this.ctx.net.send(session, {
      t: 'surf_state',
      running: run.status === 'running',
      elapsedMs: run.elapsedMs,
      stage: run.reached,
      stages: run.map.stages,
      splits: run.splitTimes,
      pbMs: session.surfPb,
      wrMs: session.surfWr,
      ...(session.surfPbSplits.length ? { pbSplits: session.surfPbSplits } : {}),
    })
  }

  private warnOnce(tag: string, message: string): void {
    if (this.warned.has(tag)) return
    this.warned.add(tag)
    this.ctx.log.warn(message)
  }
}
