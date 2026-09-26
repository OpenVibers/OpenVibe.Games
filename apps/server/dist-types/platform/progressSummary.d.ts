import type { OpenVibeClient } from 'openvibe-sdk/core';
export declare const NAMESPACE = "games.progress.summary";
export interface ProgressSummary {
    level?: number;
    achievements?: number;
    playtime_hours?: number;
    last_world?: string;
}
export interface SessionOutcome {
    levels: Record<string, number>;
    sessionSeconds: number;
    world: string;
}
/** The next record from the one stored and a finished session. */
export declare function mergeSummary(prev: ProgressSummary | undefined, s: SessionOutcome): ProgressSummary;
interface Log {
    warn(msg: string, fields?: Record<string, unknown>): void;
}
export declare class ProgressSummaryWriter {
    private readonly log;
    private readonly now;
    private readonly joined;
    private readonly modules;
    private inflight;
    private readonly writes;
    constructor(client: OpenVibeClient, log: Log, now?: () => number);
    /** A character entered the world (its session starts counting). */
    playerJoined(playerId: string): void;
    /** A character left: fold the session into the person's summary. Resolves when written (or given up). */
    playerLeft(playerId: string, subjectId: string | null, levels: Record<string, number>, world: string): Promise<void>;
    pending(): number;
    /** Graceful stop: resolves when every write in flight has finished (or given up). */
    settle(): Promise<void>;
}
export {};
//# sourceMappingURL=progressSummary.d.ts.map