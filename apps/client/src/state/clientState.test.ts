import { expect, it } from 'vitest'
import { ClientState } from './clientState.js'

it('clears old room entities on a second welcome and keeps them on a same-room welcome', () => {
  const state = new ClientState()
  const welcome = (instanceId: string) => ({
    t: 'welcome' as const,
    v: 22,
    contentDigest: 'v2-1234abcd',
    rank: null,
    playerId: 'p',
    entityId: 'self',
    tick: 0,
    tickRate: 30,
    snapshotRate: 15,
    instanceId,
    instanceCount: 2,
  })
  const entity = {
    id: 'prop',
    kind: 'prop' as const,
    def: 'scrap',
    motion: 'static' as const,
    pos: [0, 0, 0] as [number, number, number],
    rot: [0, 0, 0, 1] as [number, number, number, number],
  }
  const removed: string[] = []
  state.events.on('entityRemoved', (id) => removed.push(id))
  state.apply(welcome('scraplandia:0'))
  state.apply({ t: 'spawn', entities: [entity] })
  state.apply(welcome('scraplandia:0'))
  expect(state.entities.has('prop')).toBe(true)
  state.apply(welcome('scraplandia:1'))
  expect(state.entities.size).toBe(0)
  expect(removed).toEqual(['prop'])
  expect(state.instanceId).toBe('scraplandia:1')
})
