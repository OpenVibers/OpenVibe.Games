import type { LogicDef } from '@openvibe/content'
import { delayTicks, type OutputSpec } from './io.js'

/**
 * Runtime logic entities: relay forwards inputs, auto fires on map spawn,
 * and timer fires on an interval. All are pure data plus a small state
 * machine — no wall clock, only ticks.
 */

export type LogicClass = 'relay' | 'auto' | 'timer'

export interface LogicEntity {
  id: string
  class: LogicClass
  enabled: boolean
  wait: number
  outputs: OutputSpec[]
  /** Timer only: the tick at which the next OnTimer is due. */
  nextFireTick: number | null
}

export function buildLogicEntity(def: LogicDef): LogicEntity {
  return {
    id: def.id,
    class: def.class,
    enabled: def.class !== 'auto',
    wait: def.wait ?? 0,
    outputs: def.outputs.map((o) => ({ ...o })),
    nextFireTick: null,
  }
}

export function timerIntervalTicks(entity: LogicEntity, tickRate: number): number {
  return Math.max(1, delayTicks(entity.wait, tickRate))
}

/**
 * Fire an input on a logic entity. Returns the outputs it wants scheduled.
 * Timer scheduling lives here so `Enable`/`ResetTimer` and the graph's tick
 * cannot disagree about the next due tick.
 */
export function fireLogicInput(
  entity: LogicEntity,
  input: string,
  nowTick: number,
  tickRate: number,
): OutputSpec[] {
  switch (entity.class) {
    case 'relay': {
      if (input === 'Trigger') {
        if (!entity.enabled) return []
        return entity.outputs
      }
      if (input === 'Enable') {
        entity.enabled = true
        return []
      }
      if (input === 'Disable') {
        entity.enabled = false
        return []
      }
      if (input === 'Toggle') {
        entity.enabled = !entity.enabled
        return []
      }
      return []
    }
    case 'auto': {
      // Auto has no runtime inputs; its OnMapSpawn is seeded by the graph.
      return []
    }
    case 'timer': {
      if (input === 'Enable') {
        entity.enabled = true
        entity.nextFireTick = nowTick + timerIntervalTicks(entity, tickRate)
        return []
      }
      if (input === 'Disable') {
        entity.enabled = false
        entity.nextFireTick = null
        return []
      }
      if (input === 'Toggle') {
        entity.enabled = !entity.enabled
        entity.nextFireTick = entity.enabled
          ? nowTick + timerIntervalTicks(entity, tickRate)
          : null
        return []
      }
      if (input === 'ResetTimer') {
        if (entity.enabled) entity.nextFireTick = nowTick + timerIntervalTicks(entity, tickRate)
        return []
      }
      if (input === 'FireTimer') {
        const outputs = entity.outputs
        if (entity.enabled) entity.nextFireTick = nowTick + timerIntervalTicks(entity, tickRate)
        return outputs
      }
      return []
    }
  }
}
