import { createHash } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createConsoleLogger } from '@openvibe/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServerMetrics } from '../observability/metrics.js'
import { createHttpServer, type OAuthConfig } from './httpServer.js'

/**
 * The /auth routes against a stand-in openvibe.network: the authorize URL
 * (state + PKCE S256), the code exchange that repeats the verifier, the
 * cookies the game client still reads, and GET /auth/health.
 */

const log = createConsoleLogger({ app: 'test' }, 'error')
const APEX = 'openvibe.games'

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function listen(s: Server): Promise<number> {
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  )
}

function send(
  port: number,
  path: string,
  opts: { host?: string; cookie?: string; method?: string; json?: unknown } = {},
): Promise<Reply> {
  const payload = opts.json === undefined ? null : Buffer.from(JSON.stringify(opts.json))
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? (payload ? 'POST' : 'GET'),
        headers: {
          host: opts.host ?? APEX,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function setCookies(r: Reply): string[] {
  const raw = r.headers['set-cookie']
  return Array.isArray(raw) ? raw : raw ? [raw] : []
}

function cookieNamed(r: Reply, name: string): string | undefined {
  return setCookies(r)
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith(`${name}=`))
}

/** The login state cookie's JSON payload. */
function pinned(r: Reply): {
  state: string
  verifier: string
  next: string | null
  silent: boolean
} {
  const raw = (cookieNamed(r, 'ovg_login') ?? '').split('=')[1] ?? ''
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
}

/** An unsigned-but-well-formed JWT carrying `claims` (the Network checks signatures, not us). */
function fedcmAssertion(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`
}

const tokenCalls: Array<Record<string, unknown>> = []

let network: Server
let networkPort = 0
let server: Server
let port = 0
let refusing: Server
let refusingPort = 0
let portInvalid = 0

function oauthFor(base: string): OAuthConfig {
  return {
    clientId: 'games',
    clientSecret: 'secret',
    baseUrl: base,
    selfUrl: 'https://openvibe.games',
    playUrl: 'https://play.openvibe.games',
    internalUrl: base,
  }
}

beforeAll(async () => {
  network = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >
      tokenCalls.push(body)
      res.setHeader('content-type', 'application/json')
      // A code no sign-in ever had is the health check: invalid_grant means the client itself is fine.
      if (body.code === 'ov_health_check_never_issued') {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const claims = JSON.parse(
          Buffer.from(String(body.assertion).split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as { nonce?: string }
        if (claims.nonce !== 'n1') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.end(JSON.stringify({ access_token: 'tok-fedcm', user: { username: 'ana' } }))
        return
      }
      if (
        body.code !== 'good-code' ||
        body.client_id !== 'games' ||
        body.client_secret !== 'secret'
      ) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      res.end(JSON.stringify({ access_token: 'tok-flow', refresh_token: 'rt-flow' }))
    })
  })
  networkPort = await listen(network)
  const base = `http://127.0.0.1:${networkPort}`

  server = createHttpServer(
    null,
    new ServerMetrics(),
    log,
    undefined,
    { networkAuthUrl: null },
    undefined,
    undefined,
    oauthFor(base),
  )
  port = await listen(server)

  // A Network that refuses this site's client: the one answer /auth/health must not hide.
  refusing = createServer((_req, res) => {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'invalid_client' }))
  })
  refusingPort = await listen(refusing)
  const invalid = createHttpServer(
    null,
    new ServerMetrics(),
    log,
    undefined,
    undefined,
    undefined,
    undefined,
    oauthFor(`http://127.0.0.1:${refusingPort}`),
  )
  portInvalid = await listen(invalid)
})

afterAll(() => {
  server.close()
  network.close()
  refusing.close()
})

