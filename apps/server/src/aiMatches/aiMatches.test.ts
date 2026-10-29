import { describe, expect, it } from 'vitest'
import type { BenchClient } from 'openvibe-sdk/bench'
import { openTestDb } from '@openvibe/persistence/testing'
import { parseMove, playMatch, type Offer } from './game.js'
import { createAiGenerate, submitMatch } from './services.js'
import type { PlatformClient } from '../platform/serviceClient.js'
import { reserveMatch, runMatchJob } from './job.js'

const offers: [Offer, Offer] = [{ provider: 'a', model: 'alpha' }, { provider: 'b', model: 'beta' }]

describe('AI match', () => {
  it('sends a pinned offer and reads the AI run usage shape', async () => {
    const platform = { tokens: { getToken: async () => 'test-token' } } as unknown as PlatformClient
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ run: {
        id: 'run-1', status: 'succeeded', output: { text: 'hero_a' },
        provenance: { provider: 'a', model: 'alpha' },
        usage: { tokens_in: 4, tokens_out: 2, cost_usd: 0.01 },
      } }), { status: 201 })
    }
    const result = await createAiGenerate(platform, 'https://ai.example', fetchImpl as typeof fetch)(offers[0], 'Pick a hero')
    expect(calls[0]).toMatchObject({ url: 'https://ai.example/api/v1/generate?wait=60000', body: { route: offers[0], prompt: 'Pick a hero' } })
    expect(result).toMatchObject({ text: 'hero_a', tokens: 6, costUsd: 0.01, runId: 'run-1' })
  })

  it('accepts only an exact legal move', () => {
    expect(parseMove('hero_a', ['hero_a'])).toBe('hero_a')
    expect(parseMove('{"move":"hero_a"}', ['hero_a'])).toBe('hero_a')
    expect(parseMove('I choose hero_a', ['hero_a'])).toBeNull()
    expect(parseMove('hero_b', ['hero_a'])).toBeNull()
  })

  it('finishes with fake AI, alternates sides and records fallbacks', async () => {
    const match = await playMatch('match-1', offers, 2, async (offer, prompt) => {
      const legal = prompt.split('Legal heroes:\n')[1]!.split('\nReply')[0]!.split('\n').map((line) => line.split(':')[0]!)
      return { text: offer.model === 'beta' ? 'invalid' : legal[0]!, costUsd: 0.01, tokens: 3, ms: 10 }
    }, 44)
    expect(match.games).toHaveLength(2)
    expect(match.games.map((g) => g.first)).toEqual([0, 1])
    expect(match.games.every((g) => g.moves.length === 6 && g.battle.events.length > 0)).toBe(true)
    expect(match.usage[1].illegalMoves).toBe(6)
    expect(match.usage[0].illegalMoves).toBe(0)
    expect(match.wins[0] + match.wins[1]).toBe(2)
    expect(match.games.every((g) => new Set(g.moves.map((m) => m.hero)).size === 6)).toBe(true)
  })

  it('submits two entries and a game_outcome judgement per game plus a fun pair', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    let next = 0
    const fake = {
      tasks: { create: async (...args: unknown[]) => { calls.push({ method: 'task', args }); return { task: { id: `task-${++next}` } } } },
      rounds: { create: async (...args: unknown[]) => { calls.push({ method: 'round', args }); return { round: { id: `round-${++next}` } } } },
      entries: { submit: async (...args: unknown[]) => { calls.push({ method: 'entry', args }); return { entry: { id: `entry-${++next}` } } } },
      judgements: { cast: async (...args: unknown[]) => { calls.push({ method: 'judge', args }); return {} } },
    } as unknown as BenchClient
    const match = await playMatch('match-2', offers, 2, async (_offer, prompt) => ({ text: prompt.split('Legal heroes:\n')[1]!.split(':')[0]! }), 12)
    const receipt = await submitMatch(fake, match, 'https://openvibe.games')
    expect(receipt.rounds).toHaveLength(2)
    expect(receipt.funEntries).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'entry')).toHaveLength(6)
    const entries = calls.filter((c) => c.method === 'entry')
    expect(entries[0]!.args[1]).toMatchObject({ provider: 'a', model: 'alpha', payload: { result: { replay_url: 'https://openvibe.games/ai-matches/match-2/games/1?side=0' } } })
    expect(calls.filter((c) => c.method === 'judge')).toHaveLength(2)
    expect(calls.find((c) => c.method === 'judge')!.args[1]).toMatchObject({ kind_id: 'games.match', judge: 'game_outcome', pair: { left: expect.any(String), right: expect.any(String) } })
  })

  it('keeps the job off and enforces the UTC daily match cap', async () => {
    const db = await openTestDb()
    const fake = {} as BenchClient
    const noRun = await runMatchJob(db, fake, async () => { throw new Error('must not call AI') }, { enabled: false, dailyCap: 1, gamesPerMatch: 1, offers, publicBase: 'https://openvibe.games' })
    expect(noRun).toBeNull()
    expect(await reserveMatch(db, 1, 'cap-test-1')).toBe('cap-test-1')
    expect(await reserveMatch(db, 1, 'cap-test-2')).toBeNull()
  })
})
