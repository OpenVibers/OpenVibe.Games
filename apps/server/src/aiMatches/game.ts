import { createRng } from '@openvibe/shared'
import { heroStats, simulate, vibeHeroes, type BattleLog } from '@openvibe/casual'

export interface Offer { provider: string; model: string }
export interface Usage { costUsd: number; tokens: number; ms: number; illegalMoves: number }
export interface AiAnswer { text: string; costUsd?: number; tokens?: number; ms?: number; runId?: string }
export type Generate = (offer: Offer, prompt: string) => Promise<AiAnswer>
export interface Move { side: 0 | 1; hero: string; legal: string[]; error: boolean; runId?: string }
export interface GameResult { seed: number; first: 0 | 1; moves: Move[]; teams: [string[], string[]]; winner: 0 | 1; battle: BattleLog; usage: [Usage, Usage] }
export interface MatchResult { id: string; game: 'vibe-heroes-draft'; offers: [Offer, Offer]; games: GameResult[]; usage: [Usage, Usage]; wins: [number, number] }

const pack = vibeHeroes
const heroes = pack.heroes
const names = new Map(heroes.map((h) => [h.id, h]))
const empty = (): Usage => ({ costUsd: 0, tokens: 0, ms: 0, illegalMoves: 0 })

/** A bare id or a JSON object with one move field; prose is not a move. */
export function parseMove(answer: string, legal: readonly string[]): string | null {
  const trimmed = answer.trim()
  let candidate: unknown = trimmed
  if (trimmed.startsWith('{')) {
    try { candidate = (JSON.parse(trimmed) as { move?: unknown }).move } catch { return null }
  }
  return typeof candidate === 'string' && legal.includes(candidate) ? candidate : null
}

export function promptForPick(teams: [string[], string[]], side: 0 | 1, legal: string[]): string {
  const roster = legal.map((id) => {
    const h = names.get(id)!
    return `${id}: ${h.class}, ${h.element}, ${h.rarity}, skill ${h.skill.name}`
  })
  return `Vibe Heroes draft duel. Pick one hero for your team of three. The server auto-battles after six picks.\nYour team: ${teams[side].join(', ') || '(none)'}\nOpponent: ${teams[(1 - side) as 0 | 1].join(', ') || '(none)'}\nLegal heroes:\n${roster.join('\n')}\nReply with exactly one legal hero id.`
}

export async function playMatch(id: string, offers: [Offer, Offer], count: number, generate: Generate, seed = 1): Promise<MatchResult> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('games must be 1..100')
  if (offers.some((o) => !o.provider || !o.model)) throw new Error('two pinned offers required')
  const usage: [Usage, Usage] = [empty(), empty()]
  const games: GameResult[] = []
  const wins: [number, number] = [0, 0]
  for (let g = 0; g < count; g++) {
    const gameUsage: [Usage, Usage] = [empty(), empty()]
    const first = (g % 2) as 0 | 1
    const teams: [string[], string[]] = [[], []]
    const moves: Move[] = []
    const available = new Set(heroes.map((h) => h.id))
    const rng = createRng(seed + g)
    for (let turn = 0; turn < 6; turn++) {
      const side = ((first + turn) % 2) as 0 | 1
      const legal = [...available]
      let answer: AiAnswer | null = null
      try { answer = await generate(offers[side], promptForPick(teams, side, legal)) } catch { /* fallback */ }
      const parsed = answer ? parseMove(answer.text, legal) : null
      const error = parsed === null
      const hero = parsed ?? legal[rng.int(0, legal.length - 1)]!
      if (error) { usage[side].illegalMoves++; gameUsage[side].illegalMoves++ }
      if (answer) {
        usage[side].costUsd += answer.costUsd ?? 0
        usage[side].tokens += answer.tokens ?? 0
        usage[side].ms += answer.ms ?? 0
        gameUsage[side].costUsd += answer.costUsd ?? 0
        gameUsage[side].tokens += answer.tokens ?? 0
        gameUsage[side].ms += answer.ms ?? 0
      }
      teams[side].push(hero)
      available.delete(hero)
      moves.push({ side, hero, legal, error, ...(answer?.runId ? { runId: answer.runId } : {}) })
    }
    const units = (side: 0 | 1) => teams[side].map((id) => {
      const h = names.get(id)!
      return { id, cls: h.class, element: h.element, power: h.skill.power, stats: heroStats(pack, h, { level: 20, stars: 3, gear: {} }) }
    })
    const battle = simulate(units(first), units((1 - first) as 0 | 1), createRng(seed + g + 100_000))
    const winner = (battle.won ? first : 1 - first) as 0 | 1
    wins[winner]++
    games.push({ seed: seed + g, first, moves, teams, winner, battle, usage: gameUsage })
  }
  return { id, game: 'vibe-heroes-draft', offers, games, usage, wins }
}
