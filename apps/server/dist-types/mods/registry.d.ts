/**
 * The mod registry (ADR-013, roadmap Wave 12): installs, the approved subset
 * of each install's requested capabilities, lifecycle and the audit log, all
 * in Games' own SQLite database.
 *
 *   install   validate the manifest + pack, store it, grant the approved subset
 *   enable / disable
 *   grant / revokeGrant   change one capability of an install
 *   revoke    terminal: every grant ends and the runtime retracts the mod's
 *             effects on the next tick
 *
 * Every change is one transaction holding the registry rows, the audit rows
 * and the `games.mod.*` outbox event. The in-memory view the runtime asks on
 * its hot path (`isGranted`) is refreshed only after that commit.
 *
 * Trust tiers are metadata: `isGranted` never looks at them.
 *
 * ADR-013 puts grants in OpenVibe.Network (a `mod` principal per install).
 * Until Network issues mod principals, the approved subset lives here; the
 * shape (install -> approved capability ids, revocable at once) is the same
 * so the source of truth can move without changing the runtime seam.
 */
import type { ContentRegistry } from '@openvibe/content';
import type { ModAuditDto, ModInstallDto, ModTrustTier, PersistenceStore } from '@openvibe/persistence';
import type { SubjectRef } from 'openvibe-sdk/core';
import { type EventSink } from '../platform/gameEvents.js';
import { type ContentPack } from './contentPack.js';
import { type ModManifest } from './manifest.js';
export declare const TRUST_TIERS: readonly ModTrustTier[];
/** Who performed a registry change: an audit string and an event actor. */
export interface ModActor {
    /** `usr_…`, `ovn:<id>` for a pre-subject staff token, or `svc:<client>`. */
    audit: string;
    subject: SubjectRef;
}
export declare const SYSTEM_ACTOR: ModActor;
export declare class ModError extends Error {
    readonly code: string;
    readonly status: number;
    readonly errors: string[];
    constructor(code: string, message: string, status?: number, errors?: string[]);
}
export interface InstallRequest {
    manifest: unknown;
    pack: unknown;
    /** The approved subset of manifest.permissions.capabilities. */
    approve?: unknown;
    trustTier?: unknown;
    enable?: unknown;
}
/** A mod as the runtime and the API see it. */
export interface ModView {
    mod: ModInstallDto;
    manifest: ModManifest;
    pack: ContentPack;
    /** Capabilities currently granted (approved and not revoked). */
    granted: ReadonlySet<string>;
}
export declare class ModRegistry {
    private readonly store;
    private readonly content;
    private readonly events;
    private readonly now;
    private readonly views;
    private revision;
    constructor(store: PersistenceStore, content: ContentRegistry, events?: EventSink, now?: () => number);
    /** Bumps on every committed change; the runtime reconciles when it moves. */
    get version(): number;
    list(): ModView[];
    get(id: string): ModView | null;
    isActive(id: string): boolean;
    /**
     * The one grant check. True only while the install is enabled and the
     * capability is in its approved, unrevoked subset. The trust tier is not
     * consulted — a tier label never grants anything.
     */
    isGranted(id: string, capability: string): boolean;
    auditLog(id: string, limit?: number): ModAuditDto[];
    /** Appends a runtime audit record (use, deny, retract, …). */
    audit(id: string, action: string, capability: string | null, detail?: Record<string, unknown>): void;
    install(req: InstallRequest, actor: ModActor): ModView;
    enable(id: string, actor: ModActor): ModView;
    disable(id: string, actor: ModActor): ModView;
    /** Ends the install for good: every grant is revoked and the mod stops at the next tick. */
    revoke(id: string, actor: ModActor, reason?: string): ModView;
    grant(id: string, capability: string, actor: ModActor): ModView;
    revokeGrant(id: string, capability: string, actor: ModActor): ModView;
    private setStatus;
    private assertGrantable;
    private require;
    private writeAudit;
    private emit;
    /** Re-reads one install after a committed change. */
    private refresh;
}
//# sourceMappingURL=registry.d.ts.map