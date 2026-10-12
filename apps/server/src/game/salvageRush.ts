import type { ContentPackV2 } from '@openvibe/content'

export interface RoundPlayer {
  key: string
  name: string
  pos: readonly [number, number, number]
}
export interface RoundResult {
  key: string
  name: string
  score: number
  rank: number
}
export interface RoundView {
  roundId: string
  phase: 'intermission' | 'active'
  endsAt: number
  pickups: { x: number; z: number; available: boolean }[]
  scores: Pick<RoundResult, 'name' | 'score' | 'rank'>[]
}

/** Server-only arena rules. Positions come from movement simulation, never a score intent. */
export class SalvageRushRound {
  private phase: RoundView['phase'] = 'intermission'
  private endsAt: number
  private round = 0
  private scores = new Map<string, { name: string; score: number }>()
  private available: boolean[]
  private respawnAt: number[]
  private roundId = ''
  constructor(
    private readonly rules: NonNullable<ContentPackV2['game']>,
    now: number,
  ) {
    this.endsAt = now + rules.intermissionSeconds * 1000
    this.available = rules.pickups.map(() => true)
    this.respawnAt = rules.pickups.map(() => 0)
  }

  tick(now: number, players: readonly RoundPlayer[]): RoundResult[] | null {
    if (now >= this.endsAt) {
      if (this.phase === 'active') {
        const results = this.results()
        this.phase = 'intermission'
        this.endsAt = now + this.rules.intermissionSeconds * 1000
        return results
      }
      this.round++
      this.roundId = `${now}-${this.round}`
      this.phase = 'active'
      this.endsAt = now + this.rules.roundSeconds * 1000
      this.scores = new Map(players.map((p) => [p.key, { name: p.name, score: 0 }]))
      this.available.fill(true)
      this.respawnAt.fill(0)
    }
    if (this.phase !== 'active') return null
    for (let i = 0; i < this.rules.pickups.length; i++) {
      if (!this.available[i] && now >= (this.respawnAt[i] ?? 0)) this.available[i] = true
      if (!this.available[i]) continue
      const point = this.rules.pickups[i]!
      // Stable order gives a deterministic winner if two capsules overlap a pickup in one tick.
      const collector = [...players]
        .sort((a, b) => a.key.localeCompare(b.key))
        .find((p) => {
          const dx = p.pos[0] - point[0]
          const dz = p.pos[2] - point[2]
          return dx * dx + dz * dz <= 2.25 && Math.abs(p.pos[1] - point[1]) <= 2
        })
      if (!collector) continue
      const score = this.scores.get(collector.key) ?? { name: collector.name, score: 0 }
      score.score++
      this.scores.set(collector.key, score)
      this.available[i] = false
      this.respawnAt[i] = now + 8_000
    }
    return null
  }

  view(): RoundView {
    return {
      roundId: this.roundId,
      phase: this.phase,
      endsAt: this.endsAt,
      pickups: this.rules.pickups.map((p, i) => ({
        x: p[0],
        z: p[2],
        available: this.available[i] ?? false,
      })),
      scores: this.results().map(({ name, score, rank }) => ({ name, score, rank })),
    }
  }

  private results(): RoundResult[] {
    const sorted = [...this.scores]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    return sorted.map((p) => ({
      ...p,
      rank: sorted.findIndex((v) => v.score === p.score) + 1,
    }))
  }
}
