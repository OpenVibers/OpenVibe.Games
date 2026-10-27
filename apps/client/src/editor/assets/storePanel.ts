/**
 * The dock's Store tab: the asset store (migration 0016) inside the editor. It lists the builds creators share and
 * places one where the camera looks, and shares the selected pieces as a new build. Talks to /api/assets with the
 * signed-in Network token; placing and sharing go through the callbacks, so the document changes stay in editorApp
 * (one undo step each).
 */
import type { PrefabBody } from '@openvibe/content'

export interface StoreBuild {
  id: string
  title: string
  owner: string
  uses: number
  contents: { pieces?: number }
}

export interface StorePanelOptions {
  /** The creator world being edited (a shared build credits it), or null on the place's own map. */
  worldId: string | null
  token: () => string
  /** Puts a build in the document where the camera looks (one undo step). */
  place: (body: PrefabBody, title: string) => void
  /** The selected pieces as a build, or why there is none to share. */
  selectionBuild: () => { body: PrefabBody; pieces: number } | { error: string }
  setMessage: (m: string) => void
  fetch?: typeof fetch
}

export class StorePanel {
  private builds: StoreBuild[] = []
  private page = 1
  private more = false
  private loaded = false
  private status = ''

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: StorePanelOptions,
  ) {
    this.render()
  }

  /** Loads the first page the first time the tab is shown. */
  show(): void {
    if (!this.loaded) void this.load(true)
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.opts.token()
    const resp = await (this.opts.fetch ?? fetch)(path, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    const body = (await resp.json().catch(() => ({}))) as {
      error?: string
      detail?: string
      issues?: string[]
    }
    if (!resp.ok)
      throw new Error(body.detail ?? body.issues?.[0] ?? body.error ?? `HTTP ${resp.status}`)
    return body as T
  }

  async load(reset = false): Promise<void> {
    if (reset) this.page = 1
    try {
      const data = await this.api<{ assets: StoreBuild[]; more: boolean }>(
        `/api/assets?kind=prefab&page=${this.page}`,
      )
      this.builds = this.page === 1 ? data.assets : [...this.builds, ...data.assets]
      this.more = data.more
      this.loaded = true
      this.status = this.builds.length ? '' : 'No builds shared yet. Share yours below.'
    } catch {
      this.status = 'The store could not be loaded. Open this tab again to retry.'
      this.loaded = false
    }
    this.render()
  }

  /** A build from the store, its use counted when signed in, placed where the camera looks. */
  async use(id: string): Promise<void> {
    try {
      const signedIn = !!this.opts.token()
      const asset = await this.api<{ title: string; body: PrefabBody }>(
        signedIn ? `/api/assets/${id}/use` : `/api/assets/${id}`,
        signedIn ? { method: 'POST' } : {},
      )
      this.opts.place(asset.body, asset.title)
    } catch (err) {
      this.opts.setMessage(
        `⛔ ${err instanceof Error ? err.message : 'that build could not be placed'}`,
      )
    }
  }

  private async share(title: string, summary: string, button: HTMLButtonElement): Promise<void> {
    const picked = this.opts.selectionBuild()
    if ('error' in picked) {
      this.status = picked.error
      this.render()
      return
    }
    button.disabled = true
    try {
      await this.api('/api/assets', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'prefab',
          title,
          summary,
          body: picked.body,
          ...(this.opts.worldId ? { from_world: this.opts.worldId } : {}),
        }),
      })
      await this.load(true)
      this.status = `Shared “${title.trim()}” (${picked.pieces} pieces). Anyone can use it from the store now.`
      this.render()
    } catch (err) {
      this.status = err instanceof Error ? err.message : 'That did not work.'
      this.render()
    } finally {
      button.disabled = false
    }
  }

  private render(): void {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => {
      const node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined) node.textContent = text
      return node
    }
    const list = el('div', 'store-list')
    for (const build of this.builds) {
      const row = el('div', 'store-row')
      const what = el('span', 'store-what')
      what.append(
        el('b', '', build.title),
        el(
          'small',
          '',
          ` by ${build.owner} · ${build.contents.pieces ?? 0} pieces${build.uses ? ` · used by ${build.uses}` : ''}`,
        ),
      )
      const place = el('button', 'mini', 'Place')
      place.type = 'button'
      place.title = 'Put it where the camera looks'
      place.addEventListener('click', () => void this.use(build.id))
      row.append(what, place)
      list.append(row)
    }
    const moreButton = el('button', 'mini', 'More builds')
    moreButton.type = 'button'
    moreButton.hidden = !this.more
    moreButton.addEventListener('click', () => {
      this.page++
      void this.load()
    })

    const shareBox = el('div', 'store-share')
    const title = el('input')
    title.maxLength = 60
    title.placeholder = 'Title of your build'
    title.setAttribute('aria-label', 'Build title')
    const summary = el('input')
    summary.maxLength = 280
    summary.placeholder = 'What is it? (optional)'
    summary.setAttribute('aria-label', 'Build summary')
    const shareButton = el('button', 'mini', 'Share the selection')
    shareButton.type = 'button'
    shareButton.disabled = !this.opts.token()
    shareButton.addEventListener('click', () => {
      if (!title.value.trim()) {
        this.status = 'Give your build a title first.'
        this.render()
        return
      }
      void this.share(title.value, summary.value, shareButton)
    })
    shareBox.append(
      el(
        'p',
        'store-hint',
        this.opts.token()
          ? 'Select boxes, nodes, props and lights in the viewport, then share them as a build anyone can place.'
          : 'Sign in to share a build.',
      ),
      title,
      summary,
      shareButton,
    )
    const status = el('p', 'store-status', this.status)
    status.setAttribute('role', 'status')
    this.root.replaceChildren(
      el('p', 'store-hint', 'Builds other creators share, free. Place one where the camera looks.'),
      list,
      moreButton,
      shareBox,
      status,
    )
  }
}
