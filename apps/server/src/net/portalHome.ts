import { SCRAPLANDIA_PACK } from '@openvibe/content'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import type { CreatorWorld } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import { escapeHtml } from './notFound.js'
import type { SteamGame } from '../steam/steamCatalog.js'

/**
 * The home page's live sections, rendered on the server so crawlers and visitors without JavaScript read the same
 * page: who is playing now, the top boards (OpenVibe.Play) and Vibe Heroes' furthest teams, the achievements people
 * earn (Play's unlock counts), new and most-played creator worlds, Steam's lists (OpenVibe.Sources), how it works and
 * the questions people ask. Every number is a real row or a live count; a section with nothing to show is left out.
 *
 * The portal itself is a static Vite page: httpServer.ts swaps two markers in it for what this module builds,
 *   <!--ov:home-stats-->     the figures under the hero
 *   <!--ov:home-sections-->  the sections after the game cards
 * and adds the FAQ and game list JSON-LD. One build is kept for CACHE_MS and served while the next one is made, so a
 * slow Play or database never holds the page: the first request after boot waits at most FIRST_WAIT_MS.
 */

const CACHE_MS = 60_000
const FIRST_WAIT_MS = 2_500
const PLAY_SITE = 'https://play.openvibe.network'

export interface BoardRow {
  rank: number
  name: string
  score: number
}

export interface PlayTitleSummary {
  id: string
  name: string
  players: number
  achievements: { id: string; name: string; description: string; unlockedBy: number }[]
}

export interface SteamLists {
  top: SteamGame[]
  sale: SteamGame[]
  new: SteamGame[]
  observed_at: number | null
}

export interface HomeData {
  /** Players connected now, per built-in place, plus everyone inside running creator worlds. */
  online: { scraplandia: number; salvageRush: number; worlds: number }
  titles: PlayTitleSummary[]
  boards: {
    haulWeek: BoardRow[]
    haulAll: BoardRow[]
    rushWeek: BoardRow[]
    rushAll: BoardRow[]
  }
  heroes: { rank: number; name: string; stage: number; power: number }[]
  worlds: CreatorWorld[]
  steam: SteamLists | null
}

export interface HomeSources {
  online(): HomeData['online']
  /** Play's public titles read (players, achievements and how many unlocked each). */
  titles(): Promise<PlayTitleSummary[]>
  board(game: 'scraplandia' | 'salvage-rush', period: 'week' | 'all'): Promise<BoardRow[]>
  heroes(): Promise<HomeData['heroes']>
  worlds(): Promise<CreatorWorld[]>
  steam(): Promise<SteamLists>
}

export interface HomeParts {
  stats: string
  sections: string
  jsonLd: unknown[]
}

/** The questions the home answers, shown on the page and published as its FAQPage (the same pairs, one source). */
export const HOME_FAQ: readonly { q: string; a: string }[] = Object.freeze([
  {
    q: 'Do I need to download anything?',
    a: 'No. Every game here runs in a browser tab on a computer or a phone. Open the page and press play.',
  },
  {
    q: 'Are the games free?',
    a: 'Yes. Scraplandia, Salvage Rush, Vibe Heroes and every creator world are free to play in your browser.',
  },
  {
    q: 'Do I need an account?',
    a: 'No. You can play as a guest with one character tied to this browser. An OpenVibe account adds three character slots, keeps your progress across devices and puts your name on the leaderboards.',
  },
  {
    q: 'What do achievements give me?',
    a: 'Each one is recorded on OpenVibe.Play with your account, and some give an item you keep in your OpenVibe inventory, such as the Golden Name for a 500-point haul or the Cowboy Hat for a 2,000-point week in Scraplandia.',
  },
  {
    q: 'Can I build my own world?',
    a: 'Yes. Sign in, open Creator worlds and start a world in the map editor: terrain, buildings, lights, zones and props. Publish it and anyone can join from their browser.',
  },
  {
    q: 'Where do the Steam lists come from?',
    a: "From the Steam store's public top sellers, specials and new releases lists, read every few hours. Prices are Steam's own and every game links to its store page. OpenVibe sells nothing there.",
  },
])

