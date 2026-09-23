import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import type { Logger } from '@openvibe/shared'
import type { ServerMetrics } from '../observability/metrics.js'
import { canEditMap, fetchNetworkAccount, resolveNetworkUser } from './networkAuth.js'
import {
  LOGIN_STATE_COOKIE,
  MAX_FEDCM_BODY_BYTES,
  SESSION_COOKIE,
  SessionCheckCache,
  clearLoginStateCookie,
  clearSessionCookie,
  decodeLoginState,
  isSilentDenial,
  loginStateCookie,
  parseCookies,
  parseFedcmBody,
  safeNext,
  sessionCookie,
  sessionHandoffHtml,
  ssoHintCookie,
  withSsoNone,
} from './sso.js'
import { MAX_MAP_BYTES, loadMap, saveMap } from './mapStore.js'
import { MAX_ASSET_BYTES, isContentAddressed, storeAsset } from './mapAssetStore.js'
import type { MapFileV2 } from '@openvibe/content'

/**
 * Minimal HTTP layer: health/metrics endpoints and (in production) the
 * built client bundle. Game traffic itself is WebSocket-only.
 */

const DEFAULT_NETWORK_URL = 'https://openvibe.network'

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
}

export interface EditorAuth {
  /** Shared-secret fallback. */
  key: string | null
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
}

/**
 * Validates a map-editor token: against openvibe.network when configured (the
 * endpoint must answer a JSON body with an admin-ish rank for the given
 * bearer token), else against the EDITOR_KEY shared secret.
 */
