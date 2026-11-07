import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { CREATOR_WORLD_ID } from '@openvibe/content'
import type { CreatorWorld, CreatorWorldStore } from '@openvibe/persistence'
import { escapeHtml, sendNotFound, type NotFoundLink } from '../net/notFound.js'
import type { WorldSharing } from './sharing.js'

/**
 * GET /worlds/<id>: a creator world's own page inside the OpenVibe Frame (openvibe-shared/shell), the page
 * OpenVibe.Search links to and the link a creator shares: its title, who made it, their summary, how many have
 * visited, and the button that opens it in /play. A published world is everyone's; a draft is its owner's, its
 * team's and the people the owner shared it with (share.v1 `people`), who may read the page and join to test it.
 * Anyone else gets the real 404 the page has always given a draft.
 */
interface Shell {
  page(o: Record<string, unknown>): string
}

interface Kit {
  share(o: Record<string, unknown>): string
}

const kit = (opts: { require?: NodeRequire } = {}) =>
  (opts.require ?? createRequire(import.meta.url))('openvibe-shared/kit') as Kit

const SITE_NAME = 'OpenVibe.Games'
const NETWORK_URL = 'https://openvibe.network'
const LINKS: NotFoundLink[] = [
  { href: '/worlds', label: 'Creator worlds' },
  { href: '/', label: 'OpenVibe.Games home' },
]

const STYLE = `<style>
.world{max-width:760px;margin:0 auto;padding:28px 16px 64px;font-family:var(--ov-font,'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif)}
.world .eyebrow{margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.14em;color:var(--secondary,#22d3ee)}
.world h1{margin:0 0 6px;font-size:clamp(28px,5vw,40px);font-weight:900;overflow-wrap:anywhere}
.world .by,.world .stats{margin:0 0 10px;color:var(--text-dim,#96a7c2)}
.world .summary{margin:14px 0;font-size:18px;overflow-wrap:anywhere}
.world .row{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.world .play{display:inline-flex;align-items:center;min-height:44px;padding:10px 26px;border-radius:12px;background:var(--accent-strong,#2563eb);color:var(--on-accent-strong,#fff);font-weight:800;text-decoration:none}
.world .more{display:inline-flex;align-items:center;min-height:44px;padding:10px 18px;border-radius:12px;border:1px solid var(--border,#1f2d47);color:inherit;text-decoration:none}
.world .note{margin-top:22px;font-size:14px;color:var(--text-faint,#7386a3)}
</style>`

export function worldPageHtml(world: CreatorWorld, siteUrl: string, shell: Shell, kitLib: Kit = kit(), { draft = false }: { draft?: boolean } = {}): string {
  const url = `${siteUrl}/worlds/${world.id}`
  const description =
    world.summary ||
    `A creator world by ${world.ownerName} on OpenVibe.Games. Join it from your browser.`
  const visits = `${world.plays.toLocaleString('en-US')} ${world.plays === 1 ? 'visit' : 'visits'}${
    world.remixes
      ? ` · ${world.remixes.toLocaleString('en-US')} ${world.remixes === 1 ? 'remix' : 'remixes'}`
      : ''
  }`
  const links = [
    { label: 'Creator worlds', href: '/worlds' },
    { label: 'Play Scraplandia', href: '/play' },
  ]
  return shell.page({
    name: SITE_NAME,
    service: 'games',
    lang: 'en',
    title: `${world.title} · Creator world · ${SITE_NAME}`,
    siteName: SITE_NAME,
    description: description.slice(0, 300),
    canonical: url,
    // A draft is not in Search, the sitemap or the public list; only the people on its list may read it.
    robots: draft ? 'noindex, nofollow' : 'index, follow',
    head: `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n<link rel="stylesheet" href="/shared/kit.css">\n${STYLE}`,
    navbar: {
      service: 'games',
      apiBase: NETWORK_URL,
      links,
      history: { type: 'page', title: world.title },
    },
    footer: {
      service: 'games',
      variant: 'full',
      mount: '#ov-footer',
      brandName: SITE_NAME,
      updates: '/updates',
    },
    home: '/',
    navLinks: links,
    body: `<div id="navbar-mount"></div>
<main id="main" class="world">
  <p class="eyebrow">CREATOR WORLD</p>
  <h1>${escapeHtml(world.title)}</h1>
  <p class="by">by ${escapeHtml(world.ownerName)}</p>
  ${world.remixedFrom ? `<p class="by">Remix of <a href="/worlds/${escapeHtml(world.remixedFrom.id)}">${escapeHtml(world.remixedFrom.title)}</a> by ${escapeHtml(world.remixedFrom.owner)}</p>` : ''}
  ${world.summary ? `<p class="summary">${escapeHtml(world.summary)}</p>` : ''}
  <p class="stats">${escapeHtml(visits)}</p>
  <div class="row">
    <a class="play" href="/play?world=${world.id}">▶ Join this world</a>
    ${kitLib.share({ title: world.title, url, text: description, kind: 'world', id: world.id })}
    <a class="more" href="/worlds?remix=${world.id}">Remix it</a>
    <a class="more" href="/worlds">More worlds</a>
  </div>
  <p class="note">Plays in your browser with no download, as a guest or with your OpenVibe account. A world is a
  sandbox: what you gather or build inside it stays in it. Remix it to start a world of your own from this one; the
  remix credits it.</p>
</main>`,
  })
}

export function createWorldPage(opts: {
  store: CreatorWorldStore
  siteUrl: string
  /** The share.v1 row: a draft's Specific-people list, and the one check (worlds/sharing.ts). */
  sharing?: WorldSharing
  /** The Network's auth base, to read the signed-in person from the ovg_sso cookie. */
  networkAuthUrl?: string | null
  require?: NodeRequire
}) {
  const shell = (opts.require ?? createRequire(import.meta.url))('openvibe-shared/shell') as Shell
  const siteUrl = opts.siteUrl.replace(/\/+$/, '')
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const match = /^\/worlds\/([^/]+)$/.exec(path)
    if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    const id = match[1] ?? ''
    void (async () => {
      const world = CREATOR_WORLD_ID.test(id) ? await opts.store.get(id) : null
      const viewer = world && world.status !== 'published' && opts.sharing
        ? await opts.sharing.viewerFromRequest(req, opts.networkAuthUrl ?? null).catch(() => null)
        : null
      const draftView = !!world && world.status === 'draft' && !!viewer && !!opts.sharing &&
        await opts.sharing.canView({ subjectId: viewer.subject.id, name: '', rank: null, id: '' }, world.id).catch(() => false)
      if (!world || (world.status !== 'published' && !draftView)) {
        sendNotFound(req, res, path, LINKS)
        return
      }
      const body = worldPageHtml(world, siteUrl, shell, kit(), { draft: world.status !== 'published' })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': world.status === 'published' ? 'public, max-age=60' : 'no-store',
        'content-length': String(Buffer.byteLength(body)),
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    })().catch(() => {
      if (res.headersSent) return
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end('world unavailable')
    })
    return true
  }
}
