import type { ClientInput } from '@openvibe/protocol'
import { describe, expect, it } from 'vitest'
import type { PlayerSession } from '../playerSession.js'
import {
  CATCH_UP_PER_TICK,
  MAX_INPUT_CREDIT,
  MAX_INPUT_QUEUE,
  queueInput,
  takeInputs,
} from './movement.js'

/*
 * The client predicts every input it sends and replays the ones not yet acknowledged, so the server must simulate
 * each input once, in order, and never one the client did not send; otherwise walking rubber-bands (owner,
 * 2026-10-19: the queue held 6 and dropped the rest, and an empty queue repeated the last input).
 */
const session = (): PlayerSession =>
  ({ inputQueue: [], inputCredit: 0 }) as unknown as PlayerSession
const input = (seq: number): ClientInput => ({
  t: 'input',
  seq,
  moveX: 0,
  moveZ: 1,
  yawQ: 0,
  pitchQ: 0,
  intents: 0,
})

describe('movement input queue', () => {
  it('simulates a steady client one input a tick', () => {
    const s = session()
    const done: number[] = []
    for (let tick = 1; tick <= 120; tick++) {
      queueInput(s, input(tick))
      done.push(...takeInputs(s).map((i) => i.seq))
    }
    expect(done).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
    expect(s.inputQueue).toHaveLength(0)
  })

  it('catches up after a hitch without dropping or inventing an input', () => {
    const s = session()
    const done: number[] = []
    let seq = 0
    for (let tick = 1; tick <= 30; tick++) {
      if (tick === 20)
        for (let k = 0; k < 11; k++) queueInput(s, input(++seq)) // ten ticks of inputs land at once
      else if (tick < 10 || tick > 20) queueInput(s, input(++seq))
      done.push(...takeInputs(s).map((i) => i.seq))
    }
    expect(done).toEqual(Array.from({ length: seq }, (_, i) => i + 1))
    expect(done.length).toBe(seq)
  })

  it('keeps a burst bigger than the old cap of 6', () => {
    const s = session()
    for (let k = 1; k <= 12; k++) queueInput(s, input(k))
    const done: number[] = []
    for (let tick = 0; tick < 12; tick++) done.push(...takeInputs(s).map((i) => i.seq))
    expect(done).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('gives a client sending faster than real time no extra speed', () => {
    const s = session()
    let simulated = 0
    let seq = 0
    const ticks = 300
    for (let tick = 0; tick < ticks; tick++) {
      queueInput(s, input(++seq))
      queueInput(s, input(++seq))
      const taken = takeInputs(s)
      expect(taken.length).toBeLessThanOrEqual(CATCH_UP_PER_TICK)
      simulated += taken.length
    }
    expect(simulated).toBeLessThanOrEqual(ticks + MAX_INPUT_CREDIT)
    expect(s.inputQueue.length).toBeLessThanOrEqual(MAX_INPUT_QUEUE)
  })
})
