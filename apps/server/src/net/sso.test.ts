import { describe, expect, it } from 'vitest'
import {
  decodeLoginState,
  encodeLoginState,
  isSilentDenial,
  parseCookies,
  safeNext,
  sessionHandoffHtml,
  withSsoNone,
} from './sso.js'

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
