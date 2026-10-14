import { heroDef } from '@openvibe/casual'
import { icon } from '../art.js'
import { button, h, num, sheet } from '../dom.js'
import type { App } from '../app.js'

export function openMenu(app: App): void {
  const s = sheet('Vibe Heroes')
  const p = app.player
  s.body.append(
    h(
      'div',
      { class: 'panel who' },
      p.signedIn
        ? h(
            'p',
            null,
            'Signed in as ',
            h('b', { text: p.name ?? 'you' }),
            '. Your heroes are saved to your OpenVibe account on every device.',
          )
        : h(
            'p',
            null,
            h('b', { text: 'Playing as a guest. ' }),
            'Your progress lives in this browser. Sign in with the OpenVibe button at the top of the page to keep it on every device; this guest save moves into your account.',
          ),
    ),
    h(
      'div',
      { class: 'menu-list' },
      button([icon('trophy'), 'Leaderboard'], () => board(app), 'menu-item'),
      button([icon('quests'), 'Your history'], () => history(app), 'menu-item'),
      button([icon('summon'), 'How the game works'], () => rules(app), 'menu-item'),
    ),
  )
}

async function board(app: App): Promise<void> {
  const s = sheet('Leaderboard')
  s.body.append(
    h('p', {
      class: 'muted',
      text: 'The furthest signed-in players: highest stage, then team power.',
    }),
  )
  const list = h('ol', { class: 'board' })
  s.body.append(list)
  try {
    const { entries } = await app.api.leaderboard()
    if (!entries.length)
      list.append(
        h('li', { class: 'muted', text: 'Nobody yet. Sign in and clear a stage to be first.' }),
      )
    for (const e of entries) {
      list.append(
        h(
          'li',
          { class: e.name === app.player.name ? 'me' : '' },
          h('span', { class: 'rank', text: `#${e.rank}` }),
          h('b', { text: e.name }),
          h('span', { text: `Stage ${e.stage}` }),
          h('small', { class: 'muted', text: `Power ${num(e.power)}` }),
        ),
      )
    }
  } catch (err) {
    app.fail(err)
  }
}

const REASONS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^start$/, () => 'Starting gift'],
  [/^idle$/, () => 'Idle chest'],
  [/^stage:(\d+):first$/, (m) => `Stage ${m[1]} first clear`],
  [/^stage:(\d+)$/, (m) => `Stage ${m[1]} replay`],
  [/^sweep:(\d+)$/, (m) => `Stage ${m[1]} sweep`],
  [/^level:(.+)$/, () => 'Level up'],
  [/^star:(.+)$/, () => 'Star up'],
  [/^fuse:(.+)$/, () => 'Fuse'],
  [/^fuse$/, () => 'Fuse'],
  [/^summon$/, () => 'Summon'],
  [/^quest:(.+)$/, () => 'Quest reward'],
  [/^login:(\d+)$/, (m) => `Login day ${m[1]}`],
  [/^buy:(.+)$/, () => 'Shop'],
]

function assetName(app: App, asset: string): string {
  const [kind, id] = asset.split(':')
  if (kind === 'gold') return 'gold'
  if (kind === 'gems') return 'gems'
  if (kind === 'gemsPaid') return 'bought gems'
  if (kind === 'sigils') return 'sigils'
  if (kind === 'shard') return `${heroDef(app.pack, id ?? '')?.name ?? id} shards`
  if (kind === 'hero') return heroDef(app.pack, id ?? '')?.name ?? 'hero'
  if (kind === 'gear') return app.pack.gear.find((g) => g.id === id)?.name ?? 'gear'
  return asset
}

async function history(app: App): Promise<void> {
  const s = sheet('Your history', { wide: true })
  s.body.append(
    h('p', {
      class: 'muted',
      text: 'Every change to your currencies and items, newest first, as the server recorded it.',
    }),
  )
  const list = h('div', { class: 'ledger' })
  s.body.append(list)
  let before: number | null = null
  const more = button('Older', () => void load(), 'btn btn-wide')
  const load = async () => {
    try {
      const page = await app.api.ledger(before)
      for (const l of page.lines) {
        const rule = REASONS.find(([re]) => re.test(l.reason))
        const m = rule ? l.reason.match(rule[0]) : null
        list.append(
          h(
            'div',
            { class: 'ledger-row' },
            h('span', {
              class: l.delta >= 0 ? 'plus' : 'minus',
              text: `${l.delta >= 0 ? '+' : '−'}${num(Math.abs(l.delta))} ${assetName(app, l.asset)}`,
            }),
            h('small', {
              class: 'muted',
              text: `${rule && m ? rule[1](m) : l.reason} · ${new Date(l.at).toLocaleString()}`,
            }),
          ),
        )
      }
      before = page.next
      if (before) s.body.append(more)
      else more.remove()
    } catch (err) {
      app.fail(err)
    }
  }
  await load()
}

function rules(app: App): void {
  const s = sheet('How the game works', { wide: true })
  const pk = app.pack
  s.body.append(
    h(
      'ul',
      { class: 'rules' },
      h('li', {
        text: 'Your team fights on its own. Win stages to earn gold, gems, sigils, hero shards and gear. Each chapter ends with a boss.',
      }),
      h('li', {
        text: `The first ${pk.freeFirstClears} stages are free; after that a battle costs energy, which refills one point every five minutes up to ${pk.energy.max}. A lost battle costs only one.`,
      }),
      h('li', {
        text: 'The idle chest fills with gold (and a gem an hour) while you are away, for up to twelve hours.',
      }),
      h('li', {
        text: `Collect shards to fuse a hero: ${pk.fuseShards.common} common, ${pk.fuseShards.rare} rare, ${pk.fuseShards.epic} epic, ${pk.fuseShards.legendary} legendary. More shards raise a hero’s stars, and each star raises the level cap by ${pk.levelsPerStar}.`,
      }),
      h('li', {
        text: 'Flame beats Grove, Grove beats Tide, Tide beats Flame; Dawn and Dusk each beat the other.',
      }),
      h('li', {
        text: 'Summons use sigils, which are earned in play and never sold. The odds of every hero are published, and a legendary is guaranteed within a fixed number of draws.',
      }),
      h('li', {
        text: 'Everything in the shop lists exactly what you get. Nothing in Vibe Heroes is a paid random draw.',
      }),
      h('li', {
        text: 'Every hero and enemy is an original OpenVibe character, and every hero is an adult.',
      }),
    ),
  )
}
