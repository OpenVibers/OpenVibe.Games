import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { parseProxyTrust, resolveClientAddress } from './clientAddress.js'

/**
 * Client-address resolution behind a proxy (finding 3). Forwarded headers are
 * client-supplied: they must be honoured only when the TCP peer is a trusted
 * proxy, otherwise a caller mints unlimited rate-limit buckets by varying
 * X-Forwarded-For. nginx sets X-Real-IP from $remote_addr; Cloudflare sets
 * CF-Connecting-IP.
 */
function req(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('resolveClientAddress', () => {
  it('uses the socket address and ignores forwarded headers when nothing is trusted', () => {
    const r = req('203.0.113.5', {
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '1.2.3.4',
      'cf-connecting-ip': '1.2.3.4',
    })
    expect(resolveClientAddress(r, null)).toBe('203.0.113.5')
  })

  it('honours CF-Connecting-IP from a trusted peer, then X-Real-IP, then X-Forwarded-For', () => {
    const trust = ['10.0.0.0/8']
    const all = {
      'cf-connecting-ip': '198.51.100.1',
      'x-real-ip': '198.51.100.2',
      'x-forwarded-for': '198.51.100.3',
    }
    expect(resolveClientAddress(req('10.0.0.5', all), trust)).toBe('198.51.100.1')
    const noCf = { 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.3' }
    expect(resolveClientAddress(req('10.0.0.5', noCf), trust)).toBe('198.51.100.2')
    expect(
      resolveClientAddress(req('10.0.0.5', { 'x-forwarded-for': '198.51.100.3' }), trust),
    ).toBe('198.51.100.3')
  })

  it('takes the right-most hop that is not itself a trusted proxy', () => {
    const r = req('10.0.0.5', { 'x-forwarded-for': '9.9.9.9, 10.0.0.9, 10.0.0.8' })
    expect(resolveClientAddress(r, ['10.0.0.0/8'])).toBe('9.9.9.9')
  })

  it('ignores forwarded headers from a peer outside the trusted set', () => {
    const r = req('203.0.113.5', { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4' })
    expect(resolveClientAddress(r, ['10.0.0.0/8'])).toBe('203.0.113.5')
  })

  it("honours headers from any peer when trust is 'all' (proxy-only deployment)", () => {
    const r = req('127.0.0.1', { 'x-real-ip': '198.51.100.9' })
    expect(resolveClientAddress(r, 'all')).toBe('198.51.100.9')
  })

  it('normalises IPv4-mapped IPv6 socket addresses', () => {
    const r = req('::ffff:127.0.0.1')
    expect(resolveClientAddress(r, null)).toBe('127.0.0.1')
    // The trusted-set match works on the normalised form too.
    expect(
      resolveClientAddress(req('::ffff:10.0.0.5', { 'x-real-ip': '1.2.3.4' }), ['10.0.0.5']),
    ).toBe('1.2.3.4')
  })

  it('parses TRUST_PROXY', () => {
    expect(parseProxyTrust(undefined)).toBeNull()
    expect(parseProxyTrust('')).toBeNull()
    expect(parseProxyTrust('true')).toBe('all')
    expect(parseProxyTrust('*')).toBe('all')
    expect(parseProxyTrust('10.0.0.0/8, 192.168.1.1')).toEqual(['10.0.0.0/8', '192.168.1.1'])
  })
})
