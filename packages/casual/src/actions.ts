/**
 * The casual kit's rules as one reducer. The server applies an action to a copy of the player's state inside a
 * database transaction and stores the result together with its ledger lines; the client never decides a reward,
 * a drop or a price. A refused action throws `Refusal` and changes nothing.
 */
import type { Rng } from '@openvibe/shared'
import { DEFAULT_POWER, simulate, starsFor, type BattleLog, type UnitSpec } from './battle.js'
import { energyNow, featuredFor, goldPerMinute, heroDef, idlePending } from './kit.js'
import { BASE_STARS, enemyStats, heroStats, levelCap, levelCost } from './stats.js'
import { dayKey, weekKey } from './time.js'
import type {
  CasualPack,
  Counter,
  Currency,
  Delta,
  GearSlot,
  PlayerState,
  ProductDef,
  Rarity,
  Reward,
} from './types.js'

export type Action =
  | { t: 'collect' }
  | { t: 'battle'; stage: number }
  | { t: 'sweep'; stage: number; times: number }
  | { t: 'team'; heroes: string[] }
  | { t: 'level'; hero: string; times: number }
  | { t: 'star'; hero: string }
  | { t: 'fuse'; hero: string }
  | { t: 'equip'; hero: string; slot: GearSlot; gear: string | null }
  | { t: 'summon'; count: 1 | 10 }
  | { t: 'quest'; quest: string }
  | { t: 'login' }
  | { t: 'buy'; product: string }

export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface Outcome {
  state: PlayerState
  deltas: Delta[]
  result: Record<string, unknown>
}

const ID = /^[a-z0-9_]{1,40}$/
const SLOTS: GearSlot[] = ['weapon', 'armor', 'charm']
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null)

/** A request body's action, or null when it is not exactly one of the shapes above. */
export function parseAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  switch (a.t) {
    case 'collect':
    case 'login':
      return { t: a.t }
    case 'battle': {
      const stage = int(a.stage, 1, 10_000)
      return stage === null ? null : { t: 'battle', stage }
    }
    case 'sweep': {
      const stage = int(a.stage, 1, 10_000)
      const times = int(a.times, 1, 10)
      return stage === null || times === null ? null : { t: 'sweep', stage, times }
    }
    case 'team': {
      if (!Array.isArray(a.heroes) || a.heroes.length > 10) return null
      const heroes = a.heroes.map(id)
      return heroes.every((h): h is string => h !== null) ? { t: 'team', heroes } : null
    }
    case 'level': {
      const hero = id(a.hero)
      const times = int(a.times, 1, 200)
      return hero === null || times === null ? null : { t: 'level', hero, times }
    }
    case 'star':
    case 'fuse': {
      const hero = id(a.hero)
      return hero === null ? null : { t: a.t, hero }
    }
    case 'equip': {
      const hero = id(a.hero)
      const slot = SLOTS.find((s) => s === a.slot)
      const gear = a.gear === null ? null : id(a.gear)
      if (hero === null || !slot || (a.gear !== null && gear === null)) return null
      return { t: 'equip', hero, slot, gear }
    }
    case 'summon':
      return a.count === 1 || a.count === 10 ? { t: 'summon', count: a.count } : null
    case 'quest': {
      const quest = id(a.quest)
      return quest === null ? null : { t: 'quest', quest }
    }
    case 'buy': {
      const product = id(a.product)
      return product === null ? null : { t: 'buy', product }
    }
    default:
      return null
  }
}

/** A new player: the pack's starting heroes in the team, its starting wallet, full energy. */
export function newPlayer(pack: CasualPack, now: number): Outcome {
  const s: PlayerState = {
    v: 1,
    created: now,
    wallet: { gold: 0, gems: 0, gemsPaid: 0, sigils: 0 },
    energy: { value: pack.energy.max, at: now },
    heroes: {},
    shards: {},
    gear: {},
    team: [],
    stage: { cleared: 0, stars: {} },
    idle: { at: now },
    quests: { day: dayKey(now), week: weekKey(now), progress: {}, claimed: [] },
    login: { last: null, count: 0 },
    summon: { pity: 0, total: 0 },
    buys: {},
    stats: { battles: 0, wins: 0 },
  }
  const deltas: Delta[] = []
  for (const h of pack.start.heroes) {
    const def = heroDef(pack, h)
    if (!def) continue
    s.heroes[h] = { level: 1, stars: BASE_STARS[def.rarity], gear: {} }
    deltas.push({ asset: `hero:${h}`, delta: 1, balance: 1, reason: 'start' })
    if (s.team.length < pack.teamSize) s.team.push(h)
  }
  for (const [c, n] of Object.entries(pack.start.wallet) as [Currency, number][]) {
    credit(s, deltas, c, n, 'start')
  }
  return { state: s, deltas, result: {} }
}

