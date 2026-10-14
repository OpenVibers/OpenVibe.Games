/**
 * The casual kit's data model (plan T22). A game is a content pack (`CasualPack`): heroes, enemies, stages,
 * gear, quests, the login calendar, the summon banner and the store, all data. A player's progress is one
 * `PlayerState` document the server owns; the client only renders it and sends intents.
 */

export type Element = 'flame' | 'tide' | 'grove' | 'dawn' | 'dusk'
export type HeroClass = 'guardian' | 'blade' | 'arcanist' | 'ranger' | 'mender' | 'herald'
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'
export type GearSlot = 'weapon' | 'armor' | 'charm'
/** Wallet currencies. `gemsPaid` holds gems bought with money, kept apart from gems earned in play. */
export type Currency = 'gold' | 'gems' | 'gemsPaid' | 'sigils'

/** Parameters the client's portrait painter draws a character from. */
export interface Look {
  skin: string
  hair: string
  /** Index into the painter's hair shapes. */
  hairStyle: number
  eyes: string
  outfit: string
  trim: string
  /** Index into the painter's accessories (0 = none). */
  accessory: number
}

export interface SkillDef {
  name: string
  text: string
  /** The class skill's strength: a damage or heal multiplier of attack, a shield share of max HP, or a buff share. */
  power: number
}

export interface HeroDef {
  id: string
  name: string
  title: string
  rarity: Rarity
  element: Element
  class: HeroClass
  skill: SkillDef
  bio: string
  look: Look
}

export type EnemyKind =
  'slime' | 'wisp' | 'golem' | 'imp' | 'drone' | 'beetle' | 'specter' | 'drake'

export interface EnemyDef {
  id: string
  name: string
  kind: EnemyKind
  element: Element
  class: HeroClass
  boss: boolean
}

export interface ShardReward {
  hero: string
  n: number
}

/** Fixed contents: every reward and every product lists exactly what it gives. */
export interface Reward {
  gold?: number
  /** Gold worth this many minutes of the idle chest at the player's stage (shown as gold before buying). */
  idleMinutes?: number
  gems?: number
  sigils?: number
  energy?: number
  shards?: ShardReward[]
  gear?: string[]
}

export interface StageDef {
  /** 1-based. */
  index: number
  chapter: number
  name: string
  /** The enemies' level. */
  level: number
  enemies: string[]
  energy: number
  /** The first clear. */
  first: Reward
  /** Every clear after the first. */
  repeat: Reward
}

export interface ChapterDef {
  index: number
  name: string
  /** CSS colours for the chapter's backdrop. */
  sky: [string, string]
}

export interface GearDef {
  id: string
  name: string
  slot: GearSlot
  rarity: Rarity
  /** Percent bonuses to attack, HP and defence; a flat bonus to speed. */
  bonus: { atk?: number; hp?: number; def?: number; spd?: number }
}

export type Counter =
  | 'battle_won'
  | 'stage_cleared'
  | 'idle_collected'
  | 'hero_levelled'
  | 'summoned'
  | 'energy_spent'
  | 'star_up'
  | 'login'

export interface QuestDef {
  id: string
  period: 'daily' | 'weekly'
  text: string
  counter: Counter
  target: number
  reward: Reward
}

export type ProductLimit = { period: 'daily' | 'weekly' | 'once'; count: number }

/**
 * A store product. Prices are in gems; every product's contents are fixed and listed. A `featured` product's
 * shards are of this week's featured hero of that rarity (the rotation is public: `featuredFor`).
 */
export interface ProductDef {
  id: string
  name: string
  text: string
  gems: number
  limit: ProductLimit
  reward: Reward
  /** Instead of `reward`: `n` shards of this week's featured hero of that rarity. */
  featured?: { rarity: 'legendary' | 'epic'; n: number }
}

export interface BannerDef {
  id: string
  name: string
  /** Sigils per draw. Sigils are earned in play only; nothing sells them (ADR-055: never paid chance). */
  cost: number
  odds: Record<Rarity, number>
  /** A legendary is certain on this draw when the ones before it had none. */
  pity: number
  /** Shards a duplicate turns into, by rarity. */
  duplicateShards: Record<Rarity, number>
}

export interface CasualPack {
  id: string
  name: string
  tagline: string
  heroes: HeroDef[]
  enemies: EnemyDef[]
  chapters: ChapterDef[]
  stages: StageDef[]
  gear: GearDef[]
  quests: QuestDef[]
  /** One reward per day of a 7-day cycle; the cycle moves on each day a reward is claimed. */
  calendar: Reward[]
  banner: BannerDef
  store: ProductDef[]
  start: { heroes: string[]; wallet: Partial<Record<Currency, number>> }
  energy: { max: number; regenMs: number }
  /** First clears of stages up to this one cost no energy, so the first minutes are all play. */
  freeFirstClears: number
  idle: { capMs: number; goldPerMinBase: number; goldPerMinPerStage: number; gemsPerHour: number }
  /** Shards that unlock a hero, by rarity. */
  fuseShards: Record<Rarity, number>
  /** Shards for each star after the current one: index = current stars. */
  starShards: number[]
  /** Gold for each star after the current one, per star: index = current stars. */
  starGold: number[]
  maxStars: number
  /** The level cap per star. */
  levelsPerStar: number
  teamSize: number
}

export interface HeroState {
  level: number
  stars: number
  gear: Partial<Record<GearSlot, string>>
}

/** A product's purchases in its current period (`key` is the day, the week or `once`). */
export interface BuyCount {
  key: string
  n: number
}

export interface PlayerState {
  v: 1
  created: number
  wallet: Record<Currency, number>
  energy: { value: number; at: number }
  heroes: Record<string, HeroState>
  shards: Record<string, number>
  /** Unequipped gear by id. */
  gear: Record<string, number>
  team: string[]
  stage: { cleared: number; stars: Record<string, number> }
  idle: { at: number }
  /** Counters keyed `d:<counter>` for today and `w:<counter>` for this week; `claimed` holds quest ids. */
  quests: { day: string; week: string; progress: Record<string, number>; claimed: string[] }
  login: { last: string | null; count: number }
  summon: { pity: number; total: number }
  buys: Record<string, BuyCount>
  stats: { battles: number; wins: number }
}

/** One ledger line: an asset (`gold`, `gems`, `gemsPaid`, `sigils`, `shard:<hero>`, `hero:<hero>`, `gear:<id>`). */
export interface Delta {
  asset: string
  delta: number
  balance: number
  reason: string
}
