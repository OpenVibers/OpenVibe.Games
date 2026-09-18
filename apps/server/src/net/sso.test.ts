import { describe, expect, it } from 'vitest'
import {
  SessionCheckCache,
  decodeJwtPayload,
  decodeLoginState,
  encodeLoginState,
  fedcmNonceMatches,
  isSilentDenial,
  parseCookies,
  parseFedcmBody,
  safeNext,
  sessionHandoffHtml,
  withSsoNone,
} from './sso.js'

/** An unsigned-but-well-formed JWT carrying `claims` (the Network checks signatures, not us). */
function fakeJwt(claims: unknown): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`
}

const origins = {
  network: 'https://openvibe.network',
  self: ['https://openvibe.games', 'https://play.openvibe.games'],
}

describe('safeNext', () => {
  it('accepts same-site paths', () => {
    expect(safeNext('/play', origins)).toBe('/play')
    expect(safeNext('/editor?x=1#y', origins)).toBe('/editor?x=1#y')
  })
  it('rejects protocol-relative and junk', () => {
    expect(safeNext('//evil.example/x', origins)).toBeNull()
    expect(safeNext('/\\evil.example', origins)).toBeNull()
    expect(safeNext('javascript:alert(1)', origins)).toBeNull()
    expect(safeNext('', origins)).toBeNull()
    expect(safeNext(null, origins)).toBeNull()
  })
  it('accepts the Network and our own hosts, nothing else', () => {
    expect(safeNext('https://openvibe.network/sso/fanout?step=2', origins)).toBe(
      'https://openvibe.network/sso/fanout?step=2',
    )
    expect(safeNext('https://play.openvibe.games/', origins)).toBe('https://play.openvibe.games/')
    expect(safeNext('https://openvibe.network.evil.example/', origins)).toBeNull()
    expect(safeNext('https://evil.example/?u=https://openvibe.network', origins)).toBeNull()
  })
})

describe('withSsoNone', () => {
  it('appends to a path, keeping query and hash', () => {
    expect(withSsoNone('/play')).toBe('/play?sso=none')
    expect(withSsoNone('/play?a=1#top')).toBe('/play?a=1&sso=none#top')
  })
  it('appends to an absolute URL', () => {
    expect(withSsoNone('https://openvibe.network/sso/fanout?step=2')).toBe(
      'https://openvibe.network/sso/fanout?step=2&sso=none',
    )
  })
})

describe('login state cookie', () => {
  it('round-trips', () => {
    const s = { state: 'abc', next: 'https://openvibe.network/x', silent: true }
    expect(decodeLoginState(encodeLoginState(s))).toEqual(s)
  })
  it('tolerates garbage', () => {
    expect(decodeLoginState('not-base64-json')).toBeNull()
    expect(decodeLoginState(undefined)).toBeNull()
  })
})

describe('fedcm assertion', () => {
  it('decodes a payload without trusting it', () => {
    expect(decodeJwtPayload(fakeJwt({ sub: 7, nonce: 'n1' }))).toEqual({ sub: 7, nonce: 'n1' })
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('a.b.c')).toBeNull()
    expect(decodeJwtPayload(fakeJwt([1, 2]))).toBeNull()
  })
  it('accepts only the nonce the assertion was minted for', () => {
    const token = fakeJwt({ sub: 7, nonce: 'expected' })
    expect(fedcmNonceMatches(token, 'expected')).toBe(true)
    expect(fedcmNonceMatches(token, 'other')).toBe(false)
    expect(fedcmNonceMatches(token, 'expecte')).toBe(false)
    expect(fedcmNonceMatches(token, '')).toBe(false)
    expect(fedcmNonceMatches(fakeJwt({ sub: 7 }), 'expected')).toBe(false)
    expect(fedcmNonceMatches(fakeJwt({ nonce: 7 }), '7')).toBe(false)
  })
  it('parses the posted body and rejects mismatches before anything reaches the Network', () => {
    const token = fakeJwt({ sub: 7, nonce: 'n1' })
    expect(parseFedcmBody(JSON.stringify({ token, nonce: 'n1' }))).toEqual({
      body: { token, nonce: 'n1' },
    })
    expect(parseFedcmBody(JSON.stringify({ token, nonce: 'n2' }))).toEqual({
      error: 'nonce_mismatch',
    })
    expect(parseFedcmBody(JSON.stringify({ nonce: 'n1' }))).toEqual({
      error: 'missing_token_or_nonce',
    })
    expect(parseFedcmBody(JSON.stringify({ token, nonce: 5 }))).toEqual({
      error: 'missing_token_or_nonce',
    })
    expect(parseFedcmBody('{nope')).toEqual({ error: 'malformed_json' })
    expect(parseFedcmBody('"str"')).toEqual({ error: 'malformed_json' })
    expect(parseFedcmBody('null')).toEqual({ error: 'malformed_json' })
  })
})

describe('session check cache (silent-login shortcut)', () => {
  it('remembers a confirmed session only until its ttl', () => {
    const cache = new SessionCheckCache(1000)
    expect(cache.has('tok', 0)).toBe(false)
    cache.remember('tok', 0)
    expect(cache.has('tok', 999)).toBe(true)
    expect(cache.has('tok', 1000)).toBe(false)
    expect(cache.has('tok', 500)).toBe(false) // an expired entry is gone for good
  })
  it('forgets on logout and never grows past its cap', () => {
    const cache = new SessionCheckCache(1000, 2)
    cache.remember('a', 0)
    cache.forget('a')
    expect(cache.has('a', 1)).toBe(false)
    cache.remember('a', 0)
    cache.remember('b', 0)
    cache.remember('c', 0)
    expect(cache.has('a', 1)).toBe(false) // oldest evicted
    expect(cache.has('b', 1)).toBe(true)
    expect(cache.has('c', 1)).toBe(true)
  })
})

describe('cookies + handoff', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; ovg_sso=tok%20en; b')).toEqual({ a: '1', ovg_sso: 'tok en' })
  })
  it('recognises prompt=none denials', () => {
    expect(isSilentDenial('login_required')).toBe(true)
    expect(isSilentDenial('access_denied')).toBe(false)
  })
  it('handoff page escapes the destination', () => {
    const html = sessionHandoffHtml('t"</script>', 'account', '/play"><x')
    // Exactly one </script>: the real closing tag, never one smuggled in a value.
    expect(html.split('</script>').length).toBe(2)
    expect(html).toContain('\\u003c/script>')
    expect(html).toContain('&quot;')
  })
})
