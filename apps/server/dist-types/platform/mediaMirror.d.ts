import type { PersistenceStore } from '@openvibe/persistence';
import type { Logger } from '@openvibe/shared';
import type { OpenVibeClient } from 'openvibe-sdk/core';
export interface MediaMirrorOptions {
    client: OpenVibeClient;
    store: PersistenceStore;
    namespace: string;
    assetsDir: string;
    log: Logger;
    now?: () => number;
    intervalMs?: number;
}
export declare class MediaMirror {
    private readonly opts;
    private timer;
    private running;
    private readonly now;
    constructor(opts: MediaMirrorOptions);
    /** Queues one stored asset (idempotent) and wakes the worker. */
    enqueue(asset: {
        hash: string;
        url: string;
        bytes: number;
        mime: string;
    }): void;
    /** Queues every content-addressed asset already on disk (a no-op for known ones). */
    backfill(): Promise<number>;
    start(): void;
    stop(): void;
    kick(): void;
    /** Mirrors every due row once. Concurrent callers share the pass. */
    runOnce(): Promise<void>;
    private schedule;
    private pass;
    private base;
    private mirror;
    private fail;
}
//# sourceMappingURL=mediaMirror.d.ts.map