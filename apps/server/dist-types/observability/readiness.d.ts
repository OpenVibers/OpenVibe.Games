import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * GET /api/ready: whether this process can serve the game, in the shape the
 * other OpenVibe services answer (openvibe-shared/ready): `status`
 * ready/degraded/not_ready, a `checks` object with one entry per named check,
 * and the names of the `failed` (required) and `degraded` (optional) ones.
 * 200 when every required check passes, 503 otherwise; each failed check
 * carries its reason in `error`.
 *
 * Required: `db` (world.db answers a trivial query) and `tick` (the fixed-tick
 * simulation has advanced recently). /healthz stays liveness only.
 */
/**
 * No completed tick for this long means the simulation is stalled. The loop
 * runs at `tickRate` (30/s, one tick every ~33 ms) and resyncs itself after
 * falling more than a second behind, so a healthy server never goes a second
 * without a tick; 5 s leaves room for a GC pause, a persistence flush or a
 * live map rebuild, and still flags a frozen world within one deploy poll.
 */
export declare const TICK_STALL_MS = 5000;
export interface ReadinessCheck {
    status: 'ok' | 'fail';
    required: boolean;
    latency_ms: number;
    checked_at: string;
    error?: string;
    detail?: Record<string, unknown>;
}
export interface ReadinessBody {
    ready: boolean;
    status: 'ready' | 'degraded' | 'not_ready';
    service: 'games';
    checked_at: string;
    failed: string[];
    degraded: string[];
    checks: Record<string, ReadinessCheck>;
}
export interface ReadinessDeps {
    /** Runs a trivial query against world.db; throws or returns false when it fails. */
    pingDb: () => boolean;
    /** The tick counter and when the last tick completed (epoch ms, 0 = never). */
    metrics: {
        readonly tick: number;
        readonly lastTickAt: number;
    };
    tickStallMs?: number;
    now?: () => number;
}
export declare function createReadiness(deps: ReadinessDeps): {
    check: () => ReadinessBody;
    handle: (req: IncomingMessage, res: ServerResponse) => boolean;
};
//# sourceMappingURL=readiness.d.ts.map