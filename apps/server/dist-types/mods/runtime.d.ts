/**
 * The mod runtime seam.
 *
 * A mod never touches the game server, the world or the database. It gets a
 * `ModApi`: a frozen object of bindings, one per runtime capability, and
 * every binding checks the registry AT CALL TIME. A capability the install
 * was not granted — or one revoked a moment ago — throws before anything
 * happens, so it cannot be reached from the mod side at all.
 *
 * `games-content@1` packs are interpreted here through that same API; an
 * executable runtime (a script sandbox) would receive the same bindings.
 * Executable mods are not accepted yet: sandboxed execution with enforced
 * CPU, memory, storage and network budgets belongs to OpenVibe.Host
 * (Stage C). Until then the manifest's resource budget is metered, not
 * enforced by a sandbox.
 *
 * Each tick the runtime reconciles when the registry changed (and once a
 * second otherwise): an inactive mod, or one that lost a capability, has
 * its effects retracted — its props despawned, its announcements stopped —
 * on that very tick.
 */
import type { ContentRegistry } from '@openvibe/content';
import type { PersistenceStore } from '@openvibe/persistence';
import type { Logger } from '@openvibe/shared';
import type { ModRegistry } from './registry.js';
/** What the game server lends the runtime. Only the runtime holds it. */
export interface ModHost {
    announce(text: string): void;
    /** Spawns an inert prop owned by `owner`; returns its entity id. */
    placeProp(spec: {
        item: string;
        pos: [number, number, number];
        yaw: number;
        owner: string;
    }): string | null;
    removeEntity(entityId: string): boolean;
    entityExists(entityId: string): boolean;
}
/** The bindings a mod gets. Nothing else is reachable from a mod. */
export interface ModApi {
    readonly modId: string;
    /** games.world.announce */
    announce(text: string): void;
    /** games.prop.place: places (or re-places) the prop for `key`. */
    placeProp(key: string, item: string, pos: [number, number, number], yaw?: number): string | null;
    /** games.prop.place: removes the prop for `key`. */
    removeProp(key: string): boolean;
}
export declare class ModCapabilityError extends Error {
    readonly modId: string;
    readonly capability: string;
    readonly code = "capability.denied";
    constructor(modId: string, capability: string);
}
export interface ModRuntimeOptions {
    /** Reconcile at least this often when nothing changed (ticks). */
    reconcileEveryTicks: number;
    now?: () => number;
}
export declare class ModRuntime {
    private readonly registry;
    private readonly store;
    private readonly content;
    private readonly log;
    private readonly opts;
    private seenVersion;
    private nextTick;
    /** modId -> last announcement time per announcement index. */
    private readonly announced;
    /** `${modId}|${cap}` denials already audited since the last registry change. */
    private readonly deniedNoted;
    private readonly budgetNotedAt;
    private readonly now;
    constructor(registry: ModRegistry, store: PersistenceStore, content: ContentRegistry, log: Logger, opts: ModRuntimeOptions);
    /**
     * The mod-facing API for one install. Frozen, and closed over nothing a
     * mod could use to reach the host except through a checked binding.
     */
    bindingsFor(modId: string, host: ModHost): ModApi;
    tick(tick: number, host: ModHost): void;
    private runContentPack;
    private attempt;
    /** Despawns everything the mod placed. */
    private retractProps;
    private noteDenied;
    /** Meters the declared per-tick CPU budget (enforcement: OpenVibe.Host, Stage C). */
    private meter;
}
//# sourceMappingURL=runtime.d.ts.map