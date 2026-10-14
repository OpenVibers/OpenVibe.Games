/**
 * Plays back a battle the server already fought. The log says who acted and what each hit did; this only shows
 * it: lunges, numbers, bars and knock-outs, at 1×, 2× or 3×, or skipped to the end.
 */
import {
  heroDef,
  type BattleEvent,
  type BattleLog,
  type HeroClass,
  type Reward,
} from '@openvibe/casual'
import { enemyArt, heroPortrait, icon } from '../art.js'
import { button, h, num } from '../dom.js'
import type { App } from '../app.js'
import { rewardChips, stars } from './parts.js'

const ENEMY_SKILL: Record<HeroClass, string> = {
  guardian: 'Stone Ward',
  blade: 'Rend',
  arcanist: 'Hex Burst',
  ranger: 'Volley',
  mender: 'Mend',
  herald: 'War Cry',
}

interface UnitView {
  el: HTMLElement
  hp: HTMLElement
  shieldBar: HTMLElement
  energyBar: HTMLElement
  maxHp: number
  cur: number
  shield: number
  energy: number
  side: 'a' | 'd'
  skill: string
  cls: HeroClass
}

function readSpeed(): number {
  try {
    const v = Number(localStorage.getItem('cg.speed'))
    return v === 2 || v === 3 ? v : 1
  } catch {
    return 1
  }
}

function saveSpeed(v: number): void {
  try {
    localStorage.setItem('cg.speed', String(v))
  } catch {
    /* fine */
  }
}

export interface BattleEnd {
  next?: () => void
}

