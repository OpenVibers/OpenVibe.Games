/**
 * The client address used for per-address rate limits and logs.
 *
 * Forwarded headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP) are
 * client-supplied and must not be trusted by default: a direct caller could
 * otherwise mint an unlimited number of rate-limit buckets by varying them.
 * They are honoured only when the TCP peer is a configured trusted proxy
 * (TRUST_PROXY) — behind nginx, which sets X-Real-IP from $remote_addr and
 * overwrites X-Forwarded-For, and behind Cloudflare, whose CF-Connecting-IP
 * is authoritative. When trusted, X-Forwarded-For is walked right-to-left so
 * the right-most hop that is not itself a trusted proxy wins.
 */
import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

/** null = trust nothing; 'all' = the server is only reachable through the proxy; else IPs/CIDRs. */
export type ProxyTrust = 'all' | string[]

/** Parse TRUST_PROXY: empty = none, `true`/`1`/`*` = all, else a comma-separated IP/CIDR list. */
export function parseProxyTrust(raw: string | undefined): ProxyTrust | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  if (value === 'true' || value === '1' || value === '*') return 'all'
  const rules = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return rules.length > 0 ? rules : null
}

function normalize(addr: string | null | undefined): string | null {
  if (!addr) return null
  const trimmed = addr.trim()
  if (!trimmed) return null
  // Node reports IPv4-mapped IPv6 (::ffff:127.0.0.1) for IPv4 peers.
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number.parseInt(o, 10), 0) >>> 0
}

function matchesRule(addr: string, rule: string): boolean {
  const [net, bitsRaw] = rule.split('/')
  if (net === undefined) return false
  if (bitsRaw === undefined) return normalize(net) === addr
  const bits = Number.parseInt(bitsRaw, 10)
  if (isIP(net) !== 4 || isIP(addr) !== 4) return false
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipToInt(addr) & mask) === (ipToInt(net) & mask)
}

function isTrusted(addr: string, trust: ProxyTrust): boolean {
  if (trust === 'all') return true
  return trust.some((rule) => matchesRule(addr, rule))
}

/** The address to key a rate limit or log line on. */
export function resolveClientAddress(req: IncomingMessage, trust: ProxyTrust | null): string {
  const socketAddr = normalize(req.socket?.remoteAddress) ?? 'unknown'
  // Nothing is trusted: the TCP peer is the caller (the direct-exposure case).
  if (!trust || !isTrusted(socketAddr, trust)) return socketAddr
  const headers = req.headers
  // Cloudflare's single header wins when present (a trusted proxy stripped
  // any client-supplied copy).
  const cf = normalize(
    typeof headers['cf-connecting-ip'] === 'string' ? headers['cf-connecting-ip'] : null,
  )
  if (cf) return cf
  const real = normalize(typeof headers['x-real-ip'] === 'string' ? headers['x-real-ip'] : null)
  if (real) return real
  const xff = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : ''
  const hops = xff
    .split(',')
    .map((s) => normalize(s))
    .filter((s): s is string => s !== null)
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrusted(hops[i] as string, trust)) return hops[i] as string
  }
  // Every hop is a trusted proxy (or 'all'): the left-most is the origin.
  return hops[0] ?? socketAddr
}
