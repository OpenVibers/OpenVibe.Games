import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { casualGameOf, casualPageHtml } from '../casual/page.js'

/**
 * The agent layer (openvibe-shared/agent-layer) for the game server. The server is raw node:http, not
 * Express, so this uses the same builders the Express mount uses — agentManifest, markdownTwin and
 * linkHeaderTags — instead of app.use. /.well-known/agent.json and the Markdown twins of the portal, the
 * game and the world pages are answered here; the HTML pages themselves get the same discovery <link>
 * tags and Link header as they are served (addAgentHead, agentLinkFor).
 */
const require = createRequire(import.meta.url)
const agent = require('openvibe-shared/agent-layer') as {
  agentManifest: (descriptor: Record<string, unknown>) => unknown
  markdownTwin: (o: {
    html: string
    title?: string
    canonical: string
    updated?: string | null
  }) => string
  linkHeaderTags: (canonical: string, llms?: string) => { head: string; header: string }
}

const SITE = 'https://openvibe.games'
const PLAY_SITE = 'https://play.openvibe.games'
const LLMS = `${SITE}/llms.txt`

/** What openvibe.games tells an agent about itself. Every field is something this site really serves. */
export const AGENT_DESCRIPTOR: Record<string, unknown> = {
  id: 'games',
  name: 'OpenVibe.Games',
  purpose:
    'Browser games on the OpenVibe network: the games portal, Scraplandia (a persistent multiplayer survival-building world), Salvage Rush, Vibe Heroes and the worlds players create.',
  home: SITE,
  site: 'openvibe.games',
  api: '/api',
  policy: {
    auth: ['none', 'Network OIDC'],
    rateLimit:
      'The public pages are not rate-limited; the editor, map-asset and websocket-ticket routes are limited per address and per signed-in actor',
  },
}

/** The public pages that have a Markdown twin: the portal, the game and the world pages. */
const STATIC_PAGES: Record<string, { file: string; canonical: string }> = {
  '/': { file: 'index.html', canonical: `${SITE}/` },
  '/play': { file: 'play.html', canonical: `${PLAY_SITE}/` },
  '/worlds': { file: 'worlds.html', canonical: `${SITE}/worlds` },
}

/** The client build's own files that are pages with a twin (the portal is served through portalPage). */
export const AGENT_PAGE_FILES = new Set(['index.html', 'play.html', 'worlds.html', 'casual.html'])

/** What the twin renderer needs from the server: the built client, the portal's live parts and the host. */
export interface AgentContext {
  root: string | null
  /** The request's host (the play host serves the game at its root). */
  host: string
  /** The portal page as the HTML route renders it (with its live stats and sections), for the twin. */
  portalHtml?: () => Promise<string | null>
}

/** The Link header a page with a twin sends. */
export function agentLinkFor(canonical: string): string {
  return agent.linkHeaderTags(canonical, LLMS).header
}

/** Add the discovery <link> tags to a page's head (the page already links its own canonical). */
export function addAgentHead(html: string, canonical: string): string {
  if (/rel="alternate" type="text\/markdown"/.test(html)) return html
  const tags = agent.linkHeaderTags(canonical, LLMS).head
  return html.includes('</head>') ? html.replace('</head>', `${tags}\n</head>`) : html
}

/** The canonical a page names for itself, when it names one. */
export function canonicalOf(html: string): string | null {
  const m = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(html)
  return m ? m[1]! : null
}

// The built client is read once per file version: the game's event loop never reads a file per request.
const memo = new Map<string, { path: string; mtimeMs: number; html: string }>()
export function readPageFile(filePath: string): string | null {
  try {
    const mtimeMs = statSync(filePath).mtimeMs
    const hit = memo.get(filePath)
    if (hit && hit.path === filePath && hit.mtimeMs === mtimeMs) return hit.html
    const html = readFileSync(filePath, 'utf8')
    memo.set(filePath, { path: filePath, mtimeMs, html })
    return html
  } catch {
    return null
  }
}

/** The page a path names, as the HTML route renders it: { html, canonical } or null when it is not public. */
export async function agentPageFor(
  path: string,
  ctx: AgentContext,
): Promise<{ html: string; canonical: string } | null> {
  const { root } = ctx
  if (!root) return null
  const clean = String(path || '/').replace(/\/+$/, '') || '/'
  // On the play host the game is the root page (the apex root is the games portal).
  if (clean === '/' && ctx.host.toLowerCase().startsWith('play.')) {
    const html = readPageFile(join(root, 'play.html'))
    return html ? { html, canonical: `${PLAY_SITE}/` } : null
  }
  // A casual game is its own page (the build's casual.html with that game's own head and copy).
  const casual = casualGameOf(clean)
  if (casual) {
    const file = join(root, 'casual.html')
    if (!existsSync(file)) return null
    return { html: casualPageHtml(file, casual), canonical: `${SITE}/play/${casual}` }
  }
  if (clean === '/') {
    const portal = ctx.portalHtml ? await ctx.portalHtml() : null
    if (!portal) return null
    return { html: portal, canonical: `${SITE}/` }
  }
  const spec = STATIC_PAGES[clean]
  if (!spec) return null
  const html = readPageFile(join(root, spec.file))
  return html ? { html, canonical: spec.canonical } : null
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  canonical?: string,
  method?: string,
): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': status === 200 ? 'public, max-age=300' : 'public, max-age=60',
    ...(canonical ? { link: agentLinkFor(canonical) } : {}),
    vary: 'Accept',
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/** True when this request is the agent manifest or a Markdown twin: the agent layer answers it. */
export function isAgentRequest(req: IncomingMessage): boolean {
  const method = String(req.method ?? 'GET')
  if (!['GET', 'HEAD'].includes(method)) return false
  const url = new URL(req.url ?? '/', SITE)
  if (url.pathname === '/.well-known/agent.json') return true
  return (
    url.pathname.endsWith('.md') ||
    url.searchParams.get('format') === 'markdown' ||
    /\btext\/markdown\b/.test(String(req.headers.accept ?? ''))
  )
}

/** True when this request was the agent manifest or a Markdown twin (and has been answered). */
export async function handleAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AgentContext,
): Promise<boolean> {
  const method = String(req.method ?? 'GET')
  if (!['GET', 'HEAD'].includes(method)) return false
  const url = new URL(req.url ?? '/', SITE)
  if (url.pathname === '/.well-known/agent.json') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    })
    res.end(method === 'HEAD' ? undefined : JSON.stringify(agent.agentManifest(AGENT_DESCRIPTOR)))
    return true
  }
  const accept = String(req.headers.accept ?? '')
  const wantsMarkdown =
    url.pathname.endsWith('.md') ||
    url.searchParams.get('format') === 'markdown' ||
    /\btext\/markdown\b/.test(accept)
  if (!wantsMarkdown) return false
  let path = url.pathname === '/index.md' ? '/' : url.pathname.endsWith('.md') ? url.pathname.slice(0, -3) : url.pathname
  path = path.replace(/\/+$/, '') || '/'
  const page = await agentPageFor(path, ctx)
  if (!page) {
    send(res, 404, 'text/markdown; charset=utf-8', '# Not found\n', undefined, method)
    return true
  }
  const body = agent.markdownTwin({ html: page.html, canonical: page.canonical })
  send(res, 200, 'text/markdown; charset=utf-8', body, page.canonical, method)
  return true
}
