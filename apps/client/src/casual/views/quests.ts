import {
  boughtThisPeriod,
  dayKey,
  productReward,
  questProgress,
  resets,
  type QuestDef,
} from '@openvibe/casual'
import { icon } from '../art.js'
import { button, duration, h, sheet, tick, toast } from '../dom.js'
import type { App } from '../app.js'
import { rewardChips } from './parts.js'

export function questsView(app: App): HTMLElement {
  const { pack, state: s } = app
  const now = app.now()
  const view = h('div', { class: 'quests' })

  // ── Login calendar ──
  const today = s.login.last === dayKey(now)
  const cycleDay = s.login.count % pack.calendar.length
  const cal = h('div', { class: 'calendar' })
  pack.calendar.forEach((r, i) => {
    const claimed = i < cycleDay || (today && i === cycleDay - 1)
    const isToday = !today && i === cycleDay
    const cell = h(
      'div',
      {
        class: `cal-day${claimed ? ' done' : ''}${isToday ? ' today' : ''}${i === pack.calendar.length - 1 ? ' big' : ''}`,
      },
      h('small', { text: `Day ${i + 1}` }),
      rewardChips(pack, r),
    )
    cal.append(cell)
  })
  const claim = button(
    'Claim today',
    async () => {
      if (await app.run({ t: 'login' })) toast('Login reward claimed', 'good')
    },
    `btn btn-gold${today ? '' : ' pulse'}`,
  )
  claim.disabled = today
  view.append(
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Login rewards' }), claim),
      cal,
      h('p', {
        class: 'muted',
        text: 'One reward a day you play. Missing a day never resets the calendar.',
      }),
    ),
  )

  const list = (period: 'daily' | 'weekly') => {
    const panel = h('section', { class: 'panel' })
    const until = period === 'daily' ? resets(now).day : resets(now).week
    const left = h('small', { class: 'muted' })
    tick(left, () => `Resets in ${duration(until - app.now())}`)
    panel.append(
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: period === 'daily' ? 'Daily quests' : 'Weekly quests' }),
        left,
      ),
    )
    const quests = pack.quests.filter((q) => q.period === period)
    for (const q of sortQuests(app, quests)) panel.append(questRow(app, q))
    return panel
  }
  view.append(list('daily'), list('weekly'))
  return view
}

function sortQuests(app: App, quests: QuestDef[]): QuestDef[] {
  const now = app.now()
  const order = (q: QuestDef) => {
    const p = questProgress(app.state, q, now)
    return p.claimed ? 2 : p.n >= q.target ? 0 : 1
  }
  return [...quests].sort((a, b) => order(a) - order(b))
}

function questRow(app: App, q: QuestDef): HTMLElement {
  const p = questProgress(app.state, q, app.now())
  const done = p.n >= q.target
  const row = h(
    'div',
    { class: `quest${p.claimed ? ' claimed' : done ? ' ready' : ''}` },
    h(
      'div',
      { class: 'quest-text' },
      h('b', { text: q.text }),
      h(
        'span',
        { class: 'progress', attrs: { 'aria-label': `${Math.min(p.n, q.target)} of ${q.target}` } },
        h('i', { style: { width: `${Math.min(100, (p.n / q.target) * 100)}%` } }),
      ),
      rewardChips(app.pack, q.reward),
    ),
  )
  const b = button(
    p.claimed ? 'Done' : done ? 'Claim' : `${Math.min(p.n, q.target)}/${q.target}`,
    async () => {
      if (await app.run({ t: 'quest', quest: q.id })) toast('Quest reward claimed', 'good')
    },
    `btn btn-small${done && !p.claimed ? ' btn-gold' : ''}`,
  )
  b.disabled = p.claimed || !done
  row.append(b)
  return row
}

export function shopView(app: App): HTMLElement {
  const { pack, state: s } = app
  const now = app.now()
  const view = h('div', { class: 'shop' })
  view.append(
    h(
      'div',
      { class: 'panel shop-head' },
      icon('gems', 'ico big'),
      h(
        'div',
        null,
        h('h2', { text: `${s.wallet.gems + s.wallet.gemsPaid} gems` }),
        h('small', {
          class: 'muted',
          text: 'Earn gems from stages, quests, logins and the idle chest. Every item lists exactly what you get.',
        }),
      ),
    ),
  )
  const grid = h('div', { class: 'shop-grid' })
  for (const p of pack.store) {
    const bought = boughtThisPeriod(s, p, now)
    const left = p.limit.count - bought
    const reward = productReward(pack, s, p.id, now) ?? {}
    const per =
      p.limit.period === 'daily' ? 'today' : p.limit.period === 'weekly' ? 'this week' : 'ever'
    const buy = button(
      [icon('gems'), String(p.gems)],
      () => confirmBuy(app, p.id),
      'btn btn-gold btn-small',
      {
        'aria-label': `Buy ${p.name} for ${p.gems} gems`,
      },
    )
    buy.disabled = left <= 0 || s.wallet.gems + s.wallet.gemsPaid < p.gems
    grid.append(
      h(
        'article',
        { class: `product${left <= 0 ? ' sold' : ''}` },
        h('h3', { text: p.name }),
        h('p', { class: 'muted', text: p.text }),
        rewardChips(pack, reward),
        h(
          'div',
          { class: 'product-foot' },
          h('small', {
            class: 'muted',
            text: left > 0 ? `${left} left ${per}` : `Sold out ${per}`,
          }),
          buy,
        ),
      ),
    )
  }
  view.append(grid)
  return view
}

function confirmBuy(app: App, id: string): void {
  const p = app.pack.store.find((x) => x.id === id)
  if (!p) return
  const s = sheet(p.name)
  const reward = productReward(app.pack, app.state, id, app.now()) ?? {}
  s.body.append(
    h('p', { text: 'You get exactly:' }),
    rewardChips(app.pack, reward),
    h(
      'p',
      null,
      'Price: ',
      h('b', { text: `${p.gems} gems` }),
      app.state.wallet.gems < p.gems && app.state.wallet.gemsPaid
        ? h('span', { class: 'muted', text: ' (earned gems first, then bought ones)' })
        : null,
    ),
    button(
      'Buy',
      async () => {
        if (await app.run({ t: 'buy', product: id })) {
          s.close()
          toast(`Bought ${p.name}`, 'good')
        }
      },
      'btn btn-gold btn-wide',
    ),
  )
}
