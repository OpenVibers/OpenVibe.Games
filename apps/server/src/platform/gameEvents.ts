/**
 * Games → OpenVibe.Events: public lifecycle and progression as durable
 * events (roadmap Wave 12, ADR-004).
 *
 *   games.player.joined      a character entered the world
 *   games.player.left        it left (its state was saved in the same transaction)
 *   games.skill.leveled      a persisted skill level went up (one event per skill per save)
 *   games.blueprint.unlocked a persisted blueprint recipe unlock
 *   games.world.saved        the authoritative world was written (checkpoint / shutdown)
 *   games.mod.*              mod install, enable, disable, grant changes and revoke
 *   games.moderation.action  staff took down or put back a mod someone else published
 *                            (common.moderation-action@1, ADR-022), for Network's moderation
 *                            audit log
 *
 * Scraplandia has no achievement system, so there is no games.achievement.*
 * event: skill levels and blueprint unlocks are the real progression
 * milestones the game keeps.
 *
 * Every event is written to Games' own `event_outbox` table inside the SAME
 * SQLite transaction as the state it describes (progression events are
 * derived from what the save actually wrote), and a relay publishes them
 * with the `games` service token (audience openvibe.events, capability
 * events.event.publish). Events or Network being down never blocks a tick:
 * rows wait and are retried.
 */
import type { EventInput, PgOutbox } from 'openvibe-sdk/events'
import type { Db, Tx } from 'openvibe-sdk/db'
import type { SubjectRef } from 'openvibe-sdk/core'

export const EVENT_SOURCE = 'games'

/** A character as events describe it. */
export interface EventPlayer {
  playerId: string
  slot: number
  name: string
  /** Canonical subject for signed-in accounts; null for local guests. */
  subjectId: string | null
}

/** The persisted progression a save compares against. */
export interface ProgressSnapshot {
  /** Level per skill id. */
  levels: Record<string, number>
  /** Unlocked blueprint recipe ids. */
  unlocks: string[]
}

const GAMES_ACTOR: SubjectRef = { type: 'service', id: EVENT_SOURCE }

export function actorFor(subjectId: string | null): SubjectRef {
  if (subjectId?.startsWith('usr_')) return { type: 'user', id: subjectId }
  if (subjectId?.startsWith('gst_')) return { type: 'guest', id: subjectId }
  return GAMES_ACTOR
}

function playerPayload(p: EventPlayer): Record<string, unknown> {
  const actor = actorFor(p.subjectId)
  return {
    id: p.playerId,
    slot: p.slot,
    name: p.name,
    account: p.subjectId ? 'network' : 'guest',
    ...(actor.type === 'user' || actor.type === 'guest' ? { subject: actor } : {}),
  }
}

/** Events about one player are visible to that subject; guests' stay internal. */
function playerVisibility(p: EventPlayer): 'subject' | 'internal' {
  return p.subjectId ? 'subject' : 'internal'
}

export function playerJoinedEvent(
  p: EventPlayer,
  opts: { world: string; restored: boolean },
): EventInput {
  return {
    event_type: 'games.player.joined',
    actor: actorFor(p.subjectId),
    subject: { type: 'player', id: p.playerId },
    visibility: playerVisibility(p),
    priority: 'low',
    payload: { player: playerPayload(p), world: opts.world, restored: opts.restored },
  }
}

export function playerLeftEvent(
  p: EventPlayer,
  opts: { world: string; sessionSeconds: number },
): EventInput {
  return {
    event_type: 'games.player.left',
    actor: actorFor(p.subjectId),
    subject: { type: 'player', id: p.playerId },
    visibility: playerVisibility(p),
    priority: 'low',
    payload: {
      player: playerPayload(p),
      world: opts.world,
      session_seconds: Math.max(0, Math.round(opts.sessionSeconds)),
    },
  }
}

