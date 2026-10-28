import { describe, expect, it } from 'vitest'
import type { ZoneDef } from '@openvibe/content'
import { delayTicks, OutputQueue } from './io.js'
import {
  buildTriggerZone,
  classifyZone,
  touchTransition,
  TriggerGraph,
} from './trigger.js'

const zone = (over: Record<string, unknown> = {}): ZoneDef =>
  ({
    id: 't1',
    name: 'Trigger',
    min: [-1, 0, -1],
    max: [1, 2, 1],
    rules: { pvp: true, build: true, physgun: true },
    ...over,
  }) as unknown as ZoneDef

const p = (x = 0, y = 1, z = 0): { x: number; y: number; z: number } => ({ x, y, z })

describe('OutputQueue', () => {
  it('orders by due tick, then insertion sequence', () => {
    const q = new OutputQueue()
    q.schedule([{ event: 'a', target: 'x', input: 'Trigger', delay: 2 }], 0, 10)
    q.schedule([{ event: 'b', target: 'x', input: 'Trigger', delay: 1 }], 0, 10)
    q.schedule([{ event: 'c', target: 'x', input: 'Trigger', delay: 1 }], 0, 10)
    expect(delayTicks(2, 10)).toBe(20)
    expect(delayTicks(1, 10)).toBe(10)
    expect(q.due(9)).toEqual([])
    expect(q.due(10).map((e) => e.event)).toEqual(['b', 'c'])
    expect(q.due(20).map((e) => e.event)).toEqual(['a'])
  })
})

describe('classifyZone / buildTriggerZone', () => {
  it('recognises teleport, push, once and multiple volumes', () => {
    expect(classifyZone(zone({ teleport: { to: 'dest' } }))).toBe('trigger_teleport')
    expect(classifyZone(zone({ push: { dir: [0, 1, 0], speed: 100 } }))).toBe('trigger_push')
    expect(classifyZone(zone({ trigger: { once: true, outputs: [] } }))).toBe('trigger_once')
    expect(classifyZone(zone({ trigger: { outputs: [] } }))).toBe('trigger_multiple')
    expect(classifyZone(zone())).toBeNull()
  })

  it('defaults trigger_multiple wait to the Source-like 0.2s', () => {
    const trigger = buildTriggerZone(zone({ trigger: { outputs: [] } }))!
    expect(trigger.trigger!.wait).toBe(0.2)
  })
})

describe('touchTransition', () => {
  it('fires start and end once per crossing, and reports through-crossing starts', () => {
    const trigger = buildTriggerZone(zone({ trigger: { outputs: [] } }))!
    const start = touchTransition(trigger, p(0, 1, -2), p(0, 1, 0), false)
    expect(start.kind).toBe('start')
    expect(start.nowInside).toBe(true)

    const stay = touchTransition(trigger, p(0, 1, 0), p(0.5, 1, 0), true)
    expect(stay.kind).toBe('none')
    expect(stay.nowInside).toBe(true)

    const end = touchTransition(trigger, p(0, 1, 0), p(0, 1, 2), true)
    expect(end.kind).toBe('end')
    expect(end.nowInside).toBe(false)
  })

  it('reports a start for a catch-up segment that passes all the way through', () => {
    const trigger = buildTriggerZone(zone({ trigger: { outputs: [] } }))!
    const through = touchTransition(trigger, p(0, 1, -2), p(0, 1, 2), false)
    expect(through.kind).toBe('start')
  })
})

describe('TriggerGraph', () => {
  it('fires logic_auto OnMapSpawn edges on the first tick', () => {
    const t = zone({ id: 'vol', trigger: { outputs: [] } })
    const graph = new TriggerGraph({
      zones: [t],
      points: [],
      logic: [
        { id: 'auto1', class: 'auto', outputs: [{ event: 'OnMapSpawn', target: 'vol', input: 'Disable' }] },
      ],
      tickRate: 100,
    })
    expect(graph.triggers[0]!.enabled).toBe(true)
    graph.tick(0)
    expect(graph.triggers[0]!.enabled).toBe(false)
  })

  it('makes logic_relay delays tick-deterministic', () => {
    const t = zone({ id: 'vol', trigger: { outputs: [] } })
    const graph = new TriggerGraph({
      zones: [t],
      points: [],
      logic: [
        {
          id: 'relay',
          class: 'relay',
          outputs: [{ event: 'OnTrigger', target: 'vol', input: 'Disable', delay: 0.2 }],
        },
      ],
      tickRate: 100,
    })
    graph.fireInput('relay', 'Trigger', undefined, 0)
    graph.drain(19)
    expect(graph.triggers[0]!.enabled).toBe(true)
    graph.drain(20)
    expect(graph.triggers[0]!.enabled).toBe(false)
  })
})
