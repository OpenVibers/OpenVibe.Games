/**
 * The casual games' page (plan T22): /play/<game>. It starts from an ad or a shared link with no sign-in wall: the
 * browser's Games guest token is the identity until the player signs in with the navbar, and the save moves into
 * their account then. The link's `src` and `c` (the campaign) go to the server once, with the first visit.
 */
import { CASUAL_GAMES, idlePending, packDigest } from '@openvibe/casual'
import './casual.css'
import { App } from './app.js'
import { ApiError, CasualApi } from './api.js'
import { button, duration, h, num, sheet } from './dom.js'
import { getIdentity, sessionToken } from '../net/identity.js'
import { homeView } from './views/home.js'
import { heroesView } from './views/heroes.js'
import { summonView } from './views/summon.js'
import { questsView, shopView } from './views/quests.js'
import { openMenu } from './views/menu.js'
import { rewardChips } from './views/parts.js'

async function boot(): Promise<void> {
  const root = document.getElementById('cg')
  if (!root) return
  const id = document.body.dataset.game ?? location.pathname.split('/')[2] ?? ''
  const pack = CASUAL_GAMES[id]
  if (!pack) {
    root.replaceChildren(h('p', { class: 'boot-msg', text: 'This game does not exist.' }))
    return
  }
  const params = new URLSearchParams(location.search)
  const src = params.get('src')
  const campaign = params.get('c')
  if (src || campaign) {
    // The campaign is recorded with the first visit; a shared or bookmarked link stays clean.
    params.delete('src')
    params.delete('c')
    const rest = params.toString()
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash)
  }
  const api = new CasualApi(pack.id, packDigest(pack), {
    guest: getIdentity().token,
    bearer: sessionToken(),
  })
  let session
  try {
    session = await api.session(src, campaign)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'session_expired') {
      api.dropBearer()
      session = await api.session(src, campaign).catch(() => null)
    }
    if (!session) {
      root.replaceChildren(
        h(
          'div',
          { class: 'boot-msg' },
          h('p', { text: err instanceof Error ? err.message : 'The game could not start.' }),
          button('Try again', () => location.reload(), 'btn btn-gold'),
        ),
      )
      return
    }
  }
  const app = new App(root, pack, api, session.state, session.version, session.player, {
    home: homeView,
    heroes: heroesView,
    summon: summonView,
    quests: questsView,
    shop: shopView,
  })
  app.onMenu(openMenu)
  root.classList.add('ready')
  app.render()
  welcome(app, session.created)
  // Coming back to the tab: catch up the timers and the red dots.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !app.busy) app.render()
  })
}

/** First visit: a short hello. Returning after a while: what the idle chest earned meanwhile. */
function welcome(app: App, created: boolean): void {
  if (created) {
    const s = sheet(`Welcome to ${app.pack.name}`)
    s.body.append(
      h('p', { text: app.pack.tagline }),
      h('p', {
        class: 'muted',
        text: 'Four heroes are ready. Win the first stages, fuse new heroes from shards and spend your ten free sigils on a summon.',
      }),
      button('Let’s go', () => s.close(), 'btn btn-gold btn-wide'),
    )
    return
  }
  const p = idlePending(app.pack, app.state, app.now())
  if (p.minutes < 30) return
  const s = sheet('While you were away')
  s.body.append(
    h('p', {
      text: `Your heroes kept working for ${duration(p.minutes * 60_000)}${p.full ? ' (the chest is full)' : ''}.`,
    }),
    rewardChips(app.pack, { gold: p.gold, gems: p.gems }),
    button(
      `Collect ${num(p.gold)} gold`,
      async () => {
        s.close()
        await app.run({ t: 'collect' })
      },
      'btn btn-gold btn-wide',
    ),
  )
}

void boot()
