import { describe, expect, it } from 'vitest'
import { createRng } from '@openvibe/shared'
import {
  apply,
  BASE_STARS,
  DEFAULT_POWER,
  drawOdds,
  energyNow,
  enemyStats,
  featuredFor,
  heroDef,
  heroStats,
  idlePending,
  newPlayer,
  notices,
  packDigest,
  parseAction,
  productReward,
  questProgress,
  Refusal,
  simulate,
  validatePack,
  vibeHeroes as pack,
  type Action,
  type Outcome,
  type PlayerState,
  type UnitSpec,
} from './index.js'

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0) // a Wednesday
const MIN = 60_000

function play(state: PlayerState, action: Action, now = T0, seed = 1): Outcome {
  return apply(pack, state, action, now, createRng(seed))
}

function refused(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof Refusal) return err.code
    throw err
  }
  throw new Error('expected a refusal')
}

/** The ledger lines of an outcome add up to the change in each wallet currency. */
function ledgerMatches(before: PlayerState, out: Outcome): void {
  for (const c of ['gold', 'gems', 'gemsPaid', 'sigils'] as const) {
    const sum = out.deltas.filter((d) => d.asset === c).reduce((a, d) => a + d.delta, 0)
    expect(out.state.wallet[c] - before.wallet[c]).toBe(sum)
  }
}

describe('Vibe Heroes pack', () => {
  it('is valid: 20 heroes, 100 stages, odds adding up to one', () => {
    expect(validatePack(pack)).toEqual([])
    expect(pack.heroes).toHaveLength(20)
    expect(pack.stages).toHaveLength(100)
    const total = drawOdds(pack, T0).reduce((a, o) => a + o.chance, 0)
    expect(total).toBeCloseTo(1, 9)
  })

  it('has a stable digest that changes with the rules', () => {
    expect(packDigest(pack)).toMatch(/^[0-9a-f]{8}$/)
    expect(packDigest({ ...pack, teamSize: 4 })).not.toBe(packDigest(pack))
  })

  it('never sells sigils: summons are earned only', () => {
    for (const p of pack.store) {
      expect(p.reward.sigils ?? 0).toBe(0)
    }
  })
})

describe('a new player', () => {
  it('starts with the pack’s heroes in the team, its wallet and full energy', () => {
    const { state, deltas } = newPlayer(pack, T0)
    expect(state.team).toEqual(['gus', 'tess', 'milo', 'rook'])
    expect(state.wallet).toEqual({ gold: 5000, gems: 100, gemsPaid: 0, sigils: 10 })
    expect(energyNow(pack, state, T0)).toBe(pack.energy.max)
    expect(deltas.filter((d) => d.asset.startsWith('hero:'))).toHaveLength(4)
  })
})

