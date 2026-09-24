import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canEditMap, rankOf, resolveNetworkUser } from './networkAuth.js'

/**
 * Rank from the contracts staff map (ADR-022): the owner claim, staff.games.manage and
 * staff.moderation.chat decide it, never a role name or a username; the account's fresh
 * role wins over a token minted before a role change.
 */

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = (claims: Record<string, unknown>): string => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`

let server: Server
let url: string
let account: Record<string, unknown> = {}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ user: account }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/me`
})
afterAll(() => server.close())

describe('rank from the staff map', () => {
  it('maps claims to ranks', () => {
    expect(rankOf({ role: 'user' })).toBe(null)
    expect(rankOf({ role: 'global_mod' })).toBe('moderator')
    expect(rankOf({ role: 'admin' })).toBe('admin')
    expect(rankOf({ role: 'admin', is_owner: true })).toBe('owner')
    expect(rankOf({ role: 'user', is_owner: true })).toBe(null)
    expect(rankOf({ role: 'global_mod', staff_caps: ['staff.games.manage'], staff_map: '1.1.0' })).toBe('admin')
    expect(rankOf({ role: 'admin', staff_caps: ['staff.moderation.chat'], staff_map: '1.1.0' })).toBe('moderator')
    expect(canEditMap('owner') && canEditMap('admin') && !canEditMap('moderator') && !canEditMap(null)).toBe(true)
  })

  it('reads the accepted token and prefers the account role after a change', async () => {
    account = { id: 7, username: 'goosely', role: 'admin', subject_id: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' }
    expect((await resolveNetworkUser(url, token({ role: 'admin', is_owner: true })))?.rank).toBe('owner')
    // a username is not the owner claim
    expect((await resolveNetworkUser(url, token({ role: 'admin' })))?.rank).toBe('admin')
    account = { id: 8, username: 'demoted', role: 'user' }
    expect((await resolveNetworkUser(url, token({ role: 'admin', staff_caps: ['staff.games.manage'], staff_map: '1.1.0' })))?.rank).toBe(null)
    account = { id: 9, username: 'promoted', role: 'admin' }
    expect((await resolveNetworkUser(url, token({ role: 'user' })))?.rank).toBe('admin')
  })

  it('no server file compares a role name by hand', () => {
    const root = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const f = join(dir, name)
        if (statSync(f).isDirectory()) { walk(f); continue }
        if (!/\.ts$/.test(name) || name.endsWith('.test.ts')) continue
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (/OWNER_USERNAME|\brole\s*[!=]==?\s*['"](admin|global_mod|moderator)['"]/.test(line)) offenders.push(`${relative(root, f)}:${i + 1}`)
        })
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
