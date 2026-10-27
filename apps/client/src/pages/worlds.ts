export {}

/**
 * /worlds: the published creator worlds, and the signed-in player's own (make, publish, edit, delete, remix). A remix
 * copies a published world into a new draft of yours, credited (owner, 2026-10-27: "the same way you can copy our
 * game"); /worlds?remix=<id> (a world page's Remix link) makes one and opens it in the editor, after sign-in if needed.
 * The asset store (migration 0016) lists the builds and scripts creators share; using one puts it in a world you build.
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
  /** 'editor' on a world of someone else's team (migration 0015). */
  role?: 'owner' | 'editor'
}

interface Mine {
  worlds: World[]
  /** Worlds on someone else's team. */
  team?: World[]
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
    const world = await api<World>(`/api/worlds/${encodeURIComponent(id)}/remix`, {
      method: 'POST',
    })
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
  else
    actions.append(
      link('Remix', `/auth/login?next=${encodeURIComponent(`/worlds?remix=${world.id}`)}`),
    )
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
    button('Scripts', () => void openScripts(world)),
    button('Team', () => void openTeam(world)),
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

// ── Scripts: a world's own games-quickjs@1 mods (docs/mods.md "Scripts in creator worlds") ──
interface WorldScript {
  format: 'games-quickjs@1'
  id: string
  version: string
  entry: string
  source: string
  /** A multi-file mod made through the API: the editor shows (and saves) its entry file as the script. */
  files?: Record<string, string>
  hooks: string[]
  capabilities?: string[]
}
const HOOKS = ['onTick', 'onPlayerJoin', 'onPlayerLeave']
const CAPABILITIES: [string, string][] = [
  ['players.read', 'See the players'],
  ['player.message', 'Message a player'],
  ['world.emit', 'Announce and give items'],
  ['storage.kv', 'Remember things'],
]
const STARTER = `// Runs in your world's sandbox. game.message(id, text) needs "Message a player".
function onPlayerJoin(e) {
  game.message(e.player.id, 'Welcome, ' + e.player.name + '!')
}
`

function checkbox(label: string, checked: boolean): [HTMLLabelElement, HTMLInputElement] {
  const box = el('input')
  box.type = 'checkbox'
  box.checked = checked
  const wrap = el('label', { className: 'check' }, box, document.createTextNode(` ${label}`))
  return [wrap, box]
}

/** The scripts editor for one of your worlds: each script's name, hooks, what it may do and its code, then Save. */
async function openScripts(world: World): Promise<void> {
  let data: { scripts: WorldScript[]; running: boolean; limits: { mods: number } }
  try {
    data = await api(`/api/worlds/${world.id}/scripts`)
  } catch (err) {
    mineStatus.textContent = err instanceof Error ? err.message : 'Scripts could not be loaded.'
    return
  }
  const dialog = el('dialog', { className: 'scripts' })
  const list = el('div', { className: 'script-list' })
  const status = el('p', { className: 'status' })
  const rows: (() => WorldScript)[] = []
  const addRow = (script: WorldScript) => {
    const name = el('input')
    name.value = script.id
    name.maxLength = 40
    name.setAttribute('aria-label', 'Script name')
    const hooks = HOOKS.map((h) => checkbox(h, script.hooks.includes(h)))
    const caps = CAPABILITIES.map(([c, label]) =>
      checkbox(label, (script.capabilities ?? []).includes(c)),
    )
    const code = el('textarea', { className: 'code' })
    code.value = script.source ?? script.files?.[script.entry] ?? ''
    code.spellcheck = false
    code.setAttribute('aria-label', 'Script code')
    const card = el(
      'fieldset',
      { className: 'script' },
      el('label', { text: 'Name (a-z, 0-9, - and _)' }, name),
      el('div', { className: 'checks' }, ...hooks.map(([w]) => w)),
      el('div', { className: 'checks' }, ...caps.map(([w]) => w)),
      code,
    )
    const read = (): WorldScript => ({
      format: 'games-quickjs@1',
      id: name.value.trim(),
      version: script.version || '1.0.0',
      entry: script.entry || `${name.value.trim() || 'main'}.js`,
      source: code.value,
      hooks: HOOKS.filter((_, i) => hooks[i]?.[1].checked),
      capabilities: CAPABILITIES.filter((_, i) => caps[i]?.[1].checked).map(([c]) => c),
    })
    const remove = button('Remove this script', () => {
      card.remove()
      rows.splice(rows.indexOf(read), 1)
    })
    const share = button(
      'Share in the asset store',
      (b) => void shareScript(world, read(), b, status),
    )
    card.append(el('div', { className: 'row' }, remove, share))
    rows.push(read)
    list.append(card)
  }
  data.scripts.forEach(addRow)
  const add = button('Add a script', () => {
    if (rows.length >= data.limits.mods) {
      status.textContent = `A world takes at most ${data.limits.mods} scripts.`
      return
    }
    addRow({
      format: 'games-quickjs@1',
      id: `script-${rows.length + 1}`,
      version: '1.0.0',
      entry: `script-${rows.length + 1}.js`,
      source: STARTER,
      hooks: ['onPlayerJoin'],
      capabilities: ['players.read', 'player.message'],
    })
  })
  const save = button(
    'Save scripts',
    (b) =>
      void (async () => {
        b.disabled = true
        status.textContent = 'Saving…'
        try {
          // A script's entry follows its name, so renaming one keeps it loadable.
          const scripts = rows
            .map((read) => read())
            .map((s) => ({ ...s, entry: `${s.id || 'main'}.js` }))
          await api(`/api/worlds/${world.id}/scripts`, {
            method: 'PUT',
            body: JSON.stringify({ scripts }),
          })
          status.textContent = data.running
            ? 'Saved. Anyone in the world now was asked to join again; the new scripts run from the next join.'
            : 'Saved. Scripts are kept with your world and run once this server switches creator scripts on.'
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : 'That did not work.'
        } finally {
          b.disabled = false
        }
      })(),
    'primary',
  )
  dialog.append(
    el('h2', { text: `Scripts for ${world.title}` }),
    el('p', {
      className: 'status',
      text: data.running
        ? 'Scripts run in your world when someone joins it, in a sandbox, each with only what you tick for it.'
        : 'Scripts are not switched on for creator worlds on this server yet. You can write and save them now.',
    }),
    list,
    el(
      'div',
      { className: 'row' },
      add,
      save,
      button('Close', () => dialog.close()),
    ),
    status,
  )
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}

/** A world on someone else's team: build it, try it, edit its scripts, or leave the team. */
function teamCard(world: World): HTMLElement {
  const card = el(
    'article',
    { className: 'card' },
    el('span', { className: 'badge team', text: 'Team' }),
    titleOf(world),
    el('p', { className: 'by', text: `by ${world.owner}` }),
    el('p', { className: 'stats', text: stats(world) }),
  )
  const actions = el('div', { className: 'actions' })
  if (world.edit_url) actions.append(link('Edit', world.edit_url, true))
  if ((world.status ?? 'draft') !== 'hidden') actions.append(link('Try it', world.play_url))
  actions.append(
    button('Scripts', () => void openScripts(world)),
    button(
      'Leave',
      (b) =>
        void (async () => {
          if (!confirm(`Leave the team of “${world.title}”?`)) return
          b.disabled = true
          try {
            await api(`/api/worlds/${world.id}/team/me`, { method: 'DELETE' })
          } catch (err) {
            mineStatus.textContent = err instanceof Error ? err.message : 'That did not work.'
          } finally {
            await loadMine()
          }
        })(),
      'danger',
    ),
  )
  card.append(actions)
  return card
}

/** Your world's team: who builds it with you, and the invite link that adds people. */
async function openTeam(world: World): Promise<void> {
  const dialog = el('dialog', { className: 'scripts' })
  const body = el('div', { className: 'script-list' })
  const status = el('p', { className: 'status' })
  const draw = async () => {
    let data: {
      owner: string
      members: { subject: string; name: string; added_at: string }[]
      max: number
      invite_expires_at?: string | null
    }
    try {
      data = await api(`/api/worlds/${world.id}/team`)
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : 'The team could not be loaded.'
      return
    }
    const rows = data.members.map((m) =>
      el(
        'div',
        { className: 'row member' },
        el('span', { text: m.name }),
        button(
          'Remove',
          (b) =>
            void (async () => {
              b.disabled = true
              await api(`/api/worlds/${world.id}/team/${encodeURIComponent(m.subject)}`, {
                method: 'DELETE',
              })
              await draw()
            })(),
          'danger',
        ),
      ),
    )
    const invite = el('div', { className: 'invite' })
    const showLink = (url: string, expires: string) => {
      const field = el('input')
      field.readOnly = true
      field.value = new URL(url, location.origin).toString()
      field.setAttribute('aria-label', 'Invite link')
      invite.replaceChildren(
        el(
          'label',
          { text: `Invite link (works until ${new Date(expires).toLocaleDateString()})` },
          field,
        ),
        el(
          'div',
          { className: 'row' },
          button('Copy link', () => {
            field.select()
            void navigator.clipboard
              ?.writeText(field.value)
              .then(() => (status.textContent = 'Link copied.'))
          }),
          button(
            'Stop the link',
            (b) =>
              void (async () => {
                b.disabled = true
                await api(`/api/worlds/${world.id}/invite`, { method: 'DELETE' })
                await draw()
              })(),
          ),
        ),
      )
    }
    const make = button(
      data.invite_expires_at ? 'Make a new invite link' : 'Make an invite link',
      (b) =>
        void (async () => {
          b.disabled = true
          try {
            const made = await api<{ url: string; expires_at: string }>(
              `/api/worlds/${world.id}/invite`,
              {
                method: 'POST',
              },
            )
            showLink(made.url, made.expires_at)
            status.textContent =
              'Send this link to the people you want to build with. Anyone signed in who opens it joins.'
          } finally {
            b.disabled = false
          }
        })(),
      'primary',
    )
    invite.replaceChildren(
      el('p', {
        className: 'status',
        text: data.invite_expires_at
          ? `An invite link works until ${new Date(data.invite_expires_at).toLocaleDateString()}. For safety it is shown only when made; make a new one to share it again.`
          : 'No invite link yet.',
      }),
      el('div', { className: 'row' }, make),
    )
    if (data.invite_expires_at) {
      invite.querySelector('.row')?.append(
        button(
          'Stop the link',
          (b) =>
            void (async () => {
              b.disabled = true
              await api(`/api/worlds/${world.id}/invite`, { method: 'DELETE' })
              await draw()
            })(),
        ),
      )
    }
    body.replaceChildren(
      el('p', {
        className: 'status',
        text: `Your team edits this world's map and scripts with you (up to ${data.max} people). You alone publish, rename and delete it.`,
      }),
      ...(rows.length ? rows : [el('p', { className: 'status', text: 'Nobody on the team yet.' })]),
      invite,
    )
  }
  dialog.append(
    el('h2', { text: `Team for ${world.title}` }),
    body,
    el(
      'div',
      { className: 'row' },
      button('Close', () => dialog.close()),
    ),
    status,
  )
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  await draw()
}

/** Join a team from an invite link, then open the world in the editor. */
async function joinTeam(token: string): Promise<void> {
  mineStatus.textContent = 'Joining the team…'
  try {
    const world = await api<World>('/api/worlds/join', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    mineStatus.textContent = ''
    if (world.edit_url) location.href = world.edit_url
  } catch (err) {
    mineStatus.textContent = err instanceof Error ? err.message : 'That invite did not work.'
  }
}

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
    myWorlds = [...mine.worlds, ...(mine.team ?? [])]
    signedOut.hidden = true
    signedIn.hidden = false
    yoursButton.hidden = false
    mineGrid.replaceChildren(...mine.worlds.map(mineCard), ...(mine.team ?? []).map(teamCard))
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

// ── The asset store (migration 0016): builds and scripts creators share for anyone's worlds ──
interface Asset {
  id: string
  kind: 'prefab' | 'script'
  title: string
  summary: string
  owner: string
  uses: number
  contents: { pieces?: number; hooks?: string[]; capabilities?: string[] }
  from_world: { id: string; title: string; url: string } | null
  created_at: string
  /** Only on your own (and to staff). */
  status?: 'published' | 'hidden'
}

const assetsGrid = $('assets')
const assetsStatus = $('assets-status')
const assetsMoreRow = $('assets-more-row')
const assetsMore = $<HTMLButtonElement>('assets-more')
const kindButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.kinds button'))
const yoursButton = kindButtons.find((b) => b.dataset['kind'] === 'mine') as HTMLButtonElement
let assetKind = 'all'
let assetPage = 1
/** The worlds you build (yours and your teams'): where an asset can go. */
let myWorlds: World[] = []

function assetStats(asset: Asset): string {
  const used = asset.uses ? `used by ${count(asset.uses, 'person', 'people')}` : 'not used yet'
  if (asset.kind === 'prefab')
    return `${count(asset.contents.pieces ?? 0, 'piece', 'pieces')} · ${used}`
  const hooks = (asset.contents.hooks ?? []).join(', ')
  return `${hooks || 'no hooks'} · ${used}`
}

function assetCard(asset: Asset, own: boolean): HTMLElement {
  const hidden = asset.status === 'hidden'
  const card = el(
    'article',
    { className: 'card' },
    el('span', {
      className: `badge ${hidden ? 'hidden' : asset.kind}`,
      text: hidden ? 'Taken down' : asset.kind === 'prefab' ? 'Build' : 'Script',
    }),
    el('h3', { text: asset.title }),
    el('p', { className: 'by', text: `by ${asset.owner}` }),
  )
  if (asset.from_world) {
    const from = el('p', { className: 'stats' }, document.createTextNode('from '))
    from.append(link(asset.from_world.title, asset.from_world.url, false, 'title'))
    card.append(from)
  }
  if (asset.summary) card.append(el('p', { className: 'summary', text: asset.summary }))
  card.append(el('p', { className: 'stats', text: assetStats(asset) }))
  const actions = el('div', { className: 'actions' })
  if (!hidden) {
    if (token())
      actions.append(
        button(
          asset.kind === 'prefab' ? 'Use in a world' : 'Add to a world',
          () => void useAsset(asset),
          'primary',
        ),
      )
    else actions.append(link('Sign in to use it', '/auth/login?next=%2Fworlds', true))
  }
  if (own)
    actions.append(
      button('Rename', (b) => {
        const title = prompt('New title (up to 60 characters)', asset.title)
        if (title !== null && title.trim() && title !== asset.title)
          void changeAsset(b, asset.id, { title })
      }),
      button(
        'Delete',
        (b) =>
          void (async () => {
            if (
              !confirm(
                `Delete “${asset.title}” from the asset store? Worlds that use it keep their copy.`,
              )
            )
              return
            b.disabled = true
            try {
              await api(`/api/assets/${asset.id}`, { method: 'DELETE' })
              await loadAssets(true)
            } catch (err) {
              b.disabled = false
              alert(err instanceof Error ? err.message : 'That did not work. Try again.')
            }
          })(),
        'danger',
      ),
    )
  else if (staff)
    actions.append(
      hidden
        ? button('Put back', (b) => void changeAsset(b, asset.id, { status: 'published' }))
        : button(
            'Take down',
            (b) =>
              void changeAsset(
                b,
                asset.id,
                { status: 'hidden' },
                'Take this asset down for everyone?',
              ),
            'danger',
          ),
    )
  card.append(actions)
  return card
}

async function changeAsset(
  b: HTMLButtonElement,
  id: string,
  patch: Record<string, string>,
  confirmText?: string,
): Promise<void> {
  if (confirmText && !confirm(confirmText)) return
  b.disabled = true
  try {
    await api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    await loadAssets(true)
  } catch (err) {
    b.disabled = false
    alert(err instanceof Error ? err.message : 'That did not work. Try again.')
  }
}

/** Which of your worlds an asset goes into: a small list to pick from. */
function pickWorld(asset: Asset): Promise<World | null> {
  return new Promise((resolve) => {
    const dialog = el('dialog', { className: 'scripts' })
    let chosen: World | null = null
    const list = el('div')
    for (const world of myWorlds)
      list.append(
        el(
          'div',
          { className: 'row pick' },
          el('span', { text: world.role === 'editor' ? `${world.title} (team)` : world.title }),
          button(
            asset.kind === 'prefab' ? 'Open in the editor' : 'Add here',
            () => {
              chosen = world
              dialog.close()
            },
            'primary',
          ),
        ),
      )
    dialog.append(
      el('h2', {
        text: asset.kind === 'prefab' ? `Use “${asset.title}” in…` : `Add “${asset.title}” to…`,
      }),
      myWorlds.length
        ? list
        : el('p', { className: 'status', text: 'Make a world first (above), then come back.' }),
      el(
        'div',
        { className: 'row' },
        button('Cancel', () => dialog.close()),
      ),
    )
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(chosen)
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}

/** A build opens in the editor of the world you pick (it lands where you look); a script joins that world's scripts. */
async function useAsset(asset: Asset): Promise<void> {
  const world = await pickWorld(asset)
  if (!world) return
  if (asset.kind === 'prefab') {
    location.href = `/editor?world=${world.id}&asset=${asset.id}`
    return
  }
  assetsStatus.textContent = `Adding “${asset.title}” to ${world.title}…`
  try {
    const current = await api<{ scripts: WorldScript[]; limits: { mods: number } }>(
      `/api/worlds/${world.id}/scripts`,
    )
    if (current.scripts.length >= current.limits.mods) {
      assetsStatus.textContent = `${world.title} already has ${current.limits.mods} scripts, the most a world takes. Remove one in its Scripts first.`
      return
    }
    const used = await api<{ body: WorldScript }>(`/api/assets/${asset.id}/use`, { method: 'POST' })
    // Two scripts in a world never share a name: a second "welcome" becomes "welcome-2".
    const taken = new Set(current.scripts.map((s) => s.id))
    let id = used.body.id
    for (let n = 2; taken.has(id); n++) id = `${used.body.id.slice(0, 36)}-${n}`
    const script = { ...used.body, id, entry: `${id}.js` }
    await api(`/api/worlds/${world.id}/scripts`, {
      method: 'PUT',
      body: JSON.stringify({ scripts: [...current.scripts, script] }),
    })
    await loadAssets(true)
    assetsStatus.textContent = `Added “${asset.title}” to ${world.title} as the script “${id}”. Change it in that world's Scripts.`
  } catch (err) {
    assetsStatus.textContent = err instanceof Error ? err.message : 'That did not work.'
  }
}

/** A world's script shared in the asset store, credited to the world. */
async function shareScript(
  world: World,
  script: WorldScript,
  b: HTMLButtonElement,
  status: HTMLElement,
): Promise<void> {
  const title = prompt('Its title in the asset store (up to 60 characters)', script.id)
  if (title === null || !title.trim()) return
  b.disabled = true
  status.textContent = 'Sharing…'
  try {
    await api('/api/assets', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'script',
        title,
        body: { ...script, entry: `${script.id || 'main'}.js` },
        from_world: world.id,
      }),
    })
    status.textContent = `Shared “${title.trim()}” in the asset store.`
    void loadAssets(true)
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : 'That did not work.'
  } finally {
    b.disabled = false
  }
}

async function loadAssets(reset = false): Promise<void> {
  if (reset) assetPage = 1
  try {
    if (assetKind === 'mine') {
      const data = await api<{ assets: Asset[]; max: number }>('/api/assets/mine')
      assetsGrid.replaceChildren(...data.assets.map((a) => assetCard(a, true)))
      assetsMoreRow.hidden = true
      assetsStatus.textContent = data.assets.length
        ? ''
        : 'You have not shared anything yet. Select pieces in the editor and open Store, or share a script from a world.'
      return
    }
    const kind = assetKind === 'all' ? '' : `&kind=${assetKind}`
    const data = await api<{ assets: Asset[]; more: boolean }>(
      `/api/assets?page=${assetPage}${kind}`,
    )
    const cards = data.assets.map((a) => assetCard(a, false))
    if (assetPage === 1) assetsGrid.replaceChildren(...cards)
    else assetsGrid.append(...cards)
    assetsMoreRow.hidden = !data.more
    assetsStatus.textContent =
      assetPage === 1 && data.assets.length === 0
        ? 'Nothing shared here yet. Yours could be the first.'
        : ''
  } catch {
    assetsStatus.textContent = 'The asset store could not be loaded. Refresh to try again.'
  }
}

for (const b of kindButtons)
  b.addEventListener('click', () => {
    assetKind = b.dataset['kind'] ?? 'all'
    for (const other of kindButtons) other.setAttribute('aria-pressed', String(other === b))
    void loadAssets(true)
  })
assetsMore.addEventListener('click', () => {
  assetPage++
  void loadAssets()
})

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
  // An invite link: join the team and open the world, or sign in first and come back here to do it.
  const joinToken = new URLSearchParams(location.search).get('join')
  if (joinToken && /^[A-Za-z0-9_-]{20,64}$/.test(joinToken)) {
    if (!signedIn.hidden) {
      history.replaceState(null, '', '/worlds')
      void joinTeam(joinToken)
    } else {
      const signIn = signedOut.querySelector<HTMLAnchorElement>('a.button')
      if (signIn)
        signIn.href = `/auth/login?next=${encodeURIComponent(`/worlds?join=${joinToken}`)}`
      const note = signedOut.querySelector('.status')
      if (note) note.textContent = "Sign in with your OpenVibe account to join this world's team."
    }
  }
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
      if (note)
        note.textContent =
          'Sign in with your OpenVibe account to remix that world into one of your own.'
    }
  }
  return Promise.all([loadPublished(true), loadAssets(true)])
})
