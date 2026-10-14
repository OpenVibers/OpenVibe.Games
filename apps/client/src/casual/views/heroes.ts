import {
  BASE_STARS,
  heroDef,
  heroStats,
  levelCap,
  levelCost,
  levelCostFor,
  power,
  type GearSlot,
  type HeroDef,
} from '@openvibe/casual'
import { CLASS_NAME, ELEMENT_NAME, RARITY_NAME, elementBadge, heroPortrait, icon } from '../art.js'
import { button, h, num, sheet, toast } from '../dom.js'
import type { App } from '../app.js'
import { gearText, heroCard, heroPower, stars } from './parts.js'

const RANK = { legendary: 0, epic: 1, rare: 2, common: 3 }

export function heroesView(app: App): HTMLElement {
  const { pack, state: s } = app
  const owned = pack.heroes
    .filter((d) => s.heroes[d.id])
    .sort((a, b) => heroPower(pack, b.id, s.heroes[b.id]!) - heroPower(pack, a.id, s.heroes[a.id]!))
  const locked = pack.heroes
    .filter((d) => !s.heroes[d.id])
    .sort(
      (a, b) =>
        (s.shards[b.id] ?? 0) / pack.fuseShards[b.rarity] -
          (s.shards[a.id] ?? 0) / pack.fuseShards[a.rarity] || RANK[a.rarity] - RANK[b.rarity],
    )
  const view = h('div', { class: 'heroes' })
  const grid = (list: HeroDef[]) => {
    const g = h('div', { class: 'hero-grid' })
    for (const d of list) {
      const hs = s.heroes[d.id]
      const card = heroCard(pack, d, hs, { shards: s.shards[d.id] ?? 0 })
      if (s.team.includes(d.id)) card.append(h('span', { class: 'in-team', text: 'Team' }))
      const ready = hs
        ? hs.stars < pack.maxStars &&
          (s.shards[d.id] ?? 0) >= (pack.starShards[hs.stars] ?? Infinity)
        : (s.shards[d.id] ?? 0) >= pack.fuseShards[d.rarity]
      if (ready) card.append(h('i', { class: 'dot' }))
      g.append(
        button(card, () => heroSheet(app, d.id), 'pick', {
          'aria-label': `${d.name}${ready ? ', ready' : ''}`,
        }),
      )
    }
    return g
  }
  view.append(
    h('div', { class: 'panel-head' }, h('h2', { text: `Your heroes (${owned.length})` })),
    grid(owned),
    h('div', { class: 'panel-head' }, h('h2', { text: 'Not yet fused' })),
    h('p', { class: 'muted section-note', text: 'Shards come from stages, summons and the shop.' }),
    grid(locked),
  )
  return view
}