function credit(s: PlayerState, deltas: Delta[], c: Currency, n: number, reason: string): void {
  if (n === 0) return
  s.wallet[c] += n
  deltas.push({ asset: c, delta: n, balance: s.wallet[c], reason })
}

function spend(
  s: PlayerState,
  deltas: Delta[],
  c: 'gold' | 'sigils',
  n: number,
  reason: string,
): void {
  if (s.wallet[c] < n) throw new Refusal(`not_enough_${c}`, `That needs ${n} ${c}.`)
  credit(s, deltas, c, -n, reason)
}

/** Gems earned in play go first, then gems bought with money. */
function spendGems(s: PlayerState, deltas: Delta[], n: number, reason: string): void {
  if (s.wallet.gems + s.wallet.gemsPaid < n)
    throw new Refusal('not_enough_gems', `That needs ${n} gems.`)
  const free = Math.min(s.wallet.gems, n)
  credit(s, deltas, 'gems', -free, reason)
  credit(s, deltas, 'gemsPaid', -(n - free), reason)
}

function addShards(s: PlayerState, deltas: Delta[], hero: string, n: number, reason: string): void {
  if (n === 0) return
  const balance = (s.shards[hero] ?? 0) + n
  if (balance === 0) delete s.shards[hero]
  else s.shards[hero] = balance
  deltas.push({ asset: `shard:${hero}`, delta: n, balance, reason })
}

function addGear(s: PlayerState, deltas: Delta[], gear: string, n: number, reason: string): void {
  const balance = (s.gear[gear] ?? 0) + n
  if (balance === 0) delete s.gear[gear]
  else s.gear[gear] = balance
  deltas.push({ asset: `gear:${gear}`, delta: n, balance, reason })
}

/** Energy settled to `now` (refills counted in), then changed by `n`. */
function changeEnergy(pack: CasualPack, s: PlayerState, n: number, now: number): void {
  const current = energyNow(pack, s, now)
  if (current >= pack.energy.max) s.energy.at = now
  else {
    const regen = pack.energy.regenMs
    s.energy.at += Math.max(0, Math.floor((now - s.energy.at) / regen)) * regen
  }
  s.energy.value = current + n
}

function grant(
  pack: CasualPack,
  s: PlayerState,
  deltas: Delta[],
  reward: Reward,
  reason: string,
  now: number,
): void {
  if (reward.gold) credit(s, deltas, 'gold', reward.gold, reason)
  if (reward.idleMinutes)
    credit(s, deltas, 'gold', reward.idleMinutes * goldPerMinute(pack, s), reason)
  if (reward.gems) credit(s, deltas, 'gems', reward.gems, reason)
  if (reward.sigils) credit(s, deltas, 'sigils', reward.sigils, reason)
  if (reward.energy) changeEnergy(pack, s, reward.energy, now)
  for (const sh of reward.shards ?? []) addShards(s, deltas, sh.hero, sh.n, reason)
  for (const g of reward.gear ?? []) addGear(s, deltas, g, 1, reason)
}

/** Starts a new day or week of quests when one has begun. */
function rollQuests(pack: CasualPack, s: PlayerState, now: number): void {
  const day = dayKey(now)
  const week = weekKey(now)
  const q = s.quests
  const drop = (period: 'daily' | 'weekly', prefix: string) => {
    const ids = new Set(pack.quests.filter((x) => x.period === period).map((x) => x.id))
    q.claimed = q.claimed.filter((c) => !ids.has(c))
    for (const k of Object.keys(q.progress)) if (k.startsWith(prefix)) delete q.progress[k]
  }
  if (q.day !== day) {
    drop('daily', 'd:')
    q.day = day
  }
  if (q.week !== week) {
    drop('weekly', 'w:')
    q.week = week
  }
}

function bump(s: PlayerState, counter: Counter, n: number): void {
  if (n <= 0) return
  for (const p of ['d', 'w']) {
    const k = `${p}:${counter}`
    s.quests.progress[k] = (s.quests.progress[k] ?? 0) + n
  }
}

function owned(s: PlayerState, hero: string) {
  const hs = s.heroes[hero]
  if (!hs) throw new Refusal('not_owned', 'You do not have that hero yet.')
  return hs
}

