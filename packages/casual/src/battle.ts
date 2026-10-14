/**
 * The auto-battle. The server runs it and sends the log; the client only plays the log back. Every round each
 * living unit acts once, fastest first. A basic attack charges 30 energy and taking a hit charges 10; at 100 the
 * unit uses its class skill instead. A side wins when the other has no one standing; after `maxRounds` the
 * attackers lose.
 */
import type { Rng } from '@openvibe/shared'
import { advantage, type Stats } from './stats.js'
import type { Element, HeroClass } from './types.js'

export interface UnitSpec {
  id: string
  cls: HeroClass
  element: Element
  stats: Stats
  /** The class skill's strength (SkillDef.power); enemies use their class default. */
  power: number
  boss?: boolean
}

/** One target's outcome in an event. */
export interface Hit {
  /** `a0`…`a4` for the attackers, `d0`… for the defenders. */
  r: string
  dmg?: number
  heal?: number
  shield?: number
  /** Damage a shield took instead. */
  blocked?: number
  crit?: 1
  /** 1 = advantage, -1 = disadvantage. */
  adv?: 1 | -1
  ko?: 1
}

export interface BattleEvent {
  round: number
  actor: string
  /** `attack` is a basic attack; the rest are class skills. */
  kind: 'attack' | 'strike' | 'nova' | 'snipe' | 'heal' | 'shield' | 'rally'
  hits: Hit[]
}

export interface BattleUnitView {
  r: string
  id: string
  hp: number
  boss?: 1
}

export interface BattleLog {
  units: BattleUnitView[]
  events: BattleEvent[]
  won: boolean
  rounds: number
  /** Attackers knocked out by the end. */
  lost: number
}

export const SKILL_OF: Record<HeroClass, BattleEvent['kind']> = {
  guardian: 'shield',
  blade: 'strike',
  arcanist: 'nova',
  ranger: 'snipe',
  mender: 'heal',
  herald: 'rally',
}

/** The class skill's default strength, for enemies and as the guide for heroes. */
export const DEFAULT_POWER: Record<HeroClass, number> = {
  guardian: 0.12,
  blade: 2.6,
  arcanist: 1.1,
  ranger: 3,
  mender: 1,
  herald: 0.3,
}

interface Unit {
  r: string
  side: 0 | 1
  pos: number
  cls: HeroClass
  element: Element
  maxHp: number
  hp: number
  atk: number
  def: number
  spd: number
  power: number
  energy: number
  shield: number
  rally: number
  rallyRounds: number
}

const FRONT: Record<HeroClass, number> = {
  guardian: 0,
  blade: 1,
  herald: 2,
  ranger: 2,
  arcanist: 2,
  mender: 2,
}

function makeUnits(specs: UnitSpec[], side: 0 | 1): Unit[] {
  return specs.map((s, pos) => ({
    r: `${side === 0 ? 'a' : 'd'}${pos}`,
    side,
    pos,
    cls: s.cls,
    element: s.element,
    maxHp: s.stats.hp,
    hp: s.stats.hp,
    atk: s.stats.atk,
    def: s.stats.def,
    spd: s.stats.spd,
    power: s.power,
    energy: 0,
    shield: 0,
    rally: 0,
    rallyRounds: 0,
  }))
}

