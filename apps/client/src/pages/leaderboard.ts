export {}

interface Entry {
  rank: number
  name: string
  score: number
}

type Game = 'salvage-rush' | 'scraplandia'

const gameTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tabs button[data-game]'))
const periodTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.tabs button[data-period]'),
)
const status = document.getElementById('status') as HTMLElement
const entries = document.getElementById('entries') as HTMLElement
const pageLabel = document.getElementById('page') as HTMLElement
const previous = document.getElementById('previous') as HTMLButtonElement
const next = document.getElementById('next') as HTMLButtonElement
const title = document.getElementById('title') as HTMLElement
const lede = document.getElementById('lede') as HTMLElement
const scoreHeader = document.getElementById('score-header') as HTMLElement
const playLink = document.getElementById('play-link') as HTMLAnchorElement

const COPY: Record<
  Game,
  {
    title: string
    lede: string
    score: string
    play: string
    playLabel: string
    empty: (period: 'all' | 'week') => string
  }
> = {
  'salvage-rush': {
    title: 'Salvage Rush',
    lede:
      "Each player's best round score. Rounds last 90 seconds; every point comes from a pickup the server counted.",
    score: 'Best score',
    play: '/play?game=salvage-rush',
    playLabel: '▶ Play a round',
    empty: (period) =>
      period === 'week'
        ? 'No rounds scored this week yet. Play one and take first place.'
        : 'No rounds scored yet. Play one and take first place.',
  },
  scraplandia: {
    title: 'Scraplandia haul',
    lede:
      'Total haul points from server-confirmed extractions. Hold a recovery-bird circle to secure valuables and score.',
    score: 'Haul points',
    play: '/play',
    playLabel: '▶ Play Scraplandia',
    empty: (period) =>
      period === 'week'
        ? 'No hauls recorded this week yet. Extract some salvage to take first place.'
        : 'No hauls recorded yet. Extract some salvage to take first place.',
  },
}

let game: Game =
  new URLSearchParams(location.search).get('game') === 'scraplandia' ? 'scraplandia' : 'salvage-rush'
let period: 'all' | 'week' =
  new URLSearchParams(location.search).get('period') === 'week' ? 'week' : 'all'
let page = 1

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td')
  if (className) {
    const span = document.createElement('span')
    span.className = className
    span.textContent = text
    td.append(span)
  } else td.textContent = text
  return td
}

function applyGame(): void {
  for (const tab of gameTabs) tab.setAttribute('aria-pressed', String(tab.dataset.game === game))
  const copy = COPY[game]
  title.textContent = copy.title
  lede.textContent = copy.lede
  scoreHeader.textContent = copy.score
  playLink.href = copy.play
  playLink.textContent = copy.playLabel
  document.title = `${copy.title} leaderboard · OpenVibe.Games`
}

async function load(): Promise<void> {
  for (const tab of periodTabs) tab.setAttribute('aria-pressed', String(tab.dataset.period === period))
  const copy = COPY[game]
  status.textContent = 'Loading…'
  entries.replaceChildren()
  previous.disabled = page === 1
  next.disabled = true
  pageLabel.textContent = `Page ${page}`
  try {
    const response = await fetch(`/api/v1/games/${game}/leaderboard?period=${period}&page=${page}`)
    if (!response.ok) throw new Error('unavailable')
    const data = (await response.json()) as { entries: Entry[]; pageSize: number }
    for (const entry of data.entries) {
      const row = document.createElement('tr')
      if (entry.rank <= 3) row.className = `top-${entry.rank}`
      row.append(
        cell(String(entry.rank), 'rank'),
        cell(entry.name, 'name'),
        cell(entry.score.toLocaleString('en-US')),
      )
      entries.append(row)
    }
    status.textContent = data.entries.length ? '' : copy.empty(period)
    next.disabled = data.entries.length < data.pageSize
  } catch {
    status.textContent = 'The leaderboard is unavailable right now. Try again in a minute.'
  }
}

for (const tab of gameTabs) {
  tab.onclick = () => {
    const chosen = tab.dataset.game === 'scraplandia' ? 'scraplandia' : 'salvage-rush'
    if (chosen === game) return
    game = chosen
    page = 1
    applyGame()
    void load()
  }
}

for (const tab of periodTabs) {
  tab.onclick = () => {
    const chosen = tab.dataset.period === 'week' ? 'week' : 'all'
    if (chosen === period) return
    period = chosen
    page = 1
    void load()
  }
}

previous.onclick = () => {
  if (page > 1) {
    page--
    void load()
  }
}

next.onclick = () => {
  page++
  void load()
}

applyGame()
void load()