function teamSpecs(pack: CasualPack, s: PlayerState): UnitSpec[] {
  const out: UnitSpec[] = []
  for (const id of s.team) {
    const def = heroDef(pack, id)
    const hs = s.heroes[id]
    if (!def || !hs) continue
    out.push({
      id,
      cls: def.class,
      element: def.element,
      stats: heroStats(pack, def, hs),
      power: def.skill.power,
    })
  }
  if (!out.length) throw new Refusal('team_empty', 'Put at least one hero in your team.')
  return out
}

function stageSpecs(pack: CasualPack, index: number): UnitSpec[] {
  const stage = pack.stages[index - 1]
  if (!stage) throw new Refusal('unknown_stage', 'There is no such stage.')
  return stage.enemies.map((eid) => {
    const e = pack.enemies.find((x) => x.id === eid)
    if (!e) throw new Refusal('unknown_stage', 'There is no such stage.')
    return {
      id: e.id,
      cls: e.class,
      element: e.element,
      stats: enemyStats(e.class, stage.level, stage.index, e.boss),
      power: DEFAULT_POWER[e.class],
      boss: e.boss,
    }
  })
}

function periodKey(period: 'daily' | 'weekly' | 'once', now: number): string {
  return period === 'daily' ? dayKey(now) : period === 'weekly' ? weekKey(now) : 'once'
}

