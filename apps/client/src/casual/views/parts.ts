import {
  heroDef,
  heroStats,
  power,
  type CasualPack,
  type HeroDef,
  type HeroState,
  type Reward,
} from '@openvibe/casual'
import { elementBadge, heroPortrait, icon } from '../art.js'
import { h, num } from '../dom.js'

/** A row of stars, filled up to `n` of `max`. */
export function stars(n: number, max = n): HTMLElement {
  const row = h('span', { class: 'stars', attrs: { role: 'img', 'aria-label': `${n} stars` } })
  for (let i = 0; i < max; i++) row.append(icon('star', i < n ? 'ico star on' : 'ico star'))
  return row
}

/** A hero's card: portrait in a rarity frame, element, stars and level (or shard progress when locked). */
export function heroCard(
  pack: CasualPack,
  def: HeroDef,
  hs: HeroState | undefined,
  opts: { shards?: number; small?: boolean } = {},
): HTMLElement {
  const card = h('div', {
    class: `hero-card r-${def.rarity}${hs ? '' : ' locked'}${opts.small ? ' small' : ''}`,
  })
  const art = h('div', { class: `hero-art el-bg-${def.element}` }, heroPortrait(def, true))
  card.append(art, elementBadge(def.element))
  if (hs) {
    card.append(h('span', { class: 'lv', text: `Lv ${hs.level}` }), stars(hs.stars))
  } else {
    const need = pack.fuseShards[def.rarity]
    const have = opts.shards ?? 0
    card.append(
      h(
        'span',
        { class: 'shard-bar', attrs: { role: 'img', 'aria-label': `${have} of ${need} shards` } },
        h('i', { style: { width: `${Math.min(100, (have / need) * 100)}%` } }),
        h('b', { text: `${have}/${need}` }),
      ),
    )
  }
  if (!opts.small)
    card.append(h('span', { class: 'name', text: def.name.split(' ')[0] ?? def.name }))
  return card
}

export function heroPower(pack: CasualPack, id: string, hs: HeroState): number {
  const def = heroDef(pack, id)
  return def ? power(heroStats(pack, def, hs)) : 0
}

/** A reward as chips: gold, gems, sigils, energy, shards and gear. */
export function rewardChips(pack: CasualPack, r: Reward): HTMLElement {
  const row = h('div', { class: 'rewards' })
  const chip = (ico: string | null, text: string, cls = '') =>
    row.append(h('span', { class: `rw ${cls}` }, ico ? icon(ico) : null, h('b', { text })))
  if (r.gold) chip('gold', num(r.gold))
  if (r.gems) chip('gems', num(r.gems))
  if (r.sigils) chip('sigils', String(r.sigils))
  if (r.energy) chip('energy', String(r.energy))
  for (const s of r.shards ?? []) {
    const def = heroDef(pack, s.hero)
    if (!def) continue
    const mini = h('span', { class: `rw rw-shard r-${def.rarity}` })
    const face = h('span', { class: `rw-face el-bg-${def.element}` }, heroPortrait(def, true))
    mini.title = `${s.n} ${def.name} shard${s.n === 1 ? '' : 's'}`
    mini.append(
      face,
      h(
        'b',
        null,
        `${s.n} ${def.name.split(' ')[0]}`,
        h('span', { class: 'rw-unit', text: ` shard${s.n === 1 ? '' : 's'}` }),
      ),
    )
    row.append(mini)
  }
  for (const g of r.gear ?? []) {
    const def = pack.gear.find((x) => x.id === g)
    if (def) chip(null, `⚔ ${def.name}`, `r-${def.rarity}`)
  }
  return row
}

export function gearText(bonus: { atk?: number; hp?: number; def?: number; spd?: number }): string {
  const parts: string[] = []
  if (bonus.atk) parts.push(`ATK +${bonus.atk}%`)
  if (bonus.hp) parts.push(`HP +${bonus.hp}%`)
  if (bonus.def) parts.push(`DEF +${bonus.def}%`)
  if (bonus.spd) parts.push(`SPD +${bonus.spd}`)
  return parts.join(' · ')
}
