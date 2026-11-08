/**
 * Achievements on OpenVibe.Games: the person's unlocks when signed in, every game's
 * achievements when not. The data comes from Play through this site's own read routes
 * (/api/v1/play/…), which fetch Play server-side; the page never reads Play's tables.
 */
export {}

interface PlayAchievement {
  id: string
  name: string
  description?: string
  unlocked_by?: number
  hidden?: boolean
}

interface PlayTitle {
  id: string
  name: string
  url?: string
  summary?: string
  players?: number
  achievements: PlayAchievement[]
}

interface MineTitle {
  title: string
  name: string
  achievements: { id: string; name: string; description?: string; unlocked_at?: string }[]
}

interface Mine {
  signedIn?: boolean
  titles: MineTitle[]
}

const pageTitle = document.getElementById('page-title') as HTMLElement
const pageLede = document.getElementById('page-lede') as HTMLElement
const status = document.getElementById('status') as HTMLElement
const games = document.getElementById('games') as HTMLElement
const summary = document.getElementById('summary') as HTMLElement
const signin = document.getElementById('signin-actions') as HTMLElement
const keep = document.getElementById('keep') as HTMLElement
const keepList = document.getElementById('keep-list') as HTMLElement

const num = (n: number): string => Number(n).toLocaleString('en-US')
const plural = (n: number, one: string, many: string): string => `${num(n)} ${n === 1 ? one : many}`

async function read<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (response.status === 401) return null
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return (await response.json()) as T
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function summaryCard(value: string, label: string): HTMLLIElement {
  const li = el('li') as HTMLLIElement
  li.append(el('b', undefined, value), el('span', undefined, label))
  return li
}

/** A game's card: its name, how many players, and one tile per achievement. */
function gameCard(
  title: PlayTitle,
  achievements: { id: string; name: string; description?: string; unlocked_at?: string }[],
  mine: boolean,
): HTMLElement {
  const card = el('section', 'game')
  card.id = `game-${title.id}`
  const head = el('div', 'game-head')
  const heading = el('h2', undefined, title.name)
  heading.style.margin = '0'
  head.append(heading)
  head.append(
    el(
      'p',
      undefined,
      mine
        ? `${plural(achievements.length, 'achievement', 'achievements')} unlocked`
        : `${plural(title.players ?? 0, 'player has', 'players have')} unlocked at least one · ${plural(
            title.achievements.length,
            'achievement',
            'achievements',
          )}`,
    ),
  )
  card.append(head)
  const list = el('ul', 'ach-list') as HTMLUListElement
  for (const achievement of achievements) {
    const li = el('li', mine ? 'ach earned' : 'ach') as HTMLLIElement
    li.append(el('b', undefined, achievement.name))
    if (achievement.description) li.append(el('small', undefined, achievement.description))
    if (mine && achievement.unlocked_at) {
      li.append(el('span', 'meta', `Unlocked ${achievement.unlocked_at.slice(0, 10)}`))
    } else if (!mine) {
      const count = Number((achievement as PlayAchievement).unlocked_by ?? 0)
      li.append(
        el(
          'span',
          'meta',
          count > 0
            ? `Earned by ${plural(count, 'player', 'players')}`
            : 'Nobody has earned it yet',
        ),
      )
    }
    list.append(li)
  }
  card.append(list)
  return card
}

function showSignedIn(mine: Mine, titles: PlayTitle[]): void {
  const byId = new Map(titles.map((t) => [t.id, t]))
  const unlocked = mine.titles.reduce((n, t) => n + t.achievements.length, 0)
  pageTitle.textContent = 'Your achievements'
  pageLede.textContent =
    'Every achievement you have unlocked in every OpenVibe game, and when you earned it. Sign in on another device and this page follows you.'
  signin.hidden = true
  status.textContent = ''
  summary.hidden = false
  summary.replaceChildren(
    summaryCard(num(unlocked), unlocked === 1 ? 'achievement unlocked' : 'achievements unlocked'),
    summaryCard(num(mine.titles.length), mine.titles.length === 1 ? 'game played' : 'games played'),
  )
  games.replaceChildren()
  if (!mine.titles.length) {
    const empty = el('p', 'empty')
    empty.append(
      document.createTextNode('Nothing yet. '),
      Object.assign(document.createElement('a'), { href: '/play', textContent: 'Play a game' }),
      document.createTextNode(' signed in, and what you unlock shows here.'),
    )
    games.append(empty)
  }
  for (const t of mine.titles) {
    const title = byId.get(t.title) ?? {
      id: t.title,
      name: t.name,
      achievements: [],
    }
    games.append(gameCard(title, t.achievements, true))
  }

  const keepTitles = titles
    .map((t) => ({
      t,
      got: new Set(mine.titles.find((m) => m.title === t.id)?.achievements.map((a) => a.id) ?? []),
    }))
    .filter(({ t, got }) => t.achievements.some((a) => !got.has(a.id)))
  if (keepTitles.length) {
    keep.hidden = false
    keepList.replaceChildren(
      ...keepTitles.map(({ t, got }) => {
        const li = document.createElement('li')
        const link = document.createElement('a')
        link.href = t.url || '/play'
        link.textContent = t.name
        li.append(
          link,
          document.createTextNode(
            `: ${t.achievements.filter((a) => !got.has(a.id)).length} still to earn`,
          ),
        )
        return li
      }),
    )
  } else {
    keep.hidden = true
  }
}

function showSignedOut(titles: PlayTitle[]): void {
  const totalAchievements = titles.reduce((n, t) => n + t.achievements.length, 0)
  const totalUnlocks = titles.reduce(
    (n, t) => n + t.achievements.reduce((m, a) => m + (Number(a.unlocked_by) || 0), 0),
    0,
  )
  pageTitle.textContent = 'Achievements in every game'
  pageLede.textContent =
    'Every achievement in every OpenVibe game, and how many players have earned each. Sign in with your OpenVibe account to see the ones you have unlocked.'
  signin.hidden = false
  status.textContent = ''
  summary.hidden = false
  summary.replaceChildren(
    summaryCard(num(titles.length), titles.length === 1 ? 'game' : 'games'),
    summaryCard(num(totalAchievements), totalAchievements === 1 ? 'achievement' : 'achievements'),
    summaryCard(num(totalUnlocks), 'unlocks earned'),
  )
  games.replaceChildren()
  if (!titles.length) {
    games.append(el('p', 'empty', 'No game has joined OpenVibe.Play yet.'))
    keep.hidden = true
    return
  }
  for (const t of titles) games.append(gameCard(t, t.achievements, false))
  keep.hidden = true
}

async function load(): Promise<void> {
  try {
    const mine = await read<Mine>('/api/v1/play/achievements')
    const titles = (await read<{ titles: PlayTitle[] }>('/api/v1/play/titles'))?.titles ?? []
    if (mine && mine.signedIn !== false && Array.isArray(mine.titles)) showSignedIn(mine, titles)
    else showSignedOut(titles)
  } catch {
    status.className = 'status error'
    status.textContent = 'Achievements are unavailable right now. Try again in a minute.'
  }
}

void load()
