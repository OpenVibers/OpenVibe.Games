import {
  enemyStats,
  energyNow,
  goldPerMinute,
  heroDef,
  idlePending,
  nextEnergyAt,
  teamPower,
  power,
  dayKey,
} from '@openvibe/casual'
import { enemyArt, icon } from '../art.js'
import { button, duration, h, num, sheet, tick, toast } from '../dom.js'
import type { App } from '../app.js'
import { playBattle } from './battle.js'
import { heroCard, heroPower, rewardChips, stars } from './parts.js'

export function homeView(app: App): HTMLElement {
  const { pack, state: s } = app
  const now = app.now()
  const next = Math.min(s.stage.cleared + 1, pack.stages.length)
  const stage = pack.stages[next - 1]!
  const chapter = pack.chapters.find((c) => c.index === stage.chapter)!
  const first = next > s.stage.cleared
  const cost = first && next <= pack.freeFirstClears ? 0 : stage.energy
  const allClear = s.stage.cleared >= pack.stages.length
  const view = h('div', { class: 'home' })

  // ── The next stage ──
  const foes = h('div', { class: 'foes' })
  for (const id of stage.enemies) {
    const e = pack.enemies.find((x) => x.id === id)
    if (e)
      foes.append(
        h('div', { class: `foe-mini${e.boss ? ' boss' : ''}`, title: e.name }, enemyArt(e)),
      )
  }
  const enemyPower = stage.enemies.reduce((sum, id) => {
    const e = pack.enemies.find((x) => x.id === id)
    return e ? sum + power(enemyStats(e.class, stage.level, stage.index, e.boss)) : sum
  }, 0)
  const mine = teamPower(pack, s)
  const energy = energyNow(pack, s, now)
  const enough = energy >= cost
  const battleBtn = button(
    [
      h('span', { class: 'big', text: allClear ? 'Replay' : 'Battle' }),
      h('small', null, cost ? icon('energy') : null, cost ? String(cost) : 'Free'),
    ],
    () => void playBattle(app, next),
    `btn btn-gold btn-battle${s.stage.cleared === 0 ? ' pulse' : ''}`,
  )
  if (!enough) {
    battleBtn.disabled = true
    const at = nextEnergyAt(pack, s, now)
    battleBtn
      .querySelector('small')
      ?.replaceChildren(
        tick(
          h('span'),
          () =>
            `Energy in ${duration(Math.max(0, (at ?? now) + (cost - energy - 1) * pack.energy.regenMs - app.now()))}`,
        ),
      )
  }
  const chapterProgress = ((next - 1) % 10) + (allClear ? 1 : 0)
  view.append(
    h(
      'article',
      {
        class: 'stage-card',
        style: { '--sky-a': chapter.sky[0], '--sky-b': chapter.sky[1] },
      },
      h(
        'div',
        { class: 'stage-head' },
        h(
          'div',
          null,
          h('small', { text: `Chapter ${chapter.index}` }),
          h('h1', { text: chapter.name }),
        ),
        button([icon('board'), 'Stages'], () => stageList(app), 'btn btn-small btn-glass'),
      ),
      h(
        'div',
        {
          class: 'chapter-track',
          attrs: { role: 'img', 'aria-label': `Stage ${next} of ${pack.stages.length}` },
        },
        ...Array.from({ length: 10 }, (_, i) =>
          h('i', {
            class:
              i < chapterProgress ? 'done' : i === chapterProgress ? 'here' : i === 9 ? 'boss' : '',
          }),
        ),
      ),
      foes,
      h(
        'div',
        { class: 'stage-meta' },
        h('span', {
          text: `Stage ${next}${stage.enemies.some((id) => pack.enemies.find((e) => e.id === id)?.boss) ? ' · Boss' : ''}`,
        }),
        h('span', { text: `Enemy Lv ${stage.level}` }),
        h('span', {
          class: mine >= enemyPower ? 'ok' : 'warn',
          text: `Power ${num(mine)} vs ${num(enemyPower)}`,
        }),
      ),
      first && !allClear
        ? h(
            'div',
            { class: 'first-reward' },
            h('small', { text: 'First clear' }),
            rewardChips(pack, stage.first),
          )
        : null,
      battleBtn,
      s.stage.cleared === 0
        ? h('p', { class: 'hint', text: 'Tap Battle. Your heroes fight on their own.' })
        : null,
    ),
  )

  // ── Team ──
  const strip = h('div', { class: 'team-strip' })
  for (let i = 0; i < pack.teamSize; i++) {
    const id = s.team[i]
    const def = id ? heroDef(pack, id) : undefined
    const hs = id ? s.heroes[id] : undefined
    strip.append(
      def && hs
        ? heroCard(pack, def, hs, { small: true })
        : h(
            'div',
            { class: 'hero-card empty small', attrs: { role: 'img', 'aria-label': 'Empty slot' } },
            '+',
          ),
    )
  }
  view.append(
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: 'Team' }),
        h('span', { class: 'muted', text: `Power ${num(mine)}` }),
        button('Edit', () => teamEditor(app), 'btn btn-small'),
      ),
      strip,
    ),
  )

  // ── Idle chest ──
  const idle = h('section', { class: 'panel idle' })
  const pending = () => idlePending(pack, app.state, app.now())
  const amount = h('b')
  tick(amount, () => {
    const p = pending()
    return `${num(p.gold)} gold${p.gems ? ` · ${p.gems} gems` : ''}`
  })
  const status = h('small', { class: 'muted' })
  tick(status, () => {
    const p = pending()
    if (p.full) return 'Full: collect it to keep earning'
    return `${num(goldPerMinute(pack, app.state))} gold a minute · full in ${duration(pack.idle.capMs - (app.now() - app.state.idle.at))}`
  })
  const collect = button(
    'Collect',
    async () => {
      const answer = await app.run({ t: 'collect' })
      if (answer) {
        const r = answer.result as { gold: number; gems: number; minutes: number }
        toast(
          `+${num(r.gold)} gold${r.gems ? `, +${r.gems} gems` : ''} from ${duration(r.minutes * 60_000)} away`,
          'good',
        )
      }
    },
    `btn btn-gold${pending().minutes >= 60 ? ' pulse' : ''}`,
  )
  if (pending().minutes < 1) collect.disabled = true
  idle.append(
    icon('chest', 'ico chest'),
    h('div', { class: 'idle-text' }, h('h2', { text: 'Idle chest' }), amount, status),
    collect,
  )
  view.append(idle)

  // ── Login reward ──
  if (s.login.last !== dayKey(now)) {
    const day = (s.login.count % pack.calendar.length) + 1
    view.append(
      h(
        'section',
        { class: 'panel login' },
        h(
          'div',
          null,
          h('h2', { text: `Day ${day} reward` }),
          rewardChips(pack, pack.calendar[day - 1] ?? {}),
        ),
        button(
          'Claim',
          async () => {
            if (await app.run({ t: 'login' })) toast(`Day ${day} reward claimed`, 'good')
          },
          'btn btn-gold pulse',
        ),
      ),
    )
  }
  return view
}

