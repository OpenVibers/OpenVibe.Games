/**
 * The staff authorizer's principal branch. The KEY comes from the Network through
 * openvibe-sdk/auth's JWKS client (a stub fetch over a real key pair); every RULE comes from
 * openvibe-contracts' serviceAuth.verifyServiceToken, so a service token no longer skips them:
 *
 *   - a `svc:` token carrying games.mod.manage is accepted (a ModActor for the service)
 *   - an app token with env=sandbox is refused (null), the rules the old
 *     verifyUserToken({ allowServiceTokens: true }) skipped
 *   - a token signed by a key that is not in the JWKS is refused (null)
 *   - a JWKS that starts failing after its keys were cached still verifies (the last good keys)
 *   - a principal token without the capability is refused, and the injectable verifyPrincipal
 *     seam still decides
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Logger, LogFields } from '@openvibe/shared'
import {
  CAP_MOD_MANAGE,
  GAMES_AUDIENCE,
  NETWORK_ISSUER,
  createStaffAuthorizer,
} from './staffAuth.js'

const contracts = createRequire(import.meta.url)('openvibe-contracts') as {
  serviceAuth: {
    signServiceToken(
      claims: Record<string, unknown>,
      key: KeyObject,
      opts?: { kid?: string },
    ): string
  }
}

function keyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
}

function jwk(publicKey: KeyObject, kid: string): Record<string, unknown> {
  return {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid,
    use: 'sig',
    alg: 'RS256',
  }
}

/** A signed principal token for audience openvibe.games. */
function token(over: Record<string, unknown> = {}, priv: KeyObject, kid: string): string {
  const now = Math.floor(Date.now() / 1000)
  return contracts.serviceAuth.signServiceToken(
    {
      iss: NETWORK_ISSUER,
      sub: 'svc:games',
      actor_type: 'service',
      aud: [GAMES_AUDIENCE],
      cap: [CAP_MOD_MANAGE],
      ns: [],
      iat: now,
      exp: now + 300,
      jti: 'jti_test',
      ...over,
    },
    priv,
    { kid },
  )
}

const req = (authorization: string): IncomingMessage =>
  ({ headers: { authorization } }) as unknown as IncomingMessage

/** A fetch over one JWKS document; `setOk(false)` turns the endpoint off. */
function jwksFetch(keys: Record<string, unknown>[]): {
  fetch: typeof fetch
  calls: () => number
  setOk: (v: boolean) => void
} {
  let calls = 0
  let ok = true
  // Replaces the global entirely (nothing else in this module makes a request).
  const impl = async (): Promise<Response> => {
    calls += 1
    if (!ok) throw new Error('JWKS endpoint down')
    return new Response(JSON.stringify({ keys }), { status: 200 })
  }
  return {
    fetch: vi.fn(impl) as unknown as typeof fetch,
    calls: () => calls,
    setOk: (v: boolean) => (ok = v),
  }
}

const silent = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  child: () => silent,
}
/** A logger that records what the authorizer reports; refusals are logged, never answered. */
function recordingLogger(): Logger & { entries: string[] } {
  const entries: string[] = []
  const l = {
    entries,
    warn: (m: string, f?: LogFields) => entries.push(`${m} ${JSON.stringify(f ?? {})}`),
    info: () => {},
    error: () => {},
    debug: () => {},
    child: () => l,
  }
  return l
}

/**
 * The authorizer reads the process-wide JWKS client for the URL, so every test uses its own
 * (stubbed) Network origin and a fresh client.
 */
function authorizerFor(
  url: string,
  verifyPrincipal?: (t: string) => Promise<Record<string, unknown>>,
  log: Logger = silent as unknown as Logger,
) {
  return createStaffAuthorizer({
    networkAuthUrl: null,
    networkUrl: url,
    log,
    ...(verifyPrincipal ? { verifyPrincipal } : {}),
  })
}

