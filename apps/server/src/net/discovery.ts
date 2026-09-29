import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Crawl and machine-readability artifacts (plan T11; audit §4 items 1-2): GET /robots.txt,
 * GET /sitemap.xml and GET /llms.txt, plus the home page's JSON-LD. Every one is built with
 * openvibe-shared/seo — the toolkit the other OpenVibe sites run — so they say the same things
 * here as everywhere.
 *
 * Public pages only, and never the viewer: the portal and the game are listed; sign-in, the
 * per-user API, operational metrics and the noindex editor app are absent and Disallowed in
 * robots.txt. lastmod is a real date from the site's own data — the content-revision date
 * committed in the repository's STATUS.json, exactly as OpenVibe.Codes does — never "today" from
 * the clock, which would tell crawlers the whole site changed on every fetch.
 */

interface LlmsLink {
  title: string
  url: string
  note?: string
}
interface LlmsSection {
  title: string
  links: LlmsLink[]
}
interface LlmsOptions {
  name: string
  summary: string
  details?: string
  sections?: LlmsSection[]
}
interface SeoUrl {
  loc: string
  lastmod?: string
  changefreq?: string
  priority?: number
}
interface SeoToolkit {
  llmsTxt(o: LlmsOptions): string
  robotsTxt(o: { sitemaps?: string[]; disallow?: string[]; allow?: string[] }): string
  sitemapXml(urls: SeoUrl[]): string
  jsonLd: {
    website(o: { name: string; url: string; description: string }): unknown
    softwareApp(o: {
      name: string
      url: string
      description: string
      category?: string
      keywords?: string
    }): unknown
    webPage(o: {
      name: string
      url: string
      description: string
      type?: string
      siteUrl?: string
    }): unknown
  }
  jsonLdTag(node: unknown): string
}
const seo = createRequire(import.meta.url)('openvibe-shared/seo') as SeoToolkit

const SITE = 'https://openvibe.games'
const PLAY = 'https://play.openvibe.games'
const SITE_NAME = 'OpenVibe.Games'
const DESCRIPTION =
  'Browser games on the OpenVibe network — multiplayer, in your browser, no download: Scraplandia is a persistent physics survival-building sandbox you can play as a guest.'
const GAME_DESCRIPTION =
  'Scrappy multiplayer survival-building in and around Scrap City: physgun anything, weld it to anything else, chase supply drops in the wilds and haul your salvage home.'
// Every path robots.txt keeps out of crawlers. None is a public page, so none is in the sitemap
// or llms.txt either: sign-in, the per-user API, operational metrics and the noindex editor app.
const DISALLOW = ['/auth/', '/api/', '/metrics', '/editor']

/** "2026-09-29" or "2026-09-29T12:00:00Z" as YYYY-MM-DD; null when the value is unusable. */
function dayOf(ts: unknown): string | null {
  const m = String(ts ?? '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? (m[1] ?? null) : null
}

/** The committed STATUS.json's content date: the site's own revision date, never the clock. */
function siteUpdated(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'STATUS.json')
    if (existsSync(candidate)) {
      try {
        const status = JSON.parse(readFileSync(candidate, 'utf8')) as { updated?: unknown }
        return dayOf(status.updated)
      } catch {
        return null
      }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/** The site's fixed public pages, each with the same real content-revision lastmod. */
function publicPages(): SeoUrl[] {
  const lastmod = siteUpdated()
  const at = (loc: string, changefreq: string, priority: number): SeoUrl => ({
    loc,
    changefreq,
    priority,
    ...(lastmod ? { lastmod } : {}),
  })
  return [at(`${SITE}/`, 'weekly', 1.0), at(`${PLAY}/`, 'weekly', 0.9)]
}

/** The /llms.txt body: what the site is, its public pages and its machine-readable endpoints. */
function llmsBody(): string {
  return seo.llmsTxt({
    name: SITE_NAME,
    summary:
      'OpenVibe.Games: the games arm of the OpenVibe network — browser games you can start in a tab with no install, and the persistent multiplayer physics sandbox Scraplandia.',
    details:
      'Everything public can be played as a guest; a signed-in OpenVibe account only adds saved characters and one identity across the network. The portal and the game are plain HTML pages, and the world this game server runs is published as the canonical map document at /map.json. Sign-in, the per-user API, metrics and the editor are not crawler or model input and are listed nowhere here.',
    sections: [
      {
        title: 'Public pages',
        links: [
          {
            title: 'OpenVibe.Games home',
            url: `${SITE}/`,
            note: 'the portal: what there is to play, and what signing in adds',
          },
          {
            title: 'Scraplandia',
            url: `${PLAY}/`,
            note: 'the live multiplayer game, playable as a guest in the browser',
          },
        ],
      },
      {
        title: 'Machine-readable',
        links: [
          {
            title: 'Sitemap',
            url: `${SITE}/sitemap.xml`,
            note: 'the public pages above, each with a real lastmod',
          },
          {
            title: 'robots.txt',
            url: `${SITE}/robots.txt`,
            note: 'search and AI crawlers are welcome on the public pages',
          },
          {
            title: 'World map (JSON)',
            url: `${SITE}/map.json`,
            note: 'the canonical world document this game server runs',
          },
        ],
      },
    ],
  })
}

/**
 * The home page's JSON-LD: the site as a WebSite, the game as the site's primary type (the shared
 * kit's WebApplication, category GameApplication) and the portal page that carries them. The same
 * nodes for every crawler; nothing about the reader.
 */
export function homeJsonLd(): unknown[] {
  return [
    seo.jsonLd.website({ name: SITE_NAME, url: SITE, description: DESCRIPTION }),
    seo.jsonLd.softwareApp({
      name: 'Scraplandia',
      url: `${PLAY}/`,
      description: GAME_DESCRIPTION,
      category: 'GameApplication',
      keywords: 'browser game, multiplayer, physics sandbox, survival, building, openvibe',
    }),
    seo.jsonLd.webPage({
      name: SITE_NAME,
      url: `${SITE}/`,
      description: DESCRIPTION,
      siteUrl: SITE,
    }),
  ]
}

/** The home page's JSON-LD as `<script>` tags, ready to inject before `</head>`. */
export function homeJsonLdTags(): string {
  return homeJsonLd()
    .map((node) => seo.jsonLdTag(node))
    .join('\n')
}

function send(res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'public, max-age=3600',
  })
  res.end(body)
}

/**
 * Answers the crawl artifacts this server owns. Returns true when it handled the request, so the
 * router in httpServer drops through to nothing else. HEAD answers like GET without a body (node
 * suppresses it), so a crawler can read the headers first.
 */
export function discoveryHandler(rq: IncomingMessage, res: ServerResponse): boolean {
  const url = (rq.url ?? '/').split('?')[0] ?? '/'
  if (url !== '/robots.txt' && url !== '/sitemap.xml' && url !== '/llms.txt') return false
  if (rq.method !== 'GET' && rq.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return true
  }
  if (url === '/robots.txt') {
    // The shared toolkit names search and AI crawlers by name, keeps every Disallow below and
    // always names the sitemap.
    send(
      res,
      'text/plain',
      seo.robotsTxt({ sitemaps: [`${SITE}/sitemap.xml`], disallow: DISALLOW }),
    )
    return true
  }
  if (url === '/sitemap.xml') {
    send(res, 'application/xml', seo.sitemapXml(publicPages()))
    return true
  }
  send(res, 'text/plain', llmsBody())
  return true
}