describe('battles', () => {
  it('clears stage 1 for free and pays the first-clear reward once', () => {
    const start = newPlayer(pack, T0).state
    const out = play(start, { t: 'battle', stage: 1 })
    expect(out.result.won).toBe(true)
    expect(out.state.stage.cleared).toBe(1)
    expect(out.result.energy).toBe(0)
    expect(out.state.wallet.gold).toBe(5000 + 350)
    ledgerMatches(start, out)
    // The same stage again is a repeat: it costs energy and pays the repeat reward.
    const again = play(out.state, { t: 'battle', stage: 1 }, T0 + 1000)
    expect(again.result.first).toBe(false)
    expect(energyNow(pack, again.state, T0 + 1000)).toBe(pack.energy.max - 6)
    expect(again.state.wallet.gold - out.state.wallet.gold).toBe(110)
  })

  it('refuses a stage beyond the next one', () => {
    const start = newPlayer(pack, T0).state
    expect(refused(() => play(start, { t: 'battle', stage: 3 }))).toBe('locked_stage')
  })

  it('plays out the same log for the same seed', () => {
    const start = newPlayer(pack, T0).state
    const a = play(start, { t: 'battle', stage: 1 }, T0, 42).result.battle
    const b = play(start, { t: 'battle', stage: 1 }, T0, 42).result.battle
    expect(a).toEqual(b)
  })

  it('returns all but one energy when a battle is lost', () => {
    const s = newPlayer(pack, T0).state
    s.stage.cleared = 40
    s.team = ['gus']
    const out = play(s, { t: 'battle', stage: 41 })
    expect(out.result.won).toBe(false)
    expect(energyNow(pack, out.state, T0)).toBe(pack.energy.max - 1)
  })

  it('a first-session team (one epic, one rare) beats the first boss at level 9', () => {
    const team: UnitSpec[] = ['gus', 'tess', 'hana', 'milo', 'juno'].map((id) => {
      const d = heroDef(pack, id)!
      return {
        id,
        cls: d.class,
        element: d.element,
        stats: heroStats(pack, d, { level: 9, stars: BASE_STARS[d.rarity], gear: {} }),
        power: d.skill.power,
      }
    })
    const stage = pack.stages[9]!
    const foes: UnitSpec[] = stage.enemies.map((eid) => {
      const e = pack.enemies.find((x) => x.id === eid)!
      return {
        id: e.id,
        cls: e.class,
        element: e.element,
        stats: enemyStats(e.class, stage.level, stage.index, e.boss),
        power: DEFAULT_POWER[e.class],
        boss: e.boss,
      }
    })
    let wins = 0
    for (let i = 0; i < 40; i++) if (simulate(team, foes, createRng(i)).won) wins++
    expect(wins / 40).toBeGreaterThanOrEqual(0.6)
  })

  it('sweeps only three-star stages, for energy', () => {
    let s = newPlayer(pack, T0).state
    s.stage.cleared = 12
    s.stage.stars = { '12': 2, '11': 3 }
    expect(refused(() => play(s, { t: 'sweep', stage: 12, times: 1 }))).toBe('needs_three_stars')
    const out = play(s, { t: 'sweep', stage: 11, times: 3 })
    expect(energyNow(pack, out.state, T0)).toBe(pack.energy.max - 18)
    expect(out.state.shards[pack.stages[10]!.repeat.shards![0]!.hero]).toBe(3)
    s = out.state
    expect(refused(() => play(s, { t: 'sweep', stage: 11, times: 10 }))).toBe('not_enough_energy')
  })
})

describe('energy and idle', () => {
  it('refills one point every five minutes up to the cap', () => {
    const s = newPlayer(pack, T0).state
    s.stage.cleared = 12
    const out = play(s, { t: 'battle', stage: 12 })
    const spent = Number(out.result.energy)
    expect(spent).toBeGreaterThan(0)
    expect(energyNow(pack, out.state, T0 + 5 * MIN)).toBe(pack.energy.max - spent + 1)
    expect(energyNow(pack, out.state, T0 + 600 * MIN)).toBe(pack.energy.max)
  })

  it('keeps an energy refill above the cap until it is spent', () => {
    const s = newPlayer(pack, T0).state
    s.wallet.gems = 500
    const out = play(s, { t: 'buy', product: 'energy_refill' })
    expect(energyNow(pack, out.state, T0 + 60 * MIN)).toBe(pack.energy.max + 60)
  })

  it('fills the idle chest by the minute and stops at twelve hours', () => {
    const s = newPlayer(pack, T0).state
    expect(refused(() => play(s, { t: 'collect' }, T0 + 30_000))).toBe('not_ready')
    const p = idlePending(pack, s, T0 + 20 * 3_600_000)
    expect(p.minutes).toBe(12 * 60)
    expect(p.gems).toBe(12)
    expect(p.full).toBe(true)
    const out = play(s, { t: 'collect' }, T0 + 20 * 3_600_000)
    expect(out.state.wallet.gold - s.wallet.gold).toBe(12 * 60 * 15)
    expect(out.state.idle.at).toBe(T0 + 20 * 3_600_000)
    ledgerMatches(s, out)
  })
})

