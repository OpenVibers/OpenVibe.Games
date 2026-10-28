import type { LogicDef, PointDef, ZoneDef } from '@openvibe/content'
import { insideBox, segmentAabbEntry, segmentAabbExit } from '../surf/run.js'
import { OutputQueue, outputKey, type OutputSpec } from './io.js'
import {
  buildLogicEntity,
  fireLogicInput,
  timerIntervalTicks,
  type LogicEntity,
} from './logic.js'

/**
 * Runtime trigger entities. These are engine-free: the server feeds them
 * authoritative movement segments, and the same shape can be consumed by a
 * 2D/top-down presentation without a physics body anywhere in the model.
 */

export type TriggerKind =
  | 'trigger_multiple'
  | 'trigger_once'
  | 'trigger_teleport'
  | 'trigger_push'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Aabb {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}

export interface TriggerZoneRuntime {
  id: string
  kind: TriggerKind
  min: [number, number, number]
  max: [number, number, number]
  trigger?: { wait: number; once: boolean; outputs: OutputSpec[] }
  push?: { dir: [number, number, number]; speed: number; onlyFalling: boolean }
  teleport?: { to: string; landmark?: string; keepAngles: boolean }
  enabled: boolean
}

export interface PointEntity {
  id: string
  pos: Vec3
  yaw: number
  class: 'target' | 'teleport_destination' | 'camera'
}

export const DEFAULT_MULTIPLE_WAIT = 0.2

export function classifyZone(zone: ZoneDef): TriggerKind | null {
  if (zone.teleport) return 'trigger_teleport'
  if (zone.push) return 'trigger_push'
  if (zone.trigger) return zone.trigger.once ? 'trigger_once' : 'trigger_multiple'
  return null
}

export function buildTriggerZone(zone: ZoneDef): TriggerZoneRuntime | null {
  const kind = classifyZone(zone)
  if (!kind) return null
  return {
    id: zone.id,
    kind,
    min: [zone.min[0], zone.min[1], zone.min[2]],
    max: [zone.max[0], zone.max[1], zone.max[2]],
    ...(zone.trigger
      ? {
          trigger: {
            wait: zone.trigger.wait ?? (zone.trigger.once ? 0 : DEFAULT_MULTIPLE_WAIT),
            once: zone.trigger.once ?? false,
            outputs: zone.trigger.outputs.map((o) => ({ ...o })),
          },
        }
      : {}),
    ...(zone.push
      ? {
          push: {
            dir: [zone.push.dir[0], zone.push.dir[1], zone.push.dir[2]],
            speed: zone.push.speed,
            onlyFalling: zone.push.onlyFalling ?? false,
          },
        }
      : {}),
    ...(zone.teleport
      ? {
          teleport: {
            to: zone.teleport.to,
            ...(zone.teleport.landmark !== undefined
              ? { landmark: zone.teleport.landmark }
              : {}),
            keepAngles: zone.teleport.keepAngles ?? false,
          },
        }
      : {}),
    enabled: true,
  }
}

export function buildPointEntity(point: PointDef): PointEntity {
  return {
    id: point.id,
    pos: { x: point.pos[0], y: point.pos[1], z: point.pos[2] },
    yaw: point.yaw ?? 0,
    class: point.class,
  }
}

/** Outputs whose `event` matches a touch/trigger event name. */
export function outputsFor(trigger: TriggerZoneRuntime, event: string): OutputSpec[] {
  return (trigger.trigger?.outputs ?? []).filter((o) => o.event === event)
}

export type TouchTransition =
  | { kind: 'start'; frac: number; nowInside: boolean }
  | { kind: 'end'; frac: number; nowInside: boolean }
  | { kind: 'none'; nowInside: boolean }

/**
 * What one movement segment did to one trigger volume. Entry uses the slab
 * test, so a segment that starts outside and ends outside still reports a
 * start if it passed through the box — the catch-up guarantee.
 */
export function touchTransition(
  trigger: TriggerZoneRuntime,
  from: Vec3,
  to: Vec3,
  wasInside: boolean,
): TouchTransition {
  const box: Aabb = { min: trigger.min, max: trigger.max }
  if (wasInside) {
    if (!insideBox(box, to)) {
      const frac = segmentAabbExit(from, to, box) ?? 1
      return { kind: 'end', frac, nowInside: false }
    }
    return { kind: 'none', nowInside: true }
  }
  const entry = segmentAabbEntry(from, to, box)
  if (entry !== null) return { kind: 'start', frac: entry, nowInside: insideBox(box, to) }
  return { kind: 'none', nowInside: insideBox(box, to) }
}

