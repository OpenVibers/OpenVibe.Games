import { RARITY_ORDER } from './stats.js'
import type { CasualPack, Reward } from './types.js'

/** Problems with a pack; the server refuses to start with any. */
export function validatePack(pack: CasualPack): string[] {
  const errors: string[] = []
  const unique = (what: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${what} ${id} is listed twice`)
      seen.add(id)
      if (!/^[a-z0-9_]{1,40}$/.test(id)) errors.push(`${what} id ${id} is not [a-z0-9_]`)
    }
    return seen
  }
  const heroes = unique(
    'hero',
    pack.heroes.map((h) => h.id),
  )
  const enemies = unique(
    'enemy',
    pack.enemies.map((e) => e.id),
  )
  const gear = unique(
    'gear',
    pack.gear.map((g) => g.id),
  )
  unique(
    'quest',
    pack.quests.map((q) => q.id),
  )
  unique(
    'product',
    pack.store.map((p) => p.id),
  )
  const reward = (where: string, r: Reward) => {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0))
        errors.push(`${where}: ${k} ${v}`)
    }
    for (const s of r.shards ?? []) {
      if (!heroes.has(s.hero)) errors.push(`${where}: shards of unknown hero ${s.hero}`)
      if (!Number.isSafeInteger(s.n) || s.n <= 0) errors.push(`${where}: shard count ${s.n}`)
    }
    for (const g of r.gear ?? []) if (!gear.has(g)) errors.push(`${where}: unknown gear ${g}`)
  }
  for (const r of RARITY_ORDER) {
    if (!pack.heroes.some((h) => h.rarity === r)) errors.push(`no ${r} hero`)
  }
  const odds = Object.values(pack.banner.odds).reduce((a, b) => a + b, 0)
  if (Math.abs(odds - 1) > 1e-9) errors.push(`banner odds add up to ${odds}`)
  pack.stages.forEach((s, i) => {
    if (s.index !== i + 1) errors.push(`stage ${i + 1} has index ${s.index}`)
    if (!s.enemies.length) errors.push(`stage ${s.index} has no enemies`)
    for (const e of s.enemies)
      if (!enemies.has(e)) errors.push(`stage ${s.index}: unknown enemy ${e}`)
    if (!pack.chapters.some((c) => c.index === s.chapter))
      errors.push(`stage ${s.index}: no chapter ${s.chapter}`)
    reward(`stage ${s.index} first`, s.first)
    reward(`stage ${s.index} repeat`, s.repeat)
  })
  pack.quests.forEach((q) => reward(`quest ${q.id}`, q.reward))
  pack.calendar.forEach((r, i) => reward(`calendar day ${i + 1}`, r))
  for (const p of pack.store) {
    reward(`product ${p.id}`, p.reward)
    if (!Number.isSafeInteger(p.gems) || p.gems <= 0)
      errors.push(`product ${p.id}: price ${p.gems}`)
  }
  for (const h of pack.start.heroes) if (!heroes.has(h)) errors.push(`start hero ${h} is unknown`)
  if (pack.start.heroes.length > pack.teamSize) errors.push('more start heroes than a team holds')
  if (pack.starShards.length < pack.maxStars || pack.starGold.length < pack.maxStars)
    errors.push('star costs do not cover every star')
  return errors
}

/** A short fingerprint of the pack: the client sends it so a stale page reloads instead of playing old rules. */
export function packDigest(pack: CasualPack): string {
  const text = JSON.stringify(pack)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
