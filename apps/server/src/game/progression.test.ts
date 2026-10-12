import { describe, expect, it } from 'vitest'
import { openTestDb, openTestStore } from '@openvibe/persistence/testing'
import { accountKey } from '@openvibe/persistence'
import {
  earnedAchievements,
  leaderboard,
  playerAchievements,
  recordJoined,
  recordRound,
} from './progression.js'

describe('game progression', () => {
  it('unlocks Scraplandia first visit once from a server join', async () => {
    const db = await openTestDb()
    const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
    await recordJoined(db, subject, 100)
    await recordJoined(db, subject, 200)
    expect((await playerAchievements(db, subject))[0]?.achievements).toMatchObject([
      { id: 'first-visit', unlockedAt: 100 },
    ])
  })

  it('erases a signed-in subject from game progression with account data', async () => {
    const store = await openTestStore()
    const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
    await recordJoined(store.db, subject, 100)
    await recordRound(
      store.db,
      'salvage-rush',
      'erase-round',
      [{ key: subject, name: 'Member', score: 3, rank: 1 }],
      200,
    )
    const exported = await store.identity.exportSubject(subject)
    expect(exported.gameResults).toHaveLength(1)
    expect(exported.gameBestScores).toHaveLength(1)
    expect(exported.gameAchievements).toHaveLength(3)
    await store.identity.eraseSubjects([subject])
    expect((await playerAchievements(store.db, subject))[0]?.achievements[0]?.unlockedAt).toBeNull()
    expect((await leaderboard(store.db, 'salvage-rush', 'all', 1, 300)).entries).toEqual([])
  })

  it('moves guest scores and unlocks to the subject when its character is adopted', async () => {
    const store = await openTestStore()
    const guest = 'guest-test-key'
    const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
    await store.players.upsert({
      id: 'guest-character',
      token: guest,
      name: 'Guest',
      pos: [0, 1, 0],
      yaw: 0,
      inventory: { size: 24, hotbar: 6, slots: [] },
      skills: {},
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
    await recordRound(
      store.db,
      'salvage-rush',
      'guest-round',
      [{ key: guest, name: 'Guest', score: 3, rank: 1 }],
      100,
    )
    expect((await store.identity.adoptGuestCharacter(guest, subject, 200)).moved).toBe(1)
    expect((await leaderboard(store.db, 'salvage-rush', 'all', 1, 300)).entries[0]?.score).toBe(3)
    expect(
      (await playerAchievements(store.db, subject))[1]?.achievements.filter((a) => a.unlockedAt),
    ).toHaveLength(2)
    expect(
      (await playerAchievements(store.db, guest))[1]?.achievements.filter((a) => a.unlockedAt),
    ).toHaveLength(0)
  })
  it('unlocks criteria once and keys guests separately from subjects', async () => {
    const db = await openTestDb()
    const now = 2_000_000_000_000
    const guest = 'guest-test-key'
    const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
    expect(
      earnedAchievements('salvage-rush', { key: guest, name: 'Guest', score: 5, rank: 1 }),
    ).toEqual(['first-haul', 'big-haul', 'arena-winner'])
    await recordRound(
      db,
      'salvage-rush',
      'r1',
      [
        { key: guest, name: 'Guest', score: 5, rank: 1 },
        { key: subject, name: 'Member', score: 1, rank: 2 },
      ],
      now,
    )
    await recordRound(
      db,
      'salvage-rush',
      'r1',
      [{ key: guest, name: 'Guest', score: 5, rank: 1 }],
      now,
    )
    const guestUnlocks = (await playerAchievements(db, guest))[1]?.achievements.filter(
      (a) => a.unlockedAt,
    )
    const memberUnlocks = (await playerAchievements(db, subject))[1]?.achievements.filter(
      (a) => a.unlockedAt,
    )
    expect(guestUnlocks?.map((a) => a.id)).toEqual(['first-haul', 'big-haul', 'arena-winner'])
    expect(memberUnlocks?.map((a) => a.id)).toEqual(['first-haul'])
    expect(accountKey(guest)).toMatch(/^guest:[0-9a-f]{64}$/)
    expect(accountKey(subject)).toBe(subject)
  })

  it('orders personal bests and filters this week', async () => {
    const db = await openTestDb()
    const now = Date.UTC(2026, 9, 11, 12) // Sunday
    await recordRound(
      db,
      'salvage-rush',
      'old',
      [{ key: 'a', name: 'A', score: 10, rank: 1 }],
      Date.UTC(2026, 9, 4, 23, 59), // previous Sunday, within seven days but outside this week
    )
    await recordRound(
      db,
      'salvage-rush',
      'new',
      [
        { key: 'a', name: 'A', score: 2, rank: 2 },
        { key: 'b', name: 'B', score: 5, rank: 1 },
      ],
      now,
    )
    expect(
      (await leaderboard(db, 'salvage-rush', 'all', 1, now)).entries.map((e) => e.score),
    ).toEqual([10, 5])
    expect(
      (await leaderboard(db, 'salvage-rush', 'week', 1, now)).entries.map((e) => e.score),
    ).toEqual([5, 2])
    expect((await leaderboard(db, 'salvage-rush', 'all', 2, now)).entries).toEqual([])
  })
})
