import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { escapeHtml } from '../net/notFound.js'
import type { SteamCatalog, SteamGame } from './steamCatalog.js'

/**
 * GET /steam: Steam's featured lists (top sellers, deals, new releases) as the store showed them at the last read, each
 * game linked to its store page; GET /api/steam: the same as JSON, for anyone's code. Prices are Steam's (US dollars),
 * never converted; nothing is sold here and no endorsement by Valve is implied.
 */
interface Shell {
  page(o: Record<string, unknown>): string
}

const SITE_NAME = 'OpenVibe.Games'
const NETWORK_URL = 'https://openvibe.network'

const STYLE = `<style>
.steam{max-width:1180px;margin:0 auto;padding:28px 16px 64px}
.steam .eyebrow{margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.14em;color:var(--secondary,#22d3ee)}
.steam h1{margin:0 0 8px;font-size:clamp(28px,5vw,40px);font-weight:900}
.steam .lede{margin:0 0 6px;max-width:68ch;color:var(--text-dim,#96a7c2)}
.steam .checked{margin:0 0 26px;font-size:14px;color:var(--text-faint,#7386a3)}
.steam section{margin:0 0 34px}
.steam h2{display:flex;align-items:baseline;gap:10px;margin:0 0 14px;font-size:22px;font-weight:850}
.steam h2 small{font-size:13px;font-weight:600;color:var(--text-faint,#7386a3)}
.steam .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:14px;margin:0;padding:0;list-style:none}
.steam .game{position:relative;display:flex;flex-direction:column;border:1px solid var(--border,#1f2d47);border-radius:14px;
  overflow:hidden;background:var(--bg-card,#0f1729);transition:border-color .15s,transform .15s}
.steam .game:hover{border-color:var(--accent,#3b82f6);transform:translateY(-2px)}
.steam .game a{color:inherit;text-decoration:none}
.steam .game a::after{content:'';position:absolute;inset:0}
.steam .art{aspect-ratio:460/215;background:var(--bg-tertiary,#16213a);display:block;width:100%;object-fit:cover}
.steam .rank{position:absolute;top:8px;left:8px;min-width:30px;height:30px;padding:0 8px;border-radius:9px;display:grid;
  place-items:center;background:rgba(5,10,20,.82);font-weight:900;font-size:14px}
.steam .body{display:flex;flex-direction:column;gap:6px;padding:12px 13px 13px;flex:1}
.steam .name{margin:0;font-size:16px;font-weight:800;line-height:1.25;overflow-wrap:anywhere}
.steam .price{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:auto;font-weight:800}
.steam .off{padding:2px 7px;border-radius:7px;background:#16a34a;color:#fff;font-size:13px}
.steam .was{color:var(--text-faint,#7386a3);font-weight:600;text-decoration:line-through}
.steam .meta{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--text-faint,#7386a3)}
.steam .meta span{padding:1px 7px;border:1px solid var(--border,#1f2d47);border-radius:999px}
.steam .empty{padding:18px;border:1px dashed var(--border,#1f2d47);border-radius:14px;color:var(--text-dim,#96a7c2)}
.steam .about{margin-top:10px;font-size:14px;color:var(--text-faint,#7386a3);max-width:80ch}
.steam .about a{color:var(--accent-light,#93c5fd)}
</style>`

function money(cents: number | null, currency: string | null): string {
  if (cents == null) return ''
  if (cents === 0) return 'Free'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim()
  }
}

