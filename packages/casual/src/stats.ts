import type {
  CasualPack,
  Element,
  GearDef,
  HeroClass,
  HeroDef,
  HeroState,
  Rarity,
} from './types.js'

export interface Stats {
  hp: number
  atk: number
  def: number
  spd: number
}

/** Level 1, one star, common, no gear. */
export const CLASS_BASE: Record<HeroClass, Stats> = {
  guardian: { hp: 520, atk: 36, def: 30, spd: 90 },
  blade: { hp: 380, atk: 60, def: 18, spd: 104 },
  arcanist: { hp: 300, atk: 64, def: 12, spd: 100 },
  ranger: { hp: 320, atk: 64, def: 14, spd: 112 },
  mender: { hp: 340, atk: 44, def: 16, spd: 98 },
  herald: { hp: 360, atk: 46, def: 18, spd: 108 },
}

export const RARITY_MULT: Record<Rarity, number> = {
  common: 1,
  rare: 1.15,
  epic: 1.32,
  legendary: 1.5,
}

/** The stars a hero has when it is first unlocked. */
export const BASE_STARS: Record<Rarity, number> = { common: 1, rare: 2, epic: 3, legendary: 4 }

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary']

export function levelMult(level: number): number {
  return 1 + 0.1 * (level - 1)
}

export function starMult(stars: number): number {
  return 1 + 0.2 * (stars - 1)
}

export function levelCap(pack: CasualPack, stars: number): number {
  return pack.levelsPerStar * stars
}

/** Gold to go from `level` to `level + 1`. */
export function levelCost(level: number): number {
  return Math.round(20 * Math.pow(level, 1.6))
}

/** Gold for `times` levels from `level`. */
export function levelCostFor(level: number, times: number): number {
  let total = 0
  for (let i = 0; i < times; i++) total += levelCost(level + i)
  return total
}

export function scaled(base: Stats, mult: number, level: number, stars: number): Stats {
  const m = mult * levelMult(level) * starMult(stars)
  return {
    hp: Math.round(base.hp * m),
    atk: Math.round(base.atk * m),
    def: Math.round(base.def * m),
    spd: base.spd + Math.min(30, Math.floor(level / 4)),
  }
}

export function applyGear(stats: Stats, gear: GearDef[]): Stats {
  let atk = 0
  let hp = 0
  let def = 0
  let spd = 0
  for (const g of gear) {
    atk += g.bonus.atk ?? 0
    hp += g.bonus.hp ?? 0
    def += g.bonus.def ?? 0
    spd += g.bonus.spd ?? 0
  }
  return {
    hp: Math.round(stats.hp * (1 + hp / 100)),
    atk: Math.round(stats.atk * (1 + atk / 100)),
    def: Math.round(stats.def * (1 + def / 100)),
    spd: stats.spd + spd,
  }
}

export function heroStats(pack: CasualPack, def: HeroDef, state: HeroState): Stats {
  const base = scaled(CLASS_BASE[def.class], RARITY_MULT[def.rarity], state.level, state.stars)
  const gear: GearDef[] = []
  for (const id of Object.values(state.gear)) {
    const g = pack.gear.find((x) => x.id === id)
    if (g) gear.push(g)
  }
  return applyGear(base, gear)
}

/** One number for a hero's strength, shown beside it and used to rank teams. */
export function power(stats: Stats): number {
  return Math.round(stats.hp / 8 + stats.atk * 2.2 + stats.def * 1.6 + stats.spd)
}

/**
 * An enemy's stats at a stage: they grow with the stage the way a hero grows with levels, plus a star step every
 * 20 stages, so a team keeps pace by levelling and starring up.
 */
export function enemyStats(cls: HeroClass, level: number, stage: number, boss: boolean): Stats {
  const tier = 1 + Math.floor((stage - 1) / 20)
  const mult = 0.78 + 0.0035 * stage
  const s = scaled(CLASS_BASE[cls], mult, level, tier)
  if (!boss) return s
  return {
    hp: Math.round(s.hp * 3.5),
    atk: Math.round(s.atk * 1.2),
    def: Math.round(s.def * 1.2),
    spd: s.spd,
  }
}

/** Element advantage: flame > grove > tide > flame; dawn and dusk each beat the other. */
export function advantage(attacker: Element, defender: Element): number {
  const beats: Record<Element, Element[]> = {
    flame: ['grove'],
    grove: ['tide'],
    tide: ['flame'],
    dawn: ['dusk'],
    dusk: ['dawn'],
  }
  if (beats[attacker].includes(defender)) return 1.3
  if (beats[defender].includes(attacker) && attacker !== 'dawn' && attacker !== 'dusk') return 0.8
  return 1
}
