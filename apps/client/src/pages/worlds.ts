export {}

/**
 * /worlds: the published creator worlds, and the signed-in player's own (make, publish, edit, delete, remix). A remix
 * copies a published world into a new draft of yours, credited (owner, 2026-10-27: "the same way you can copy our
 * game"); /worlds?remix=<id> (a world page's Remix link) makes one and opens it in the editor, after sign-in if needed.
 */

interface World {
  id: string
  title: string
  summary: string
  owner: string
  plays: number
  online: number
  published_at: string | null
  updated_at: string
  play_url: string
  status?: 'draft' | 'published' | 'hidden'
  edit_url?: string
  remixed_from?: { id: string; title: string; owner: string; url: string } | null
  remixes?: number
}

interface Mine {
  worlds: World[]
  max: number
  staff: boolean
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const signedOut = $('signed-out')
const signedIn = $('signed-in')
const mineGrid = $('mine')
const mineStatus = $('mine-status')
const publishedGrid = $('published')
const publishedStatus = $('published-status')
const moreRow = $('more-row')
const moreButton = $<HTMLButtonElement>('more')
const createForm = $<HTMLFormElement>('create')
const createTitle = $<HTMLInputElement>('create-title')
const createSummary = $<HTMLTextAreaElement>('create-summary')
const createButton = $<HTMLButtonElement>('create-button')
const createStatus = $('create-status')

/** The Network access token the site keeps after sign-in (the same one /play and /editor use). */
function token(): string {
  const stored = localStorage.getItem('ovg_sso')
  if (stored) return stored
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('ovg_sso='))
  return cookie ? decodeURIComponent(cookie.slice('ovg_sso='.length)) : ''
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = token()
  const resp = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (resp.status === 204) return undefined as T
  const body = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string }
  if (!resp.ok) throw new ApiError(resp.status, body.detail ?? body.error ?? `HTTP ${resp.status}`)
  return body as T
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.className) node.className = props.className
  if (props.text !== undefined) node.textContent = props.text
  for (const child of children) if (child) node.append(child)
  return node
}

function link(text: string, href: string, primary = false, className?: string): HTMLAnchorElement {
  const a = el('a', { className: className ?? (primary ? 'button primary' : 'button'), text })
  a.href = href
  return a
}

function button(
  text: string,
  onClick: (b: HTMLButtonElement) => void,
  className = '',
): HTMLButtonElement {
  const b = el('button', { className, text })
  b.type = 'button'
  b.addEventListener('click', () => onClick(b))
  return b
}

/** A world's title: a link to its own page (/worlds/<id>) once it is published, plain text before. */
function titleOf(world: World): HTMLElement {
  const heading = el('h3')
  if ((world.status ?? 'published') === 'published')
    heading.append(link(world.title, `/worlds/${world.id}`, false, 'title'))
  else heading.textContent = world.title
  return heading
}

const count = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

function stats(world: World): string {
  const parts = [count(world.plays, 'visit', 'visits')]
  if (world.online > 0) parts.unshift(`${world.online} playing now`)
  if (world.remixes) parts.push(count(world.remixes, 'remix', 'remixes'))
  return parts.join(' · ')
}

/** "Remix of <title> by <owner>", the credit a remix carries (null for an original). */
function credit(world: World): HTMLElement | null {
  const from = world.remixed_from
  if (!from) return null
  return el(
    'p',
    { className: 'by' },
    document.createTextNode('Remix of '),
    link(from.title || 'a world', from.url, false, 'inline'),
    document.createTextNode(` by ${from.owner}`),
  )
}

const remixStatus = (): HTMLElement => (signedIn.hidden ? publishedStatus : createStatus)

/** Copy a world into a new draft of yours and open it in the editor. */
async function remixWorld(id: string, b?: HTMLButtonElement): Promise<void> {
  if (b) b.disabled = true
  remixStatus().textContent = 'Making your remix…'
  try {
    const world = await api<World>(`/api/worlds/${encodeURIComponent(id)}/remix`, { method: 'POST' })
    remixStatus().textContent = ''
    if (world.edit_url) location.href = world.edit_url
  } catch (err) {
    remixStatus().textContent = err instanceof Error ? err.message : 'That did not work.'
    if (b) b.disabled = false
  }
}

function publishedCard(world: World, staff: boolean): HTMLElement {
  const card = el(
    'article',
    { className: 'card' },
    titleOf(world),
    el('p', { className: 'by', text: `by ${world.owner}` }),
    credit(world),
    world.summary ? el('p', { className: 'summary', text: world.summary }) : null,
    el('p', { className: 'stats', text: stats(world) }),
  )
  const actions = el('div', { className: 'actions' }, link('▶ Play', world.play_url, true))
  // Anyone signed in may copy a published world into a world of their own; signed out, the link signs in first.
  if (token()) actions.append(button('Remix', (b) => void remixWorld(world.id, b)))
  else actions.append(link('Remix', `/auth/login?next=${encodeURIComponent(`/worlds?remix=${world.id}`)}`))
  if (staff)
    actions.append(
      button(
        'Take down',
        (b) => void change(b, world.id, { status: 'hidden' }, 'Take this world down for everyone?'),
        'danger',
      ),
    )
  card.append(actions)
  return card
}

