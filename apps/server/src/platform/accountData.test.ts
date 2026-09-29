import { openTestStore } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createAccountData, type AccountEvent } from './accountData.js'

/**
 * Account export and deletion in Games (roadmap WS-B task 7, ADR-033):
 *   - the export part holds the subject's characters without the sign-in token;
 *   - a deletion closes the sessions first, then erases the characters of the subject and its merged-in aliases;
 *   - Games confirms with counts; a failed confirmation is retried without erasing again; a redelivery sends nothing
 *     twice; foreign or malformed events are ignored.
 */
const req = createRequire(import.meta.url)
const { validate } = req('openvibe-contracts') as {
  validate(id: string, v: unknown): { valid: boolean; errors?: unknown }
}
const log = createConsoleLogger({ app: 'test' }, 'error')
const DANA = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3'
const OLD = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4'
const OTTO = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2C5'
const char = (id: string, token: string) => ({
  id,
  token,
  name: `char-${id}`,
  pos: [0, 1, 0] as [number, number, number],
  yaw: 0,
  inventory: { size: 24, hotbar: 6, slots: [] },
  skills: { mining: 3 },
  friends: [],
  appearance: null,
  charSlot: 0,
  armor: null,
  reputation: {},
  unlocks: [],
  activeJob: null,
  stats: null,
  updatedAt: 1,
})
const ev = (type: string, payload: Record<string, unknown>, source = 'network'): AccountEvent => ({
  event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2D6',
  event_type: type,
  source,
  payload,
})

describe('account export and deletion (ADR-033)', () => {
  it('exports, then closes sessions, erases and confirms once', async () => {
    const store = await openTestStore()
    await store.players.upsertMany([char('d0', DANA), char('d1', OLD), char('o0', OTTO)])
    const sent: {
      path: string
      body: {
        files?: { name: string; content: unknown }[]
        erased?: Record<string, number>
        retained?: Record<string, number>
      }
    }[] = []
    let failNext = false
    const closed: string[][] = []
    const data = createAccountData({
      db: store.db,
      identity: store.identity,
      send: async (path, body) => {
        if (failNext) {
          failNext = false
          return { ok: false, status: 503 }
        }
        sent.push({ path, body: body as (typeof sent)[number]['body'] })
        return { ok: true, status: 200 }
      },
      closeSessions: async (subjects) => {
        closed.push(subjects)
      },
      log,
    })
    const exp = ev('network.account.export_requested', {
      export_id: 'exp_01J8Z3Q4R5S6T7V8W9X0Y1Z2E7',
      subject: DANA,
    })
    expect(await data.apply({ ...exp, source: 'live' })).toBe('ignored:source')
    expect(
      await data.apply(
        ev('network.account.export_requested', { export_id: 'nope', subject: DANA }),
      ),
    ).toBe('ignored:payload')
    expect(await data.apply(exp)).toBe('exported')
    const part = sent[0]!.body
    expect(
      validate('network.account-export-part@1', { subject: DANA, files: part.files }).valid,
    ).toBe(true)
    const chars = part.files![0]!.content as Record<string, unknown>[]
    expect(chars.map((c) => c.id)).toEqual(['d0'])
    expect(chars[0]).not.toHaveProperty('token')
    expect(await data.apply(exp)).toBe('unchanged')
    expect(sent.length).toBe(1)

    const del = ev('network.account.deleted', {
      deletion_id: 'del_01J8Z3Q4R5S6T7V8W9X0Y1Z2F8',
      subject: DANA,
      aliases: [OLD],
    })
    failNext = true
    await expect(data.apply(del)).rejects.toThrow(/confirmation refused: 503/)
    expect(closed).toEqual([[DANA, OLD]])
    const dana = await store.players.listByToken(DANA)
    const old = await store.players.listByToken(OLD)
    expect(dana.length + old.length).toBe(0)
    expect((await store.players.listByToken(OTTO)).map((p) => p.id)).toEqual(['o0'])
    expect(await data.apply(del)).toBe('confirmed')
    expect(closed.length).toBe(1)
    const conf = sent[1]!
    expect(conf.path).toBe(
      '/internal/account-deletions/del_01J8Z3Q4R5S6T7V8W9X0Y1Z2F8/confirmations',
    )
    expect(validate('network.account-deletion-confirmation@1', conf.body).valid).toBe(true)
    expect(conf.body.erased).toEqual({ characters: 2, identity_rows: 0 })
    expect(conf.body.retained).toEqual({ structures_unowned: 0 })
    expect(await data.apply(del)).toBe('unchanged')
    expect(sent.length).toBe(2)
    await store.close()
  })
})
