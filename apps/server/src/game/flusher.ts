import type {
  ConstraintDto,
  PersistenceStore,
  PlayerDto,
  WorldEntityDto,
} from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { ServerMetrics } from '../observability/metrics.js'
import type { EventPlayer, GameEventRecorder, ProgressSnapshot } from '../platform/gameEvents.js'
import type { PlayerSession } from './playerSession.js'

/**
 * The write-behind flusher (ADR-0007 decision 5). The tick never awaits I/O: it takes a
 * copy-on-write snapshot of the dirty rows (clearing the flags as it copies) and hands it here, then
 * carries on. One serialized queue per instance runs at most one database transaction at a time.
 *
 *   checkpoint(build)   called on the tick; if a checkpoint is already queued or running the new one
 *                       is coalesced — `build` is never called, so the dirty flags stay set and the
 *                       next checkpoint carries those rows. `{ final: true }` (shutdown) is never
 *                       coalesced: behind an in-flight checkpoint it is queued and built when it runs
 *                       (the tick has stopped, so building later sees the same state).
 *   savePlayer(payload) a disconnect save, always queued, so it lands after an earlier checkpoint of
 *                       the same character. A failure is retried in place with backoff (the session is
 *                       gone, so there is no dirty flag to restore) unless the character came back.
 *   drain(timeout)      resolves when the queue is empty, or false at the deadline (shutdown, and a
 *                       returning player's sign-in, so it reads its own last save).
 *
 * A failed transaction restores the snapshot's dirtiness (`payload.restore`): nothing is lost
 * silently, the failure is logged and counted, and the next checkpoint retries.
 */
export interface FlushCharacter {
  session: PlayerSession
  dto: PlayerDto
  player: EventPlayer
  progress: ProgressSnapshot
}

export interface FlushPayload {
  reason: 'checkpoint' | 'shutdown'
  /** A disconnect save also records games.player.left in the same transaction. */
  leaving: boolean
  /** Whether a games.world.saved checkpoint event belongs to this flush. */
  worldSaved: boolean
  meta: Record<string, unknown>
  entityUpserts: readonly WorldEntityDto[]
  entityDeletes: readonly string[]
  npcUpserts: readonly WorldEntityDto[]
  constraintUpserts: readonly ConstraintDto[]
  constraintDeletes: readonly string[]
  characters: readonly FlushCharacter[]
  worldSavedCount: number
  /** Puts the snapshot's dirtiness back after a failed transaction. */
  restore: () => void
}

export class Flusher {
  private chain: Promise<void> = Promise.resolve()
  private checkpointActive = false
  private failures = 0
  private coalesced = 0
  private pendingJobs = 0

  constructor(
    private readonly store: PersistenceStore,
    private readonly metrics: ServerMetrics,
    private readonly log: Logger,
    private readonly recorder: GameEventRecorder | undefined,
  ) {}

  /** Queued or running jobs. */
  get pending(): number {
    return this.pendingJobs
  }

  /**
   * Synchronous entry point for the tick. Returns immediately; when a checkpoint is already in
   * flight this one is coalesced (the builder is not called, so nothing is cleared).
   */
  checkpoint(build: () => FlushPayload | null, { final = false }: { final?: boolean } = {}): void {
    if (this.checkpointActive && final) {
      void this.enqueue(async () => {
        const payload = build()
        if (!payload) return
        try {
          await this.run(payload)
        } catch (err) {
          this.countFailure(err)
          payload.restore()
        }
      })
      return
    }
    if (this.checkpointActive) {
      this.coalesced++
      this.metrics.persistCoalesced = this.coalesced
      return
    }
    const payload = build()
    if (!payload) return
    this.checkpointActive = true
    void this.enqueue(async () => {
      try {
        await this.run(payload)
      } catch (err) {
        this.countFailure(err)
        payload.restore()
      } finally {
        this.checkpointActive = false
      }
    })
  }

  /**
   * A character save queued behind any in-flight checkpoint; never coalesced. `returned()` says
   * whether the character is online again (its session then carries the state, and a retry would
   * write an older copy over it).
   */
  savePlayer(
    payload: FlushPayload,
    returned: () => boolean = () => false,
    retryDelaysMs = [1000, 2000, 4000, 8000],
  ): void {
    void this.enqueue(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.run(payload)
          return
        } catch (err) {
          this.countFailure(err)
          if (returned() || attempt >= retryDelaysMs.length) {
            payload.restore()
            if (!returned())
              this.log.error(
                'a character save failed for good: its changes since the last checkpoint are lost',
                {
                  characters: payload.characters.map((c) => c.dto.id).join(','),
                },
              )
            return
          }
          await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]))
        }
      }
    })
  }

  /** Resolves true when the queue is empty, false when it is not empty by `timeoutMs`. */
  async drain(timeoutMs = 25_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = this.chain
      const left = deadline - Date.now()
      if (left <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        current.then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), left)
        }),
      ])
      clearTimeout(timer)
      if (timedOut) return false
      if (current === this.chain) return true
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.pendingJobs++
    this.metrics.dbDirtyQueue = this.pendingJobs
    const next = this.chain.then(job)
    // The chain never rejects: a failed job is handled by its own catch, and the next job must run.
    this.chain = next.then(
      () => {},
      () => {},
    )
    return next.finally(() => {
      this.pendingJobs--
      this.metrics.dbDirtyQueue = this.pendingJobs
    })
  }

  private async run(payload: FlushPayload): Promise<void> {
    const t0 = performance.now()
    const afterCommit: (() => void)[] = []
    await this.store.transaction(async (t) => {
      for (const [key, value] of Object.entries(payload.meta)) {
        await this.store.meta.set(key, value)
      }
      if (payload.npcUpserts.length > 0)
        await this.store.worldEntities.upsertMany(payload.npcUpserts)
      if (payload.entityUpserts.length > 0)
        await this.store.worldEntities.upsertMany(payload.entityUpserts)
      if (payload.entityDeletes.length > 0)
        await this.store.worldEntities.deleteMany(payload.entityDeletes)
      if (payload.constraintUpserts.length > 0)
        await this.store.constraints.upsertMany(payload.constraintUpserts)
      if (payload.constraintDeletes.length > 0)
        await this.store.constraints.deleteMany(payload.constraintDeletes)
      if (payload.characters.length > 0)
        await this.store.players.upsertMany(payload.characters.map((c) => c.dto))
      if (this.recorder) {
        afterCommit.push(
          await this.recorder.recordPlayersSaved(
            t,
            payload.characters.map((c) => ({ player: c.player, progress: c.progress })),
          ),
        )
        if (payload.leaving) {
          for (const c of payload.characters)
            afterCommit.push(await this.recorder.recordLeave(t, c.player))
        }
        if (payload.worldSaved) {
          afterCommit.push(
            await this.recorder.recordWorldSaved(
              t,
              payload.worldSavedCount,
              payload.characters.length,
              payload.reason,
            ),
          )
        }
      }
    })
    for (const done of afterCommit) done()
    this.metrics.persistRowsWritten =
      payload.npcUpserts.length +
      payload.entityUpserts.length +
      payload.entityDeletes.length +
      payload.constraintUpserts.length +
      payload.constraintDeletes.length +
      payload.characters.length
    this.metrics.persistFlushMs = performance.now() - t0
  }

  private countFailure(err: unknown): void {
    this.failures++
    this.metrics.persistFlushFailures = this.failures
    this.log.error('persistence flush failed: rows stay dirty and will be retried', {
      error: String((err as Error | undefined)?.message ?? err),
    })
  }
}