describe('/auth/login', () => {
  it('redirects with state and PKCE S256, pinning both in the login state cookie', async () => {
    const r = await send(port, '/auth/login?next=%2Fplay%3Fgame%3Dsurf_lagoon')
    expect(r.status).toBe(302)
    const url = new URL(r.headers.location ?? '')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('games')
    expect(url.searchParams.get('redirect_uri')).toBe('https://openvibe.games/auth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('profile theme')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const state = url.searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThan(20)
    expect(url.searchParams.get('prompt')).toBeNull()

    const pin = cookieNamed(r, 'ovg_login')
    expect(pin).toBeTruthy()
    const value = pinned(r)
    expect(value.state).toBe(state)
    expect(value.next).toBe('/play?game=surf_lagoon')
    expect(value.silent).toBe(false)
    // The verifier is in the cookie only; the Network got its hash.
    expect(value.verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const challenge = createHash('sha256').update(value.verifier).digest('base64url')
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
  })

  it('silent=1 asks for prompt=none', async () => {
    const r = await send(port, '/auth/login?silent=1')
    const url = new URL(r.headers.location ?? '')
    expect(url.searchParams.get('prompt')).toBe('none')
  })

  it('sanitizes next: an off-site target is not pinned', async () => {
    const r = await send(port, '/auth/login?next=https%3A%2F%2Fevil.example%2Fx')
    expect(pinned(r).next).toBeNull()
  })
})

describe('/auth/callback', () => {
  it('exchanges the code with the pinned verifier and keeps the ovg_sso hand-off', async () => {
    const started = await send(port, '/auth/login?next=%2Fplay')
    const pin = (cookieNamed(started, 'ovg_login') ?? '').split(';')[0] ?? ''
    const value = pinned(started)

    tokenCalls.length = 0
    const r = await send(
      port,
      `/auth/callback?code=good-code&state=${encodeURIComponent(value.state)}`,
      { cookie: pin },
    )
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    // The game client reads the token from localStorage; the cookie and the hint still ride along.
    expect(r.body).toContain('localStorage.setItem(\'ovg_sso\', "tok-flow")')
    expect(r.body).toContain('location.replace("/play")')
    expect(cookieNamed(r, 'ovg_sso')).toBe('ovg_sso=tok-flow')
    expect(cookieNamed(r, 'ov_sso_hint')).toBe('ov_sso_hint=account')
    expect(cookieNamed(r, 'ovg_login')).toBe('ovg_login=')
    expect(tokenCalls.at(-1)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'good-code',
      code_verifier: value.verifier,
      redirect_uri: 'https://openvibe.games/auth/callback',
      client_id: 'games',
      client_secret: 'secret',
    })
  })

  it('recovers a lost flow once, then explains it — and never sets a session', async () => {
    const first = await send(port, '/auth/callback?code=good-code&state=not-the-state')
    expect(first.status).toBe(302)
    expect(first.headers.location).toMatch(/^\/auth\/login/)
    const retry = cookieNamed(first, 'ov_oauth_retry')
    expect(retry).toBe('ov_oauth_retry=1')
    expect(cookieNamed(first, 'ovg_sso')).toBeUndefined()

    const second = await send(port, '/auth/callback?code=good-code&state=not-the-state', {
      cookie: retry ?? '',
    })
    expect(second.status).toBe(400)
    expect(second.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(second.body).toContain('Try again')
    expect(cookieNamed(second, 'ovg_sso')).toBeUndefined()
  })

  it('sanitizes next again at the callback', async () => {
    const pin = `ovg_login=${Buffer.from(
      JSON.stringify({
        state: 's1',
        verifier: 'v1',
        next: 'https://evil.example/x',
        silent: false,
      }),
      'utf8',
    ).toString('base64url')}`
    const r = await send(port, '/auth/callback?code=good-code&state=s1', { cookie: pin })
    expect(r.status).toBe(200)
    expect(r.body).toContain('location.replace("/play")')
    expect(r.body).not.toContain('evil.example')
  })

  it('refuses a callback with no login state cookie at all', async () => {
    const r = await send(port, '/auth/callback?code=good-code&state=anything')
    expect(r.status).toBe(302)
    expect(cookieNamed(r, 'ovg_sso')).toBeUndefined()
  })

  it('lands a silent sign-in quietly with sso=none', async () => {
    const started = await send(port, '/auth/login?silent=1&next=%2Fplay')
    const pin = (cookieNamed(started, 'ovg_login') ?? '').split(';')[0] ?? ''
    const r = await send(port, '/auth/callback?error=login_required', { cookie: pin })
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe('/play?sso=none')
  })
})

describe('/auth/fedcm', () => {
  it('sets the same session cookies from an assertion', async () => {
    const r = await send(port, '/auth/fedcm', {
      json: { token: fedcmAssertion({ sub: 7, nonce: 'n1' }), nonce: 'n1' },
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, user: { username: 'ana' } })
    expect(cookieNamed(r, 'ovg_sso')).toBe('ovg_sso=tok-fedcm')
    expect(cookieNamed(r, 'ov_sso_hint')).toBe('ov_sso_hint=account')
  })

  it('refuses an assertion whose nonce does not match', async () => {
    const r = await send(port, '/auth/fedcm', {
      json: { token: fedcmAssertion({ sub: 7, nonce: 'other' }), nonce: 'n1' },
    })
    expect(r.status).toBe(400)
    expect(cookieNamed(r, 'ovg_sso')).toBeUndefined()
  })
})

describe('/auth/health', () => {
  it('is 200 when the Network accepts the client (invalid_grant, not invalid_client)', async () => {
    const r = await send(port, '/auth/health')
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(r.body)).toEqual({ ok: true, client: 'ok' })
  })

  it('is 503 only when the Network refuses the client', async () => {
    const r = await send(portInvalid, '/auth/health')
    expect(r.status).toBe(503)
    expect(JSON.parse(r.body)).toEqual({ ok: false, client: 'invalid' })
  })
})