describe('heroes', () => {
  it('levels up as far as the gold goes, never past the cap', () => {
    const s = newPlayer(pack, T0).state
    const out = play(s, { t: 'level', hero: 'tess', times: 200 })
    expect(out.state.heroes.tess!.level).toBeLessThanOrEqual(20)
    expect(Number(out.result.levels)).toBeGreaterThan(5)
    ledgerMatches(s, out)
    const rich = structuredClone(s)
    rich.wallet.gold = 10_000_000
    const capped = play(rich, { t: 'level', hero: 'tess', times: 200 })
    expect(capped.state.heroes.tess!.level).toBe(20)
    expect(refused(() => play(capped.state, { t: 'level', hero: 'tess', times: 1 }))).toBe(
      'max_level',
    )
    expect(refused(() => play(s, { t: 'level', hero: 'nyx', times: 1 }))).toBe('not_owned')
  })

  it('fuses Hana from the third stage’s shards and puts her in the team', () => {
    let s = newPlayer(pack, T0).state
    for (const stage of [1, 2, 3]) {
      s.team = ['gus', 'tess', 'milo', 'rook']
      s = play(s, { t: 'battle', stage }, T0, 9).state
    }
    expect(s.stage.cleared).toBe(3)
    expect(s.shards.hana).toBeGreaterThanOrEqual(20)
    const out = play(s, { t: 'fuse', hero: 'hana' })
    expect(out.state.heroes.hana).toEqual({ level: 1, stars: 2, gear: {} })
    expect(out.state.team).toContain('hana')
    expect(refused(() => play(out.state, { t: 'fuse', hero: 'hana' }))).toBe('already_owned')
  })

  it('stars up for shards and gold, raising the level cap', () => {
    const s = newPlayer(pack, T0).state
    s.shards.tess = 15
    const out = play(s, { t: 'star', hero: 'tess' })
    expect(out.state.heroes.tess!.stars).toBe(2)
    expect(out.state.shards.tess).toBe(5)
    expect(out.state.wallet.gold).toBe(3000)
    expect(
      questProgress(
        out.state,
        pack.quests.find((q) => q.id === 'w_star1')!,
        T0,
      ).n,
    ).toBe(1)
  })

  it('equips gear into its own slot and returns what it replaces', () => {
    const s = newPlayer(pack, T0).state
    s.gear = { rustwood_axe: 1, ember_blade: 1 }
    const one = play(s, { t: 'equip', hero: 'tess', slot: 'weapon', gear: 'rustwood_axe' }).state
    expect(one.heroes.tess!.gear.weapon).toBe('rustwood_axe')
    expect(one.gear.rustwood_axe).toBeUndefined()
    const two = play(one, { t: 'equip', hero: 'tess', slot: 'weapon', gear: 'ember_blade' }).state
    expect(two.gear).toEqual({ rustwood_axe: 1 })
    expect(
      refused(() => play(two, { t: 'equip', hero: 'tess', slot: 'armor', gear: 'rustwood_axe' })),
    ).toBe('bad_gear')
    const off = play(two, { t: 'equip', hero: 'tess', slot: 'weapon', gear: null }).state
    expect(off.gear).toEqual({ rustwood_axe: 1, ember_blade: 1 })
  })
})

describe('summons', () => {
  it('ten draws cost ten sigils and always hold an epic or better', () => {
    const s = newPlayer(pack, T0).state
    for (let seed = 1; seed <= 30; seed++) {
      const out = play(s, { t: 'summon', count: 10 }, T0, seed)
      const pulls = out.result.pulls as { rarity: string }[]
      expect(pulls).toHaveLength(10)
      expect(pulls.some((p) => p.rarity === 'epic' || p.rarity === 'legendary')).toBe(true)
      expect(out.state.wallet.sigils).toBe(0)
      ledgerMatches(s, out)
    }
  })

  it('makes the draw at the pity count a legendary and resets the counter', () => {
    const s = newPlayer(pack, T0).state
    s.summon.pity = pack.banner.pity - 1
    const out = play(s, { t: 'summon', count: 1 }, T0, 5)
    const pulls = out.result.pulls as { rarity: string }[]
    expect(pulls[0]!.rarity).toBe('legendary')
    expect(out.state.summon.pity).toBe(0)
  })

  it('turns a duplicate into shards', () => {
    const s = newPlayer(pack, T0).state
    for (const h of pack.heroes) s.heroes[h.id] ??= { level: 1, stars: 1, gear: {} }
    const out = play(s, { t: 'summon', count: 1 }, T0, 3)
    const pull = (out.result.pulls as { hero: string; new: boolean; shards: number }[])[0]!
    expect(pull.new).toBe(false)
    expect(out.state.shards[pull.hero]).toBe(pull.shards)
  })

  it('refuses without sigils', () => {
    const s = newPlayer(pack, T0).state
    s.wallet.sigils = 0
    expect(refused(() => play(s, { t: 'summon', count: 1 }))).toBe('not_enough_sigils')
  })
})