/** Progression milestones between two persisted snapshots (never downgrades). */
export function progressEvents(
  p: EventPlayer,
  before: ProgressSnapshot,
  after: ProgressSnapshot,
  world: string,
): EventInput[] {
  const out: EventInput[] = []
  for (const skill of Object.keys(after.levels).sort()) {
    const level = after.levels[skill] ?? 0
    const previous = before.levels[skill] ?? 1
    if (level <= previous) continue
    out.push({
      event_type: 'games.skill.leveled',
      actor: actorFor(p.subjectId),
      subject: { type: 'player', id: p.playerId },
      visibility: playerVisibility(p),
      priority: 'low',
      payload: { player: playerPayload(p), world, skill, level, previous_level: previous },
    })
  }
  const had = new Set(before.unlocks)
  for (const recipe of [...after.unlocks].sort()) {
    if (had.has(recipe)) continue
    out.push({
      event_type: 'games.blueprint.unlocked',
      actor: actorFor(p.subjectId),
      subject: { type: 'player', id: p.playerId },
      visibility: playerVisibility(p),
      priority: 'low',
      payload: { player: playerPayload(p), world, recipe },
    })
  }
  return out
}

export function worldSavedEvent(
  world: string,
  save: { reason: 'checkpoint' | 'shutdown'; entities: number; players: number; sinceMs: number },
): EventInput {
  return {
    event_type: 'games.world.saved',
    actor: GAMES_ACTOR,
    subject: { type: 'world', id: world },
    visibility: 'internal',
    priority: 'low',
    payload: {
      world,
      reason: save.reason,
      entities_written: save.entities,
      players_written: save.players,
      since: new Date(save.sinceMs).toISOString(),
    },
  }
}

export type ModLifecycle = 'installed' | 'enabled' | 'disabled' | 'revoked' | 'grants_changed'

export function modEvent(
  kind: ModLifecycle,
  mod: { id: string; name: string; version: string; target: string; trustTier: string },
  actor: SubjectRef,
  detail: Record<string, unknown>,
): EventInput {
  return {
    event_type: `games.mod.${kind}`,
    actor,
    subject: { type: 'mod', id: mod.id },
    visibility: 'internal',
    priority: kind === 'revoked' ? 'important' : 'low',
    payload: {
      mod: {
        id: mod.id,
        name: mod.name,
        version: mod.version,
        target: mod.target,
        trust_tier: mod.trustTier,
      },
      ...detail,
    },
  }
}

/**
 * games.moderation.action: one staff action on someone else's content. `actor` is the staff
 * member (a service when no person is known); the payload never carries the content itself.
 */
export function moderationEvent(
  action: string,
  target: { type: string; id: string; ownerSubject: string | null },
  actor: SubjectRef,
  opts: { reason?: string | null; details?: Record<string, unknown> } = {},
): EventInput {
  const t = { type: target.type, id: target.id.slice(0, 200), owner_subject: target.ownerSubject }
  return {
    event_type: 'games.moderation.action',
    actor,
    subject: { type: 'moderation_action', id: `${t.type}:${t.id}`.slice(0, 200) },
    visibility: 'internal',
    payload: {
      action,
      target: t,
      actor_subject: actor.type === 'user' ? actor.id : null,
      reason: opts.reason ? opts.reason.slice(0, 500) : null,
      details: opts.details ?? {},
    },
  }
}

/**
 * Where events go. `enqueue` is awaited inside the transaction making the change and is handed that
 * transaction's handle: the SDK's PostgreSQL outbox writes the row on it, so the event exists if and
 * only if the change commits. Only the relay wake is deferred.
 */
export interface EventSink {
  readonly enabled: boolean
  enqueue(t: Tx, event: EventInput): Promise<void>
}

export const NO_EVENTS: EventSink = { enabled: false, enqueue: async () => {} }

/** An EventSink over the SDK PostgreSQL outbox; wakes the relay right after the write. */
export function outboxSink(outbox: PgOutbox, db: Db): EventSink {
  return {
    enabled: true,
    async enqueue(t, event) {
      // The old SQLite outbox refused an enqueue outside a transaction; the PG port takes the tx handle
      // but a Db also satisfies the type, so nothing else would stop an event committing on its own
      // connection. Refuse it here too.
      if (!db.inTransaction()) {
        throw new Error('outbox.enqueue() must run inside the transaction that makes the change')
      }
      await outbox.enqueue(t, event)
      setImmediate(() => outbox.kick())
    },
  }
}