/** Fights `stage` on the server, then plays it back. Resolves when the player leaves the result screen. */
export async function playBattle(app: App, stage: number): Promise<void> {
  const before = app.state
  const answer = await app.run({ t: 'battle', stage }, { quiet: true })
  if (!answer) return
  const result = answer.result as {
    battle: BattleLog
    won: boolean
    stars: number
    first: boolean
    reward: Reward
  }
  const pack = app.pack
  const def = pack.stages[stage - 1]
  const chapter = pack.chapters.find((c) => c.index === def?.chapter)
  const overlay = h('div', {
    class: 'battle',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': `Battle: stage ${stage}` },
    style: chapter ? { '--sky-a': chapter.sky[0], '--sky-b': chapter.sky[1] } : {},
  })
  const round = h('span', { class: 'round', text: 'Round 1' })
  let speed = readSpeed()
  let skipped = false
  const speedBtn = button(
    `${speed}×`,
    () => {
      speed = speed === 3 ? 1 : speed + 1
      speedBtn.textContent = `${speed}×`
      saveSpeed(speed)
    },
    'btn btn-small',
    { 'aria-label': 'Battle speed' },
  )
  const skipBtn = button(
    'Skip',
    () => {
      skipped = true
    },
    'btn btn-small',
  )
  const foes = h('div', { class: 'side side-d' })
  const team = h('div', { class: 'side side-a' })
  const fx = h('div', { class: 'fx-layer', attrs: { 'aria-hidden': 'true' } })
  const banner = h('div', { class: 'skill-banner', attrs: { 'aria-hidden': 'true' } })
  overlay.append(
    h(
      'div',
      { class: 'battle-head' },
      h('div', null, h('b', { text: `Stage ${stage}` }), h('small', { text: chapter?.name ?? '' })),
      round,
      h('div', { class: 'battle-ctl' }, speedBtn, skipBtn),
    ),
    h('div', { class: 'field' }, foes, h('div', { class: 'vs', text: 'VS' }), team, fx, banner),
  )
  app.root.append(overlay)

  const units = new Map<string, UnitView>()
  for (const u of result.battle.units) {
    const side = u.r.startsWith('a') ? 'a' : 'd'
    const hero = side === 'a' ? heroDef(pack, u.id) : undefined
    const enemy = side === 'd' ? pack.enemies.find((e) => e.id === u.id) : undefined
    const art = hero ? heroPortrait(hero, true) : enemy ? enemyArt(enemy) : h('span')
    const hp = h('i', { class: 'hp' })
    const shieldBar = h('i', { class: 'shield' })
    const energyBar = h('i', { class: 'en' })
    const el = h(
      'div',
      {
        class: `unit ${side === 'a' ? `r-${hero?.rarity ?? 'common'}` : 'foe'}${u.boss ? ' boss' : ''}`,
        attrs: { 'data-r': u.r },
      },
      h('div', { class: `unit-art${hero ? ` el-bg-${hero.element}` : ''}` }, art),
      h(
        'div',
        { class: 'bars' },
        h('span', { class: 'bar' }, hp, shieldBar),
        h('span', { class: 'bar bar-en' }, energyBar),
      ),
      h('span', {
        class: 'unit-name',
        text: hero ? (hero.name.split(' ')[0] ?? hero.name) : (enemy?.name ?? ''),
      }),
    )
    ;(side === 'a' ? team : foes).append(el)
    units.set(u.r, {
      el,
      hp,
      shieldBar,
      energyBar,
      maxHp: u.hp,
      cur: u.hp,
      shield: 0,
      energy: 0,
      side,
      skill: hero ? hero.skill.name : enemy ? ENEMY_SKILL[enemy.class] : '',
      cls: hero ? hero.class : (enemy?.class ?? 'blade'),
    })
  }
  const draw = (u: UnitView) => {
    u.hp.style.width = `${(u.cur / u.maxHp) * 100}%`
    u.hp.classList.toggle('low', u.cur / u.maxHp < 0.3)
    u.shieldBar.style.width = `${Math.min(100, (u.shield / u.maxHp) * 100)}%`
    u.energyBar.style.width = `${u.energy}%`
    u.el.classList.toggle('ko', u.cur <= 0)
  }
  units.forEach(draw)

  const wait = (ms: number) =>
    new Promise<void>((r) => window.setTimeout(r, skipped ? 0 : ms / speed))
  const float = (target: UnitView, text: string, cls: string) => {
    if (skipped) return
    const rect = target.el.getBoundingClientRect()
    const host = fx.getBoundingClientRect()
    const n = h('span', {
      class: `float ${cls}`,
      text,
      style: {
        left: `${rect.left - host.left + rect.width / 2}px`,
        top: `${rect.top - host.top + rect.height * 0.3}px`,
      },
    })
    fx.append(n)
    window.setTimeout(() => n.remove(), 1100)
  }

  const apply = (ev: BattleEvent) => {
    const actor = units.get(ev.actor)
    if (!actor) return
    if (ev.kind === 'attack') actor.energy = Math.min(100, actor.energy + 30)
    else actor.energy = 0
    for (const hit of ev.hits) {
      const t = units.get(hit.r)
      if (!t) continue
      if (hit.dmg !== undefined) {
        t.shield = Math.max(0, t.shield - (hit.blocked ?? 0))
        t.cur = Math.max(0, t.cur - hit.dmg)
        t.energy = Math.min(100, t.energy + 10)
        const text = hit.dmg === 0 && hit.blocked ? `${num(hit.blocked)} blocked` : num(hit.dmg)
        float(
          t,
          hit.crit ? `${text}!` : text,
          `${hit.crit ? 'crit' : 'dmg'}${hit.adv === 1 ? ' adv' : ''}${hit.adv === -1 ? ' weak' : ''}`,
        )
        if (!skipped) {
          t.el.classList.remove('hit')
          void t.el.offsetWidth
          t.el.classList.add('hit')
        }
      }
      if (hit.heal !== undefined) {
        t.cur = Math.min(t.maxHp, t.cur + hit.heal)
        if (hit.heal > 0) float(t, `+${num(hit.heal)}`, 'heal')
      }
      if (hit.shield !== undefined) {
        t.shield += hit.shield
        float(t, `+${num(hit.shield)}`, 'shield-up')
      }
      if (ev.kind === 'rally' && t !== actor) {
        t.energy = Math.min(100, t.energy + 20)
        float(t, 'ATK ↑', 'buff')
      }
      draw(t)
    }
    draw(actor)
  }

  for (const ev of result.battle.events) {
    if (skipped) {
      apply(ev)
      continue
    }
    round.textContent = `Round ${ev.round}`
    const actor = units.get(ev.actor)
    if (!actor) continue
    const skill = ev.kind !== 'attack'
    actor.el.classList.add(skill ? 'cast' : 'act')
    if (skill) {
      banner.textContent = actor.skill
      banner.className = `skill-banner on side-${actor.side}`
      await wait(380)
    } else await wait(160)
    apply(ev)
    await wait(skill ? 520 : 360)
    actor.el.classList.remove('act', 'cast')
    banner.className = 'skill-banner'
  }
  units.forEach(draw)
  round.textContent = `Round ${result.battle.rounds}`
  skipBtn.disabled = true
  await wait(300)

  // ── Result ──
  const next = stage < pack.stages.length && result.won && result.first ? stage + 1 : null
  const panel = h('div', { class: `result ${result.won ? 'win' : 'lose'}` })
  panel.append(h('h2', { text: result.won ? 'Victory' : 'Defeat' }))
  if (result.won) {
    panel.append(stars(result.stars, 3))
    panel.append(
      h('p', { class: 'muted', text: result.first ? 'First clear reward' : 'Replay reward' }),
      rewardChips(pack, result.reward),
    )
  } else {
    panel.append(
      h('p', {
        text:
          stage > before.stage.cleared
            ? 'Your team needs to be stronger. Level up heroes, star them up or try another team.'
            : 'Not this time. Try again with a stronger team.',
      }),
      h('p', { class: 'muted', text: 'A lost battle costs 1 energy; the rest came back.' }),
    )
  }
  const actions = h('div', { class: 'result-actions' })
  panel.append(actions)
  overlay.append(panel)
  await new Promise<void>((resolve) => {
    const leave = (then?: () => void) => {
      overlay.remove()
      app.render()
      resolve()
      then?.()
    }
    if (next !== null)
      actions.append(
        button(
          ['Next stage ', icon('battle')],
          () => leave(() => void playBattle(app, next)),
          'btn btn-gold',
        ),
      )
    if (!result.won)
      actions.append(button('Heroes', () => leave(() => app.go('heroes')), 'btn btn-gold'))
    actions.append(button(result.won ? 'Done' : 'Back', () => leave(), 'btn'))
    window.setTimeout(() => (actions.firstElementChild as HTMLElement | null)?.focus(), 50)
  })
}
