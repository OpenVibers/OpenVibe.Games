/**
 * The casual page's shell: the player's state as the server last answered it, the top bar with the wallet and
 * energy, the five tabs, and the one way to change anything (`run`, which asks the server).
 */
import {
  energyNow,
  gemsTotal,
  nextEnergyAt,
  notices,
  type Action,
  type CasualPack,
  type PlayerState,
} from '@openvibe/casual'
import { ApiError, type ActionAnswer, type CasualApi, type Player } from './api.js'
import { icon } from './art.js'
import { button, duration, h, num, sheet, tick, toast } from './dom.js'
import { forgetSession } from '../net/identity.js'

export type Tab = 'home' | 'heroes' | 'summon' | 'quests' | 'shop'

export type View = (app: App) => HTMLElement

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Battle', icon: 'battle' },
  { id: 'heroes', label: 'Heroes', icon: 'heroes' },
  { id: 'summon', label: 'Summon', icon: 'summon' },
  { id: 'quests', label: 'Quests', icon: 'quests' },
  { id: 'shop', label: 'Shop', icon: 'shop' },
]

export class App {
  tab: Tab = 'home'
  busy = false
  private top = h('header', { class: 'cg-top' })
  private view = h('section', { class: 'cg-view', attrs: { 'aria-live': 'off' } })
  private tabs = h('nav', { class: 'cg-tabs', attrs: { 'aria-label': 'Game sections' } })
  private menu: (app: App) => void = () => {}

  constructor(
    readonly root: HTMLElement,
    readonly pack: CasualPack,
    readonly api: CasualApi,
    public state: PlayerState,
    public version: number,
    public player: Player,
    private views: Record<Tab, View>,
  ) {
    root.replaceChildren(this.top, this.view, this.tabs)
  }

  onMenu(fn: (app: App) => void): void {
    this.menu = fn
  }

  now(): number {
    return this.api.now()
  }

  /** Asks the server to apply an action; the answer replaces the state. Refusals become a toast. */
  async run(action: Action, opts: { quiet?: boolean } = {}): Promise<ActionAnswer | null> {
    if (this.busy) return null
    this.busy = true
    this.root.classList.add('is-busy')
    try {
      const answer = await this.api.act(action)
      if (answer.version >= this.version) {
        this.state = answer.state
        this.version = answer.version
      }
      if (!opts.quiet) this.render()
      return answer
    } catch (err) {
      this.fail(err)
      return null
    } finally {
      this.busy = false
      this.root.classList.remove('is-busy')
    }
  }

  fail(err: unknown): void {
    if (err instanceof ApiError && err.code === 'content_changed') {
      const s = sheet('A new version is out')
      s.body.append(
        h('p', {
          text: 'Vibe Heroes was just updated. Reload to keep playing; your progress is saved.',
        }),
        button('Reload', () => location.reload(), 'btn btn-gold btn-wide'),
      )
      return
    }
    if (err instanceof ApiError && err.code === 'session_expired') {
      forgetSession()
      this.api.dropBearer()
      toast('Your sign-in expired. Sign in again from the top bar to keep this progress.', 'bad')
      return
    }
    toast(err instanceof Error ? err.message : 'Something went wrong.', 'bad')
  }

  go(tab: Tab): void {
    this.tab = tab
    this.render()
    this.view.scrollTop = 0
  }

  render(): void {
    this.renderTop()
    this.view.replaceChildren(this.views[this.tab](this))
    this.view.dataset.tab = this.tab
    this.renderTabs()
  }

  private renderTop(): void {
    const s = this.state
    const p = this.pack
    // Each chip names its currency for screen readers in hidden text (a label on a plain div is not read).
    const chip = (name: string, value: Node | string, label: string, cls = '') =>
      h(
        'div',
        { class: `chip ${cls}`, title: label },
        icon(name),
        h('span', {
          class: 'sr',
          text: `${name === 'gems' ? 'Gems' : name === 'gold' ? 'Gold' : 'Sigils'}: `,
        }),
        h('b', null, value),
      )
    const energy = h('b')
    tick(energy, () => `${energyNow(p, this.state, this.now())}/${p.energy.max}`)
    const energyTimer = h('small')
    tick(energyTimer, () => {
      const at = nextEnergyAt(p, this.state, this.now())
      return at ? duration(at - this.now()) : ''
    })
    this.top.replaceChildren(
      chip('gold', num(s.wallet.gold), `${s.wallet.gold.toLocaleString('en-US')} gold`),
      chip(
        'gems',
        num(gemsTotal(s)),
        s.wallet.gemsPaid
          ? `${gemsTotal(s)} gems (${s.wallet.gems} earned, ${s.wallet.gemsPaid} bought)`
          : `${s.wallet.gems} gems`,
      ),
      chip('sigils', String(s.wallet.sigils), `${s.wallet.sigils} summon sigils`),
      h(
        'div',
        {
          class: 'chip chip-energy',
          title: 'Energy: one point every five minutes',
        },
        icon('energy'),
        h('span', { class: 'sr', text: 'Energy: ' }),
        h('span', { class: 'chip-stack' }, energy, energyTimer),
      ),
      button(icon('menu'), () => this.menu(this), 'icon-btn top-menu', { 'aria-label': 'Menu' }),
    )
  }

  private renderTabs(): void {
    const n = notices(this.pack, this.state, this.now())
    const dots: Record<Tab, boolean> = {
      home: n.idle || n.login,
      heroes: n.heroes > 0,
      summon: n.summon,
      quests: n.quests > 0 || n.login,
      shop: false,
    }
    this.tabs.replaceChildren(
      ...TABS.map((t) =>
        button(
          [
            icon(t.icon),
            h('span', { text: t.label }),
            dots[t.id]
              ? h('i', { class: 'dot' }, h('span', { class: 'sr', text: ' (something is ready)' }))
              : null,
          ],
          () => this.go(t.id),
          `tab${this.tab === t.id ? ' is-on' : ''}`,
          this.tab === t.id ? { 'aria-current': 'page' } : {},
        ),
      ),
    )
  }
}
