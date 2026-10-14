/**
 * The casual API from the page. Actions go one at a time, each under a fresh idempotency key that a retry reuses,
 * so a dropped answer on a phone network never applies a tap twice.
 */
import type { Action, PlayerState } from '@openvibe/casual'

export interface Player {
  signedIn: boolean
  name: string | null
}

export interface SessionAnswer {
  state: PlayerState
  version: number
  created: boolean
  now: number
  digest: string
  player: Player
}

export interface ActionAnswer {
  state: PlayerState
  version: number
  result: Record<string, unknown>
  now: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

export class CasualApi {
  /** Server clock minus this device's clock, so countdowns match the server's resets. */
  offset = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly game: string,
    readonly digest: string,
    private identity: { guest: string; bearer: string | undefined },
  ) {}

  now(): number {
    return Date.now() + this.offset
  }

  dropBearer(): void {
    this.identity.bearer = undefined
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { 'x-guest-token': this.identity.guest }
    if (this.identity.bearer) h.authorization = `Bearer ${this.identity.bearer}`
    if (json) {
      h['content-type'] = 'application/json'
      h['x-casual-digest'] = this.digest
    }
    return h
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await wait(attempt * 900)
      let r: Response
      try {
        r = await fetch(`/api/v1/casual/${this.game}/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: this.headers(body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: 'same-origin',
        })
      } catch (err) {
        lastError = err
        continue
      }
      const data = (await r.json().catch(() => ({}))) as Record<string, unknown>
      if (r.ok) return data as T
      if (r.status === 503 && attempt < 2) {
        lastError = new ApiError(503, 'unavailable', String(data.message ?? 'Busy'))
        continue
      }
      throw new ApiError(
        r.status,
        String(data.error ?? 'error'),
        String(data.message ?? 'Something went wrong. Try again.'),
      )
    }
    throw lastError instanceof ApiError
      ? lastError
      : new ApiError(0, 'offline', 'No connection. Check your signal and try again.')
  }

  async session(src: string | null, campaign: string | null): Promise<SessionAnswer> {
    const before = Date.now()
    const answer = await this.request<SessionAnswer>('session', {
      ...(src ? { src } : {}),
      ...(campaign ? { c: campaign } : {}),
    })
    this.offset = answer.now - Math.round((before + Date.now()) / 2)
    return answer
  }

  act(action: Action): Promise<ActionAnswer> {
    const key = crypto.randomUUID()
    const run = this.queue.then(() => this.request<ActionAnswer>('actions', { key, action }))
    this.queue = run.catch(() => undefined)
    return run
  }

  leaderboard(): Promise<{
    entries: { rank: number; name: string; stage: number; power: number }[]
  }> {
    return this.request('leaderboard')
  }

  ledger(before: number | null): Promise<{
    lines: {
      id: number
      asset: string
      delta: number
      balance: number
      reason: string
      at: number
    }[]
    next: number | null
  }> {
    return this.request(`ledger${before ? `?before=${before}` : ''}`)
  }
}