function teamEditor(app: App): void {
  const s = sheet('Choose your team', { wide: true, onClose: () => app.render() })
  let picked = [...app.state.team]
  const grid = h('div', { class: 'hero-grid' })
  const count = h('p', { class: 'muted' })
  const save = button(
    'Save team',
    async () => {
      if (await app.run({ t: 'team', heroes: picked })) {
        s.close()
        toast('Team saved', 'good')
      }
    },
    'btn btn-gold btn-wide',
  )
  const draw = () => {
    grid.replaceChildren()
    const owned = Object.entries(app.state.heroes).sort(
      (a, b) => heroPower(app.pack, b[0], b[1]) - heroPower(app.pack, a[0], a[1]),
    )
    for (const [id, hs] of owned) {
      const def = heroDef(app.pack, id)
      if (!def) continue
      const card = heroCard(app.pack, def, hs)
      const slot = picked.indexOf(id)
      if (slot >= 0) card.append(h('span', { class: 'slot-no', text: String(slot + 1) }))
      const b = button(
        card,
        () => {
          if (picked.includes(id)) picked = picked.filter((x) => x !== id)
          else if (picked.length < app.pack.teamSize) picked.push(id)
          else toast(`A team holds ${app.pack.teamSize} heroes`)
          draw()
        },
        `pick${slot >= 0 ? ' is-on' : ''}`,
        { 'aria-pressed': String(slot >= 0), 'aria-label': def.name },
      )
      grid.append(b)
    }
    count.textContent = `${picked.length} of ${app.pack.teamSize} picked. Guardians stand in front; the rest strike from behind.`
    save.disabled = picked.length === 0
  }
  draw()
  s.body.append(count, grid, save)
}

function stageList(app: App): void {
  const s = sheet('Stages', { wide: true, onClose: () => app.render() })
  const { pack } = app
  const list = h('div', { class: 'stage-list' })
  const upto = Math.min(app.state.stage.cleared + 1, pack.stages.length)
  for (let i = upto; i >= 1; i--) {
    const st = pack.stages[i - 1]!
    const got = app.state.stage.stars[String(i)] ?? 0
    const row = h(
      'div',
      { class: `stage-row${i === upto && i > app.state.stage.cleared ? ' next' : ''}` },
      h('div', null, h('b', { text: `Stage ${i}` }), h('small', { class: 'muted', text: st.name })),
      got
        ? stars(got, 3)
        : h('small', { class: 'muted', text: i > app.state.stage.cleared ? 'Not cleared' : '' }),
    )
    const ctl = h('div', { class: 'stage-ctl' })
    ctl.append(
      button(
        'Battle',
        () => {
          s.close()
          void playBattle(app, i)
        },
        'btn btn-small',
      ),
    )
    if (got >= 3) {
      ctl.append(
        button(
          [icon('sweep'), '×3'],
          async () => {
            const a = await app.run({ t: 'sweep', stage: i, times: 3 }, { quiet: true })
            if (a)
              toast(
                `Swept stage ${i} three times (${(a.result as { energy: number }).energy} energy)`,
                'good',
              )
          },
          'btn btn-small',
          { 'aria-label': `Sweep stage ${i} three times` },
        ),
      )
    }
    row.append(ctl)
    list.append(row)
  }
  s.body.append(
    h('p', {
      class: 'muted',
      text: 'Replays pay gold and one shard of the stage’s hero. Three-star stages can be swept instantly for the same energy.',
    }),
    list,
  )
}