/** Applies one action to a copy of `state`. */
export function apply(
  pack: CasualPack,
  state: PlayerState,
  action: Action,
  now: number,
  rng: Rng,
): Outcome {
  const s = structuredClone(state)
  const deltas: Delta[] = []
  rollQuests(pack, s, now)
  const done = (result: Record<string, unknown> = {}): Outcome => ({ state: s, deltas, result })

  switch (action.t) {
    case 'collect': {
      const p = idlePending(pack, s, now)
      if (p.minutes < 1) throw new Refusal('not_ready', 'Nothing has piled up yet.')
      credit(s, deltas, 'gold', p.gold, 'idle')
      credit(s, deltas, 'gems', p.gems, 'idle')
      s.idle.at = now
      bump(s, 'idle_collected', 1)
      return done({ minutes: p.minutes, gold: p.gold, gems: p.gems })
    }

    case 'battle': {
      const stage = pack.stages[action.stage - 1]
      if (!stage) throw new Refusal('unknown_stage', 'There is no such stage.')
      if (action.stage > s.stage.cleared + 1)
        throw new Refusal('locked_stage', 'Clear the stage before it first.')
      const first = action.stage === s.stage.cleared + 1
      const cost = first && action.stage <= pack.freeFirstClears ? 0 : stage.energy
      if (energyNow(pack, s, now) < cost)
        throw new Refusal('not_enough_energy', `That needs ${cost} energy.`)
      const log: BattleLog = simulate(teamSpecs(pack, s), stageSpecs(pack, action.stage), rng)
      s.stats.battles++
      // A lost battle costs one energy; the rest comes back.
      const spent = log.won ? cost : Math.min(cost, 1)
      if (spent) {
        changeEnergy(pack, s, -spent, now)
        bump(s, 'energy_spent', spent)
      }
      const stars = starsFor(log)
      let reward: Reward = {}
      if (log.won) {
        s.stats.wins++
        bump(s, 'battle_won', 1)
        reward = first ? stage.first : stage.repeat
        grant(
          pack,
          s,
          deltas,
          reward,
          first ? `stage:${stage.index}:first` : `stage:${stage.index}`,
          now,
        )
        if (first) {
          s.stage.cleared = stage.index
          bump(s, 'stage_cleared', 1)
        }
        const key = String(stage.index)
        s.stage.stars[key] = Math.max(s.stage.stars[key] ?? 0, stars)
      }
      return done({
        battle: log,
        won: log.won,
        stars,
        first: first && log.won,
        reward,
        energy: spent,
      })
    }

    case 'sweep': {
      const stage = pack.stages[action.stage - 1]
      if (!stage || action.stage > s.stage.cleared)
        throw new Refusal('locked_stage', 'Clear the stage first.')
      if ((s.stage.stars[String(stage.index)] ?? 0) < 3)
        throw new Refusal('needs_three_stars', 'Win the stage with three stars to sweep it.')
      const cost = stage.energy * action.times
      if (energyNow(pack, s, now) < cost)
        throw new Refusal('not_enough_energy', `That needs ${cost} energy.`)
      changeEnergy(pack, s, -cost, now)
      bump(s, 'energy_spent', cost)
      for (let i = 0; i < action.times; i++)
        grant(pack, s, deltas, stage.repeat, `sweep:${stage.index}`, now)
      s.stats.battles += action.times
      s.stats.wins += action.times
      bump(s, 'battle_won', action.times)
      return done({ times: action.times, energy: cost })
    }

    case 'team': {
      const unique = [...new Set(action.heroes)]
      if (unique.length !== action.heroes.length || unique.length > pack.teamSize)
        throw new Refusal('bad_team', `A team is up to ${pack.teamSize} different heroes.`)
      if (!unique.length) throw new Refusal('team_empty', 'Put at least one hero in your team.')
      for (const h of unique) owned(s, h)
      s.team = unique
      return done()
    }

    case 'level': {
      const def = heroDef(pack, action.hero)
      const hs = owned(s, action.hero)
      if (!def) throw new Refusal('unknown_hero', 'There is no such hero.')
      const cap = levelCap(pack, hs.stars)
      if (hs.level >= cap)
        throw new Refusal('max_level', 'Star this hero up to raise the level cap.')
      let gained = 0
      let cost = 0
      while (gained < action.times && hs.level + gained < cap) {
        const next = levelCost(hs.level + gained)
        if (s.wallet.gold < cost + next) break
        cost += next
        gained++
      }
      if (!gained)
        throw new Refusal('not_enough_gold', `The next level needs ${levelCost(hs.level)} gold.`)
      spend(s, deltas, 'gold', cost, `level:${action.hero}`)
      hs.level += gained
      bump(s, 'hero_levelled', gained)
      return done({ levels: gained, gold: cost })
    }

    case 'star': {
      const def = heroDef(pack, action.hero)
      const hs = owned(s, action.hero)
      if (!def) throw new Refusal('unknown_hero', 'There is no such hero.')
      if (hs.stars >= pack.maxStars) throw new Refusal('max_stars', 'This hero has every star.')
      const shards = pack.starShards[hs.stars] ?? Infinity
      const gold = pack.starGold[hs.stars] ?? Infinity
      if ((s.shards[action.hero] ?? 0) < shards)
        throw new Refusal('not_enough_shards', `That needs ${shards} shards.`)
      spend(s, deltas, 'gold', gold, `star:${action.hero}`)
      addShards(s, deltas, action.hero, -shards, `star:${action.hero}`)
      hs.stars++
      bump(s, 'star_up', 1)
      return done({ stars: hs.stars })
    }

    case 'fuse': {
      const def = heroDef(pack, action.hero)
      if (!def) throw new Refusal('unknown_hero', 'There is no such hero.')
      if (s.heroes[action.hero]) throw new Refusal('already_owned', 'You already have this hero.')
      const need = pack.fuseShards[def.rarity]
      if ((s.shards[action.hero] ?? 0) < need)
        throw new Refusal('not_enough_shards', `That needs ${need} shards.`)
      addShards(s, deltas, action.hero, -need, `fuse:${action.hero}`)
      s.heroes[action.hero] = { level: 1, stars: BASE_STARS[def.rarity], gear: {} }
      deltas.push({ asset: `hero:${action.hero}`, delta: 1, balance: 1, reason: 'fuse' })
      if (s.team.length < pack.teamSize) s.team.push(action.hero)
      return done({ hero: action.hero })
    }

    case 'equip': {
      const hs = owned(s, action.hero)
      const current = hs.gear[action.slot]
      if (action.gear !== null) {
        const g = pack.gear.find((x) => x.id === action.gear)
        if (!g || g.slot !== action.slot)
          throw new Refusal('bad_gear', 'That does not go in this slot.')
        if ((s.gear[g.id] ?? 0) < 1) throw new Refusal('not_owned', 'You do not have that item.')
        s.gear[g.id] = (s.gear[g.id] ?? 0) - 1
        if (s.gear[g.id] === 0) delete s.gear[g.id]
        hs.gear[action.slot] = g.id
      } else delete hs.gear[action.slot]
      if (current) s.gear[current] = (s.gear[current] ?? 0) + 1
      return done()
    }

    case 'summon': {
      const b = pack.banner
      spend(s, deltas, 'sigils', b.cost * action.count, 'summon')
      const featured = featuredFor(pack, now)
      const pulls: { hero: string; rarity: Rarity; new: boolean; shards: number }[] = []
      for (let i = 0; i < action.count; i++) {
        s.summon.pity++
        s.summon.total++
        let rarity: Rarity
        const r = rng.next()
        if (s.summon.pity >= b.pity) rarity = 'legendary'
        else if (r < b.odds.legendary) rarity = 'legendary'
        else if (r < b.odds.legendary + b.odds.epic) rarity = 'epic'
        else if (r < b.odds.legendary + b.odds.epic + b.odds.rare) rarity = 'rare'
        else rarity = 'common'
        // Ten at once always holds an epic or better: the last draw is lifted when none came.
        if (
          action.count === 10 &&
          i === 9 &&
          (rarity === 'common' || rarity === 'rare') &&
          !pulls.some((p) => p.rarity === 'epic' || p.rarity === 'legendary')
        ) {
          rarity =
            rng.next() < b.odds.legendary / (b.odds.legendary + b.odds.epic) ? 'legendary' : 'epic'
        }
        if (rarity === 'legendary') s.summon.pity = 0
        const list = pack.heroes.filter((h) => h.rarity === rarity)
        const pick =
          rarity === 'legendary' ? featured.legendary : rarity === 'epic' ? featured.epic : null
        let hero: string
        if (pick && list.length > 1 && rng.next() < 0.5) hero = pick
        else {
          const others = pick && list.length > 1 ? list.filter((h) => h.id !== pick) : list
          hero = others[Math.floor(rng.next() * others.length)]?.id ?? list[0]?.id ?? ''
        }
        const def = heroDef(pack, hero)
        if (!def) continue
        if (!s.heroes[hero]) {
          s.heroes[hero] = { level: 1, stars: BASE_STARS[def.rarity], gear: {} }
          deltas.push({ asset: `hero:${hero}`, delta: 1, balance: 1, reason: 'summon' })
          if (s.team.length < pack.teamSize) s.team.push(hero)
          pulls.push({ hero, rarity, new: true, shards: 0 })
        } else {
          const n = b.duplicateShards[rarity]
          addShards(s, deltas, hero, n, 'summon')
          pulls.push({ hero, rarity, new: false, shards: n })
        }
      }
      bump(s, 'summoned', action.count)
      return done({ pulls, pity: s.summon.pity })
    }

    case 'quest': {
      const q = pack.quests.find((x) => x.id === action.quest)
      if (!q) throw new Refusal('unknown_quest', 'There is no such quest.')
      if (s.quests.claimed.includes(q.id)) throw new Refusal('already_claimed', 'Already claimed.')
      const key = `${q.period === 'daily' ? 'd' : 'w'}:${q.counter}`
      if ((s.quests.progress[key] ?? 0) < q.target) throw new Refusal('not_ready', 'Not done yet.')
      s.quests.claimed.push(q.id)
      grant(pack, s, deltas, q.reward, `quest:${q.id}`, now)
      return done({ reward: q.reward })
    }

    case 'login': {
      const day = dayKey(now)
      if (s.login.last === day) throw new Refusal('already_claimed', 'Come back tomorrow.')
      const reward = pack.calendar[s.login.count % pack.calendar.length] ?? {}
      grant(pack, s, deltas, reward, `login:${(s.login.count % pack.calendar.length) + 1}`, now)
      s.login.count++
      s.login.last = day
      bump(s, 'login', 1)
      return done({ reward, day: s.login.count })
    }

    case 'buy': {
      const p = pack.store.find((x) => x.id === action.product)
      if (!p) throw new Refusal('unknown_product', 'There is no such product.')
      const key = periodKey(p.limit.period, now)
      const bought = boughtThisPeriod(s, p, now)
      if (bought >= p.limit.count)
        throw new Refusal('limit_reached', 'You have bought all of these for now.')
      spendGems(s, deltas, p.gems, `buy:${p.id}`)
      const reward = productReward(pack, s, p.id, now) ?? {}
      grant(pack, s, deltas, reward, `buy:${p.id}`, now)
      s.buys[p.id] = { key, n: bought + 1 }
      return done({ reward })
    }
  }
}

/** How many of a product the player bought in its current period (today, this week, or ever). */
export function boughtThisPeriod(s: PlayerState, p: ProductDef, now: number): number {
  const b = s.buys[p.id]
  return b && b.key === periodKey(p.limit.period, now) ? b.n : 0
}

/** What a product gives this player now, in plain amounts (its contents are listed before buying). */
export function productReward(
  pack: CasualPack,
  s: PlayerState,
  productId: string,
  now: number,
): Reward | null {
  const p = pack.store.find((x) => x.id === productId)
  if (!p) return null
  if (!p.featured) {
    const { idleMinutes, ...rest } = p.reward
    return idleMinutes
      ? { ...rest, gold: (rest.gold ?? 0) + idleMinutes * goldPerMinute(pack, s) }
      : rest
  }
  const f = featuredFor(pack, now)
  return {
    shards: [{ hero: p.featured.rarity === 'legendary' ? f.legendary : f.epic, n: p.featured.n }],
  }
}