function mineCard(world: World): HTMLElement {
  const status = world.status ?? 'draft'
  const label = status === 'published' ? 'Published' : status === 'hidden' ? 'Taken down' : 'Draft'
  const card = el(
    'article',
    { className: 'card' },
    el('span', { className: `badge ${status}`, text: label }),
    titleOf(world),
    credit(world),
    world.summary ? el('p', { className: 'summary', text: world.summary }) : null,
    el('p', { className: 'stats', text: stats(world) }),
  )
  const actions = el('div', { className: 'actions' })
  if (world.edit_url) actions.append(link('Edit', world.edit_url, true))
  if (status !== 'hidden')
    actions.append(link(status === 'published' ? 'Play' : 'Try it', world.play_url))
  if (status === 'draft')
    actions.append(button('Publish', (b) => void change(b, world.id, { status: 'published' })))
  if (status === 'published')
    actions.append(button('Unpublish', (b) => void change(b, world.id, { status: 'draft' })))
  actions.append(
    button('Rename', (b) => {
      const title = prompt('New title (up to 60 characters)', world.title)
      if (title !== null && title.trim() && title !== world.title)
        void change(b, world.id, { title })
    }),
    button(
      'Delete',
      (b) =>
        void remove(
          b,
          world.id,
          `Delete “${world.title}”? Its map and everything built in it go too.`,
        ),
      'danger',
    ),
  )
  if (status === 'hidden')
    card.append(
      el('p', {
        className: 'summary',
        text: 'Staff took this world down. You can still edit it; ask on openvibe.help to bring it back.',
      }),
    )
  card.append(actions)
  return card
}

let staff = false
let page = 1

async function change(
  b: HTMLButtonElement,
  id: string,
  patch: Record<string, string>,
  confirmText?: string,
): Promise<void> {
  if (confirmText && !confirm(confirmText)) return
  b.disabled = true
  try {
    await api(`/api/worlds/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    await Promise.all([loadMine(), loadPublished(true)])
  } catch (err) {
    b.disabled = false
    alert(err instanceof Error ? err.message : 'That did not work. Try again.')
  }
}

async function remove(b: HTMLButtonElement, id: string, confirmText: string): Promise<void> {
  if (!confirm(confirmText)) return
  b.disabled = true
  try {
    await api(`/api/worlds/${id}`, { method: 'DELETE' })
    await Promise.all([loadMine(), loadPublished(true)])
  } catch (err) {
    b.disabled = false
    alert(err instanceof Error ? err.message : 'That did not work. Try again.')
  }
}

async function loadMine(): Promise<void> {
  if (!token()) {
    signedOut.hidden = false
    signedIn.hidden = true
    return
  }
  try {
    const mine = await api<Mine>('/api/worlds/mine')
    staff = mine.staff
    signedOut.hidden = true
    signedIn.hidden = false
    mineGrid.replaceChildren(...mine.worlds.map(mineCard))
    const full = mine.worlds.length >= mine.max
    createButton.disabled = full
    mineStatus.textContent = mine.worlds.length
      ? full
        ? `You have ${mine.max} worlds, the most one person keeps. Delete one to make another.`
        : ''
      : 'No worlds yet. Give your first one a title and open it in the editor.'
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      signedOut.hidden = false
      signedIn.hidden = true
      return
    }
    mineStatus.textContent = 'Your worlds could not be loaded. Refresh to try again.'
  }
}

async function loadPublished(reset = false): Promise<void> {
  if (reset) page = 1
  try {
    const data = await api<{ worlds: World[]; more: boolean }>(`/api/worlds?page=${page}`)
    const cards = data.worlds.map((w) => publishedCard(w, staff))
    if (page === 1) publishedGrid.replaceChildren(...cards)
    else publishedGrid.append(...cards)
    moreRow.hidden = !data.more
    publishedStatus.textContent =
      page === 1 && data.worlds.length === 0
        ? 'No published worlds yet. Yours could be the first.'
        : ''
  } catch {
    publishedStatus.textContent = 'Worlds could not be loaded. Refresh to try again.'
  }
}

createForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void (async () => {
    createButton.disabled = true
    createStatus.textContent = 'Making your world…'
    try {
      const world = await api<World>('/api/worlds', {
        method: 'POST',
        body: JSON.stringify({ title: createTitle.value, summary: createSummary.value }),
      })
      createStatus.textContent = ''
      if (world.edit_url) location.href = world.edit_url
    } catch (err) {
      createStatus.textContent = err instanceof Error ? err.message : 'That did not work.'
      createButton.disabled = false
    }
  })()
})

moreButton.addEventListener('click', () => {
  page++
  void loadPublished()
})

void loadMine().then(() => {
  // A world page's Remix link: make the copy and open it, or sign in first and come back here to do it.
  const want = new URLSearchParams(location.search).get('remix')
  if (want && /^w[a-z0-9]{10}$/.test(want)) {
    if (!signedIn.hidden) {
      history.replaceState(null, '', '/worlds')
      void remixWorld(want)
    } else {
      const signIn = signedOut.querySelector<HTMLAnchorElement>('a.button')
      if (signIn) signIn.href = `/auth/login?next=${encodeURIComponent(`/worlds?remix=${want}`)}`
      const note = signedOut.querySelector('.status')
      if (note) note.textContent = 'Sign in with your OpenVibe account to remix that world into one of your own.'
    }
  }
  return loadPublished(true)
})
