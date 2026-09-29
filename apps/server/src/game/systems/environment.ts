import {
  Buttons,
  activeStatuses,
  ambientTemperature,
  precipitation,
  stepEnvironment,
  tickSurvival,
  type WeatherKind,
} from '@openvibe/gameplay'
import { WATER_LEVEL, terrainHeight } from '@openvibe/content'
import type { ServerContext } from './context.js'
import type { System } from './system.js'
import { nearbyWorkstationKinds } from '../interactions.js'

/** The five weather kinds a persisted env_weather may name. */
const WEATHERS = new Set<WeatherKind>(['clear', 'cloudy', 'rain', 'storm', 'fog'])

export class EnvironmentSystem implements System {
  readonly name = 'environment'

  constructor(private readonly ctx: ServerContext) {}

  /**
   * Async boot: the world clock and weather are read from PostgreSQL.
   * main.ts awaits this before starting the tick loop.
   */
  async load(): Promise<void> {
    const rawTime = await this.ctx.store.meta.get('env_time')
    const savedTime = Number(rawTime ?? Number.NaN)
    if (Number.isFinite(savedTime)) this.ctx.env.timeOfDay = savedTime
    const savedWeather = await this.ctx.store.meta.get('env_weather')
    if (typeof savedWeather === 'string' && WEATHERS.has(savedWeather as WeatherKind)) {
      this.ctx.env.weather = savedWeather as WeatherKind
    }
  }

  tick(ctx: ServerContext, _dt: number): void {
    if (ctx.clock.tick % ctx.config.tickRate !== 0) return
    const weatherBefore = ctx.env.weather
    stepEnvironment(ctx.env, 1, Math.random)
    if (ctx.env.weather !== weatherBefore) {
      ctx.net.broadcastAll(ctx.net.timeWire())
      ctx.log.info('weather changed', { from: weatherBefore, to: ctx.env.weather })
    }
    const ambientC = ambientTemperature(ctx.env)
    const raining = precipitation(ctx.env) > 0
    const nowMs = Date.now()
    // Region activation follows players (coarse, 1 Hz).
    ctx.regions.update(
      [...ctx.sessions.values()].map((s) => ({ x: s.move.pos.x, z: s.move.pos.z })),
    )
    for (const session of ctx.sessions.values()) {
      const sprinting =
        (session.buttons & Buttons.Sprint) !== 0 &&
        Math.hypot(session.move.vel.x, session.move.vel.z) > 1
      // Wet: wading/swimming, or out in the rain (no roof detection yet —
      // "indoors" arrives with the shelter model).
      const inWater =
        terrainHeight(ctx.world.content.world, session.move.pos.x, session.move.pos.z) <
        WATER_LEVEL - 0.03
      // Warmth: standing near a lit burn barrel (workstation scan; the
      // spatial index will replace this walk).
      const nearHeat = nearbyWorkstationKinds(session, ctx.world).has('campfire')
      const before = { ...session.stats }
      const statusesBefore = activeStatuses(session.stats, nowMs).join(',')
      const died = tickSurvival(session.stats, 1, {
        sprinting,
        ambientC,
        wet: inWater || raining,
        nearHeat,
        nowMs,
      })
      if (
        Math.round(before.health) !== Math.round(session.stats.health) ||
        Math.round(before.hunger) !== Math.round(session.stats.hunger) ||
        Math.round(before.thirst) !== Math.round(session.stats.thirst) ||
        Math.round(before.stamina) !== Math.round(session.stats.stamina) ||
        Math.round(before.bodyTemp * 2) !== Math.round(session.stats.bodyTemp * 2) ||
        activeStatuses(session.stats, nowMs).join(',') !== statusesBefore
      ) {
        session.statsDirty = true
      }
      if (died) {
        ctx.log.info('player died of exposure', { playerId: session.playerId })
        ctx.systems.combat.respawn(session, true)
      } else if (session.statsDirty) {
        ctx.net.send(session, { t: 'stats', ...ctx.net.statsWire(session) })
        session.statsDirty = false
        session.dirty = true
      }
      if (session.move.pos.y < -25) {
        ctx.systems.combat.respawn(session, false)
        ctx.log.info('void rescue', { playerId: session.playerId })
      }
    }
    if (ctx.clock.tick % (ctx.config.tickRate * 10) === 0) {
      ctx.net.broadcastAll(ctx.net.timeWire())
    }
  }
}
