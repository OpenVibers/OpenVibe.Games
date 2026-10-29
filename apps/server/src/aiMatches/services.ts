import { createClient } from 'openvibe-sdk/core'
import { createBenchClient, type BenchClient } from 'openvibe-sdk/bench'
import type { PlatformClient } from '../platform/serviceClient.js'
import type { AiAnswer, Generate, MatchResult, Offer } from './game.js'

export function createBench(platform: PlatformClient, url: string): BenchClient {
  return createBenchClient(createClient({
    network: url,
    baseUrls: { bench: url },
    tokenProvider: platform.tokens,
    autoDiscover: false,
    retries: 0,
  }), { baseUrl: url })
}

const textOf = (output: unknown): string => {
  if (typeof output === 'string') return output
  if (!output || typeof output !== 'object') return ''
  const o = output as Record<string, unknown>
  for (const key of ['text', 'content', 'body']) if (typeof o[key] === 'string') return o[key]
  return ''
}

/** OpenVibe.AI generate, pinned to the offered route for every move. */
export function createAiGenerate(platform: PlatformClient, url: string, fetchImpl: typeof fetch = fetch): Generate {
  return async (offer: Offer, prompt: string): Promise<AiAnswer> => {
    const started = Date.now()
    const token = await platform.tokens.getToken({ audience: 'openvibe.ai', scope: 'ai.run.create' })
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/generate?wait=60000`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, system: 'Choose one legal Vibe Heroes draft move. Reply with its id only.', route: offer, max_tokens: 30, temperature: 0, options: { cache: false } }),
      signal: AbortSignal.timeout(70_000),
    })
    if (!response.ok) throw new Error(`AI status ${response.status}`)
    const body = await response.json() as { run?: Record<string, unknown> }
    let run = body.run
    const deadline = Date.now() + 70_000
    while (run && (run.status === 'queued' || run.status === 'running') && Date.now() < deadline) {
      if (typeof run.id !== 'string') break
      await new Promise((resolve) => setTimeout(resolve, 500))
      const poll = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/runs/${encodeURIComponent(run.id)}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      })
      if (!poll.ok) throw new Error(`AI poll status ${poll.status}`)
      run = ((await poll.json()) as { run?: Record<string, unknown> }).run
    }
    if (!run || !['succeeded', 'cached', 'completed', 'ok'].includes(String(run.status))) throw new Error('AI run unfinished')
    const provenance = (run.provenance ?? {}) as Record<string, unknown>
    if (provenance.provider !== offer.provider || provenance.model !== offer.model) throw new Error('AI route changed')
    const usage = (run.usage ?? {}) as Record<string, unknown>
    return {
      text: textOf(run.output),
      costUsd: Number(usage.cost_usd ?? 0),
      tokens: Number(usage.tokens_in ?? 0) + Number(usage.tokens_out ?? 0),
      ms: Date.now() - started,
      ...(typeof run.id === 'string' ? { runId: run.id } : {}),
    }
  }
}

/** Two model entries share one pooled games.match judgement per individual game. */
export async function submitMatch(bench: BenchClient, match: MatchResult, publicBase: string): Promise<{ rounds: string[]; funRound: string; funEntries: [string, string] }> {
  const task = (await bench.tasks.create('games.match', {
    prompt: 'Vibe Heroes draft duel: alternate three hero picks, then resolve the auto-battle.',
    task_class: match.game,
    public: true,
  })).task
  const rounds: string[] = []
  for (let index = 0; index < match.games.length; index++) {
    const game = match.games[index]!
    const round = (await bench.rounds.create(task.id, { offers: match.offers, seed: game.seed })).round
    const entries = []
    for (const side of [0, 1] as const) {
      const offer = match.offers[side]
      const u = game.usage[side]
      entries.push((await bench.entries.submit(round.id, {
        ...offer,
        route: { provider: offer.provider, model: offer.model },
        payload: { result: { game: match.game, winner: game.winner, side, replay_url: `${publicBase}/ai-matches/${match.id}/games/${index + 1}?side=${side}`, moves: game.moves.filter((m) => m.side === side), illegal_moves: u.illegalMoves } },
        cost_usd: u.costUsd,
        tokens: u.tokens,
        ms: u.ms,
      })).entry)
    }
    await bench.judgements.cast(round.id, { kind_id: 'games.match', judge: 'game_outcome', pair: { left: entries[0]!.id, right: entries[1]!.id }, outcome: game.winner === 0 ? 'left' : 'right' })
    rounds.push(round.id)
  }
  const funTask = (await bench.tasks.create('games.fun', { prompt: 'Which Vibe Heroes draft replay is more fun to watch?', task_class: match.game, public: true })).task
  const funRound = (await bench.rounds.create(funTask.id, { offers: match.offers, seed: match.games[0]!.seed })).round
  const funEntries: string[] = []
  for (const side of [0, 1] as const) funEntries.push((await bench.entries.submit(funRound.id, {
    ...match.offers[side], route: { provider: match.offers[side].provider, model: match.offers[side].model },
    payload: { result: { replay_url: `${publicBase}/ai-matches/${match.id}/games/1?side=${side}`, side, game: match.game } },
  })).entry.id)
  return { rounds, funRound: funRound.id, funEntries: funEntries as [string, string] }
}