/** The item each achievement gives (the content packs' rewards, the same ones inventoryRewards.ts grants). */
const REWARDS = new Map<string, string>([
  ...(SCRAPLANDIA_PACK.achievements ?? []).flatMap((a) =>
    a.reward ? [[`scraplandia/${a.id}`, a.reward.name] as const] : [],
  ),
  ...(SALVAGE_RUSH_PACK.game?.achievements ?? []).flatMap((a) =>
    a.reward ? [[`salvage-rush/${a.id}`, a.reward.name] as const] : [],
  ),
])

const esc = (v: unknown): string => escapeHtml(String(v ?? ''))
const fmt = new Intl.NumberFormat('en-US')
const n = (v: number): string => fmt.format(v)
const plural = (count: number, one: string, many: string): string =>
  `${n(count)} ${count === 1 ? one : many}`

function money(cents: number | null, currency: string | null): string {
  if (cents == null) return ''
  if (cents === 0) return 'Free'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim()
  }
}

function ago(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}

/** The figures under the hero: only the ones that have something to say. */
export function renderStats(d: HomeData): string {
  const items: { value: number; label: string }[] = []
  const playing = d.online.scraplandia + d.online.salvageRush + d.online.worlds
  if (playing > 0)
    items.push({
      value: playing,
      label: playing === 1 ? 'player online now' : 'players online now',
    })
  for (const t of d.titles) {
    if (t.players > 0)
      items.push({
        value: t.players,
        label: `${t.players === 1 ? 'player has' : 'players have'} played ${t.name}`,
      })
  }
  const earned = d.titles.reduce(
    (sum, t) => sum + t.achievements.reduce((s, a) => s + a.unlockedBy, 0),
    0,
  )
  if (earned > 0)
    items.push({
      value: earned,
      label: earned === 1 ? 'achievement earned' : 'achievements earned',
    })
  const published = d.worlds.length
  if (published > 0)
    items.push({
      value: published,
      label: published === 1 ? 'creator world published' : 'creator worlds published',
    })
  const deals = d.steam?.sale.length ?? 0
  if (deals > 0)
    items.push({ value: deals, label: deals === 1 ? 'Steam deal today' : 'Steam deals today' })
  if (!items.length) return ''
  return `<ul class="home-stats" aria-label="OpenVibe.Games in numbers">${items
    .slice(0, 5)
    .map((s) => `<li><b>${n(s.value)}</b><span>${esc(s.label)}</span></li>`)
    .join('')}</ul>`
}

function boardCard(o: {
  title: string
  board: string
  rows: BoardRow[]
  unit: (score: number) => string
  href: string
  more: string
}): string {
  if (!o.rows.length) return ''
  return `<article class="board-card">
  <h3>${esc(o.title)} <small>${esc(o.board)}</small></h3>
  <ol class="board-rows">${o.rows
    .slice(0, 5)
    .map(
      (r) =>
        `<li><span class="rank" aria-hidden="true">${r.rank}</span><span class="who">${esc(r.name)}</span><span class="score">${esc(o.unit(r.score))}</span></li>`,
    )
    .join('')}</ol>
  <a class="card-link" href="${esc(o.href)}">${esc(o.more)}</a>
</article>`
}

function boardsSection(d: HomeData): string {
  const haulWeek = d.boards.haulWeek.length > 0
  const rushWeek = d.boards.rushWeek.length > 0
  const cards = [
    boardCard({
      title: 'Scraplandia',
      board: haulWeek ? 'haul points this week' : 'haul points, all time',
      rows: haulWeek ? d.boards.haulWeek : d.boards.haulAll,
      unit: (s) => `${n(s)} pts`,
      href: '/leaderboard.html?game=scraplandia',
      more: 'Full haul board →',
    }),
    boardCard({
      title: 'Salvage Rush',
      board: rushWeek ? 'best round this week' : 'best round, all time',
      rows: rushWeek ? d.boards.rushWeek : d.boards.rushAll,
      unit: (s) => plural(s, 'scrap', 'scrap'),
      href: '/leaderboard.html?game=salvage-rush',
      more: 'Full leaderboard →',
    }),
    boardCard({
      title: 'Vibe Heroes',
      board: 'furthest teams',
      rows: d.heroes.map((h) => ({ rank: h.rank, name: h.name, score: h.stage })),
      unit: (s) => `stage ${n(s)}`,
      href: '/play/vibe-heroes',
      more: 'Build your team →',
    }),
  ].filter(Boolean)
  if (!cards.length) return ''
  return `<section class="home-sec" aria-labelledby="home-boards">
  <h2 id="home-boards">Top players</h2>
  <p class="home-lede">The servers score every round, so these boards are what really happened. Signed-in players get their name on them.</p>
  <div class="board-grid">${cards.join('')}</div>
</section>`
}

