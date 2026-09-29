/**
 * Per-actor limits on the HTTP writes that are capability boundaries (roadmap WS-R task 4; openvibe-sdk/limits):
 * editor map saves and asset uploads (an editor key or a staff Network token) and the mods API (staff or a service
 * holding games.mod.manage). Gameplay is the WebSocket, which has its own per-socket flood control (wsTransport.ts).
 *
 * Counted after the caller is authorised, before the body is read. Past a limit: 429 problem+json `rate_limited`
 * with Retry-After. The actor is a hash of the editor credential (never the credential) or the mod actor's audit id.
 * Numbers per minute / per hour; GAMES_LIMITS_MINUTE / GAMES_LIMITS_HOUR set the defaults (120 / 3000).
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createActorLimiter, createValkeyLimitStore } from 'openvibe-sdk/limits'
import type { Valkey } from 'openvibe-sdk/valkey'

type Req = IncomingMessage & { ovActor?: string }
const num = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : d
}

export function createGamesActorLimits(
  opts: {
    env?: NodeJS.ProcessEnv
    now?: () => number
    onLimited?: (name: string, actor: string) => void
    /** Shared Valkey: one actor counts the same across every instance; null = in-process counters. */
    valkey?: Valkey | null
  } = {},
) {
  const env = opts.env ?? process.env
  const store = opts.valkey ? createValkeyLimitStore(opts.valkey) : null
  const limiter = createActorLimiter({
    limits: { minute: num(env.GAMES_LIMITS_MINUTE, 120), hour: num(env.GAMES_LIMITS_HOUR, 3000) },
    actor: (req) => (req as Req).ovActor ?? null,
    ...(opts.now ? { now: opts.now } : {}),
    ...(store ? { store } : {}),
    onLimited: (e) => opts.onLimited?.(e.name, e.actor),
  })
  // A map save validates and migrates the whole map and swaps it live; an asset is hashed and stored on disk.
  const mapSave = limiter('games.map.save', { minute: 30, hour: 600 })
  const asset = limiter('games.map.asset', { minute: 60, hour: 1200 })
  // Mod installs, grants and revokes each ask OpenVibe.Network first.
  const modWrite = limiter('games.mod.write', { minute: 30, hour: 300 })
  const run =
    (mw: ReturnType<typeof limiter>) =>
    (req: IncomingMessage, res: ServerResponse, actor: string): Promise<boolean> =>
      new Promise((resolve) => {
        ;(req as Req).ovActor = actor
        mw(req, res, () => resolve(true))
        if (res.writableEnded || res.headersSent) resolve(false)
      })
  return {
    /** An editor credential as an actor id: a short hash, never the credential. */
    editorActor: (token: string): string =>
      `editor:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`,
    /** true = go on; false = refused (the 429 was sent). */
    mapSave: run(mapSave),
    asset: run(asset),
    modWrite: run(modWrite),
  }
}

export type GamesActorLimits = ReturnType<typeof createGamesActorLimits>