async function editorAuthorized(auth: EditorAuth, token: string | undefined): Promise<boolean> {
  if (!token) return false
  if (auth.networkAuthUrl) {
    const user = await resolveNetworkUser(auth.networkAuthUrl, token)
    return user !== null && canEditMap(user.rank)
  }
  return auth.key !== null && token === auth.key
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
): Server {
  const root = staticDir ? resolve(staticDir) : null
  // Sessions the Network confirmed recently: lets a silent login on a signed-in
  // browser answer without the Network round trip. See /auth/login.
  const knownSessions = new SessionCheckCache()
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    // Host-based routing: play.openvibe.games serves the game at its root
    // (the apex root is the games portal). Everything else — /assets,
    // /map.json, /api, /auth, websockets — behaves identically on both.
    const playHost = (req.headers.host ?? '').toLowerCase().startsWith('play.')
    if (platform?.handle?.(req, res)) return
    if (url === '/map.json' && mapPath) {
      // The canonical v2 document, with its revision as an ETag. This IS the
      // wire format: there is no v1 projection any more.
      void loadMap(mapPath).then((rec) => {
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
      const token = (req.headers['x-editor-key'] as string | undefined) ?? undefined
      void editorAuthorized(editorAuth, token).then((ok) => {
        if (!ok) {
          log.warn('editor save rejected', {})
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
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
    // ── Custom texture assets: uploaded once, served to every player. ──
    // Big source files (4k photo textures) live on disk next to the map
    // artifact instead of being base64-embedded into map.json.
    // Generic content-addressed asset upload (textures, paint masks, models).
    // `/api/texture` is the same handler under its old name so older editor
    // builds keep working; there is ONE store behind both.
    if (
      (url === '/api/map-assets' || url === '/api/texture') &&
      req.method === 'POST' &&
      mapPath &&
      editorAuth
    ) {
      const token = (req.headers['x-editor-key'] as string | undefined) ?? undefined
      void editorAuthorized(editorAuth, token).then((authed) => {
        if (!authed) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
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

      if (url === '/auth/login' && oauth && redirectBase) {
        const silent = query.get('silent') === '1'
        const next = safeNext(query.get('next'), origins)
        const startLogin = () => {
          // Both callbacks are registered with the provider; using the host the
          // player came from means the callback lands back on that same host.
          const state = randomBytes(16).toString('hex')
          const params = new URLSearchParams({
            client_id: oauth.clientId,
            redirect_uri: `${redirectBase}/auth/callback`,
            response_type: 'code',
            scope: 'profile theme',
            state,
          })
          if (silent) params.set('prompt', 'none')
          res.writeHead(302, {
            location: `${oauth.baseUrl}/oauth/authorize?${params.toString()}`,
            'set-cookie': loginStateCookie({ state, next, silent }, secure),
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
      if (url === '/auth/callback' && oauth && redirectBase) {
        const login = decodeLoginState(cookies[LOGIN_STATE_COOKIE])
        const next = login?.next ?? null
        const error = query.get('error')
        if (error) {
          // prompt=none found nobody signed in (or the silent attempt was
          // refused): land quietly where the caller asked, flagged sso=none.
          if (login?.silent || isSilentDenial(error)) {
            res.writeHead(302, {
              location: withSsoNone(next ?? home),
              'set-cookie': clearLoginStateCookie(),
              'cache-control': 'no-store',
            })
            res.end()
            return
          }
          res.writeHead(400, {
            'content-type': 'text/plain',
            'set-cookie': clearLoginStateCookie(),
          })
          res.end(`sign-in failed: ${query.get('error_description') ?? error}`)
          return
        }
        const code = query.get('code')
        if (!code) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('missing code')
          return
        }
        // A login-state cookie is only ever missing when the browser refused
        // it; when present, the state it pinned must be the one coming back.
        if (login && login.state !== query.get('state')) {
          log.warn('oauth callback state mismatch', {})
          res.writeHead(400, {
            'content-type': 'text/plain',
            'set-cookie': clearLoginStateCookie(),
          })
          res.end('sign-in failed: state mismatch — start again')
          return
        }
        void (async () => {
          try {
            // The exchange must repeat the redirect_uri the authorize step
            // used; the callback arrives on that same host, so Host decides.
            const resp = await fetch(`${oauth.baseUrl}/oauth/token`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                grant_type: 'authorization_code',
                client_id: oauth.clientId,
                client_secret: oauth.clientSecret,
                code,
                redirect_uri: `${redirectBase}/auth/callback`,
              }),
            })
            const data = (await resp.json()) as TokenResponse
            if (!data.access_token) {
              res.writeHead(400, {
                'content-type': 'text/plain',
                'set-cookie': clearLoginStateCookie(),
              })
              res.end(`sign-in failed: ${data.error_description ?? data.error ?? 'no token'}`)
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
              ],
            })
            res.end(sessionHandoffHtml(data.access_token, 'account', dest))
          } catch (err) {
            log.warn('oauth callback failed', { error: String(err) })
            res.writeHead(502, { 'content-type': 'text/plain' })
            res.end('openvibe.network is unreachable — try again shortly')
          }
        })()
        return
      }
      if (url === '/auth/fedcm' && oauth) {
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
            // Same endpoint and answer shape as the code exchange; the
            // Network verifies the assertion's signature and audience.
            const resp = await fetch(`${oauth.baseUrl}/oauth/token`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: parsed.body.token,
                client_id: oauth.clientId,
                client_secret: oauth.clientSecret,
              }),
            })
            const data = (await resp.json().catch(() => ({}))) as TokenResponse
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
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(metrics.snapshot()))
      return
    }
    if (!root) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    // Pretty page routes: on the apex, / is the games portal, /play the
    // game and /editor the map editor. On the play host the game IS the
    // root page (with /play redirecting there so old links keep working).
    // The old .html URLs redirect so bookmarks keep working.
    if (url === '/play.html' || url === '/editor.html') {
      res.writeHead(301, {
        location: url === '/play.html' ? (playHost ? '/' : '/play') : '/editor',
      })
      res.end()
      return
    }
    if (playHost && url === '/play') {
      res.writeHead(301, { location: '/' })
      res.end()
      return
    }
    const pageAlias =
      playHost && url === '/'
        ? 'play.html'
        : url === '/play'
          ? 'play.html'
          : url === '/editor'
            ? 'editor.html'
            : null

    // Static files with path traversal guard.
    const safePath = normalize(pageAlias ?? url).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(root, safePath)
    if (!filePath.startsWith(root)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // Unknown paths fall back to the host's landing page (apex: portal
      // home; play host: the game itself).
      filePath = join(root, playHost ? 'play.html' : 'index.html')
      if (!existsSync(filePath)) {
        res.writeHead(404)
        res.end('client build missing')
        return
      }
    }
    const type = MIME[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      // HTML must always revalidate (a stale page pins an old protocol
      // version and can't join). Vite content-hashes /assets/, so those
      // are immutable; everything else gets a modest TTL.
      'cache-control': filePath.endsWith('.html')
        ? 'no-cache'
        : filePath.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    })
    createReadStream(filePath)
      .on('error', (err) => {
        log.warn('static file error', { path: filePath, error: String(err) })
        res.destroy()
      })
      .pipe(res)
  })
}