function achievementsSection(d: HomeData): string {
  const all = d.titles.flatMap((t) => t.achievements.map((a) => ({ ...a, title: t })))
  if (!all.length) return ''
  all.sort((a, b) => b.unlockedBy - a.unlockedBy || a.title.name.localeCompare(b.title.name))
  return `<section class="home-sec" aria-labelledby="home-achievements">
  <h2 id="home-achievements">Achievements to earn</h2>
  <p class="home-lede">Every achievement is kept on OpenVibe.Play with the number of players who earned it. Some give an item for your OpenVibe inventory.</p>
  <ul class="ach-grid">${all
    .slice(0, 8)
    .map(
      (a) => `<li class="ach${a.unlockedBy > 0 ? ' earned' : ''}">
    <span class="ach-game">${esc(a.title.name)}</span>
    <b>${esc(a.name)}</b>
    <span class="ach-how">${esc(a.description)}</span>
    ${REWARDS.has(`${a.title.id}/${a.id}`) ? `<span class="ach-reward">Gives the ${esc(REWARDS.get(`${a.title.id}/${a.id}`))}</span>` : ''}
    <span class="ach-count">${a.unlockedBy > 0 ? `Earned by ${plural(a.unlockedBy, 'player', 'players')}` : 'Nobody has earned it yet'}</span>
  </li>`,
    )
    .join('')}</ul>
  <p class="home-more">${d.titles
    .map(
      (t) =>
        `<a class="card-link" href="${PLAY_SITE}/t/${encodeURIComponent(t.id)}">${esc(t.name)} on OpenVibe.Play →</a>`,
    )
    .join(' ')}</p>
</section>`
}

function worldCard(w: CreatorWorld, now: number): string {
  const meta = [
    `by ${w.ownerName}`,
    w.plays > 0 ? plural(w.plays, 'visit', 'visits') : 'no visits yet',
  ]
  if (w.publishedAt) meta.push(`published ${ago(w.publishedAt, now)}`)
  return `<li class="world-card">
  <h3><a href="/worlds/${encodeURIComponent(w.id)}">${esc(w.title)}</a></h3>
  ${w.summary ? `<p>${esc(w.summary)}</p>` : ''}
  <span class="world-meta">${esc(meta.join(' · '))}</span>
</li>`
}

function worldsSection(d: HomeData, now: number): string {
  if (!d.worlds.length) return ''
  const newest = d.worlds.slice(0, 6)
  const shown = new Set(newest.map((w) => w.id))
  const popular = [...d.worlds]
    .filter((w) => w.plays > 0 && !shown.has(w.id))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 6)
  return `<section class="home-sec" aria-labelledby="home-worlds">
  <h2 id="home-worlds">Creator worlds</h2>
  <p class="home-lede">Worlds players built in the map editor and published. Each one opens in your browser.</p>
  <h3 class="home-sub">Newest</h3>
  <ul class="world-grid">${newest.map((w) => worldCard(w, now)).join('')}</ul>
  ${popular.length ? `<h3 class="home-sub">Most visited</h3><ul class="world-grid">${popular.map((w) => worldCard(w, now)).join('')}</ul>` : ''}
  <p class="home-more"><a class="card-link" href="/worlds">Every creator world →</a></p>
</section>`
}

