import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASUAL_GAMES } from '@openvibe/casual'

/**
 * Crawl and machine-readability artifacts (plan T11; audit §4 items 1-2): GET /robots.txt,
 * GET /sitemap.xml, GET /llms.txt and GET /llms-full.txt, plus the home page's JSON-LD. Every one
 * is built with openvibe-shared/seo — the toolkit the other OpenVibe sites run — so they say the
 * same things here as everywhere.
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
interface LlmsFullPage {
  title: string
  url: string
  /** The page's own text; here the site's own description of it, never scraped HTML. */
  text?: string
}
interface LlmsFullSection {
  title: string
  pages: LlmsFullPage[]
}
interface LlmsFullOptions {
  /** The site name and base URL: the document opens `# <name>`, and page URLs resolve against it. */
  site: { name: string; url: string }
  summary: string
  sections?: LlmsFullSection[]
  /** Hard byte ceiling: a page that would cross it is dropped, never truncated mid-word. */
  maxBytes?: number
}
interface SeoToolkit {
  llmsTxt(o: LlmsOptions): string
  llmsFull(o: LlmsFullOptions): string
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
// The installable app: the shared OpenVibe icon set for Games (openvibe-shared/app-icons, pre-rendered PNGs).
const appIcons = createRequire(import.meta.url)('openvibe-shared/app-icons') as {
  path(name: string): string
  site(service: string): { name: string; description?: string } | null
}
const APP_ICON_RE = /^\/app-icons\/(games-(?:maskable-)?(?:192|512)\.png)$/
function manifestBody(): string {
  const icons = [192, 512].flatMap((size) =>
    [false, true].map((maskable) => ({
      src: `/app-icons/games-${maskable ? 'maskable-' : ''}${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: maskable ? 'maskable' : 'any',
    })),
  )
  return JSON.stringify({
    name: 'OpenVibe.Games',
    short_name: 'Games',
    description: appIcons.site('games')?.description ?? 'Browser games',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0a0f1c',
    theme_color: '#0d131d',
    icons,
  })
}

const SITE = 'https://openvibe.games'
const PLAY = 'https://play.openvibe.games'
const SITE_NAME = 'OpenVibe.Games'
const DESCRIPTION =
  'Browser games on the OpenVibe network — multiplayer, in your browser, no download: Scraplandia is a persistent physics survival-building sandbox you can play as a guest.'
const GAME_DESCRIPTION =
  'Scrappy multiplayer survival-building in and around Scrap City: physgun anything, weld it to anything else, chase supply drops in the wilds and haul your salvage home.'
// The one summary and one detail paragraph /llms.txt and /llms-full.txt both open with: a model
// reading the full document must meet the same description of the site as one reading the index.
const SITE_SUMMARY =
  'OpenVibe.Games: the games arm of the OpenVibe network — browser games you can start in a tab with no install, and the persistent multiplayer physics sandbox Scraplandia.'
const SITE_DETAILS =
  'Everything public can be played as a guest; a signed-in OpenVibe account only adds saved characters and one identity across the network. The portal and the game are plain HTML pages, and the world this game server runs is published as the canonical map document at /map.json. Sign-in, the per-user API, metrics and the editor are not crawler or model input and are listed nowhere here.'
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
  return publicPageDocs().map((p) => at(p.url, 'weekly', p.priority))
}

/**
 * The site's public pages, once, as the data both artifacts read: llms.txt lists them with a note,
 * llms-full.txt carries the same pages with their text. One source, so the two can never disagree
 * about what is public. There are no user-created public pages here — the world is a game document
 * served at /map.json, not a page — so this list is fixed.
 */
interface PublicPageDoc {
  title: string
  url: string
  note: string
  text: string
  priority: number
}
function publicPageDocs(): PublicPageDoc[] {
  return [
    {
      title: 'OpenVibe.Games home',
      url: `${SITE}/`,
      note: 'the portal: what there is to play, and what signing in adds',
      text: DESCRIPTION,
      priority: 1.0,
    },
    {
      title: 'Scraplandia',
      url: `${PLAY}/`,
      note: 'the live multiplayer game, playable as a guest in the browser',
      text: GAME_DESCRIPTION,
      priority: 0.9,
    },
    ...Object.values(CASUAL_GAMES).map((pack) => ({
      title: pack.name,
      url: `${SITE}/play/${pack.id}`,
      note: 'a casual game for the phone browser, playable as a guest with nothing to install',
      text: pack.tagline,
      priority: 0.8,
    })),
    {
      title: 'Creator worlds',
      url: `${SITE}/worlds`,
      note: 'worlds players built in the map editor and published, each playable in the browser',
      text: 'Creator worlds: players shape terrain and place buildings, lights, zones, resource nodes and props in the OpenVibe.Games map editor, then publish the world for anyone to join from the browser. A world is a sandbox: what players gather or build inside it stays in that world.',
      priority: 0.7,
    },
    {
      title: 'On Steam right now',
      url: `${SITE}/steam`,
      note: "Steam's top sellers, deals and new releases with Steam's prices, each linked to its store page",
      text: "Steam's featured lists as the store shows them: top sellers in the store's order, the deals Steam features and the new releases, with Steam's own US dollar prices and a link to every game's store page. Read from the Steam store's public storefront lists every few hours through OpenVibe.Sources.",
      priority: 0.6,
    },
    {
      title: 'What shipped',
      url: `${SITE}/updates`,
      note: 'every change deployed to OpenVibe.Games, newest first',
      text: "The update log of OpenVibe.Games: every change deployed to the site and its games, newest first, each a commit from the OpenVibers repositories linked to the change itself (the network's shared log; the whole network's is at https://openvibe.network/updates).",
      priority: 0.4,
    },
  ]
}

/** The /llms.txt body: what the site is, its public pages and its machine-readable endpoints. */
function llmsBody(): string {
  return seo.llmsTxt({
    name: SITE_NAME,
    summary: SITE_SUMMARY,
    details: SITE_DETAILS,
    sections: [
      {
        title: 'Public pages',
        links: publicPageDocs().map((p) => ({ title: p.title, url: p.url, note: p.note })),
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
            title: 'Full text (llms-full.txt)',
            url: `${SITE}/llms-full.txt`,
            note: 'this site’s public pages as one text document, for a model to read whole',
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
 * The /llms-full.txt body: the same site header and summary as /llms.txt, then every public page
 * llms.txt lists with its own text — the two descriptions the site's JSON-LD already publishes,
 * which are the site's own words for those pages rather than scraped markup. Public pages only, so
 * nothing under robots' Disallow can reach a model, and a 512 KB ceiling keeps the answer a
 * document rather than a payload.
 */
const LLMS_FULL_MAX_BYTES = 512 * 1024
function llmsFullBody(): string {
  return seo.llmsFull({
    site: { name: SITE_NAME, url: SITE },
    summary: SITE_SUMMARY,
    sections: [
      {
        title: 'Public pages',
        pages: publicPageDocs().map((p) => ({ title: p.title, url: p.url, text: p.text })),
      },
    ],
    maxBytes: LLMS_FULL_MAX_BYTES,
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
    seo.jsonLd.organization(),
    seo.jsonLd.softwareApp({
      name: 'Scraplandia',
      url: `${PLAY}/`,
      description: GAME_DESCRIPTION,
      category: 'GameApplication',
      keywords: 'browser game, multiplayer, physics sandbox, survival, building, openvibe',
    }),
    ...Object.values(CASUAL_GAMES).map((pack) =>
      seo.jsonLd.softwareApp({
        name: pack.name,
        url: `${SITE}/play/${pack.id}`,
        description: pack.tagline,
        category: 'GameApplication',
        keywords: 'browser game, idle game, hero collector, mobile, free to play, openvibe',
      }),
    ),
    seo.jsonLd.webPage({
      name: SITE_NAME,
      url: `${SITE}/`,
      description: DESCRIPTION,
      siteUrl: SITE,
    }),
  ]
}

/** Any JSON-LD nodes as `<script>` tags, through the shared kit's escaping (the home's live parts use it). */
export function jsonLdTagsOf(nodes: unknown[]): string {
  return nodes.map((node) => seo.jsonLdTag(node)).join('\n')
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
  const icon = APP_ICON_RE.exec(url)
  if (
    url !== '/robots.txt' &&
    url !== '/sitemap.xml' &&
    url !== '/llms.txt' &&
    url !== '/llms-full.txt' &&
    url !== '/manifest.webmanifest' &&
    !icon
  ) {
    return false
  }
  if (rq.method !== 'GET' && rq.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return true
  }
  if (url === '/manifest.webmanifest') {
    send(res, 'application/manifest+json', manifestBody())
    return true
  }
  if (icon) {
    // Only the names the regex allows reach the file system (openvibe-shared/app-icons resolves them).
    let png: Buffer
    try {
      png = readFileSync(appIcons.path(`icons/${icon[1]}`))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return true
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
    res.end(png)
    return true
  }
  if (url === '/robots.txt') {
    // The shared toolkit names search and AI crawlers by name, keeps every Disallow below and
    // always names the sitemap.
    send(
      res,
      'text/plain',
      seo.robotsTxt({ sitemaps: [`${SITE}/sitemap.xml`], disallow: DISALLOW }) + `# Agent manifest: ${SITE}/.well-known/agent.json\n`,
    )
    return true
  }
  if (url === '/sitemap.xml') {
    send(res, 'application/xml', seo.sitemapXml(publicPages()))
    return true
  }
  // Same type, same cache lifetime as /llms.txt: the full document is a bigger body of the same
  // site description, so it ages on the same clock.
  send(res, 'text/plain', url === '/llms-full.txt' ? llmsFullBody() : llmsBody())
  return true
}

/** A casual game's page JSON-LD (plan T22): the game as a GameApplication, as on the home page. */
export function casualJsonLdTag(packId: string): string {
  const pack = CASUAL_GAMES[packId]
  if (!pack) return ''
  return seo.jsonLdTag(
    seo.jsonLd.softwareApp({
      name: pack.name,
      url: `${SITE}/play/${pack.id}`,
      description: pack.tagline,
      category: 'GameApplication',
      keywords: 'browser game, idle game, hero collector, mobile, free to play, openvibe',
    }),
  )
}
