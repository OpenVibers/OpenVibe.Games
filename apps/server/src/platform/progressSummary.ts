/**
 * games.progress.summary on OpenVibe.Network (openvibe-contracts user-module namespace, roadmap WS-B
 * task 9): a public summary of a signed-in person's progress, for other sites. The characters and
 * their inventories stay Games' truth.
 *
 *   level        the best total skill level among the person's characters
 *   playtime_hours  accumulated from sessions (joined → left), one decimal
 *   last_world   the world they last played
 *
 * Scraplandia has no achievement system, so `achievements` is never written (an existing value is kept).
 * Written when a character leaves, as the owning service (grant games network.modules.write on
 * games.progress.summary), read-modify-write through openvibe-sdk/modules (412 → read again). Guests
 * (gst_) and local players have no record. Network being down only logs: the next session catches up.
 */
import { createModulesClient } from 'openvibe-sdk/modules'
import type { OpenVibeClient } from 'openvibe-sdk/core'

export const NAMESPACE = 'games.progress.summary'
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/

export interface ProgressSummary {
  level?: number
  achievements?: number
  playtime_hours?: number
  last_world?: string
}

export interface SessionOutcome {
  levels: Record<string, number>
  sessionSeconds: number
  world: string
}

/** The next record from the one stored and a finished session. */
export function mergeSummary(
  prev: ProgressSummary | undefined,
  s: SessionOutcome,
): ProgressSummary {
  const total = Object.values(s.levels).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  const hours = (prev?.playtime_hours ?? 0) + Math.max(0, s.sessionSeconds) / 3600
  const out: ProgressSummary = {
    level: Math.max(prev?.level ?? 0, Math.floor(total)),
    playtime_hours: Math.round(hours * 10) / 10,
    last_world: s.world.slice(0, 120),
  }
  if (typeof prev?.achievements === 'number') out.achievements = prev.achievements
  return out
}

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void
}

export class ProgressSummaryWriter {
  private readonly joined = new Map<string, number>()
  private readonly modules: ReturnType<typeof createModulesClient>['forSubject']
  private inflight = 0

  constructor(
    client: OpenVibeClient,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {
    this.modules = createModulesClient(client).forSubject
  }

  /** A character entered the world (its session starts counting). */
  playerJoined(playerId: string): void {
    this.joined.set(playerId, this.now())
  }

  /** A character left: fold the session into the person's summary. Resolves when written (or given up). */
  playerLeft(
    playerId: string,
    subjectId: string | null,
    levels: Record<string, number>,
    world: string,
  ): Promise<void> {
    const since = this.joined.get(playerId)
    this.joined.delete(playerId)
    if (!subjectId || !USER_SUBJECT.test(subjectId)) return Promise.resolve()
    const outcome: SessionOutcome = {
      levels,
      world,
      sessionSeconds: since === undefined ? 0 : (this.now() - since) / 1000,
    }
    this.inflight++
    return this.modules
      .update(NAMESPACE, subjectId, (prev: ProgressSummary | undefined) =>
        mergeSummary(prev, outcome),
      )
      .then(() => undefined)
      .catch((err: unknown) => {
        this.log.warn('progress summary not written', {
          subject: subjectId,
          error: String((err as Error)?.message ?? err),
        })
      })
      .finally(() => {
        this.inflight--
      })
  }

  pending(): number {
    return this.inflight
  }
}