export interface TriggerGraphInput {
  zones: readonly ZoneDef[]
  points: readonly PointDef[]
  logic: readonly LogicDef[]
  tickRate: number
}

const MAX_DRAIN_ITERATIONS = 10_000

/**
 * The whole map's trigger graph: trigger volumes, point entities, logic
 * entities and the one deterministic queue that connects them.
 *
 * `drain` fires every edge due at the current tick, including delay-0 edges
 * scheduled by an earlier edge in the same tick, so a relay chain resolves
 * immediately and deterministically.
 */
export class TriggerGraph {
  readonly triggers: TriggerZoneRuntime[]
  readonly points = new Map<string, PointEntity>()
  private readonly logic = new Map<string, LogicEntity>()
  private readonly queue = new OutputQueue()
  private readonly tickRate: number
  private readonly firedOnce = new Set<string>()
  private started = false

  constructor(input: TriggerGraphInput) {
    this.tickRate = input.tickRate
    this.triggers = input.zones
      .map(buildTriggerZone)
      .filter((t): t is TriggerZoneRuntime => t !== null)
    for (const point of input.points) {
      const p = buildPointEntity(point)
      this.points.set(p.id, p)
    }
    for (const def of input.logic) {
      const l = buildLogicEntity(def)
      this.logic.set(l.id, l)
    }
  }

  /** Seed `logic_auto` OnMapSpawn edges and initial timers, once. */
  begin(nowTick: number): void {
    if (this.started) return
    this.started = true
    for (const l of this.logic.values()) {
      if (l.class !== 'auto') continue
      this.schedule(l.outputs, nowTick)
    }
  }

  /** Fire every edge due at `nowTick`, following delay-0 chains. */
  drain(nowTick: number): void {
    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
      const due = this.queue.due(nowTick)
      if (due.length === 0) return
      for (const edge of due) this.dispatch(edge.target, edge.input, edge.param, nowTick)
    }
  }

  /** One tick: seed auto, fire due timers, then drain. */
  tick(nowTick: number): void {
    this.begin(nowTick)
    for (const l of this.logic.values()) {
      if (l.class !== 'timer' || !l.enabled) continue
      if (l.nextFireTick === null || l.nextFireTick > nowTick) continue
      this.schedule(l.outputs, nowTick)
      l.nextFireTick = nowTick + timerIntervalTicks(l, this.tickRate)
    }
    this.drain(nowTick)
  }

  /** Schedule outputs from a touch event (does not drain; call drain after). */
  fireTouchOutputs(trigger: TriggerZoneRuntime, event: string, nowTick: number): void {
    this.schedule(outputsFor(trigger, event), nowTick)
  }

  /** Send an input to a named entity; schedules whatever it returns. */
  fireInput(target: string, input: string, param: string | undefined, nowTick: number): void {
    this.dispatch(target, input, param, nowTick)
  }

  /** Schedule edges, honouring `once` and dropping unknown targets. */
  private schedule(outputs: readonly OutputSpec[], nowTick: number): void {
    const pending: OutputSpec[] = []
    for (const output of outputs) {
      const key = outputKey(output)
      if (output.once && this.firedOnce.has(key)) continue
      if (output.once) this.firedOnce.add(key)
      pending.push(output)
    }
    this.queue.schedule(pending, nowTick, this.tickRate)
  }

  private dispatch(target: string, input: string, param: string | undefined, nowTick: number): void {
    const logic = this.logic.get(target)
    if (logic) {
      this.schedule(fireLogicInput(logic, input, nowTick, this.tickRate), nowTick)
      return
    }
    const trigger = this.triggers.find((t) => t.id === target)
    if (!trigger) return
    if (input === 'Enable') {
      trigger.enabled = true
      return
    }
    if (input === 'Disable') {
      trigger.enabled = false
      return
    }
    if (input === 'Toggle') {
      trigger.enabled = !trigger.enabled
      return
    }
    if (input === 'Trigger') {
      this.schedule(outputsFor(trigger, 'OnTrigger'), nowTick)
    }
  }
}
