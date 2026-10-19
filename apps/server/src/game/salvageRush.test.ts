import { describe, expect, it } from 'vitest'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import { createContent } from '@openvibe/content'
import { decodeClientMessage } from '@openvibe/protocol'
import { SalvageRushRound } from './salvageRush.js'

const rules = {
  ...SALVAGE_RUSH_PACK.game!,
  roundSeconds: 2,
  intermissionSeconds: 1,
  pickups: [
    [0, 1, 0],
    [8, 1, 0],
  ] as [number, number, number][],
}
const player = (key: string, x: number) => ({ key, name: key, pos: [x, 1, 0] as const })

describe('Salvage Rush server round', () => {
  it('loads its own map without replacing the default Scraplandia map', () => {
    expect(createContent().world.id).toBe('scrap_island')
    expect(createContent([], SALVAGE_RUSH_PACK).world.id).toBe('salvage_rush_arena')
  })
  it('starts, collects from simulated positions, ends and resets', () => {
    const round = new SalvageRushRound(rules, 0)
    expect(round.view().phase).toBe('intermission')
    round.tick(1000, [player('a', 0), player('b', 8)])
    expect(round.view().phase).toBe('active')
    expect(round.view().scores.map((s) => s.score)).toEqual([1, 1])
    expect(round.view().scores.map((s) => s.rank)).toEqual([1, 1])
    const final = round.tick(3000, [player('a', 0)])
    expect(final?.map((s) => s.rank)).toEqual([1, 1])
    expect(round.view().phase).toBe('intermission')
    round.tick(4000, [player('a', 20)])
    expect(round.view().scores[0]?.score).toBe(0)
  })

  it('has no score path from a client intent', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'score', points: 999 }))).toBeNull()
    const round = new SalvageRushRound(rules, 0)
    round.tick(1000, [player('a', 20)])
    round.tick(1500, [player('a', 20)])
    expect(round.view().scores[0]?.score).toBe(0)
  })
})
