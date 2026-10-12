export {}

interface Entry {
  rank: number
  name: string
  score: number
}
// Salvage Rush is the only game with scored rounds today; Scraplandia has no scored mode, so it has no board here.
const GAME = 'salvage-rush'
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tabs button[data-period]'))
const status = document.getElementById('status') as HTMLElement
const entries = document.getElementById('entries') as HTMLElement
const pageLabel = document.getElementById('page') as HTMLElement
const previous = document.getElementById('previous') as HTMLButtonElement
const next = document.getElementById('next') as HTMLButtonElement
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

async function load(): Promise<void> {
  for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.period === period))
  status.textContent = 'Loading…'
  entries.replaceChildren()
  previous.disabled = page === 1
  next.disabled = true
  pageLabel.textContent = `Page ${page}`
  try {
    const response = await fetch(`/api/v1/games/${GAME}/leaderboard?period=${period}&page=${page}`)
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
    status.textContent = data.entries.length
      ? ''
      : period === 'week'
        ? 'No rounds scored this week yet. Play one and take first place.'
        : 'No rounds scored yet. Play one and take first place.'
    next.disabled = data.entries.length < data.pageSize
  } catch {
    status.textContent = 'The leaderboard is unavailable right now. Try again in a minute.'
  }
}

for (const tab of tabs) {
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
void load()
