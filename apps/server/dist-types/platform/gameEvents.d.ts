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
import type { EventInput, Outbox } from 'openvibe-sdk/events';
import type { SubjectRef } from 'openvibe-sdk/core';
export declare const EVENT_SOURCE = "games";
/** A character as events describe it. */
export interface EventPlayer {
    playerId: string;
    slot: number;
    name: string;
    /** Canonical subject for signed-in accounts; null for local guests. */
    subjectId: string | null;
}
/** The persisted progression a save compares against. */
export interface ProgressSnapshot {
    /** Level per skill id. */
    levels: Record<string, number>;
    /** Unlocked blueprint recipe ids. */
    unlocks: string[];
}
export declare function actorFor(subjectId: string | null): SubjectRef;
export declare function playerJoinedEvent(p: EventPlayer, opts: {
    world: string;
    restored: boolean;
}): EventInput;
export declare function playerLeftEvent(p: EventPlayer, opts: {
    world: string;
    sessionSeconds: number;
}): EventInput;
/** Progression milestones between two persisted snapshots (never downgrades). */
export declare function progressEvents(p: EventPlayer, before: ProgressSnapshot, after: ProgressSnapshot, world: string): EventInput[];
export declare function worldSavedEvent(world: string, save: {
    reason: 'checkpoint' | 'shutdown';
    entities: number;
    players: number;
    sinceMs: number;
}): EventInput;
export type ModLifecycle = 'installed' | 'enabled' | 'disabled' | 'revoked' | 'grants_changed';
export declare function modEvent(kind: ModLifecycle, mod: {
    id: string;
    name: string;
    version: string;
    target: string;
    trustTier: string;
}, actor: SubjectRef, detail: Record<string, unknown>): EventInput;
/**
 * games.moderation.action: one staff action on someone else's content. `actor` is the staff
 * member (a service when no person is known); the payload never carries the content itself.
 */
export declare function moderationEvent(action: string, target: {
    type: string;
    id: string;
    ownerSubject: string | null;
}, actor: SubjectRef, opts?: {
    reason?: string | null;
    details?: Record<string, unknown>;
}): EventInput;
/** Where events go. `enqueue` must run inside the transaction making the change. */
export interface EventSink {
    readonly enabled: boolean;
    enqueue(event: EventInput): void;
}
export declare const NO_EVENTS: EventSink;
/** An EventSink over the SDK outbox; wakes the relay right after the write. */
export declare function outboxSink(outbox: Outbox): EventSink;
/**
 * Per-session bookkeeping the game server drives: the progression baseline
 * each save is compared with, join times, and the world-save accumulator.
 * All `record*` methods run inside the caller's store transaction and return
 * a callback to run once it has committed.
 */
export declare class GameEventRecorder {
    private readonly sink;
    private readonly world;
    private readonly checkpointEveryMs;
    private readonly now;
    private readonly tracked;
    private sinceMs;
    private pendingEntities;
    private pendingPlayers;
    private lastSavedEventMs;
    constructor(sink: EventSink, world: string, checkpointEveryMs: number, now?: () => number);
    get enabled(): boolean;
    /** A character joined; `progress` is what the database holds for it. */
    recordJoin(player: EventPlayer, progress: ProgressSnapshot, restored: boolean): void;
    /**
     * Players were written: emits the progression they newly persisted.
     * Returns the commit callback that advances their baselines.
     */
    recordPlayersSaved(saved: {
        player: EventPlayer;
        progress: ProgressSnapshot;
    }[]): () => void;
    /** The character left; its final save is part of the same transaction. */
    recordLeave(player: EventPlayer): () => void;
    /**
     * A flush wrote `entities` world rows and `players` player rows. Emits a
     * `games.world.saved` checkpoint at most once per interval (and always on
     * shutdown) with the totals since the previous one.
     */
    recordWorldSaved(entities: number, players: number, reason: 'checkpoint' | 'shutdown'): () => void;
}
//# sourceMappingURL=gameEvents.d.ts.map