import { describe, expect, it } from 'vitest'
import { OpenVibeError, type OpenVibeClient } from 'openvibe-sdk/core'
import { mergeSummary, NAMESPACE, ProgressSummaryWriter } from './progressSummary.js'

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA'

/** A stub Network: one record per (namespace, subject) with revisions and If-Match, like the real one. */
function stubNetwork(opts: { conflictOnce?: boolean } = {}) {
  const records = new Map<string, { data: Record<string, unknown>; revision: number }>()
  const calls: string[] = []
  let conflict = opts.conflictOnce ?? false
  const client = {
    async json(o: {
      method?: string
      path: string
      json?: { data: Record<string, unknown> }
      headers?: Record<string, string | undefined>
    }) {
      const m = o.path.match(/^\/internal\/modules\/([^/]+)\/([^/]+)$/)
      if (!m) throw new Error(`unexpected ${o.path}`)
      const key = `${decodeURIComponent(m[1] as string)}|${decodeURIComponent(m[2] as string)}`
      const method = o.method ?? 'GET'
      calls.push(`${method} ${key}`)
      const rec = records.get(key)
      if (method === 'GET') {
        if (!rec)
          throw new OpenVibeError({ status: 404, code: 'modules.not_found', message: 'none' })
        return { ...rec }
      }
      const want = o.headers?.['If-Match']
      if (conflict) {
        conflict = false
        records.set(key, {
          data: { level: 99, playtime_hours: 1 },
          revision: (rec?.revision ?? 0) + 1,
        })
        throw new OpenVibeError({
          status: 412,
          code: 'modules.revision_conflict',
          message: 'moved',
        })
      }
      if (want !== undefined && want !== `"${rec?.revision ?? 0}"`)
        throw new OpenVibeError({
          status: 412,
          code: 'modules.revision_conflict',
          message: 'moved',
        })
      const next = { data: o.json?.data ?? {}, revision: (rec?.revision ?? 0) + 1 }
      records.set(key, next)
      return next
    },
  }
  return { client: client as unknown as OpenVibeClient, records, calls }
}

const quiet = { warn: () => {} }

describe('games.progress.summary', () => {
  it('merges a session: the best total level, accumulated playtime, the last world', () => {
    expect(
      mergeSummary(undefined, {
        levels: { mining: 3, crafting: 2 },
        sessionSeconds: 1800,
        world: 'scraplandia',
      }),
    ).toEqual({ level: 5, playtime_hours: 0.5, last_world: 'scraplandia' })
    expect(
      mergeSummary(
        { level: 9, playtime_hours: 2, achievements: 4 },
        { levels: { mining: 3 }, sessionSeconds: 360, world: 'w' },
      ),
    ).toEqual({ level: 9, playtime_hours: 2.1, last_world: 'w', achievements: 4 })
  })

  it('writes when a signed-in character leaves, and nothing for guests', async () => {
    let t = 1_000_000
    const net = stubNetwork()
    const w = new ProgressSummaryWriter(net.client, quiet, () => t)
    w.playerJoined('p1')
    t += 2 * 3600_000
    await w.playerLeft('p1', ANN, { mining: 4, salvage: 6 }, 'scraplandia')
    expect(net.records.get(`${NAMESPACE}|${ANN}`)).toEqual({
      data: { level: 10, playtime_hours: 2, last_world: 'scraplandia' },
      revision: 1,
    })
    w.playerJoined('p2')
    await w.playerLeft('p2', 'gst_01JAB2C3D4E5F6G7H8J9K0MNPG', { mining: 50 }, 'scraplandia')
    await w.playerLeft('p3', null, { mining: 50 }, 'scraplandia')
    expect(net.calls.filter((c) => c.startsWith('PUT')).length).toBe(1)
  })

  it('reads again when another writer moved the record', async () => {
    const net = stubNetwork({ conflictOnce: true })
    const w = new ProgressSummaryWriter(net.client, quiet, () => 0)
    await w.playerLeft('p1', ANN, { mining: 1 }, 'scraplandia')
    expect(net.records.get(`${NAMESPACE}|${ANN}`)?.data).toEqual({
      level: 99,
      playtime_hours: 1,
      last_world: 'scraplandia',
    })
  })

  it('never throws when Network is down', async () => {
    const warnings: string[] = []
    const client = {
      json: async () => {
        throw new OpenVibeError({ status: 503, code: 'network.unavailable', message: 'down' })
      },
    } as unknown as OpenVibeClient
    const w = new ProgressSummaryWriter(client, { warn: (m) => warnings.push(m) })
    await expect(w.playerLeft('p1', ANN, { mining: 1 }, 'w')).resolves.toBeUndefined()
    expect(warnings).toEqual(['progress summary not written'])
    expect(w.pending()).toBe(0)
  })
})