interface Tracked {
  player: EventPlayer
  progress: ProgressSnapshot
  joinedAt: number
}

/**
 * Per-session bookkeeping the game server drives: the progression baseline
 * each save is compared with, join times, and the world-save accumulator.
 * All `record*` methods are handed the caller's transaction handle and return
 * a callback to run once it has committed.
 */
export class GameEventRecorder {
  private readonly tracked = new Map<string, Tracked>()
  private sinceMs: number
  private pendingEntities = 0
  private pendingPlayers = 0
  private lastSavedEventMs: number

  constructor(
    private readonly sink: EventSink,
    private readonly world: string,
    private readonly checkpointEveryMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.sinceMs = now()
    this.lastSavedEventMs = now()
  }

  get enabled(): boolean {
    return this.sink.enabled
  }

  /** A character joined; `progress` is what the database holds for it. */
  async recordJoin(
    t: Tx,
    player: EventPlayer,
    progress: ProgressSnapshot,
    restored: boolean,
  ): Promise<void> {
    this.tracked.set(player.playerId, {
      player,
      progress: cloneProgress(progress),
      joinedAt: this.now(),
    })
    await this.sink.enqueue(t, playerJoinedEvent(player, { world: this.world, restored }))
  }

  /**
   * Players were written: emits the progression they newly persisted.
   * Returns the commit callback that advances their baselines.
   */
  async recordPlayersSaved(
    t: Tx,
    saved: { player: EventPlayer; progress: ProgressSnapshot }[],
  ): Promise<() => void> {
    const advance: { id: string; progress: ProgressSnapshot }[] = []
    for (const { player, progress } of saved) {
      const tr = this.tracked.get(player.playerId)
      if (tr) {
        for (const ev of progressEvents(player, tr.progress, progress, this.world)) {
          await this.sink.enqueue(t, ev)
        }
      }
      advance.push({ id: player.playerId, progress: cloneProgress(progress) })
    }
    return () => {
      for (const a of advance) {
        const tr = this.tracked.get(a.id)
        if (tr) tr.progress = a.progress
      }
    }
  }

  /** The character left; its final save is part of the same transaction. */
  async recordLeave(t: Tx, player: EventPlayer): Promise<() => void> {
    const tr = this.tracked.get(player.playerId)
    const sessionSeconds = tr ? (this.now() - tr.joinedAt) / 1000 : 0
    await this.sink.enqueue(t, playerLeftEvent(player, { world: this.world, sessionSeconds }))
    return () => {
      this.tracked.delete(player.playerId)
    }
  }

  /**
   * A flush wrote `entities` world rows and `players` player rows. Emits a
   * `games.world.saved` checkpoint at most once per interval (and always on
   * shutdown) with the totals since the previous one.
   */
  async recordWorldSaved(
    t: Tx,
    entities: number,
    players: number,
    reason: 'checkpoint' | 'shutdown',
  ): Promise<() => void> {
    const nowMs = this.now()
    // The accumulator holds only committed saves. This flush's rows join it at commit, never before,
    // so a failed (and retried) save is counted once and a rollback leaves nothing behind.
    const totalEntities = this.pendingEntities + entities
    const totalPlayers = this.pendingPlayers + players
    const due =
      reason === 'shutdown' ||
      (nowMs - this.lastSavedEventMs >= this.checkpointEveryMs && totalEntities + totalPlayers > 0)
    if (!due) {
      return () => {
        this.pendingEntities = totalEntities
        this.pendingPlayers = totalPlayers
      }
    }
    await this.sink.enqueue(
      t,
      worldSavedEvent(this.world, {
        reason,
        entities: totalEntities,
        players: totalPlayers,
        sinceMs: this.sinceMs,
      }),
    )
    return () => {
      this.pendingEntities = 0
      this.pendingPlayers = 0
      this.sinceMs = nowMs
      this.lastSavedEventMs = nowMs
    }
  }
}

function cloneProgress(p: ProgressSnapshot): ProgressSnapshot {
  return { levels: { ...p.levels }, unlocks: [...p.unlocks] }
}