function steamRow(g: SteamGame): string {
  const price =
    g.discount_percent > 0 && g.original_price != null
      ? `<span class="off">−${g.discount_percent}%</span> ${esc(money(g.final_price, g.currency))} <s>${esc(money(g.original_price, g.currency))}</s>`
      : esc(money(g.final_price, g.currency))
  return `<li><a href="https://store.steampowered.com/app/${g.appid}/" rel="noopener" target="_blank">${
    g.header_image
      ? `<img src="${esc(g.header_image)}" alt="" width="120" height="56" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '<span class="steam-art" aria-hidden="true"></span>'
  }<span class="steam-text"><b>${esc(g.name)}</b>${price ? `<span class="steam-price">${price}</span>` : ''}</span></a></li>`
}

function steamSection(d: HomeData, now: number): string {
  const s = d.steam
  if (!s) return ''
  const deals = [...s.sale].sort((a, b) => b.discount_percent - a.discount_percent)
  const cols = [
    { id: 'home-steam-top', title: 'Top sellers', games: s.top },
    { id: 'home-steam-deals', title: 'Biggest deals', games: deals },
    { id: 'home-steam-new', title: 'New releases', games: s.new },
  ].filter((c) => c.games.length)
  if (!cols.length) return ''
  return `<section class="home-sec" aria-labelledby="home-steam">
  <h2 id="home-steam">On Steam right now</h2>
  <p class="home-lede">What sells, what's discounted and what just came out on Steam, with Steam's prices in US dollars${
    s.observed_at ? `, checked ${esc(ago(s.observed_at, now))}` : ''
  }. Each game opens its store page.</p>
  <div class="steam-cols">${cols
    .map(
      (c) => `<div class="steam-col">
    <h3 id="${c.id}">${c.title}</h3>
    <ol class="steam-list" aria-labelledby="${c.id}">${c.games.slice(0, 5).map(steamRow).join('')}</ol>
  </div>`,
    )
    .join('')}</div>
  <p class="home-more"><a class="card-link" href="/steam">All of Steam's lists →</a></p>
</section>`
}

const HOW: readonly { title: string; text: string }[] = [
  {
    title: 'Open a game',
    text: 'Pick one above and press play. It loads in the tab, on a computer or a phone, with nothing to install.',
  },
  {
    title: 'Play as a guest',
    text: 'You get one character tied to this browser right away. No form, no email.',
  },
  {
    title: 'Sign in to keep it',
    text: 'An OpenVibe account adds three character slots, saves progress across devices and puts your name on the boards.',
  },
  {
    title: 'Earn and build',
    text: 'Achievements give items worn across OpenVibe, and the map editor lets you publish a world of your own.',
  },
]

function howSection(): string {
  return `<section class="home-sec" aria-labelledby="home-how">
  <h2 id="home-how">How it works</h2>
  <ol class="how-steps">${HOW.map((s) => `<li><b>${esc(s.title)}</b><span>${esc(s.text)}</span></li>`).join('')}</ol>
