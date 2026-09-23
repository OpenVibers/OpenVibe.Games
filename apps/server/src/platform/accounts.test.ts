import { openSqliteStore } from '@openvibe/persistence/sqlite'
import type { PlayerDto } from '@openvibe/persistence'
import { describe, expect, it } from 'vitest'
import { accountForNetworkUser, isGuestToken, legacyNetworkKey } from './accounts.js'

const SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'

function legacyChar(id: string, token: string, slot: number): PlayerDto {
  return {
    id,
    token,
    name: id,
    pos: [4, 5, 6],
    yaw: 0,
    inventory: { size: 24, hotbar: 6, slots: [] },
    skills: {},
    friends: [],
    appearance: null,
    charSlot: slot,
    armor: null,
    reputation: {},
    unlocks: [],
    activeJob: null,
    stats: null,
    updatedAt: 1,
  }
}

describe('guest tokens (hostile input)', () => {
  it('accepts what the client mints', () => {
    expect(isGuestToken('a1B2c3D4')).toBe(true)
    expect(isGuestToken('0123456789abcdef0123456789abcdef')).toBe(true)
    // Older clients and the slice test use `_`/`-`; still fine.
    expect(isGuestToken('token_aaaaaaaaaaaa')).toBe(true)
    expect(isGuestToken('guest-1234-abcd')).toBe(true)
  })

  it('refuses anything shaped like an account key or out of range', () => {
    for (const bad of [
      SUBJECT,
      'gst_01JABCDEFGHJKMNPQRSTVWXYZ0',
      'ovn:57',
      'ovn:1',
      'short',
      'x'.repeat(65),
      'has space1',
      'usr_whatever123',
      'GST_01JABCDEFGHJKMNPQRSTVWXYZ0',
      'ovn:57:x',
      '',
      null,
      42,
    ]) {
      expect(isGuestToken(bad), String(bad)).toBe(false)
    }
  })
})

describe('accountForNetworkUser', () => {
  it('keys a signed-in account by its subject and adopts legacy characters once', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsertMany([legacyChar('p1', 'ovn:57', 0), legacyChar('p2', 'ovn:57', 1)])
    const user = { id: '57', name: 'ana', rank: null, subjectId: SUBJECT }

    const first = accountForNetworkUser(store, user, 1)
    expect(first).toEqual({ key: SUBJECT, subjectId: SUBJECT, adopted: 2 })
    expect(store.players.listByToken(SUBJECT).map((p) => p.id)).toEqual(['p1', 'p2'])
    // Same player ids: friends lists, prop ownership and trust still point at them.
    expect(store.players.findById('p1')?.pos).toEqual([4, 5, 6])

    const again = accountForNetworkUser(store, user, 2)
    expect(again).toEqual({ key: SUBJECT, subjectId: SUBJECT, adopted: 0 })
    store.close()
  })

  it('keeps the legacy key for a token issued before subjects', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsert(legacyChar('p1', 'ovn:8', 0))
    const res = accountForNetworkUser(
      store,
      { id: '8', name: 'old', rank: null, subjectId: null },
      1,
    )
    expect(res).toEqual({ key: legacyNetworkKey('8'), subjectId: null, adopted: 0 })
    expect(store.players.findByTokenSlot('ovn:8', 0)?.id).toBe('p1')
    store.close()
  })

  it('reports a conflicting legacy map instead of re-homing characters', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsert(legacyChar('p1', 'ovn:3', 0))
    store.identity.adoptLegacyAccount('ovn:3', SUBJECT, 'network', 1)
    store.players.upsert(legacyChar('p2', 'ovn:3', 1))
    const conflicts: unknown[] = []
    const other = 'usr_01JZZZZZZZZZZZZZZZZZZZZZZZ'
    const res = accountForNetworkUser(
      store,
      { id: '3', name: 'x', rank: null, subjectId: other },
      2,
      (c) => conflicts.push(c),
    )
    expect(res.key).toBe(other)
    expect(conflicts).toHaveLength(1)
    expect(store.players.findById('p2')?.token).toBe('ovn:3')
    store.close()
  })
})
