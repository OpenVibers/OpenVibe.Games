import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PlayerDto } from '../dto.js'
import { openSqliteStore } from './sqliteStore.js'

const SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
const OTHER = 'usr_01JZZZZZZZZZZZZZZZZZZZZZZZ'

function player(
  id: string,
  token: string,
  slot: number,
  extra: Partial<PlayerDto> = {},
): PlayerDto {
  return {
    id,
    token,
    name: `char-${id}`,
    pos: [0, 1, 0],
    yaw: 0,
    inventory: { size: 24, hotbar: 6, slots: [] },
    skills: { woodcutting: 10 },
    friends: [],
    appearance: null,
    charSlot: slot,
    armor: null,
    reputation: {},
    unlocks: [],
    activeJob: null,
    stats: null,
    updatedAt: 1,
    ...extra,
  }
}

describe('guest conversion (WS-B task 8)', () => {
  it('moves the guest character into the first free slot, once, keyed by a hash of the token', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsertMany([player('g1', 'guest00042abc', 0), player('a0', SUBJECT, 0)])
    expect(store.identity.adoptGuestCharacter('guest00042abc', SUBJECT, 10)).toEqual({ moved: 1, slot: 1, full: false })
    expect(store.players.listByToken(SUBJECT).map((p) => [p.id, p.charSlot]).sort()).toEqual([['a0', 0], ['g1', 1]])
    expect(store.players.listByToken('guest00042abc')).toEqual([])
    expect(store.identity.adoptGuestCharacter('guest00042abc', SUBJECT, 11)).toEqual({ moved: 0, slot: null, full: false })
    const keys = (store.db.prepare('SELECT legacy_key FROM identity_legacy_map').all() as { legacy_key: string }[]).map((r) => r.legacy_key)
    expect(keys.some((k) => k.includes('guest00042abc'))).toBe(false)
    expect(keys.some((k) => /^guest:[0-9a-f]{32}$/.test(k))).toBe(true)
    store.close()
  })

  it('keeps the guest character when every slot is taken, and does nothing without one', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsertMany([player('a0', SUBJECT, 0), player('a1', SUBJECT, 1), player('a2', SUBJECT, 2), player('g1', 'guestfull01', 0)])
    expect(store.identity.adoptGuestCharacter('guestfull01', SUBJECT, 1)).toEqual({ moved: 0, slot: null, full: true })
    expect(store.players.listByToken('guestfull01').length).toBe(1)
    expect(store.identity.adoptGuestCharacter('nobodyhere01', SUBJECT, 1)).toEqual({ moved: 0, slot: null, full: false })
    store.close()
  })
})

describe('identity repository (legacy -> canonical subject)', () => {
  it('moves every legacy character to the subject once and records the map', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsertMany([player('p1', 'ovn:57', 0), player('p2', 'ovn:57', 1)])

    expect(store.identity.legacyAccountKeys('ovn:')).toEqual(['ovn:57'])
    expect(store.identity.adoptLegacyAccount('ovn:57', SUBJECT, 'network', 100)).toEqual({
      moved: 2,
      conflicts: 0,
    })
    const chars = store.players.listByToken(SUBJECT)
    expect(chars.map((c) => [c.id, c.charSlot, c.subjectId])).toEqual([
      ['p1', 0, SUBJECT],
      ['p2', 1, SUBJECT],
    ])
    expect(store.players.listByToken('ovn:57')).toEqual([])
    expect(store.identity.subjectForLegacy('ovn:57')).toBe(SUBJECT)
    expect(store.identity.legacyAccountKeys('ovn:')).toEqual([])

    // Idempotent: nothing left to move, the map is unchanged.
    expect(store.identity.adoptLegacyAccount('ovn:57', SUBJECT, 'network', 200)).toEqual({
      moved: 0,
      conflicts: 0,
    })
    expect(store.players.listByToken(SUBJECT)).toHaveLength(2)
    store.close()
  })

  it('never overwrites a slot the subject already uses', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsertMany([
      player('new0', SUBJECT, 0, { subjectId: SUBJECT }),
      player('old0', 'ovn:9', 0),
      player('old2', 'ovn:9', 2),
    ])
    expect(store.identity.adoptLegacyAccount('ovn:9', SUBJECT, 'network', 1)).toEqual({
      moved: 1,
      conflicts: 1,
    })
    expect(store.players.findByTokenSlot(SUBJECT, 0)?.id).toBe('new0')
    expect(store.players.findByTokenSlot(SUBJECT, 2)?.id).toBe('old2')
    // The conflicting character stays reachable under its legacy key.
    expect(store.players.findByTokenSlot('ovn:9', 0)?.id).toBe('old0')
    store.close()
  })

  it('refuses to re-home a legacy key to a different subject', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsert(player('p1', 'ovn:1', 0))
    store.identity.adoptLegacyAccount('ovn:1', SUBJECT, 'network', 1)
    store.players.upsert(player('p9', 'ovn:1', 1))
    expect(() => store.identity.adoptLegacyAccount('ovn:1', OTHER, 'network', 2)).toThrow(
      /already mapped/,
    )
    // Nothing moved by the refused call.
    expect(store.players.findById('p9')?.token).toBe('ovn:1')
    store.close()
  })

  it('keeps subject_id through ordinary saves that do not carry it', () => {
    const store = openSqliteStore(':memory:')
    store.players.upsert(player('p1', SUBJECT, 0, { subjectId: SUBJECT }))
    const { subjectId: _drop, ...withoutSubject } = store.players.findById('p1')!
    store.players.upsert({ ...withoutSubject, name: 'renamed' })
    expect(store.players.findById('p1')).toMatchObject({ name: 'renamed', subjectId: SUBJECT })
    store.close()
  })
})