export function simulate(
  attackers: UnitSpec[],
  defenders: UnitSpec[],
  rng: Rng,
  maxRounds = 15,
): BattleLog {
  const a = makeUnits(attackers, 0)
  const d = makeUnits(defenders, 1)
  const all = [...a, ...d]
  const events: BattleEvent[] = []
  const alive = (side: Unit[]) => side.filter((u) => u.hp > 0)
  const foesOf = (u: Unit) => (u.side === 0 ? d : a)
  const friendsOf = (u: Unit) => (u.side === 0 ? a : d)
  const front = (side: Unit[]): Unit | undefined =>
    alive(side).sort((x, y) => FRONT[x.cls] - FRONT[y.cls] || x.pos - y.pos)[0]
  const weakest = (side: Unit[]): Unit | undefined =>
    alive(side).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp || x.pos - y.pos)[0]

  const strike = (from: Unit, to: Unit, mult: number): Hit => {
    const adv = advantage(from.element, to.element)
    const crit = rng.next() < 0.1
    const spread = 0.95 + rng.next() * 0.1
    const atk = from.atk * (1 + (from.rallyRounds > 0 ? from.rally : 0))
    let dmg = Math.max(
      1,
      // Attack against defence as a ratio, so damage keeps pace at every level.
      Math.round(atk * mult * (atk / (atk + to.def * 1.2)) * adv * (crit ? 1.6 : 1) * spread),
    )
    const blocked = Math.min(to.shield, dmg)
    to.shield -= blocked
    dmg = Math.min(to.hp, dmg - blocked)
    to.hp -= dmg
    const hit: Hit = { r: to.r, dmg }
    if (blocked > 0) hit.blocked = blocked
    to.energy = Math.min(100, to.energy + 10)
    if (crit) hit.crit = 1
    if (adv > 1) hit.adv = 1
    else if (adv < 1) hit.adv = -1
    if (to.hp === 0) hit.ko = 1
    return hit
  }

  let round = 0
  while (round < maxRounds && alive(a).length && alive(d).length) {
    round++
    const order = alive(all).sort((x, y) => y.spd - x.spd || x.side - y.side || x.pos - y.pos)
    for (const u of order) {
      if (u.hp <= 0) continue
      const foes = foesOf(u)
      if (!alive(foes).length) break
      const friends = friendsOf(u)
      let ev: BattleEvent
      if (u.energy >= 100) {
        u.energy = 0
        const kind = SKILL_OF[u.cls]
        ev = { round, actor: u.r, kind, hits: [] }
        if (kind === 'strike') {
          const t = front(foes)
          if (t) ev.hits.push(strike(u, t, u.power))
        } else if (kind === 'snipe') {
          const t = weakest(foes)
          if (t) ev.hits.push(strike(u, t, u.power))
        } else if (kind === 'nova') {
          for (const t of alive(foes)) ev.hits.push(strike(u, t, u.power))
        } else if (kind === 'heal') {
          const amount = Math.round(u.atk * u.power)
          const low = weakest(friends)
          for (const t of alive(friends)) {
            const heal = Math.min(t.maxHp - t.hp, t === low ? amount * 2 : amount)
            t.hp += heal
            ev.hits.push({ r: t.r, heal })
          }
        } else if (kind === 'shield') {
          const amount = Math.round(u.maxHp * u.power)
          for (const t of alive(friends)) {
            t.shield += amount
            ev.hits.push({ r: t.r, shield: amount })
          }
        } else {
          for (const t of alive(friends)) {
            t.rally = Math.max(t.rally, u.power)
            t.rallyRounds = 2
            if (t !== u) t.energy = Math.min(100, t.energy + 20)
            ev.hits.push({ r: t.r })
          }
        }
      } else {
        u.energy = Math.min(100, u.energy + 30)
        const t =
          u.cls === 'ranger'
            ? weakest(foes)
            : u.cls === 'arcanist'
              ? alive(foes)[Math.floor(rng.next() * alive(foes).length)]
              : front(foes)
        ev = { round, actor: u.r, kind: 'attack', hits: t ? [strike(u, t, 1)] : [] }
      }
      events.push(ev)
    }
    for (const u of all) if (u.rallyRounds > 0) u.rallyRounds--
  }
  const won = alive(a).length > 0 && alive(d).length === 0
  return {
    units: [
      ...attackers.map((s, i) => ({ r: `a${i}`, id: s.id, hp: s.stats.hp })),
      ...defenders.map((s, i) => ({
        r: `d${i}`,
        id: s.id,
        hp: s.stats.hp,
        ...(s.boss ? { boss: 1 as const } : {}),
      })),
    ],
    events,
    won,
    rounds: round,
    lost: a.filter((u) => u.hp === 0).length,
  }
}

/** Three stars with no one knocked out, two with one, otherwise one. */
export function starsFor(log: BattleLog): number {
  if (!log.won) return 0
  return log.lost === 0 ? 3 : log.lost === 1 ? 2 : 1
}