export function heroSheet(app: App, id: string): void {
  const def = heroDef(app.pack, id)
  if (!def) return
  const s = sheet(def.name, { wide: true, onClose: () => app.render() })
  const draw = () => {
    const { pack, state } = app
    const hs = state.heroes[id]
    const shards = state.shards[id] ?? 0
    s.body.replaceChildren()
    const head = h(
      'div',
      { class: `hero-head r-${def.rarity}` },
      h('div', { class: `hero-big el-bg-${def.element}` }, heroPortrait(def)),
      h(
        'div',
        { class: 'hero-id' },
        h('small', { class: `rarity r-${def.rarity}`, text: RARITY_NAME[def.rarity] }),
        h('h3', { text: def.title }),
        h(
          'div',
          { class: 'tags' },
          elementBadge(def.element),
          h('span', { text: `${ELEMENT_NAME[def.element]} · ${CLASS_NAME[def.class]}` }),
          icon(def.class),
        ),
        hs ? stars(hs.stars, pack.maxStars) : stars(BASE_STARS[def.rarity], pack.maxStars),
        h('p', { class: 'bio', text: def.bio }),
      ),
    )
    s.body.append(head)
    const show = hs ?? { level: 1, stars: BASE_STARS[def.rarity], gear: {} }
    const st = heroStats(pack, def, show)
    s.body.append(
      h(
        'div',
        { class: 'stats' },
        ...[
          ['Power', num(power(st))],
          ['HP', num(st.hp)],
          ['ATK', num(st.atk)],
          ['DEF', num(st.def)],
          ['SPD', String(st.spd)],
        ].map(([k, v]) => h('div', null, h('small', { text: k ?? '' }), h('b', { text: v ?? '' }))),
      ),
      h(
        'div',
        { class: 'skill' },
        h('b', { text: def.skill.name }),
        h('span', { text: def.skill.text }),
      ),
    )
    if (!hs) {
      const need = pack.fuseShards[def.rarity]
      const fuse = button(
        `Fuse (${shards}/${need} shards)`,
        async () => {
          if (await app.run({ t: 'fuse', hero: id }, { quiet: true })) {
            toast(`${def.name} joined your heroes!`, 'good')
            draw()
          }
        },
        'btn btn-gold btn-wide',
      )
      fuse.disabled = shards < need
      s.body.append(fuse)
      return
    }
    // Level
    const cap = levelCap(pack, hs.stars)
    const levelRow = h('div', { class: 'upgrade' })
    levelRow.append(
      h(
        'div',
        null,
        h('b', { text: `Level ${hs.level} / ${cap}` }),
        h('small', {
          class: 'muted',
          text:
            hs.level < cap
              ? `Next level: ${num(levelCost(hs.level))} gold`
              : 'Star up to raise the cap',
        }),
      ),
    )
    const lvl = (times: number, label: string) => {
      const n = Math.min(times, cap - hs.level)
      const b = button(
        label,
        async () => {
          const a = await app.run({ t: 'level', hero: id, times }, { quiet: true })
          if (a) draw()
        },
        'btn btn-small',
      )
      b.disabled = n <= 0 || state.wallet.gold < levelCost(hs.level)
      b.title = n > 0 ? `${num(levelCostFor(hs.level, n))} gold for ${n}` : ''
      return b
    }
    levelRow.append(h('div', { class: 'btn-row' }, lvl(1, '+1'), lvl(10, '+10'), lvl(200, 'Max')))
    s.body.append(levelRow)
    // Stars
    if (hs.stars < pack.maxStars) {
      const needShards = pack.starShards[hs.stars] ?? 0
      const needGold = pack.starGold[hs.stars] ?? 0
      const star = button(
        ['Star up ', icon('star')],
        async () => {
          if (await app.run({ t: 'star', hero: id }, { quiet: true })) {
            toast(`${def.name} reached ${hs.stars + 1} stars`, 'good')
            draw()
          }
        },
        'btn btn-gold btn-small',
      )
      star.disabled = shards < needShards || state.wallet.gold < needGold
      s.body.append(
        h(
          'div',
          { class: 'upgrade' },
          h(
            'div',
            null,
            h('b', { text: `Stars ${hs.stars} → ${hs.stars + 1}` }),
            h('small', {
              class: 'muted',
              text: `${shards}/${needShards} shards · ${num(needGold)} gold · level cap ${cap} → ${cap + pack.levelsPerStar}`,
            }),
          ),
          star,
        ),
      )
    }
    // Gear
    const slots: GearSlot[] = ['weapon', 'armor', 'charm']
    const gearRow = h('div', { class: 'gear-row' })
    for (const slot of slots) {
      const gid = hs.gear[slot]
      const g = gid ? pack.gear.find((x) => x.id === gid) : undefined
      gearRow.append(
        button(
          [
            h('small', { text: slot }),
            h('b', { text: g ? g.name : 'Empty' }),
            g ? h('span', { class: 'muted', text: gearText(g.bonus) }) : null,
          ],
          () => gearPicker(app, id, slot, draw),
          `gear-slot${g ? ` r-${g.rarity}` : ''}`,
        ),
      )
    }
    s.body.append(h('h4', { text: 'Gear' }), gearRow)
    // Team
    const inTeam = state.team.includes(id)
    const teamBtn = button(
      inTeam ? 'Remove from team' : 'Add to team',
      async () => {
        const next = inTeam ? state.team.filter((x) => x !== id) : [...state.team, id]
        if (!inTeam && next.length > pack.teamSize) {
          toast(`A team holds ${pack.teamSize}. Remove someone first.`)
          return
        }
        if (await app.run({ t: 'team', heroes: next }, { quiet: true })) draw()
      },
      'btn btn-wide',
    )
    if (inTeam && state.team.length === 1) teamBtn.disabled = true
    s.body.append(teamBtn)
  }
  draw()
}

function gearPicker(app: App, hero: string, slot: GearSlot, done: () => void): void {
  const s = sheet(`Choose ${slot}`)
  const hs = app.state.heroes[hero]
  const list = h('div', { class: 'gear-list' })
  const own = app.pack.gear.filter((g) => g.slot === slot && (app.state.gear[g.id] ?? 0) > 0)
  if (hs?.gear[slot]) {
    list.append(
      button(
        'Take it off',
        async () => {
          if (await app.run({ t: 'equip', hero, slot, gear: null }, { quiet: true })) {
            s.close()
            done()
          }
        },
        'btn',
      ),
    )
  }
  for (const g of own) {
    list.append(
      button(
        [
          h('b', { text: g.name }),
          h('span', { class: 'muted', text: `${gearText(g.bonus)} · ×${app.state.gear[g.id]}` }),
        ],
        async () => {
          if (await app.run({ t: 'equip', hero, slot, gear: g.id }, { quiet: true })) {
            s.close()
            done()
          }
        },
        `gear-choice r-${g.rarity}`,
      ),
    )
  }
  if (!own.length && !hs?.gear[slot]) {
    list.append(
      h('p', {
        class: 'muted',
        text: 'No spare gear for this slot yet. Bosses drop gear every ten stages, and the shop sells some.',
      }),
    )
  }
  s.body.append(list)
}
