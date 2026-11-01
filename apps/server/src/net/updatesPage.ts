import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'

/**
 * GET /updates: what shipped on openvibe.games, the network's shared update log (openvibe-shared/frame updatesBody and
 * shipped.js) inside the OpenVibe Frame, as every OpenVibe site serves it. openvibe.help links each site's /updates.
 *
 * The page is rendered once per process by openvibe-shared/shell (this server is plain node:http, like legalPages.ts);
 * the log itself is filled in the browser from openvibe.network's changelog.
 */
interface Shell {
  page(o: Record<string, unknown>): string
}
interface Frame {
  updatesBody(o: { service: string; siteName: string }): string
}
interface Serve {
  url(p: string): string
}

const SITE_NAME = 'OpenVibe.Games'
const SITE_URL = 'https://openvibe.games'
const NETWORK_URL = 'https://openvibe.network'

export function updatesHandler(req: NodeRequire = createRequire(import.meta.url)) {
  const shell = req('openvibe-shared/shell') as Shell
  const frame = req('openvibe-shared/frame') as Frame
  const serve = req('openvibe-shared/serve') as Serve
  let html: string | null = null
  const render = (): string => {
    if (html) return html
    const links = [
      { label: 'Play', href: '/play' },
      { label: 'Leaderboard', href: '/leaderboard.html' },
    ]
    html = shell.page({
      name: SITE_NAME,
      service: 'games',
      lang: 'en',
      title: `What shipped on ${SITE_NAME}`,
      siteName: SITE_NAME,
      description: `Every change deployed to ${SITE_NAME}, newest first.`,
      canonical: `${SITE_URL}/updates`,
      robots: 'index, follow',
      // The site's icon, as on every other page (apps/client/*.html): without it the browser asks for /favicon.ico (404).
      // The page's type: shell.page sets no font, so without these rules /updates fell back to the browser's Times New
      // Roman (domain sweep, 2026-11-01). Zero specificity: any site rule wins.
      head: `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n<style>:where(body){font-family:var(--ov-font,'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif)}:where(main.page){display:block;max-width:880px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-right,0px)) 56px max(16px,env(safe-area-inset-left,0px))}:where(.ov-updates h1){font-size:clamp(1.6rem,5.4vw,2.2rem);line-height:1.15;margin:0 0 10px;text-wrap:balance}</style>`,
      navbar: {
        service: 'games',
        apiBase: NETWORK_URL,
        links,
        history: { type: 'page', title: SITE_NAME },
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
      body: `<div id="navbar-mount"></div>\n<main id="main" class="page">\n${frame.updatesBody({ service: 'games', siteName: SITE_NAME })}\n</main>\n<script src="${serve.url('shipped.js')}" defer></script>`,
    })
    return html
  }
  return (rq: IncomingMessage, res: ServerResponse): boolean => {
    const url = (rq.url ?? '/').split('?')[0] ?? '/'
    if (url !== '/updates') return false
    if (rq.method !== 'GET' && rq.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return true
    }
    const body = render()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(rq.method === 'HEAD' ? undefined : body)
    return true
  }
}
