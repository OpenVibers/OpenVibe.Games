import { describe, expect, it } from 'vitest'
import { sql } from 'openvibe-sdk/db'
import type { PlayerDto } from '../dto.js'
import { openTestStore } from '../testing.js'

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
  it('moves the guest character into the first free slot, once, keyed by a hash of the token', async () => {
    const store = await openTestStore()
    await store.players.upsertMany([player('g1', 'guest00042abc', 0), player('a0', SUBJECT, 0)])
    expect(await store.identity.adoptGuestCharacter('guest00042abc', SUBJECT, 10)).toEqual({
      moved: 1,
      slot: 1,
      full: false,
    })
    expect(
      (await store.players.listByToken(SUBJECT)).map((p) => [p.id, p.charSlot]).sort(),
    ).toEqual([
      ['a0', 0],
      ['g1', 1],
    ])
    expect(await store.players.listByToken('guest00042abc')).toEqual([])
    expect(await store.identity.adoptGuestCharacter('guest00042abc', SUBJECT, 11)).toEqual({
      moved: 0,
      slot: null,
      full: false,
    })
    const keys = (
      await store.db.many<{ adoption_key: string }>(
        sql`SELECT adoption_key FROM identity_adoptions`,
      )
    ).map((r) => r.adoption_key)
    expect(keys.some((k) => k.includes('guest00042abc'))).toBe(false)
    expect(keys.some((k) => /^guest:[0-9a-f]{64}$/.test(k))).toBe(true)
  })

  it('keeps the guest character when every slot is taken, and does nothing without one', async () => {
    const store = await openTestStore()
    await store.players.upsertMany([
      player('a0', SUBJECT, 0),
      player('a1', SUBJECT, 1),
      player('a2', SUBJECT, 2),
      player('g1', 'guestfull01', 0),
    ])
    expect(await store.identity.adoptGuestCharacter('guestfull01', SUBJECT, 1)).toEqual({
      moved: 0,
      slot: null,
      full: true,
    })
    expect((await store.players.listByToken('guestfull01')).length).toBe(1)
    expect(await store.identity.adoptGuestCharacter('nobodyhere01', SUBJECT, 1)).toEqual({
      moved: 0,
      slot: null,
      full: false,
    })
  })
})

describe('account merge (ADR-029)', () => {
  const FROM = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2F8'
  it('moves the folded-in characters into free slots, keeps what does not fit, once per merge', async () => {
    const store = await openTestStore()
    // The survivor has slot 0; the folded-in account has slots 0, 1 and 2.
    await store.players.upsertMany([
      player('s0', SUBJECT, 0),
      player('f0', FROM, 0),
      player('f1', FROM, 1),
      player('f2', FROM, 2),
    ])
    expect(
      await store.identity.mergeSubject(FROM, SUBJECT, 'mrg_01J8Z3Q4R5S6T7V8W9X0Y1Z2G9', 5),
    ).toEqual({ moved: 2, kept: 1, already: false })
    expect(
      (await store.players.listByToken(SUBJECT)).map((p) => [p.id, p.charSlot]).sort(),
    ).toEqual([
      ['f1', 1],
      ['f2', 2],
      ['s0', 0],
    ])
    expect((await store.players.listByToken(FROM)).map((p) => p.id)).toEqual(['f0'])
    expect(
      await store.identity.mergeSubject(FROM, SUBJECT, 'mrg_01J8Z3Q4R5S6T7V8W9X0Y1Z2G9', 6),
    ).toEqual({ moved: 0, kept: 0, already: true })
    expect((await store.players.listByToken(FROM)).length).toBe(1)
  })
})

describe('account export and deletion (ADR-033)', () => {
  const ALIAS = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2F8'
  it("exports the subject's characters without the account key, then erases them and the alias's; structures stay unowned", async () => {
    const store = await openTestStore()
    await store.players.upsertMany([
      player('d0', SUBJECT, 0),
      player('d1', ALIAS, 0),
      player('o0', OTHER, 0),
    ])
    for (const [id, owner] of [
      ['e1', 'd0'],
      ['e2', 'o0'],
    ] as const) {
      await store.db.exec(sql`
        INSERT INTO world_entities (place_id, id, kind, def_id, owner_id, pos_x, pos_y, pos_z, rot_x, rot_y, rot_z, rot_w, motion, state, updated_at)
        VALUES (${store.placeId}, ${id}, 'structure', 'hut', ${owner}, 0, 0, 0, 0, 0, 0, 1, 'static', '{}'::jsonb, 1)
      `)
    }
    await store.db.exec(sql`
      INSERT INTO identity_adoptions (adoption_key, subject_id, source, adopted_at)
      VALUES ('merge:mrg_01J8Z3Q4R5S6T7V8W9X0Y1Z2G9', ${SUBJECT}, 'merge', 1)
    `)
    const out = await store.identity.exportSubject(SUBJECT)
    expect(out.characters.map((c) => c.id)).toEqual(['d0'])
    expect(out.characters[0]).not.toHaveProperty('token')
    expect(out.characters[0]).not.toHaveProperty('account_key')
    expect(out.characters[0]?.skills).toEqual({ woodcutting: 10 })
    expect(out.structures.map((e) => e.id)).toEqual(['e1'])
    expect(await store.identity.eraseSubjects([SUBJECT, ALIAS])).toEqual({
      characters: 2,
      structures_unowned: 1,
      identity_rows: 1,
    })
    expect(await store.players.listByToken(SUBJECT)).toEqual([])
    expect(await store.players.listByToken(ALIAS)).toEqual([])
    expect((await store.players.listByToken(OTHER)).map((p) => p.id)).toEqual(['o0'])
    expect(
      await store.db.many<{ id: string; owner_id: string | null }>(
        sql`SELECT id, owner_id FROM world_entities ORDER BY id`,
      ),
    ).toEqual([
      { id: 'e1', owner_id: null },
      { id: 'e2', owner_id: 'o0' },
    ])
    expect(await store.identity.eraseSubjects([SUBJECT])).toEqual({
      characters: 0,
      structures_unowned: 0,
      identity_rows: 0,
    })
  })
})

