import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Logger } from '@openvibe/shared'
import type { ServerMetrics } from '../observability/metrics.js'
import { isDirectLoopback, prometheusText, wantsPrometheus } from '../observability/release.js'
import { canEditMap, fetchNetworkAccount, resolveNetworkUser } from './networkAuth.js'
import { createSsoClient, failurePage } from 'openvibe-sdk/sso'
import {
  LOGIN_STATE_COOKIE,
  MAX_FEDCM_BODY_BYTES,
  RETRY_COOKIE,
  SESSION_COOKIE,
  SessionCheckCache,
  clearLoginStateCookie,
  clearRetryCookie,
  clearSessionCookie,
  decodeLoginState,
  isSilentDenial,
  loginStateCookie,
  parseCookies,
  parseFedcmBody,
  retryCookie,
  safeNext,
  sameString,
  sessionCookie,
  sessionHandoffHtml,
  ssoHintCookie,
  withSsoNone,
} from './sso.js'
import { MAX_MAP_BYTES, loadMap, saveMap } from './mapStore.js'
import { MAX_ASSET_BYTES, isContentAddressed, storeAsset } from './mapAssetStore.js'
import type { GamesActorLimits } from './actorLimits.js'
import { resolveClientAddress } from './clientAddress.js'
import { sendNotFound, type NotFoundLink } from './notFound.js'
import { versionSharedRefs } from './sharedAssets.js'
import { discoveryHandler, homeJsonLdTags, jsonLdTagsOf } from './discovery.js'
import {
  addAgentHead,
  agentLinkFor,
  canonicalOf,
  handleAgent,
  isAgentRequest,
  readPageFile,
  AGENT_PAGE_FILES,
  type AgentContext,
} from './agent.js'
import { applyCardFacts, type HomeParts } from './portalHome.js'
import { legalHandler } from './legalPages.js'
import { updatesHandler } from './updatesPage.js'
import { indexnowHandler, type SharedIndexNow } from './indexnow.js'
import { observeRequest } from './telemetryRoute.js'

/** The portal page with its JSON-LD, built once per file version: the game server's event loop never reads the file
 *  per request (a new build changes the mtime and rebuilds it once). */
let portalMemo: { path: string; mtimeMs: number; html: string } | null = null
export function portalHtml(filePath: string): string {
  const mtimeMs = statSync(filePath).mtimeMs
  if (portalMemo && portalMemo.path === filePath && portalMemo.mtimeMs === mtimeMs)
    return portalMemo.html
  const raw = readFileSync(filePath, 'utf8')
  const html = versionSharedRefs(
    raw.includes('</head>') ? raw.replace('</head>', `${homeJsonLdTags()}\n  </head>`) : raw,
  )
  portalMemo = { path: filePath, mtimeMs, html }
  return html
}

/** The portal with its live parts (portalHome.ts) in place of the build's markers, and their JSON-LD in the head. */
export function portalPage(filePath: string, parts: HomeParts | null): string {
  // The card facts come from the content packs, so they are in the page even when the live sections
  // are not (a slow source must not leave a card without its round length).
  const html = applyCardFacts(portalHtml(filePath))
  if (!parts) return html
  return html
    .replace('<!--ov:home-stats-->', () => parts.stats)
    .replace('<!--ov:home-sections-->', () => parts.sections)
    .replace('</head>', () => `${jsonLdTagsOf(parts.jsonLd)}\n  </head>`)
}
import { handleWsTicketRequest, type WsTicketStore } from './wsTicket.js'
import { casualGameOf, casualPageHtml } from '../casual/page.js'
import { surfMap, type MapFileV2 } from '@openvibe/content'

/**
 * The human surf pages: `/surf/<map>` is canonical, `/surf/embed` is the iframe
 * route, and the old forms are permanent redirects. A redirect is returned for
 * the caller to send before any static file is looked up; `page` means the
 * client bundle's play.html answers it.
 */
const SURF_MAP_PATH = /^\/surf\/([^/]+)\/?$/

function surfPageRoute(
  path: string,
  query: URLSearchParams,
): { redirect?: string; page?: boolean } | null {
  const match = SURF_MAP_PATH.exec(path)
  if (!match) {
    // ?game=<surf map> on the game page (or the apex root) is the old entry
    // point. Every surf game value lands on its canonical /surf/<id> page.
    if (path !== '/play' && path !== '/' && path !== '/play/') return null
    const game = query.get('game')
    if (!game) return null
    const info = surfMap(game)
    if (!info) return null
    const requestedMap = query.get('map')
    const target = (requestedMap ? surfMap(requestedMap) : null) ?? info
    const rest = new URLSearchParams(query)
    rest.delete('game')
    rest.delete('map')
    return { redirect: `/surf/${target.id}${rest.size ? `?${rest.toString()}` : ''}` }
  }
  const requested = match[1]!
  if (requested === 'embed') {
    const map = query.get('map')
    if (!map) return { page: true }
    const info = surfMap(map)
    if (!info) return { page: true } // the client reports the unknown map
    if (info.id === map) return { page: true }
    const rest = new URLSearchParams(query)
    rest.set('map', info.id)
    return { redirect: `/surf/embed?${rest.toString()}` }
  }
  const info = surfMap(requested)
  if (!info) return null
  if (requested !== info.id || path.endsWith('/')) {
    return { redirect: `/surf/${info.id}${query.size ? `?${query.toString()}` : ''}` }
  }
  return { page: true }
}

