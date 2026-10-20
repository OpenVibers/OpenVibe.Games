import { describe, expect, it } from 'vitest'
import { openTestDb, openTestStore } from '@openvibe/persistence/testing'
import { accountKey } from '@openvibe/persistence'
import { sql, type Db } from 'openvibe-sdk/db'
import {
  GameProgressWriter,
  earnedAchievements,
  earnedHaulAchievements,
  earnedMilestoneAchievements,
  playerAchievements,
  recordHaul,
  recordJoined,
  recordRound,
} from './progression.js'

// The boards are OpenVibe.Play's (platform/playBoards.ts); these read what the local tables recorded for it.
const bestScores = async (db: Db, game: string) =>
  (
    await db.many<{ account_key: string; score: number }>(
      sql`SELECT account_key, score FROM game_best_scores WHERE game_id = ${game} ORDER BY score DESC, account_key`,
    )
  ).map((row) => ({ key: row.account_key, score: Number(row.score) }))
const haulTotals = async (db: Db) =>
  (
    await db.many<{ account_key: string; total: number }>(
      sql`SELECT account_key, SUM(score) AS total FROM game_hauls GROUP BY account_key ORDER BY total DESC`,
    )
  ).map((row) => Number(row.total))

describe('game progression', () => {
  it('unlocks Scraplandia first visit once from a server join', async () => {
    const db = await openTestDb()
    const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
    await recordJoined(db, subject, 100)
    await recordJoined(db, subject, 200)
    expect(
      (await playerAchievements(db, subject))[0]?.achievements.filter((a) => a.unlockedAt),
    ).toMatchObject([{ id: 'first-visit', unlockedAt: 100 }])
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
    expect(await bestScores(store.db, 'salvage-rush')).toEqual([])
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
    expect(await bestScores(store.db, 'salvage-rush')).toEqual([
      { key: accountKey(subject), score: 3 },
    ])
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

  it("keeps each player's all-time best and every round", async () => {
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
    expect((await bestScores(db, 'salvage-rush')).map((e) => e.score)).toEqual([10, 5])
    const rounds = await db.many<{ score: number }>(
      sql`SELECT score FROM game_round_results WHERE game_id = 'salvage-rush' ORDER BY score DESC`,
    )
    expect(rounds.map((r) => Number(r.score))).toEqual([10, 5, 2])
  })

  it('unlocks Scraplandia haul achievements at their thresholds', () => {
    expect(earnedHaulAchievements(1, 1)).toEqual(['first-haul'])
    expect(earnedHaulAchievements(499, 499)).toEqual(['first-haul'])
    expect(earnedHaulAchievements(500, 500)).toEqual(['first-haul', 'big-haul'])
    expect(earnedHaulAchievements(500, 2000)).toEqual(['first-haul', 'big-haul', 'haul-week'])
  })

  it('records hauls once per extraction, never a zero-value one', async () => {
    const db = await openTestDb()
    const now = Date.UTC(2026, 9, 11, 12) // Sunday
    await recordHaul(db, 'a', 'e1', 'A', 100, now)
    await recordHaul(db, 'a', 'e2', 'A', 50, now)
    await recordHaul(db, 'a', 'e2', 'A', 999, now) // duplicate extraction id, ignored
    await recordHaul(db, 'b', 'e3', 'B', 10, Date.UTC(2026, 9, 4, 23, 59)) // previous week
    await recordHaul(db, 'c', 'e4', 'C', 0, now) // zero-value, not recorded
    expect(await haulTotals(db)).toEqual([150, 10])
  })

  it('unlocks haul achievements after a recorded haul', async () => {
    const db = await openTestDb()
    const now = Date.UTC(2026, 9, 11, 12)
    await recordHaul(db, 'guest-test-key', 'e1', 'Guest', 500, now)
    await recordHaul(db, 'guest-test-key', 'e2', 'Guest', 2000, now)
    const unlocks = (await playerAchievements(db, 'guest-test-key'))[0]?.achievements.filter(
      (a) => a.unlockedAt,
    )
    expect(unlocks?.map((a) => a.id)).toEqual(['first-haul', 'big-haul', 'haul-week'])
  })

  it('earns the after-the-haul achievements from milestones', () => {
    expect(earnedMilestoneAchievements({ event: 'contract_completed' })).toEqual(['first-contract'])
    expect(earnedMilestoneAchievements({ event: 'crop_harvested' })).toEqual(['green-thumb'])
    expect(
      earnedMilestoneAchievements({ event: 'skill_level', skill: 'mining', level: 4 }),
    ).toEqual([])
    expect(
      earnedMilestoneAchievements({ event: 'skill_level', skill: 'mining', level: 5 }),
    ).toEqual(['journeyman'])
    expect(
      earnedMilestoneAchievements({ event: 'skill_level', skill: 'farming', level: 10 }),
    ).toEqual(['journeyman', 'old-hand'])
  })

  it('records milestone unlocks once per account through the writer', async () => {
    const db = await openTestDb()
    const committed: string[] = []
    const writer = new GameProgressWriter(
      db,
      (error) => {
        throw error
      },
      (subject) => committed.push(subject),
    )
    const subject = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'
    writer.submitMilestone(subject, { event: 'contract_completed' })
    writer.submitMilestone(subject, { event: 'contract_completed' })
    writer.submitMilestone(subject, { event: 'skill_level', skill: 'woodcutting', level: 3 }) // earns nothing
    writer.submitMilestone(subject, { event: 'skill_level', skill: 'woodcutting', level: 5 })
    await writer.stop()
    const unlocked = (await playerAchievements(db, subject))[0]?.achievements.filter(
      (a) => a.unlockedAt,
    )
    expect(unlocked?.map((a) => a.id).sort()).toEqual(['first-contract', 'journeyman'])
    expect(committed.length).toBeGreaterThan(0)
  })
})