describe('player subject_id', () => {
  it('keeps subject_id through ordinary saves that do not carry it', async () => {
    const store = await openTestStore()
    await store.players.upsert(player('p1', SUBJECT, 0, { subjectId: SUBJECT }))
    const loaded = (await store.players.findById('p1'))!
    const { subjectId: _drop, ...withoutSubject } = loaded
    await store.players.upsert({ ...withoutSubject, name: 'renamed' })
    expect(await store.players.findById('p1')).toMatchObject({
      name: 'renamed',
      subjectId: SUBJECT,
    })
  })
})

describe('mod repository', () => {
  it('stores installs, grants, placements and an append-only audit log', async () => {
    const store = await openTestStore()
    const id = 'mod_01JABCDEFGHJKMNPQRSTVWXYZ0'
    await store.mods.insert({
      id,
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
    await store.mods.upsertGrant({
      modId: id,
      capability: 'games.world.announce',
      grantedBy: SUBJECT,
      grantedAt: 2,
      revokedAt: null,
      revokedBy: null,
    })
    expect(await store.mods.revokeGrant(id, 'games.world.announce', SUBJECT, 3)).toBe(true)
    expect(await store.mods.revokeGrant(id, 'games.world.announce', SUBJECT, 4)).toBe(false)
    expect((await store.mods.grants(id))[0]).toMatchObject({ revokedAt: 3, revokedBy: SUBJECT })

    await store.mods.setPlacement({ modId: id, key: 'bench', entityId: 'e1', at: 5 })
    await store.mods.setPlacement({ modId: id, key: 'bench', entityId: 'e2', at: 6 })
    expect(await store.mods.placements(id)).toEqual([
      { modId: id, key: 'bench', entityId: 'e2', at: 6 },
    ])
    await store.mods.deletePlacement(id, 'bench')
    expect(await store.mods.placements(id)).toEqual([])

    await store.mods.audit({
      modId: id,
      action: 'install',
      capability: null,
      actor: SUBJECT,
      detail: null,
      at: 1,
    })
    await store.mods.audit({
      modId: id,
      action: 'grant',
      capability: 'games.world.announce',
      actor: SUBJECT,
      detail: { x: 1 },
      at: 2,
    })
    expect((await store.mods.auditLog(id, 10)).map((a) => a.action)).toEqual(['grant', 'install'])
    await store.mods.setStatus(id, 'revoked', 9)
    expect(await store.mods.get(id)).toMatchObject({
      status: 'revoked',
      updatedAt: 9,
      manifest: { a: 1 },
    })
  })
})

describe('media mirror queue', () => {
  it('queues once, schedules retries and records the Media object', async () => {
    const store = await openTestStore()
    const asset = { assetHash: 'sha256-aa', fileName: 'sha256-aa.png', mime: 'image/png', bytes: 3 }
    expect(await store.mediaMirrors.enqueue(asset, 10)).toBe(true)
    expect(await store.mediaMirrors.enqueue(asset, 11)).toBe(false)
    expect(await store.mediaMirrors.due(10, 5)).toHaveLength(1)
    await store.mediaMirrors.markFailed('sha256-aa', 'http.503: down', 100, false, 12)
    expect(await store.mediaMirrors.due(50, 5)).toHaveLength(0)
    expect(await store.mediaMirrors.due(100, 5)).toHaveLength(1)
    await store.mediaMirrors.noteObject('sha256-aa', 'med_X', 13)
    await store.mediaMirrors.markMirrored(
      'sha256-aa',
      'med_X',
      'https://openvibe.media/o/med_X',
      14,
    )
    expect(await store.mediaMirrors.get('sha256-aa')).toMatchObject({
      status: 'mirrored',
      mediaId: 'med_X',
      attempts: 2,
      lastError: null,
    })
    expect(await store.mediaMirrors.counts()).toEqual({ pending: 0, mirrored: 1, failed: 0 })
  })
})

describe('store transactions', () => {
  it('rolls back every repository write together', async () => {
    const store = await openTestStore()
    await expect(
      store.transaction(async () => {
        await store.players.upsert(player('p1', SUBJECT, 0))
        await store.meta.set('env_time', '0.5')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await store.players.findById('p1')).toBeNull()
    expect(await store.meta.get('env_time')).toBeNull()
  })
})
