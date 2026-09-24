import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildRelease, gitCommit, isDirectLoopback, releaseHandler } from './release.js'

const SHA = 'a'.repeat(40)
function checkout(kind: 'loose' | 'packed' | 'detached'): string {
  const root = mkdtempSync(join(tmpdir(), 'games-release-'))
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  mkdirSync(join(root, 'apps', 'server'), { recursive: true })
  if (kind === 'detached') writeFileSync(join(root, '.git', 'HEAD'), `${SHA}\n`)
  else writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  if (kind === 'loose') writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${SHA}\n`)
  if (kind === 'packed') writeFileSync(join(root, '.git', 'packed-refs'), `# pack-refs\n${SHA} refs/heads/main\n`)
  return root
}

describe('release manifest (D43)', () => {
  it('reads the checked-out commit from a loose ref, packed-refs or a detached HEAD, from a subdirectory too', () => {
    for (const kind of ['loose', 'packed', 'detached'] as const) {
      const root = checkout(kind)
      expect(gitCommit(root)).toBe(SHA)
      expect(gitCommit(join(root, 'apps', 'server'))).toBe(SHA)
    }
    expect(gitCommit(mkdtempSync(join(tmpdir(), 'no-git-')))).toBeNull()
  })

  it('builds the shared manifest shape; RELEASE_SHA wins', () => {
    const m = buildRelease(checkout('loose'), { env: {}, now: () => new Date('2026-09-24T00:00:00Z') })
    expect(m.service).toBe('games')
    expect(m.release).toBe(SHA.slice(0, 12))
    expect(m.components.server).toEqual({ kind: 'server', version: SHA.slice(0, 12) })
    expect(m.booted_at).toBe('2026-09-24T00:00:00.000Z')
    expect(buildRelease('/nowhere', { env: { RELEASE_SHA: 'b'.repeat(40) } }).release).toBe('b'.repeat(12))
  })

  it('answers GET /release.json only', () => {
    const handle = releaseHandler(buildRelease('/nowhere', { env: { RELEASE_SHA: 'c'.repeat(40) } }))
    const out: { status?: number; body?: string | undefined } = {}
    const res = { writeHead: (s: number) => { out.status = s }, end: (b?: string) => { out.body = b } } as unknown as ServerResponse
    expect(handle({ url: '/api/x', method: 'GET' } as IncomingMessage, res)).toBe(false)
    expect(handle({ url: '/release.json?x=1', method: 'GET' } as IncomingMessage, res)).toBe(true)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body ?? '{}').release).toBe('c'.repeat(12))
  })

  it('metrics are for direct loopback callers only', () => {
    const req = (addr: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: addr }, headers }) as unknown as IncomingMessage
    expect(isDirectLoopback(req('127.0.0.1'))).toBe(true)
    expect(isDirectLoopback(req('::1'))).toBe(true)
    expect(isDirectLoopback(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))).toBe(false)
    expect(isDirectLoopback(req('127.0.0.1', { 'x-real-ip': '1.2.3.4' }))).toBe(false)
    expect(isDirectLoopback(req('203.0.113.9'))).toBe(false)
  })
})