describe('mod repository', () => {
  it('stores installs, grants, placements and an append-only audit log', () => {
    const store = openSqliteStore(':memory:')
    store.mods.insert({
      id: 'mod_01JABCDEFGHJKMNPQRSTVWXYZ0',
      name: 'Test',
      version: '1.0.0',
      target: 'games.browser',
      runtime: 'games-content@1',
      manifest: { a: 1 },
      pack: { props: [] },
      trustTier: 'unreviewed',
      status: 'disabled',
      installedBy: SUBJECT,
      installedAt: 1,
      updatedAt: 1,
    })
    const id = 'mod_01JABCDEFGHJKMNPQRSTVWXYZ0'
    store.mods.upsertGrant({
      modId: id,
      capability: 'games.world.announce',
      grantedBy: SUBJECT,
      grantedAt: 2,
      revokedAt: null,
      revokedBy: null,
    })
    expect(store.mods.revokeGrant(id, 'games.world.announce', SUBJECT, 3)).toBe(true)
    expect(store.mods.revokeGrant(id, 'games.world.announce', SUBJECT, 4)).toBe(false)
    expect(store.mods.grants(id)[0]).toMatchObject({ revokedAt: 3, revokedBy: SUBJECT })

    store.mods.setPlacement({ modId: id, key: 'bench', entityId: 'e1', at: 5 })
    store.mods.setPlacement({ modId: id, key: 'bench', entityId: 'e2', at: 6 })
    expect(store.mods.placements(id)).toEqual([{ modId: id, key: 'bench', entityId: 'e2', at: 6 }])
    store.mods.deletePlacement(id, 'bench')
    expect(store.mods.placements(id)).toEqual([])

    store.mods.audit({
      modId: id,
      action: 'install',
      capability: null,
      actor: SUBJECT,
      detail: null,
      at: 1,
    })
    store.mods.audit({
      modId: id,
      action: 'grant',
      capability: 'games.world.announce',
      actor: SUBJECT,
      detail: { x: 1 },
      at: 2,
    })
    expect(store.mods.auditLog(id, 10).map((a) => a.action)).toEqual(['grant', 'install'])
    store.mods.setStatus(id, 'revoked', 9)
    expect(store.mods.get(id)).toMatchObject({
      status: 'revoked',
      updatedAt: 9,
      manifest: { a: 1 },
    })
    store.close()
  })
})

describe('media mirror queue', () => {
  it('queues once, schedules retries and records the Media object', () => {
    const store = openSqliteStore(':memory:')
    const asset = { assetHash: 'sha256-aa', fileName: 'sha256-aa.png', mime: 'image/png', bytes: 3 }
    expect(store.mediaMirrors.enqueue(asset, 10)).toBe(true)
    expect(store.mediaMirrors.enqueue(asset, 11)).toBe(false)
    expect(store.mediaMirrors.due(10, 5)).toHaveLength(1)
    store.mediaMirrors.markFailed('sha256-aa', 'http.503: down', 100, false, 12)
    expect(store.mediaMirrors.due(50, 5)).toHaveLength(0)
    expect(store.mediaMirrors.due(100, 5)).toHaveLength(1)
    store.mediaMirrors.noteObject('sha256-aa', 'med_X', 13)
    store.mediaMirrors.markMirrored('sha256-aa', 'med_X', 'https://openvibe.media/o/med_X', 14)
    expect(store.mediaMirrors.get('sha256-aa')).toMatchObject({
      status: 'mirrored',
      mediaId: 'med_X',
      attempts: 2,
      lastError: null,
    })
    expect(store.mediaMirrors.counts()).toEqual({ pending: 0, mirrored: 1, failed: 0 })
    store.close()
  })
})

describe('store transactions', () => {
  it('roll back every repository write together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openvibe-tx-'))
    const store = openSqliteStore(join(dir, 'world.db'))
    expect(() =>
      store.transaction(() => {
        store.players.upsert(player('p1', 'tok_12345678', 0))
        store.meta.set('env_time', '0.5')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.players.findById('p1')).toBeNull()
    expect(store.meta.get('env_time')).toBeNull()
    store.close()
  })
})
