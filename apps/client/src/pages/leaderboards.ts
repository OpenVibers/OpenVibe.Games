/**
 * Leaderboards on OpenVibe.Games: every game's board, this week and all time.
 *
 * The data is Play's, read through this site's own route (/api/v1/play/titles/…); the page
 * never reads Play's tables. The query string carries the game, board and period so a link
 * opens the same board, and the old /leaderboard.html?game=… links keep working.
 */
export {}

interface PlayBoardDef {
  id: string
  name: string
  kind: 'best' | 'sum'
}

interface PlayTitle {
  id: string
  name: string
  url?: string
  summary?: string
  boards: PlayBoardDef[]
}

interface BoardPage {
  title: string
  title_name: string
  board: string
  name: string
  kind: 'best' | 'sum'
  period: 'all' | 'week'
  page: number
  pages: number
  total: number
  entries: { rank: number; name: string; score: number; signed_in: boolean }[]
}

const gameTabs = document.getElementById('game-tabs') as HTMLElement
const boardTabs = document.getElementById('board-tabs') as HTMLElement
const periodTabs = document.getElementById('period-tabs') as HTMLElement
const status = document.getElementById('status') as HTMLElement
const entries = document.getElementById('entries') as HTMLElement
const pageLabel = document.getElementById('page') as HTMLElement
const previous = document.getElementById('previous') as HTMLButtonElement
const next = document.getElementById('next') as HTMLButtonElement
const title = document.getElementById('title') as HTMLElement
const lede = document.getElementById('lede') as HTMLElement
const scoreHeader = document.getElementById('score-header') as HTMLElement
const playLink = document.getElementById('play-link') as HTMLAnchorElement

const query = new URLSearchParams(location.search)
const wantedGame = query.get('game') ?? ''
const wantedBoard = query.get('board') ?? ''
const wantedPeriod: 'all' | 'week' = query.get('period') === 'week' ? 'week' : 'all'

let titles: PlayTitle[] = []
let game = wantedGame
let board = wantedBoard
let period: 'all' | 'week' = wantedPeriod
let page = 1
let loadId = 0

const num = (n: number): string => Number(n).toLocaleString('en-US')

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

function tabs(
  host: HTMLElement,
  items: { id: string; label: string }[],
  current: string,
  onPick: (id: string) => void,
): void {
  host.replaceChildren(
    ...items.map((item) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = item.label
      button.setAttribute('aria-pressed', String(item.id === current))
      button.addEventListener('click', () => {
        if (item.id !== current) onPick(item.id)
      })
      return button
    }),
  )
}

function currentTitle(): PlayTitle {
  return titles.find((t) => t.id === game) ?? titles.find((t) => t.boards.length)!
}

function setUrl(): void {
  const next = new URLSearchParams()
  next.set('game', game)
  if (board) next.set('board', board)
  if (period === 'week') next.set('period', 'week')
  history.replaceState(null, '', `${location.pathname}?${next.toString()}`)
}

function selectGame(id: string): void {
  game = id
  const t = currentTitle()
  board = t.boards[0]?.id ?? ''
  page = 1
  apply()
  setUrl()
  void load()
}

function selectBoard(id: string): void {
  board = id
  page = 1
  apply()
  setUrl()
  void load()
}

function selectPeriod(nextPeriod: 'all' | 'week'): void {
  period = nextPeriod
  page = 1
  apply()
  setUrl()
  void load()
}

function apply(): void {
  const t = currentTitle()
  if (!t) return
  game = t.id
  if (!t.boards.some((b) => b.id === board)) board = t.boards[0]?.id ?? ''
  const def = t.boards.find((b) => b.id === board)
  title.textContent = t.name
  lede.textContent = t.summary
    ? `${t.summary} ${period === 'week' ? 'This week, from Monday 00:00 UTC.' : 'All time.'}`
    : period === 'week'
      ? "This week's board, from Monday 00:00 UTC."
      : 'The all-time board.'
  scoreHeader.textContent = def?.kind === 'sum' ? 'Total' : 'Best'
  playLink.href = t.url || '/play'
  playLink.textContent = `▶ Play ${t.name}`
  document.title = `${t.name} leaderboard · OpenVibe.Games`
  tabs(
    gameTabs,
    titles.filter((x) => x.boards.length).map((x) => ({ id: x.id, label: x.name })),
    game,
    selectGame,
  )
  tabs(
    boardTabs,
    t.boards.map((b) => ({ id: b.id, label: b.name })),
    board,
    selectBoard,
  )
  boardTabs.hidden = t.boards.length < 2
  for (const button of periodTabs.querySelectorAll<HTMLButtonElement>('button[data-period]')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === period))
  }
}

async function load(): Promise<void> {
  const id = ++loadId
  const t = currentTitle()
  if (!t) return
  status.className = 'status'
  status.textContent = 'Loading…'
  entries.replaceChildren()
  previous.disabled = page === 1
  next.disabled = true
  pageLabel.textContent = `Page ${page}`
  try {
    const queryString = new URLSearchParams({ period, page: String(page) })
    const response = await fetch(
      `/api/v1/play/titles/${encodeURIComponent(t.id)}/boards/${encodeURIComponent(board)}?${queryString}`,
      { headers: { accept: 'application/json' } },
    )
    if (!response.ok) throw new Error(`unavailable: ${response.status}`)
    const data = (await response.json()) as BoardPage
    if (id !== loadId) return
    for (const entry of data.entries) {
      const row = document.createElement('tr')
      if (entry.rank <= 3) row.className = `top-${entry.rank}`
      const player = cell(entry.name, 'name')
      if (!entry.signed_in) {
        const guest = document.createElement('span')
        guest.className = 'guest'
        guest.textContent = 'guest'
        player.append(guest)
      }
      row.append(cell(String(entry.rank), 'rank'), player, cell(num(entry.score)))
      entries.append(row)
    }
    status.textContent = data.entries.length
      ? ''
      : period === 'week'
        ? 'Nobody has scored this week yet. Play a round and take first place.'
        : 'Nobody has scored yet. Play a round and take first place.'
    pageLabel.textContent = `Page ${page} of ${data.pages}`
    previous.disabled = page <= 1
    next.disabled = page >= data.pages
  } catch {
    if (id !== loadId) return
    status.className = 'status error'
    status.textContent = 'The leaderboard is unavailable right now. Try again in a minute.'
    pageLabel.textContent = `Page ${page}`
  }
}

for (const button of periodTabs.querySelectorAll<HTMLButtonElement>('button[data-period]')) {
  button.addEventListener('click', () => {
    const chosen = button.dataset.period === 'week' ? 'week' : 'all'
    if (chosen !== period) selectPeriod(chosen)
  })
}

previous.addEventListener('click', () => {
  if (page > 1) {
    page--
    void load()
  }
})

next.addEventListener('click', () => {
  page++
  void load()
})

async function start(): Promise<void> {
  try {
    const response = await fetch('/api/v1/play/titles', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`unavailable: ${response.status}`)
    titles = ((await response.json()) as { titles: PlayTitle[] }).titles.filter(
      (t) => t.boards.length,
    )
    const first = titles[0]
    if (!first) {
      status.textContent = 'No game has a board yet.'
      return
    }
    if (!titles.some((t) => t.id === game)) game = first.id
    apply()
    setUrl()
    await load()
  } catch {
    status.className = 'status error'
    status.textContent = 'The leaderboards are unavailable right now. Try again in a minute.'
  }
}

void start()
