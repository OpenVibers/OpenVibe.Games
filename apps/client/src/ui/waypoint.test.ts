// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Waypoint, bearing, pickTarget, type NodeSighting } from './waypoint.js'

const node = (def: string, x: number, z: number, remaining = 3): NodeSighting => ({
  def,
  name: def,
  x,
  z,
  remaining,
})
const zones = [{ id: 'forest', name: 'The Forest', min: [-160, -10, -30], max: [-50, 80, 80] }]

describe('pickTarget', () => {
  it('points at the nearest node of the wanted kind that has something left', () => {
    const t = pickTarget(
      { x: 0, z: 0 },
      { nodes: ['oak_tree'], zone: 'forest' },
      [
        node('oak_tree', 30, 0, 0),
        node('oak_tree', -40, 0),
        node('oak_tree', -20, 5),
        node('loose_stones', 2, 0),
      ],
      zones,
    )
    expect(t).toEqual({ label: 'oak_tree', x: -20, z: 5 })
  })

  it('falls back to the landmark zone when no such node is in sight', () => {
    expect(pickTarget({ x: 0, z: 0 }, { nodes: ['oak_tree'], zone: 'forest' }, [], zones)).toEqual({
      label: 'The Forest',
      x: -105,
      z: 25,
    })
    expect(pickTarget({ x: 0, z: 0 }, { nodes: ['oak_tree'] }, [], zones)).toBeNull()
  })

  it('prefers the pile that gives what is still missing, even if another is nearer', () => {
    const t = pickTarget(
      { x: 0, z: 30 },
      { nodes: ['branch_pile', 'loose_stones'], prefer: ['branch_pile'] },
      [node('loose_stones', 6, 34), node('branch_pile', -6, 34)],
      zones,
    )
    expect(t?.label).toBe('branch_pile')
  })
})

describe('bearing', () => {
  it('is 0 straight ahead, a quarter turn clockwise to the right, and wraps', () => {
    expect(bearing({ x: 0, z: 0 }, 0, { x: 0, z: 10 })).toBeCloseTo(0)
    expect(bearing({ x: 0, z: 0 }, 0, { x: 10, z: 0 })).toBeCloseTo(Math.PI / 2)
    expect(bearing({ x: 0, z: 0 }, Math.PI / 2, { x: 10, z: 0 })).toBeCloseTo(0)
    expect(Math.abs(bearing({ x: 0, z: 0 }, 0.1, { x: 0, z: -10 }))).toBeCloseTo(Math.PI - 0.1)
  })
})

describe('Waypoint', () => {
  it('shows the target and its distance, and hides when there is none or you are there', () => {
    document.body.innerHTML = '<div id="ui"></div>'
    const root = document.getElementById('ui')!
    const w = new Waypoint(root)
    const el = root.querySelector('.waypoint') as HTMLElement
    w.update({ x: 0, z: 0 }, 0, { label: 'The Forest', x: -100, z: 0 })
    expect(el.hidden).toBe(false)
    expect(el.textContent).toContain('The Forest · 100 m')
    w.update({ x: -98, z: 0 }, 0, { label: 'The Forest', x: -100, z: 0 })
    expect(el.hidden).toBe(true)
    w.update({ x: 0, z: 0 }, 0, null)
    expect(el.hidden).toBe(true)
  })
})