/**
 * Minimal HTTP layer: health/metrics endpoints and (in production) the
 * built client bundle. Game traffic itself is WebSocket-only. A path no
 * route matches is a 404 (see notFound.ts), never the landing page.
 */

const DEFAULT_NETWORK_URL = 'https://openvibe.network'
const DEFAULT_PORTAL_URL = 'https://openvibe.games'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  // Wavefront models are text: a text type lets the CDN compress them (the physgun's 472 KB went out raw as
  // application/octet-stream).
  '.obj': 'text/plain; charset=utf-8',
  // GPU-compressed surface textures (Games M6, apps/client/src/render/ktx2.ts).
  '.ktx2': 'image/ktx2',
}

/** A file name Vite content-hashed (`main-CE0R2rej.js`): its bytes can never change under that name. */
const HASHED_BUILD_FILE = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/

/**
 * Authorization for the editor HTTP routes. Owner rule (ADR-0007 deleted
 * the shared secret): a Network staff session with `staff.games.manage` is
 * the ONLY way to edit the map. No legacy fallback remains.
 */
export interface EditorAuth {
  /** openvibe.network session endpoint; token validated there when configured. */
  networkAuthUrl: string | null
}

/** openvibe.network OAuth2 client — powers the /auth/login → /auth/callback flow. */
export interface OAuthConfig {
  clientId: string
  clientSecret: string
  /** Public openvibe.network base, e.g. https://openvibe.network */
  baseUrl: string
  /** Our public base, e.g. https://openvibe.games (redirect_uri host). */
  selfUrl: string
  /** Public base of the play vhost, e.g. https://play.openvibe.games. */
  playUrl: string
  /** Host-internal Network base the token grant tries first (OV_NETWORK_INTERNAL_URL). */
  internalUrl?: string
}

/**
 * Validates an editor request: the bearer token MUST be a Network session
 * whose rank resolves to owner or admin (`staff.games.manage`, ADR-022).
 * The shared-secret editor key is gone (ADR-0007 "Deleted"), and no
 * local-only fallback remains — a developer without Network configured
 * must run openvibe.network to use the editor.
 */
async function editorAuthorized(auth: EditorAuth, token: string | undefined): Promise<boolean> {
  if (!token) return false
  if (!auth.networkAuthUrl) return false
  const user = await resolveNetworkUser(auth.networkAuthUrl, token)
  return user !== null && canEditMap(user.rank)
}

/** Reads a small request body as utf8, or null when it exceeds `limit`. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        tooBig = true
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolvePromise(tooBig ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('close', () => resolvePromise(null))
    req.on('error', () => resolvePromise(null))
  })
}

/** Platform seams (roadmap Wave 12): extra API routes and a stored-asset hook. */
export interface HttpPlatformHooks {
  /** Answers a request it owns (returns true), e.g. the mod registry API. */
  handle?: (req: IncomingMessage, res: ServerResponse) => boolean
  /** A map asset was stored (or found already stored) locally. */
  onAssetStored?: (asset: { hash: string; url: string; bytes: number; mime: string }) => void
  /** Per-actor limits on editor saves, uploads, the mods API and ticket minting (./actorLimits.ts); absent in tests that do not need them. */
  limits?: GamesActorLimits
  /** Trusted-proxy-aware client address (./clientAddress.ts); the socket address when absent. */
  clientAddress?: (req: IncomingMessage) => string
  /** The home page's live sections (./portalHome.ts); the static portal alone when absent. */
  homeSections?: () => Promise<HomeParts>
}

