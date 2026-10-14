import { drawOdds, featuredFor, heroDef, type Rarity } from '@openvibe/casual'
import { RARITY_NAME, heroPortrait, icon } from '../art.js'
import { button, duration, h, sheet, tick } from '../dom.js'
import type { App } from '../app.js'
import { heroSheet } from './heroes.js'

export function summonView(app: App): HTMLElement {
  const { pack, state: s } = app
  const b = pack.banner
  const f = featuredFor(pack, app.now())
  const legend = heroDef(pack, f.legendary)
  const epic = heroDef(pack, f.epic)
  const view = h('div', { class: 'summon' })
  const left = b.pity - s.summon.pity
  const countdown = h('span')
  tick(countdown, () => `Changes in ${duration(f.until - app.now())}`)
  const art = h('div', { class: 'banner-art' })
  if (epic)
    art.append(h('div', { class: `banner-hero second el-bg-${epic.element}` }, heroPortrait(epic)))
  if (legend)
    art.append(
      h('div', { class: `banner-hero first el-bg-${legend.element}` }, heroPortrait(legend)),
    )
  view.append(
    h(
      'article',
      { class: 'banner' },
      art,
      h(
        'div',
        { class: 'banner-text' },
        h('small', { text: 'This week’s featured heroes' }),
        h('h1', { text: b.name }),
        h(
          'p',
          null,
          legend ? h('b', { text: `${legend.name}` }) : null,
          ' and ',
          epic ? h('b', { text: epic.name }) : null,
          ' take half of their rarity’s chance.',
        ),
        h('p', { class: 'muted' }, countdown),
      ),
    ),
    h(
      'div',
      { class: 'pity', attrs: { role: 'group', 'aria-label': 'Legendary guarantee' } },
      h(
        'div',
        { class: 'pity-bar' },
        h('i', { style: { width: `${(s.summon.pity / b.pity) * 100}%` } }),
      ),
      h('span', {
        text:
          left <= 1
            ? 'The next draw is a legendary'
            : `A legendary within ${left} draws, guaranteed`,
      }),
    ),
  )
  const pull = (count: 1 | 10) => {
    const btn = button(
      [
        h('span', { class: 'big', text: `Summon ×${count}` }),
        h('small', null, icon('sigils'), String(b.cost * count)),
      ],
      async () => {
        const a = await app.run({ t: 'summon', count }, { quiet: true })
        if (a) reveal(app, a.result.pulls as Pull[])
      },
      `btn ${count === 10 ? 'btn-gold' : 'btn-violet'} btn-summon`,
    )
    btn.disabled = s.wallet.sigils < b.cost * count
    return btn
  }
  view.append(
    h('div', { class: 'summon-btns' }, pull(1), pull(10)),
    h(
      'p',
      { class: 'muted center' },
      `You have ${s.wallet.sigils} sigils. Sigils come only from playing: quests, login rewards and stages. They are never sold. Ten at once always holds an epic or better.`,
    ),
    button('See the odds of every hero', () => oddsSheet(app), 'btn btn-link'),
  )
  return view
}

interface Pull {
  hero: string
  rarity: Rarity
  new: boolean
  shards: number
}

function reveal(app: App, pulls: Pull[]): void {
  const s = sheet(pulls.length === 1 ? 'Summon' : 'Summon ×10', {
    wide: true,
    onClose: () => app.render(),
  })
  const grid = h('div', { class: `reveal${pulls.length === 1 ? ' one' : ''}` })
  pulls.forEach((p, i) => {
    const def = heroDef(app.pack, p.hero)
    if (!def) return
    const card = h(
      'div',
      { class: `reveal-card r-${p.rarity}`, style: { 'animation-delay': `${i * 110}ms` } },
      h('div', { class: `hero-art el-bg-${def.element}` }, heroPortrait(def, true)),
      h('b', { text: def.name.split(' ')[0] ?? def.name }),
      h('small', {
        text: p.new ? `New ${RARITY_NAME[p.rarity].toLowerCase()}!` : `+${p.shards} shards`,
      }),
    )
    grid.append(
      button(card, () => heroSheet(app, def.id), 'pick', {
        'aria-label': `${def.name}, ${p.new ? 'new' : `${p.shards} shards`}`,
      }),
    )
  })
  s.body.append(
    grid,
    button('Done', () => s.close(), 'btn btn-gold btn-wide'),
  )
}

function oddsSheet(app: App): void {
  const s = sheet('Summon odds', { wide: true })
  const b = app.pack.banner
  const odds = drawOdds(app.pack, app.now())
  const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 3 : 2)}%`
  s.body.append(
    h(
      'p',
      null,
      'Each draw costs ',
      h('b', { text: `${b.cost} sigil` }),
      '. Sigils are earned in play only and are never sold, so no draw is ever bought with money.',
    ),
    h(
      'ul',
      { class: 'odds-rules' },
      h('li', {
        text: `Legendary ${pct(b.odds.legendary)}, epic ${pct(b.odds.epic)}, rare ${pct(b.odds.rare)}, common ${pct(b.odds.common)}.`,
      }),
      h('li', {
        text: `The featured legendary and epic each take half of their rarity’s chance; the rest is shared evenly.`,
      }),
      h('li', {
        text: `A legendary is certain by draw ${b.pity} since the last one (your counter is shown above the buttons).`,
      }),
      h('li', { text: 'Ten at once always holds at least one epic or legendary.' }),
      h('li', {
        text: `A hero you already have turns into shards: ${b.duplicateShards.common} common, ${b.duplicateShards.rare} rare, ${b.duplicateShards.epic} epic, ${b.duplicateShards.legendary} legendary.`,
      }),
    ),
  )
  const table = h('table', { class: 'odds' })
  table.append(
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', { text: 'Hero' }),
        h('th', { text: 'Rarity' }),
        h('th', { text: 'Chance' }),
      ),
    ),
  )
  const body = h('tbody')
  for (const o of odds) {
    const def = heroDef(app.pack, o.hero)
    body.append(
      h(
        'tr',
        null,
        h('td', { text: def?.name ?? o.hero }),
        h('td', { text: RARITY_NAME[o.rarity] }),
        h('td', { text: pct(o.chance) }),
      ),
    )
  }
  table.append(body)
  s.body.append(table)
}