describe('quests, logins and the store', () => {
  it('claims a daily quest once, and a new day starts it over', () => {
    let s = newPlayer(pack, T0).state
    for (const stage of [1, 2, 3]) s = play(s, { t: 'battle', stage }, T0, 9).state
    const win3 = pack.quests.find((q) => q.id === 'd_win3')!
    expect(questProgress(s, win3, T0).n).toBe(3)
    const out = play(s, { t: 'quest', quest: 'd_win3' })
    expect(refused(() => play(out.state, { t: 'quest', quest: 'd_win3' }))).toBe('already_claimed')
    const tomorrow = T0 + 24 * 3_600_000
    expect(questProgress(out.state, win3, tomorrow)).toEqual({ n: 0, claimed: false })
    // The week is the same, so weekly progress stays.
    const w = pack.quests.find((q) => q.id === 'w_win30')!
    expect(questProgress(out.state, w, tomorrow).n).toBe(3)
    expect(refused(() => play(out.state, { t: 'quest', quest: 'd_win3' }, tomorrow))).toBe(
      'not_ready',
    )
  })

  it('pays one login reward a day, moving through the calendar', () => {
    const s = newPlayer(pack, T0).state
    const one = play(s, { t: 'login' })
    expect(one.state.wallet.gold - s.wallet.gold).toBe(3000)
    expect(refused(() => play(one.state, { t: 'login' }, T0 + 1000))).toBe('already_claimed')
    const two = play(one.state, { t: 'login' }, T0 + 24 * 3_600_000)
    expect(two.state.wallet.gems - one.state.wallet.gems).toBe(30)
    expect(notices(pack, two.state, T0 + 24 * 3_600_000).login).toBe(false)
  })

  it('spends earned gems before bought ones and keeps to the daily limit', () => {
    const s = newPlayer(pack, T0).state
    s.wallet.gems = 30
    s.wallet.gemsPaid = 200
    const one = play(s, { t: 'buy', product: 'energy_refill' })
    expect(one.state.wallet.gems).toBe(0)
    expect(one.state.wallet.gemsPaid).toBe(180)
    ledgerMatches(s, one)
    const two = play(one.state, { t: 'buy', product: 'energy_refill' }).state
    const three = play(two, { t: 'buy', product: 'energy_refill' }).state
    expect(refused(() => play(three, { t: 'buy', product: 'energy_refill' }))).toBe('limit_reached')
    expect(
      play(three, { t: 'buy', product: 'energy_refill' }, T0 + 24 * 3_600_000).state.wallet
        .gemsPaid,
    ).toBe(30)
  })

  it('sells this week’s featured shards, listed before buying', () => {
    const s = newPlayer(pack, T0).state
    s.wallet.gems = 1000
    const f = featuredFor(pack, T0)
    expect(productReward(pack, s, 'featured_legendary', T0)).toEqual({
      shards: [{ hero: f.legendary, n: 30 }],
    })
    const out = play(s, { t: 'buy', product: 'featured_legendary' })
    expect(out.state.shards[f.legendary]).toBe(30)
    expect(refused(() => play(out.state, { t: 'buy', product: 'featured_legendary' }))).toBe(
      'limit_reached',
    )
  })

  it('prices the gold crate as idle gold at the player’s stage', () => {
    const s = newPlayer(pack, T0).state
    s.stage.cleared = 20
    expect(productReward(pack, s, 'gold_crate', T0)).toEqual({ gold: 120 * (15 + 3 * 20) })
  })
})

describe('parseAction', () => {
  it('accepts exactly the known shapes', () => {
    expect(parseAction({ t: 'battle', stage: 3 })).toEqual({ t: 'battle', stage: 3 })
    expect(parseAction({ t: 'summon', count: 10 })).toEqual({ t: 'summon', count: 10 })
    expect(parseAction({ t: 'equip', hero: 'tess', slot: 'weapon', gear: null })).toEqual({
      t: 'equip',
      hero: 'tess',
      slot: 'weapon',
      gear: null,
    })
    for (const bad of [
      null,
      'battle',
      { t: 'battle', stage: 0 },
      { t: 'battle', stage: 1.5 },
      { t: 'summon', count: 5 },
      { t: 'level', hero: 'Tess', times: 1 },
      { t: 'team', heroes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] },
      { t: 'equip', hero: 'tess', slot: 'hat', gear: 'x' },
      { t: 'grant', gold: 1e9 },
    ]) {
      expect(parseAction(bad)).toBeNull()
    }
  })
})
