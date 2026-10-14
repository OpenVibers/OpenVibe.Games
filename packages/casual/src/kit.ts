/**
 * Read-only views of a player's state at a time: energy, idle earnings, this week's featured heroes, resets and
 * the red dots. Both sides use them; only the server's answers count.
 */
import { heroStats, power } from './stats.js'
import { dayKey, nextDay, nextWeek, weekIndex, weekKey } from './time.js'
import type { CasualPack, HeroDef, PlayerState, QuestDef, Rarity } from './types.js'

export function heroDef(pack: CasualPack, id: string): HeroDef | undefined {
  return pack.heroes.find((h) => h.id === id)
}

/** Energy now: it refills one point per `regenMs` up to the cap; refills above the cap stay until spent. */
export function energyNow(pack: CasualPack, s: PlayerState, now: number): number {
  const e = s.energy
  if (e.value >= pack.energy.max) return e.value
  const ticks = Math.max(0, Math.floor((now - e.at) / pack.energy.regenMs))
  return Math.min(pack.energy.max, e.value + ticks)
}

/** When the next energy point arrives, or null when full. */
export function nextEnergyAt(pack: CasualPack, s: PlayerState, now: number): number | null {
  if (energyNow(pack, s, now) >= pack.energy.max) return null
  const regen = pack.energy.regenMs
  const ticks = Math.max(0, Math.floor((now - s.energy.at) / regen))
  return s.energy.at + (ticks + 1) * regen
}

export function goldPerMinute(pack: CasualPack, s: PlayerState): number {
  return pack.idle.goldPerMinBase + pack.idle.goldPerMinPerStage * s.stage.cleared
}

/** What the idle chest holds now (it stops filling at `capMs`). */
export function idlePending(
  pack: CasualPack,
  s: PlayerState,
  now: number,
): { minutes: number; gold: number; gems: number; full: boolean } {
  const ms = Math.max(0, Math.min(now - s.idle.at, pack.idle.capMs))
  const minutes = Math.floor(ms / 60_000)
  return {
    minutes,
    gold: minutes * goldPerMinute(pack, s),
    gems: Math.floor(minutes / 60) * pack.idle.gemsPerHour,
    full: now - s.idle.at >= pack.idle.capMs,
  }
}

/** This week's featured legendary and epic (a public rotation by week number) and when it changes. */
export function featuredFor(
  pack: CasualPack,
  now: number,
): { legendary: string; epic: string; until: number } {
  const w = weekIndex(now)
  const of = (r: Rarity) => pack.heroes.filter((h) => h.rarity === r)
  const legendaries = of('legendary')
  const epics = of('epic')
  return {
    legendary: legendaries[w % legendaries.length]?.id ?? '',
    epic: epics[w % epics.length]?.id ?? '',
    until: nextWeek(now),
  }
}

/**
 * Each hero's chance on one draw, as published: a rarity's share is split evenly, except that the featured hero
 * of that rarity takes half of it.
 */
export function drawOdds(
  pack: CasualPack,
  now: number,
): { hero: string; rarity: Rarity; chance: number }[] {
  const featured = featuredFor(pack, now)
  const out: { hero: string; rarity: Rarity; chance: number }[] = []
  for (const rarity of ['legendary', 'epic', 'rare', 'common'] as Rarity[]) {
    const list = pack.heroes.filter((h) => h.rarity === rarity)
    const share = pack.banner.odds[rarity]
    const pick =
      rarity === 'legendary' ? featured.legendary : rarity === 'epic' ? featured.epic : null
    for (const h of list) {
      const chance =
        pick && list.length > 1
          ? h.id === pick
            ? share / 2
            : share / 2 / (list.length - 1)
          : share / list.length
      out.push({ hero: h.id, rarity, chance })
    }
  }
  return out
}

/** Quest progress for the current day and week (a stale period reads as zero). */
export function questProgress(
  s: PlayerState,
  q: QuestDef,
  now: number,
): { n: number; claimed: boolean } {
  const current =
    q.period === 'daily' ? s.quests.day === dayKey(now) : s.quests.week === weekKey(now)
  if (!current) return { n: 0, claimed: false }
  // Daily and weekly quests share the counters map, keyed by period.
  const key = `${q.period === 'daily' ? 'd' : 'w'}:${q.counter}`
  const n = s.quests.progress[key] ?? 0
  return { n, claimed: s.quests.claimed.includes(q.id) }
}

export function resets(now: number): { day: number; week: number } {
  return { day: nextDay(now), week: nextWeek(now) }
}

export function teamPower(pack: CasualPack, s: PlayerState): number {
  let total = 0
  for (const id of s.team) {
    const def = heroDef(pack, id)
    const hs = s.heroes[id]
    if (def && hs) total += power(heroStats(pack, def, hs))
  }
  return total
}

export function gemsTotal(s: PlayerState): number {
  return s.wallet.gems + s.wallet.gemsPaid
}

/**
 * The red dots: what is waiting to be claimed or can be done right now. Heroes count only a fuse or a star-up
 * (levelling is always possible with some gold, and a dot that never goes away teaches players to ignore dots).
 */
export function notices(
  pack: CasualPack,
  s: PlayerState,
  now: number,
): { idle: boolean; login: boolean; quests: number; heroes: number; summon: boolean } {
  let quests = 0
  for (const q of pack.quests) {
    const p = questProgress(s, q, now)
    if (!p.claimed && p.n >= q.target) quests++
  }
  let heroes = 0
  for (const h of pack.heroes) {
    const hs = s.heroes[h.id]
    const shards = s.shards[h.id] ?? 0
    if (!hs) {
      if (shards >= pack.fuseShards[h.rarity]) heroes++
      continue
    }
    if (
      hs.stars < pack.maxStars &&
      shards >= (pack.starShards[hs.stars] ?? Infinity) &&
      s.wallet.gold >= (pack.starGold[hs.stars] ?? Infinity)
    )
      heroes++
  }
  return {
    idle: idlePending(pack, s, now).minutes >= 60,
    login: s.login.last !== dayKey(now),
    quests,
    heroes,
    summon: s.wallet.sigils >= pack.banner.cost,
  }
}