</section>`
}

function faqSection(): string {
  return `<section class="home-sec" aria-labelledby="home-faq">
  <h2 id="home-faq">Questions</h2>
  <div class="faq">${HOME_FAQ.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</section>`
}

/** The home page's JSON-LD beyond the site and game nodes discovery.ts already writes: the games and the FAQ. */
export function homeExtraJsonLd(site: string, playSite: string): unknown[] {
  const games = [
    {
      name: 'Scraplandia',
      url: `${playSite}/`,
      description: 'Multiplayer survival-building in the browser.',
    },
    {
      name: 'Salvage Rush',
      url: `${site}/play?game=salvage-rush`,
      description: '90-second scrap-collecting rounds with a leaderboard.',
    },
    {
      name: 'Vibe Heroes',
      url: `${site}/play/vibe-heroes`,
      description: 'An idle hero collector made for the phone.',
    },
    {
      name: 'Creator worlds',
      url: `${site}/worlds`,
      description: 'Worlds players built in the map editor and published.',
    },
    {
      name: 'On Steam right now',
      url: `${site}/steam`,
      description: "Steam's top sellers, deals and new releases.",
    },
  ]
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Games on OpenVibe.Games',
      url: `${site}/`,
      numberOfItems: games.length,
      itemListElement: games.map((g, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: g.name,
        url: g.url,
        description: g.description,
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: HOME_FAQ.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ]
}

export function renderHome(
  d: HomeData,
  now: number,
  site = 'https://openvibe.games',
  playSite = 'https://play.openvibe.games',
): HomeParts {
  return {
    stats: renderStats(d),
    sections: [
      boardsSection(d),
      achievementsSection(d),
      worldsSection(d, now),
      steamSection(d, now),
      howSection(),
      faqSection(),
    ]
      .filter(Boolean)
      .join('\n'),
    jsonLd: homeExtraJsonLd(site, playSite),
  }
}

const EMPTY: HomeData = {
  online: { scraplandia: 0, salvageRush: 0, worlds: 0 },
  titles: [],
  boards: { haulWeek: [], haulAll: [], rushWeek: [], rushAll: [] },
  heroes: [],
  worlds: [],
  steam: null,
}

/** Reads every source at once; a source that fails or is slow leaves its section out, never the page. */
export async function gatherHome(src: HomeSources, log?: Pick<Logger, 'warn'>): Promise<HomeData> {
  const soft = <T>(name: string, p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((err: unknown) => {
      log?.warn('home section unavailable', {
        section: name,
        error: err instanceof Error ? err.message : String(err),
      })
      return fallback
    })
  let online = EMPTY.online
  try {
    online = src.online()
  } catch {
    /* counts are optional */
  }
  const [titles, haulWeek, haulAll, rushWeek, rushAll, heroes, worlds, steam] = await Promise.all([
    soft('titles', src.titles(), [] as PlayTitleSummary[]),
    soft('haul-week', src.board('scraplandia', 'week'), [] as BoardRow[]),
    soft('haul-all', src.board('scraplandia', 'all'), [] as BoardRow[]),
    soft('rush-week', src.board('salvage-rush', 'week'), [] as BoardRow[]),
    soft('rush-all', src.board('salvage-rush', 'all'), [] as BoardRow[]),
    soft('heroes', src.heroes(), [] as HomeData['heroes']),
    soft('worlds', src.worlds(), [] as CreatorWorld[]),
    soft('steam', src.steam(), null as SteamLists | null),
  ])
  return { online, titles, boards: { haulWeek, haulAll, rushWeek, rushAll }, heroes, worlds, steam }
}

/** Play's public titles read, trimmed to what the home shows. */
export async function readPlayTitles(
  playUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<PlayTitleSummary[]> {
  const res = await doFetch(`${playUrl}/api/v1/titles`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`play ${res.status}`)
  const body = (await res.json()) as {
    titles?: {
      id?: unknown
      name?: unknown
      players?: unknown
      achievements?: {
        id?: unknown
        name?: unknown
        description?: unknown
        unlocked_by?: unknown
      }[]
    }[]
  }
  return (body.titles ?? [])
    .filter((t) => typeof t.id === 'string' && typeof t.name === 'string')
    .map((t) => ({
      id: String(t.id),
      name: String(t.name),
      players: Math.max(0, Number(t.players) || 0),
      achievements: (t.achievements ?? [])
        .filter((a) => typeof a.id === 'string' && typeof a.name === 'string')
        .map((a) => ({
          id: String(a.id),
          name: String(a.name),
          description: String(a.description ?? ''),
          unlockedBy: Math.max(0, Number(a.unlocked_by) || 0),
        })),
    }))
}

/** The cached builder httpServer.ts asks for on every home request. */
export function createPortalHome(
  src: HomeSources,
  opts: { site?: string; playSite?: string; log?: Pick<Logger, 'warn'>; now?: () => number } = {},
): () => Promise<HomeParts> {
  const now = opts.now ?? Date.now
  let cached: { at: number; parts: HomeParts } | null = null
  let building: Promise<HomeParts> | null = null
  // A source that is down is said once every ten minutes, not on every rebuild.
  const warned = new Map<string, number>()
  const log: Pick<Logger, 'warn'> | undefined = opts.log && {
    warn: (msg, meta) => {
      const key = String((meta as { section?: unknown } | undefined)?.section ?? msg)
      if (now() - (warned.get(key) ?? -Infinity) < 600_000) return
      warned.set(key, now())
      opts.log!.warn(msg, meta)
    },
  }
  const build = (): Promise<HomeParts> => {
    building ??= gatherHome(src, log)
      .then((d) => {
        const parts = renderHome(d, now(), opts.site, opts.playSite)
        cached = { at: now(), parts }
        return parts
      })
      .finally(() => {
        building = null
      })
    return building
  }
  return async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.parts
    const next = build()
    if (cached) {
      next.catch(() => undefined)
      return cached.parts
    }
    // Nothing built yet and the sources are slow: the sections that need no data (how it works, the questions).
    const bare = (): HomeParts => renderHome(EMPTY, now(), opts.site, opts.playSite)
    return Promise.race([
      next,
      new Promise<HomeParts>((resolve) => setTimeout(() => resolve(bare()), FIRST_WAIT_MS).unref()),
    ]).catch(bare)
  }
}