describe('staff authorizer: service principals', () => {
  it('accepts a svc: token carrying games.mod.manage', async () => {
    const kp = keyPair()
    const origin = 'https://net-ok.test'
    const f = jwksFetch([jwk(kp.publicKey, 'k1')])
    vi.stubGlobal('fetch', f.fetch)
    const tok = token({}, kp.privateKey, 'k1')
    const log = recordingLogger()

    const actor = await authorizerFor(origin, undefined, log)(req(`Bearer ${tok}`))

    expect(actor).toEqual({ audit: 'svc:games', subject: { type: 'service', id: 'games' } })
    expect(f.calls()).toBeGreaterThan(0)
    expect(log.entries).toEqual([])
    vi.unstubAllGlobals()
  })

  it('refuses a sandbox app token with the capability (null)', async () => {
    const kp = keyPair()
    const origin = 'https://net-sandbox.test'
    vi.stubGlobal('fetch', jwksFetch([jwk(kp.publicKey, 'k1')]).fetch)
    const log = recordingLogger()
    const tok = token(
      {
        sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0',
        actor_type: 'app',
        env: 'sandbox',
        project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0',
      },
      kp.privateKey,
      'k1',
    )

    // The rule the old verifyUserToken({ allowServiceTokens: true }) skipped.
    expect(await authorizerFor(origin, undefined, log)(req(`Bearer ${tok}`))).toBeNull()
    expect(log.entries.join(' ')).toContain('sandbox')
    expect(log.entries.join(' ')).not.toContain('net-sandbox.test')
    vi.unstubAllGlobals()
  })

  it('refuses a token signed by a key that is not in the JWKS (null)', async () => {
    const signer = keyPair()
    const other = keyPair()
    const origin = 'https://net-wrongkey.test'
    vi.stubGlobal('fetch', jwksFetch([jwk(other.publicKey, 'k1')]).fetch)

    expect(
      await authorizerFor(origin)(req(`Bearer ${token({}, signer.privateKey, 'k1')}`)),
    ).toBeNull()
    vi.unstubAllGlobals()
  })

  it('still verifies through a JWKS outage once keys are cached', async () => {
    const kp = keyPair()
    const origin = 'https://net-outage.test'
    const f = jwksFetch([jwk(kp.publicKey, 'k1')])
    vi.stubGlobal('fetch', f.fetch)
    const tok = token({}, kp.privateKey, 'k1')
    const log = recordingLogger()
    const authorize = authorizerFor(origin, undefined, log)

    expect(await authorize(req(`Bearer ${tok}`))).not.toBeNull()
    f.setOk(false)
    // The keys are fresh (inside the 6 h TTL), so this needs no fetch at all; even after the
    // document goes stale the client serves the last good keys while a refresh fails.
    expect(await authorize(req(`Bearer ${tok}`))).not.toBeNull()
    vi.unstubAllGlobals()
  })

  it('refuses when no signing key can be loaded (null), and never answers the SDK message', async () => {
    const kp = keyPair()
    const origin = 'https://net-nokeys.test'
    const log = recordingLogger()
    vi.stubGlobal('fetch', jwksFetch([]).fetch)

    expect(
      await authorizerFor(origin, undefined, log)(req(`Bearer ${token({}, kp.privateKey, 'k1')}`)),
    ).toBeNull()
    // The JWKS client already logged its own state change (it names the URL: server-side only);
    // what the authorizer adds carries the reason, and the answer is a null either way.
    expect(log.entries.join(' ')).toContain('signing key unavailable')
    vi.unstubAllGlobals()
  })

  it('refuses a principal token without games.mod.manage, and honours the verifyPrincipal seam', async () => {
    const kp = keyPair()
    const origin = 'https://net-nocap.test'
    vi.stubGlobal('fetch', jwksFetch([jwk(kp.publicKey, 'k1')]).fetch)

    expect(
      await authorizerFor(origin)(
        req(`Bearer ${token({ cap: ['media.read'] }, kp.privateKey, 'k1')}`),
      ),
    ).toBeNull()

    // The seam replaces verification entirely (no key needed); the token still has to look
    // like a principal, since that is the branch it exercises.
    const withSeam = authorizerFor('https://net-seam.test', async () => ({
      sub: 'svc:ci',
      cap: [CAP_MOD_MANAGE],
    }))
    const fakeJwt = `x.${Buffer.from('{"sub":"svc:ci"}').toString('base64url')}.y`
    expect(await withSeam(req(`Bearer ${fakeJwt}`))).toEqual({
      audit: 'svc:ci',
      subject: { type: 'service', id: 'ci' },
    })
    vi.unstubAllGlobals()
  })
})