/** The token endpoint's answer, for both the code and the jwt-bearer grant. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  error_description?: string
  error?: string
  user?: { username?: string; [key: string]: unknown }
  preferences?: unknown
}

export function createHttpServer(
  staticDir: string | null,
  metrics: ServerMetrics,
  log: Logger,
  mapPath?: string,
  editorAuth?: EditorAuth,
  onMapSaved?: (next: MapFileV2, revision: string) => void,
  listCharacters?: (
    token: string,
    auth: string | undefined,
  ) => Promise<{ slot: number; name: string; appearance: unknown }[]>,
  oauth?: OAuthConfig | null,
  platform?: HttpPlatformHooks,
  tickets?: WsTicketStore,
  indexnow?: SharedIndexNow,
  defaultPlaceId = 'scraplandia',
  /** Per-place map documents (surf places each have their own). */
  mapPathFor?: (place: string | undefined) => string | undefined,
): Server {
  const root = staticDir ? resolve(staticDir) : null
  // The agent layer (openvibe-shared/agent-layer): the Markdown twins of the public pages render through the
  // same builders the HTML routes use, so a twin cannot drift from its page.
  const agentCtx: AgentContext = {
    root,
    host: '',
    portalHtml: async () => {
      if (!root) return null
      const file = join(root, 'index.html')
      if (!existsSync(file)) return null
      const live = platform?.homeSections
      const parts = live ? await live().catch(() => null) : null
      return portalPage(file, parts)
    },
  }
  // Sessions the Network confirmed recently: lets a silent login on a signed-in
  // browser answer without the Network round trip. See /auth/login.
  const knownSessions = new SessionCheckCache()
  // openvibe-sdk/sso's client per public origin: the authorize URL, PKCE, the code exchange and the
  // /auth/health verdict are the SDK's, not a hand copy. Both callback URIs stay registered.
  const ssoClients = new Map<string, ReturnType<typeof createSsoClient>>()
  function ssoFor(base: string, cfg: OAuthConfig) {
    let client = ssoClients.get(base)
    if (!client) {
      client = createSsoClient({
        site: 'games',
        siteName: 'OpenVibe.Games',
        baseUrl: base,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        networkUrl: cfg.baseUrl,
        networkInternalUrl: cfg.internalUrl ?? cfg.baseUrl,
        redirectUri: `${base}/auth/callback`,
        scope: 'profile theme',
        secureCookies: base.startsWith('https'),
        log: {
          log: (msg: string) => log.info(msg),
          warn: (msg: string) => log.warn(msg),
          error: (msg: string) => log.error(msg),
        },
      })
      ssoClients.set(base, client)
    }
    return client
  }
  // The real entry points, offered on the 404 page of each host.
  const portalHome = `${(oauth?.selfUrl ?? DEFAULT_PORTAL_URL).replace(/\/+$/, '')}/`
  const apexLinks: NotFoundLink[] = [
    { href: '/', label: 'OpenVibe.Games home' },
    { href: '/play', label: 'Play Scraplandia' },
    { href: '/play?game=salvage-rush', label: 'Play Salvage Rush' },
    { href: '/play/vibe-heroes', label: 'Play Vibe Heroes' },
    { href: '/leaderboards', label: 'Leaderboards' },
    { href: '/achievements', label: 'Achievements' },
    { href: '/developers', label: 'Game developers' },
    { href: '/worlds', label: 'Creator worlds' },
    { href: '/steam', label: 'On Steam right now' },
    { href: '/editor', label: 'Map editor' },
  ]
  const playLinks: NotFoundLink[] = [
    { href: '/', label: 'Play Scraplandia' },
    { href: '/?game=salvage-rush', label: 'Play Salvage Rush' },
    { href: '/editor', label: 'Map editor' },
    { href: portalHome, label: 'OpenVibe.Games home' },
  ]
  // The site's own /terms, /privacy and /dmca (openvibe-shared/legal), built once for the process.
  const serveLegal = legalHandler()
  // What shipped on the site (the shared update log), as on every OpenVibe site: the portal's host only.
  const serveUpdates = updatesHandler()
  // GET /<key>.txt — the IndexNow key file, before the static files so it is never shadowed by a
  // build artifact of the same name. Absent when no key is configured.
  const serveIndexNow = indexnow ? indexnowHandler(indexnow) : null
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    observeRequest(req, res, url)   // request telemetry (telemetryRoute.ts): a no-op until main.ts calls telemetry.init()
    // Host-based routing: play.openvibe.games serves the game at its root
    // (the apex root is the games portal). Everything else — /assets,
    // /map.json, /api, /auth, websockets — behaves identically on both.
    const playHost = (req.headers.host ?? '').toLowerCase().startsWith('play.')
    const notFound = () => sendNotFound(req, res, url, playHost ? playLinks : apexLinks)
    if (tickets && url === '/api/ws-ticket') {
      const ticketLimits = platform?.limits
      const address =
        platform?.clientAddress ?? ((r: IncomingMessage) => resolveClientAddress(r, null))
      void (async () => {
        // Per-address limit BEFORE any identity is resolved or ticket minted:
        // an unauthenticated caller cannot flood the store.
        if (ticketLimits && !(await ticketLimits.ticket(req, res, `ip:${address(req)}`))) return
        await handleWsTicketRequest(req, res, {
          tickets,
          networkAuthUrl: editorAuth?.networkAuthUrl ?? null,
          log,
        })
      })().catch((err: unknown) => {
        log.warn('ws-ticket request failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        if (!res.headersSent) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"error":"ticket_unavailable"}')
        }
      })
      return
    }
    if (platform?.handle?.(req, res)) return
    // The IndexNow key file (only when a key is configured) — before the static files below.
    if (serveIndexNow?.(req, res)) return
    // Crawl artifacts (plan T11): /robots.txt, /sitemap.xml, /llms.txt and /llms-full.txt, built by
    // openvibe-shared/seo.
    if (discoveryHandler(req, res)) return
    // The site's own legal pages (plan T11 decision 6): /terms, /privacy, /dmca. Before the SPA and the
    // static fallback so they never resolve to a file or the landing page.
    if (serveLegal(req, res)) return
    if (!playHost && serveUpdates(req, res)) return
    const requestedMapPlace = new URL(req.url ?? '/', 'http://games.local').searchParams.get('game')
    const resolvedMapPath = mapPathFor ? mapPathFor(requestedMapPlace ?? defaultPlaceId) : mapPath
    if (url === '/map.json' && requestedMapPlace && requestedMapPlace !== defaultPlaceId && !resolvedMapPath) {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end('{"error":"no_editor_map"}')
      return
    }
    if (url === '/map.json' && resolvedMapPath) {
      // The canonical v2 document, with its revision as an ETag. This IS the
      // wire format.
      void loadMap(resolvedMapPath).then((rec) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-cache',
          etag: `"${rec.revision}"`,
        })
        res.end(JSON.stringify(rec.map))
      })
      return
    }
    if (url === '/api/map' && req.method === 'POST' && mapPath && editorAuth) {
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      void editorAuthorized(editorAuth, token).then(async (ok) => {
        if (!ok) {
          log.warn('editor save rejected', {})
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
          return
        }
        const limits = platform?.limits
        if (limits && !(await limits.mapSave(req, res, limits.editorActor(token ?? '')))) {
          req.resume()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        let aborted = false
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_MAP_BYTES) {
            aborted = true
            req.destroy()
          } else chunks.push(c)
        })
        req.on('close', () => {
          if (!aborted || res.headersSent) return
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end('{"error":"map_too_large"}')
        })
        req.on('end', () => {
          void (async () => {
            const body = Buffer.concat(chunks).toString('utf8')
            // If-Match carries the revision the editor last loaded; a
            // mismatch is a 409 rather than a silent overwrite.
            const ifMatch = (req.headers['if-match'] as string | undefined)?.replace(/"/g, '')
            const current = await loadMap(mapPath)
            const outcome = await saveMap(mapPath, body, current, ifMatch)
            if (outcome.status !== 200) {
              log.warn('map save rejected', { status: outcome.status, error: outcome.error })
              res.writeHead(outcome.status, { 'content-type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: outcome.error,
                  ...(outcome.issues ? { issues: outcome.issues.slice(0, 40) } : {}),
                  ...(outcome.revision ? { revision: outcome.revision } : {}),
                }),
              )
              return
            }
            log.info('map saved by editor', {
              bytes: body.length,
              revision: outcome.record.revision,
            })
            onMapSaved?.(outcome.record.map, outcome.record.revision)
            res.writeHead(200, {
              'content-type': 'application/json',
              etag: `"${outcome.record.revision}"`,
            })
            res.end(JSON.stringify({ ok: true, live: true, revision: outcome.record.revision }))
          })().catch(() => {
            if (res.headersSent) return
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end('{"error":"save_failed"}')
          })
        })
      })
      return
    }
    // ── Map assets: uploaded once, served to every player. ──
    // Big source files (4k photo textures) live on disk next to the map
    // artifact instead of being base64-embedded into map.json.
    // Generic content-addressed upload (textures, paint masks, models).
    if (url === '/api/map-assets' && req.method === 'POST' && mapPath && editorAuth) {
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      void editorAuthorized(editorAuth, token).then(async (authed) => {
        if (!authed) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
          return
        }
        const limits = platform?.limits
        if (limits && !(await limits.asset(req, res, limits.editorActor(token ?? '')))) {
          req.resume()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        let aborted = false
        req.on('data', (c: Buffer) => {
          size += c.length
          // Enforced WHILE streaming: a 48 MB cap that only checks at the end
          // has already buffered 48 MB.
          if (size > MAX_ASSET_BYTES) {
            aborted = true
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end('{"error":"too_large"}')
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => {
          if (aborted) return
          void storeAsset(join(dirname(mapPath), 'map-assets'), Buffer.concat(chunks))
            .then((outcome) => {
              if (!outcome.ok) {
                res.writeHead(outcome.status, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ error: outcome.error }))
                return
              }
              platform?.onAssetStored?.(outcome.asset)
              log.info('map asset stored', {
                hash: outcome.asset.hash,
                bytes: outcome.asset.bytes,
                mime: outcome.asset.mime,
                deduplicated: outcome.deduplicated,
              })
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: true, ...outcome.asset }))
            })
            .catch((err: unknown) => {
              log.warn('map asset store failed', { error: String(err) })
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end('{"error":"write_failed"}')
            })
        })
      })
      return
    }
    if (url.startsWith('/map-assets/') && mapPath) {
      const base = url.slice('/map-assets/'.length)
      // Ids are server-generated; anything else is rejected outright.
      if (!/^[a-z0-9.-]+$/.test(base) || base.includes('..')) {
        res.writeHead(403)
        res.end()
        return
      }
      const assetPath = join(dirname(mapPath), 'map-assets', base)
      if (!existsSync(assetPath)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(assetPath)] ?? 'application/octet-stream',
        // A content-addressed name cannot ever refer to different bytes, so
        // it is immutable. Legacy `tex-<timestamp>` names are not: they were
        // minted per upload and carry no such promise.
        'cache-control': isContentAddressed(base)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
      })
      createReadStream(assetPath).pipe(res)
      return
    }
    if (url === '/api/characters' && listCharacters) {
      const params = new URL(req.url ?? '/', 'http://x').searchParams
      const token = params.get('token') ?? ''
      const auth = params.get('auth') ?? undefined
      void (token.length >= 8 || auth ? listCharacters(token, auth) : Promise.resolve([])).then(
        (chars) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(chars))
        },
      )
      return
    }
    // ── openvibe.network OAuth2 SSO ──────────────────────────────────────
    // /auth/login redirects to the openvibe.network account chooser; the
    // callback exchanges the code server-side (client secret never
    // reaches the browser), then hands the access token to the page.
    //
    // `?silent=1` adds prompt=none (the Network's sign-in-everywhere chain
    // and the shared navbar's one-shot silent attempt); `?next=` may be a
    // same-site path or an https://openvibe.network/... hop. See sso.ts.
    if (url.startsWith('/auth/')) {
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      const cookies = parseCookies(req.headers.cookie)
      const redirectBase = oauth ? (playHost ? oauth.playUrl : oauth.selfUrl) : null
      const secure = redirectBase ? redirectBase.startsWith('https') : false
      const origins = {
        network: oauth?.baseUrl ?? DEFAULT_NETWORK_URL,
        self: oauth ? [oauth.selfUrl, oauth.playUrl] : [],
      }
      // The game IS the root on the play host; on the apex it lives at /play.
      const home = playHost ? '/' : '/play'
      // Where a session token is resolved to an account (see networkAuth.ts).
      const networkMeUrl =
        editorAuth?.networkAuthUrl ?? (oauth ? `${oauth.baseUrl}/api/auth/me` : null)
      // The SDK client for the host the browser is on (see ssoFor above).
      const sso = oauth && redirectBase ? ssoFor(redirectBase, oauth) : null

      if (url === '/auth/login' && oauth && redirectBase && sso) {
        const silent = query.get('silent') === '1'
        const next = safeNext(query.get('next'), origins)
        const startLogin = () => {
          // Both callbacks are registered with the provider; using the host the
          // player came from means the callback lands back on that same host.
          // openvibe-sdk/sso builds the URL with state and PKCE (S256); the
          // verifier rides in the login state cookie and never reaches a script.
          const started = sso.authorizeUrl({ silent })
          res.writeHead(302, {
            location: started.url,
            'set-cookie': loginStateCookie(
              { state: started.state, verifier: started.verifier, next, silent },
              secure,
            ),
            'cache-control': 'no-store',
          })
          res.end()
        }
        const existing = silent ? cookies[SESSION_COOKIE] : undefined
        if (!existing) {
          startLogin()
          return
        }
        // Silent login on a browser that is already signed in here: the
        // Network would only hand back the session we hold, so go straight
        // to `next`. Confirmed either from the short-lived cache or by one
        // /api/auth/me lookup (the same check /auth/me itself makes).
        const shortcut = () => {
          res.writeHead(302, {
            location: next ?? home,
            'set-cookie': clearLoginStateCookie(),
            'cache-control': 'no-store',
          })
          res.end()
        }
        if (knownSessions.has(existing)) {
          shortcut()
          return
        }
        void fetchNetworkAccount(networkMeUrl, existing).then((user) => {
          if (user) {
            knownSessions.remember(existing)
            shortcut()
          } else startLogin()
        })
        return
      }
      if (url === '/auth/callback' && oauth && redirectBase && sso) {
        const login = decodeLoginState(cookies[LOGIN_STATE_COOKIE])
        // Sanitized again here: the cookie is the browser's to lose or rewrite,
        // and this is the value a redirect follows.
        const next = safeNext(login?.next ?? null, origins)
        const loginHref = `/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`
        /** The page a sign-in that cannot finish shows: plain words, "Try again", no bare line of text. */
        const failure = (status: number, title: string, text: string, cookieList: string[]) => {
          res.writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': cookieList,
          })
          res.end(
            failurePage({
              siteName: 'OpenVibe.Games',
              title,
              text,
              retryHref: loginHref,
              backHref: next ?? home,
            }),
          )
        }
        /**
         * A lost or expired flow (the cookie is gone, or the state does not
         * match) starts the sign-in once more by itself; the second failure
         * shows the page instead of looping. Neither ever sets a session.
         */
        const retryOrExplain = (cookieList: string[]) => {
          if (cookies[RETRY_COOKIE] !== '1') {
            res.writeHead(302, {
              location: loginHref,
              'set-cookie': [...cookieList, retryCookie(secure)],
              'cache-control': 'no-store',
            })
            res.end()
            return
          }
          failure(
            400,
            "Sign-in didn't finish",
            'It took too long, or it started in another tab or app. Start it again and it will go through; your account is fine.',
            [...cookieList, clearRetryCookie()],
          )
        }
        const error = query.get('error')
        if (error) {
          // prompt=none found nobody signed in (or the silent attempt was
          // refused): land quietly where the caller asked, flagged sso=none.
          if (login?.silent || isSilentDenial(error)) {
            res.writeHead(302, {
              location: withSsoNone(next ?? home),
              'set-cookie': [clearLoginStateCookie(), clearRetryCookie()],
              'cache-control': 'no-store',
            })
            res.end()
            return
          }
          log.warn('oauth sign-in not completed', {
            error: String(query.get('error_description') ?? error).slice(0, 120),
          })
          failure(
            400,
            "Sign-in didn't finish",
            `OpenVibe.Network did not complete the sign-in (${String(error).slice(0, 60)}). Try again when you are ready; your account is fine.`,
            [clearLoginStateCookie(), clearRetryCookie()],
          )
          return
        }
        const code = query.get('code')
        // The cookie is required, not only compared when present: without it
        // a crafted link would sign a visitor into someone else's account. The
        // state is compared in constant time and so is the PKCE verifier's flow.
        if (!code || !login || !login.verifier || !sameString(query.get('state'), login.state)) {
          log.warn('oauth callback state mismatch', {})
          retryOrExplain([clearLoginStateCookie()])
          return
        }
        void (async () => {
          try {
            // The exchange (and its PKCE verifier) is openvibe-sdk/sso's. It
            // must repeat the redirect_uri the authorize step used; the
            // callback arrives on that same host, so Host decides.
            const data = (await sso.tokenGrant({
              grant_type: 'authorization_code',
              redirect_uri: `${redirectBase}/auth/callback`,
              code: String(code),
              code_verifier: login.verifier,
            })) as TokenResponse
            if (!data.access_token) {
              retryOrExplain([clearLoginStateCookie()])
              return
            }
            knownSessions.remember(data.access_token)
            // Land where the login asked to (a same-site page or the next hop
            // of the Network's sign-in-everywhere chain), else at the game.
            const dest = next ?? home
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'set-cookie': [
                sessionCookie(data.access_token, secure),
                ssoHintCookie('account', secure),
                clearLoginStateCookie(),
                clearRetryCookie(),
              ],
            })
            res.end(sessionHandoffHtml(data.access_token, 'account', dest))
          } catch (err) {
            const failureInfo = err as { status?: number; error?: string }
            if (
              failureInfo.error === 'invalid_client' ||
              failureInfo.error === 'unauthorized_client' ||
              failureInfo.status === 401
            ) {
              log.error("the Network refuses this site's OAuth client", {
                error: failureInfo.error ?? String(failureInfo.status),
              })
              failure(
                500,
                "Sign-in isn't working on OpenVibe.Games right now",
                'This is a problem on our side, not with your account, and it has been logged. Please try again a little later.',
                [clearLoginStateCookie(), clearRetryCookie()],
              )
              return
            }
            log.warn('oauth callback failed', { error: String(err) })
            if (failureInfo.status && failureInfo.status < 500) {
              retryOrExplain([clearLoginStateCookie()])
              return
            }
            failure(
              502,
              "OpenVibe.Network didn't answer",
              'Your account is fine: the sign-in service did not reply in time. Try again in a moment.',
              [clearLoginStateCookie(), clearRetryCookie()],
            )
          }
        })()
        return
      }
      if (url === '/auth/fedcm' && oauth && sso) {
        // Browser-native FedCM sign-in: the shared navbar posts the assertion
        // JWT openvibe.network issued through the browser's account chooser,
        // plus the nonce it put in the FedCM request. Same-origin JSON only.
        // Both hosts serve it, like /auth/login: the play host's navbar
        // posts to its own origin.
        const json = (status: number, body: unknown, setCookie?: string[]) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...(setCookie ? { 'set-cookie': setCookie } : {}),
          })
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
          res.end('{"error":"method_not_allowed"}')
          return
        }
        const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          json(400, { error: 'invalid_request', error_description: 'Expected application/json' })
          return
        }
        void readBody(req, MAX_FEDCM_BODY_BYTES).then(async (raw) => {
          if (raw === null) {
            json(400, { error: 'invalid_request', error_description: 'Body missing or too large' })
            return
          }
          const parsed = parseFedcmBody(raw)
          if ('error' in parsed) {
            json(400, { error: 'invalid_request', error_description: parsed.error })
            return
          }
          try {
            // Same endpoint and answer shape as the code exchange (the SDK's grant); the
            // Network verifies the assertion's signature and audience.
            const data = (await sso.tokenGrant({
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion: parsed.body.token,
            })) as TokenResponse
            if (!data.access_token) {
              log.warn('fedcm exchange rejected', { error: data.error ?? 'no_token' })
              json(401, {
                error: data.error ?? 'invalid_grant',
                error_description:
                  data.error_description ?? 'openvibe.network rejected the assertion',
              })
              return
            }
            knownSessions.remember(data.access_token)
            const user =
              data.user ?? (await fetchNetworkAccount(networkMeUrl, data.access_token)) ?? null
            // Exactly the session the callback sets up: the ovg_sso cookie
            // plus the year-long, JS-readable ov_sso_hint=account.
            json(200, { ok: true, user }, [
              sessionCookie(data.access_token, secure),
              ssoHintCookie('account', secure),
            ])
          } catch (err) {
            const info = err as { status?: number; error?: string; message?: string }
            if (info.status && info.status < 500) {
              log.warn('fedcm exchange rejected', { error: info.error ?? info.status })
              json(401, {
                error: info.error ?? 'invalid_grant',
                error_description: info.message ?? 'openvibe.network rejected the assertion',
              })
              return
            }
            log.warn('fedcm exchange failed', { error: String(err) })
            json(502, {
              error: 'server_error',
              error_description: 'openvibe.network is unreachable — try again shortly',
            })
          }
        })
        return
      }
      if (url === '/auth/logout') {
        // Drops this site's session and marks the browser a guest for the
        // whole network; `next` lets the sign-out-everywhere chain continue.
        const dest = safeNext(query.get('next'), origins) ?? home
        if (cookies[SESSION_COOKIE]) knownSessions.forget(cookies[SESSION_COOKIE])
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': [
            clearSessionCookie(),
            ssoHintCookie('guest', secure),
            clearLoginStateCookie(),
          ],
        })
        res.end(sessionHandoffHtml(null, 'guest', dest))
        return
      }
      if (url === '/auth/me') {
        // Same-origin session lookup for the shared navbar: { user } for the
        // ovg_sso cookie (or a bearer token), { user: null } otherwise.
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
        const token = cookies[SESSION_COOKIE] || bearer
        void fetchNetworkAccount(networkMeUrl, token).then((user) => {
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          })
          res.end(JSON.stringify({ user }))
        })
        return
      }
      if (url === '/auth/health' && sso) {
        // Does the Network accept this site's OAuth client? openvibe-sdk/sso's checkClient
        // (a token request with a code no sign-in ever had), cached 10 minutes; 503 only
        // when the Network refuses the client, never for a Network that cannot answer.
        void sso.checkClient().then((client) => {
          res.writeHead(client === 'invalid' ? 503 : 200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ ok: client !== 'invalid', client }))
        })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not_found"}')
      return
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tick: metrics.tick }))
      return
    }
    if (url === '/metrics') {
      // Operational numbers are for this machine's scrapers only (Track O), never the public site.
      if (!isDirectLoopback(req)) {
        notFound()
        return
      }
      if (wantsPrometheus(req)) {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(prometheusText(metrics.snapshot() as unknown as Record<string, unknown>))
        return
      }
      // ?place=<id>: the world gauges of that place's rooms only (the process hosts several places).
      const place = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('place')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(place && /^[a-z0-9-]{1,64}$/.test(place) ? metrics.placeSnapshot(place) : metrics.snapshot()))
      return
    }
    // Every API route has answered above; what is left under /api is unknown.
    if (url === '/api' || url.startsWith('/api/')) {
      notFound()
      return
    }
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and the Markdown twins of the
    // portal, the game and the world pages. Before the page routes, so a twin is the page's own render and
    // never a static file; after the API routes, so /api keeps answering for itself.
    if (isAgentRequest(req)) {
      const ctx: AgentContext = { ...agentCtx, host: String(req.headers.host ?? '') }
      void handleAgent(req, res, ctx).catch((err: unknown) => {
        log.warn('agent layer failed', { error: String(err) })
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Something went wrong on our side. Try again in a moment.')
        }
      })
      return
    }
    const surfRoute = surfPageRoute(url, new URL(req.url ?? '/', 'http://games.local').searchParams)
    if (surfRoute?.redirect) {
      res.writeHead(301, { location: surfRoute.redirect, 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (!root) {
      notFound()
      return
    }
    // Pretty page routes: on the apex, / is the games portal, /play the
    // game and /editor the map editor. On the play host the game IS the
    // root page (with /play redirecting there so old links keep working).
    // The old .html URLs and a trailing slash redirect to the canonical URL.
    // A casual game (plan T22): /play/<game> is the page an ad or a shared link opens. Its query (src, c) is
    // kept through the trailing-slash redirect, because that is the campaign.
    const casualId = casualGameOf(url)
    if (casualId) {
      if (url.endsWith('/')) {
        res.writeHead(301, { location: url.slice(0, -1) + (req.url ?? '').slice(url.length) })
        res.end()
        return
      }
      const page = join(root, 'casual.html')
      if (!existsSync(page)) {
        res.writeHead(404)
        res.end('client build missing')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(casualPageHtml(page, casualId))
      return
    }
    if (url === '/casual.html') {
      notFound()
      return
    }
    if (url === '/play.html' || url === '/editor.html') {
      res.writeHead(301, {
        location: url === '/play.html' ? (playHost ? '/' : '/play') : '/editor',
      })
      res.end()
      return
    }
    if (playHost && (url === '/play' || url === '/play/')) {
      res.writeHead(301, { location: '/' })
      res.end()
      return
    }
    if (url === '/play/' || url === '/editor/' || url === '/achievements/' || url === '/leaderboards/' || url === '/developers/') {
      res.writeHead(301, { location: url.slice(0, -1) })
      res.end()
      return
    }
    // The old board page became Leaderboards: a link from a round, a share or a bookmark keeps its game and period.
    if (url === '/leaderboard.html') {
      const tail = (req.url ?? '').slice(url.length)
      res.writeHead(301, { location: `/leaderboards${tail}` })
      res.end()
      return
    }
    const pageAlias =
      url === '/'
        ? playHost
          ? 'play.html'
          : 'index.html'
        : url === '/play'
          ? 'play.html'
          : url === '/editor'
            ? 'editor.html'
            : url === '/worlds'
              ? 'worlds.html'
              : url === '/achievements'
                ? 'achievements.html'
                : url === '/leaderboards'
                  ? 'leaderboards.html'
                  : url === '/developers'
                    ? 'developers.html'
                    : url === '/surf/embed' || surfRoute?.page
                      ? 'play.html'
                      : null

    // Static files with path traversal guard.
    const safePath = normalize(pageAlias ?? url).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(root, safePath)
    if (!filePath.startsWith(root)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      if (pageAlias) {
        res.writeHead(404)
        res.end('client build missing')
        return
      }
      // No route and no such file: a real 404, not the landing page.
      notFound()
      return
    }
    // The portal is a static build, so its JSON-LD is injected as the page is served: the same
    // openvibe-shared/seo builders every OpenVibe site uses, one response for every crawler.
    if (pageAlias === 'index.html' || url === '/index.html') {
      const live = platform?.homeSections
      void (live ? live().catch(() => null) : Promise.resolve(null)).then((parts) => {
        const page = portalPage(filePath, parts)
        // The portal has a Markdown twin, so the page names it (the agent layer's discovery tags).
        const canonical = canonicalOf(page) ?? `${DEFAULT_PORTAL_URL.replace(/\/+$/, '')}/`
        const body = addAgentHead(page, canonical)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': String(Buffer.byteLength(body)),
          link: agentLinkFor(canonical),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      })
      return
    }
    // The other pages with a twin (the game, the world list, a casual game) carry the same discovery tags
    // and the Link header as they are served.
    const fileName = filePath.slice(filePath.lastIndexOf(sep) + 1)
    if (AGENT_PAGE_FILES.has(fileName)) {
      const page = readPageFile(filePath)
      if (page) {
        const canonical = canonicalOf(page) ?? `${DEFAULT_PORTAL_URL.replace(/\/+$/, '')}/`
        const body = addAgentHead(page, canonical)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': String(Buffer.byteLength(body)),
          link: agentLinkFor(canonical),
          // The embeddable surf route keeps its frame rule on this path too (it is play.html).
          ...(url === '/surf/embed'
            ? { 'content-security-policy': "frame-ancestors https://openvibe.surf 'self'" }
            : {}),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
    }
    const type = MIME[extname(filePath)] ?? 'application/octet-stream'
    const headers = {
      'content-type': type,
      // HTML must always revalidate (a stale page pins an old protocol
      // version and can't join). Vite content-hashes what it builds into
      // /assets/, so those are immutable. The files public/assets/ copies
      // there keep their names (textures, the physgun model), so they get a
      // day: one of them changed in place would otherwise stay stale a year.
      'cache-control': filePath.endsWith('.html')
        ? 'no-cache'
        : filePath.includes('/assets/') && HASHED_BUILD_FILE.test(filePath)
          ? 'public, max-age=31536000, immutable'
          : filePath.includes('/assets/')
            ? 'public, max-age=86400, stale-while-revalidate=604800'
            : 'public, max-age=3600',
      // The embeddable surf route is frameable by openvibe.surf only; every
      // other page keeps the deployment's no-CSP/no-frame-rule default.
      ...(url === '/surf/embed'
        ? { 'content-security-policy': "frame-ancestors https://openvibe.surf 'self'" }
        : {}),
    }
    if (filePath.endsWith('.html')) {
      // play.html and editor.html are build output too: their /shared/ references
      // get the pinned file's hash so the browser can keep it for a year.
      const body = versionSharedRefs(readFileSync(filePath, 'utf8'))
      res.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(body)) })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    res.writeHead(200, headers)
    createReadStream(filePath)
      .on('error', (err) => {
        log.warn('static file error', { path: filePath, error: String(err) })
        res.destroy()
      })
      .pipe(res)
  })
}