function ago(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const h = Math.round(min / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}

function endsIn(ms: number | null, now: number): string {
  if (!ms || ms <= now) return ''
  const days = Math.floor((ms - now) / 86400000)
  if (days >= 1) return `Ends in ${days} day${days === 1 ? '' : 's'}`
  const h = Math.max(1, Math.round((ms - now) / 3600000))
  return `Ends in ${h} hour${h === 1 ? '' : 's'}`
}

function card(g: SteamGame, now: number, ranked: boolean): string {
  const store = `https://store.steampowered.com/app/${g.appid}/`
  const price =
    g.discount_percent > 0 && g.original_price != null
      ? `<span class="off">−${g.discount_percent}%</span><span>${escapeHtml(money(g.final_price, g.currency))}</span><span class="was">${escapeHtml(money(g.original_price, g.currency))}</span>`
      : `<span>${escapeHtml(money(g.final_price, g.currency)) || 'See the store'}</span>`
  const platforms = [g.windows && 'Windows', g.mac && 'macOS', g.linux && 'Linux'].filter(Boolean) as string[]
  const ends = endsIn(g.discount_ends_at, now)
  return `<li class="game">
  ${g.header_image ? `<img class="art" src="${escapeHtml(g.header_image)}" alt="" loading="lazy" decoding="async" width="460" height="215" referrerpolicy="no-referrer">` : '<span class="art" aria-hidden="true"></span>'}
  ${ranked ? `<span class="rank" aria-label="Number ${g.position + 1}">${g.position + 1}</span>` : ''}
  <div class="body">
    <h3 class="name"><a href="${store}" rel="noopener" target="_blank">${escapeHtml(g.name)}</a></h3>
    <p class="price">${price}</p>
    <p class="meta">${platforms.map((p) => `<span>${p}</span>`).join('')}${ends ? `<span>${escapeHtml(ends)}</span>` : ''}</p>
  </div>
</li>`
}

function section(id: string, title: string, note: string, games: SteamGame[], now: number, ranked = false): string {
  return `<section aria-labelledby="${id}"><h2 id="${id}">${title} <small>${note}</small></h2>
${games.length ? `<ol class="grid">${games.map((g) => card(g, now, ranked)).join('')}</ol>` : '<p class="empty">Steam\'s list could not be read just now.</p>'}
</section>`
}

export function steamPageHtml(
  data: Awaited<ReturnType<SteamCatalog['lists']>>,
  siteUrl: string,
  shell: Shell,
  now = Date.now(),
): string {
  const links = [
    { label: 'Steam', href: '/steam' },
    { label: 'Creator worlds', href: '/worlds' },
    { label: 'Play Scraplandia', href: '/play' },
  ]
  const checked = data.observed_at ? `From the Steam store, checked ${ago(data.observed_at, now)}.` : ''
  return shell.page({
    name: SITE_NAME,
    service: 'games',
    lang: 'en',
    title: `Steam top sellers, deals and new releases · ${SITE_NAME}`,
    siteName: SITE_NAME,
    description: "What sells on Steam right now, what's on sale and what just came out, with Steam's prices and a link to every store page.",
    canonical: `${siteUrl}/steam`,
    robots: 'index, follow',
    head: `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n${STYLE}`,
    navbar: { service: 'games', apiBase: NETWORK_URL, links, history: { type: 'page', title: 'Steam' } },
    footer: { service: 'games', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' },
    home: '/',
    navLinks: links,
    body: `<div id="navbar-mount"></div>
<main id="main" class="steam">
  <p class="eyebrow">STEAM</p>
  <h1>On Steam right now</h1>
  <p class="lede">Top sellers, deals and new releases as the Steam store lists them, with Steam's prices in US dollars. Every game opens its store page.</p>
  ${checked ? `<p class="checked">${escapeHtml(checked)}</p>` : ''}
  ${section('steam-top', 'Top sellers', "the store's order", data.top, now, true)}
  ${section('steam-sale', 'Deals', 'discounts Steam features', data.sale, now)}
  ${section('steam-new', 'New releases', 'just out', data.new, now)}
  <p class="about">Read from the Steam store's public storefront lists every few hours through OpenVibe.Sources
  and shown as they were at that time; prices change on Steam first. Game names and images belong to Valve and the games'
  publishers. OpenVibe sells nothing here and is not affiliated with Valve. The same lists as JSON: <a href="/api/steam">/api/steam</a>.</p>
</main>`,
  })
}

export function createSteamRoutes(opts: { catalog: SteamCatalog; siteUrl: string; require?: NodeRequire }) {
  const shell = (opts.require ?? createRequire(import.meta.url))('openvibe-shared/shell') as Shell
  const siteUrl = opts.siteUrl.replace(/\/+$/, '')
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path !== '/steam' && path !== '/api/steam') return false
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    void (async () => {
      const data = await opts.catalog.lists()
      const json = path === '/api/steam'
      const body = json
        ? JSON.stringify({ source: 'store.steampowered.com (featured lists)', checked_at: data.observed_at ? new Date(data.observed_at).toISOString() : null, top_sellers: data.top, deals: data.sale, new_releases: data.new })
        : steamPageHtml(data, siteUrl, shell)
      res.writeHead(200, {
        'content-type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        ...(json ? { 'access-control-allow-origin': '*' } : {}),
        'content-length': String(Buffer.byteLength(body)),
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    })().catch(() => {
      if (res.headersSent) return
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('steam lists unavailable')
    })
    return true
  }
}
