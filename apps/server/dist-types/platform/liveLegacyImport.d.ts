import type Database from 'better-sqlite3';
import type { IdentityClient } from 'openvibe-sdk/identity';
/** A Live user's canonical subject: `usr_<ULID>`. Guest subjects never own Live rows. */
export declare const USER_SUBJECT: RegExp;
/** The production Live data directory; the importer reads snapshots only. */
export declare const LIVE_PRODUCTION_DIR = "/opt/openvibe.live/";
export interface LegacyTableSpec {
    table: string;
    decision: 'import' | 'exclude';
    /** Column naming the owning Live user (for exclude tables: evidence of play only). */
    userColumn?: string;
    /** Primary-key columns of the source row: the idempotency key (import tables only). */
    keyColumns?: string[];
    /** Why the table is excluded, or what the archived rows are. */
    reason: string;
    /** Rows of an import table that are excluded one by one, and why. */
    excludeRows?: {
        reason: string;
        test: (row: Row, ownsOtherRows: boolean) => boolean;
    };
}
type Row = Record<string, unknown>;
/**
 * A `game_players` row nobody played: Live's profile lookup
 * (`game.getPlayer`, still called by Live's chat profile routes) inserts a
 * default row for every profile it shows. Such a row was never acted on
 * (`last_action = created_at`), has no XP, counters, equipment, sleeping bag
 * or cosmetics, and its user owns no row in any other legacy game table.
 */
export declare function isPlaceholderPlayer(row: Row, ownsOtherRows: boolean): boolean;
/** Every legacy game and canvas table in Live, with its decision (docs/legacy-import.md). */
export declare const LEGACY_TABLES: readonly LegacyTableSpec[];
export type HoldReason = 'no-subject' | 'subject-unconfirmed' | 'subject-conflict' | 'no-owner' | 'differs-from-earlier-import';
export declare const HOLD_REASONS: Record<HoldReason, string>;
export interface HeldRow {
    table: string;
    key: string;
    liveUserId: number | null;
    reason: HoldReason;
}
export interface TableReport {
    table: string;
    decision: 'import' | 'exclude';
    /** The table does not exist in the snapshot (counts are 0). */
    missing: boolean;
    read: number;
    /** Rows in world.db after the run (new plus already imported). */
    imported: number;
    /** Rows this run writes (0 on a re-run). */
    written: number;
    held: number;
    excluded: number;
    balanced: boolean;
}
export interface ImportReport {
    dryRun: boolean;
    subjectSource: string;
    tables: TableReport[];
    totals: Omit<TableReport, 'table' | 'decision' | 'missing'>;
    /** Live users owning importable rows, and how their subjects resolved. */
    users: {
        total: number;
        mapped: number;
        held: Record<string, number>;
    };
    held: HeldRow[];
    /** Rows of import tables excluded one by one, per `table: reason`. */
    excludedRows: Record<string, number>;
    /** Legacy-looking tables in the snapshot that no decision covers. */
    unlisted: {
        table: string;
        rows: number;
    }[];
    /** Every table balances and nothing is unlisted. */
    reconciled: boolean;
}
/** Resolves Live user ids to subjects at the Network; null = the Network does not know the user. */
export type NetworkSubjectLookup = (liveUserIds: number[]) => Promise<Map<number, string | null>>;
/** Lookup through the Network identity service: `(system 'live', type 'user', id)` -> subject. */
export declare function networkSubjectLookup(identity: Pick<IdentityClient, 'resolveBatch'>): NetworkSubjectLookup;
/** Lookup from a map exported from the Network: `{ "<live user id>": "usr_…" }`. */
export declare function subjectMapLookup(map: unknown): NetworkSubjectLookup;
/** A row about to be written. */
export interface PlannedRow {
    table: string;
    key: string;
    liveUserId: number;
    subjectId: string;
    payload: string;
}
export interface ImportPlan {
    report: ImportReport;
    rows: PlannedRow[];
}
/** Deterministic JSON of a source row (sorted keys) so re-runs compare byte for byte. */
export declare function canonicalRow(row: Row): string;
export declare function rowKey(row: Row, columns: readonly string[]): string;
/**
 * Refuses the production Live database: the importer reads a `.backup`
 * snapshot, never the file Live has open.
 */
export declare function assertSnapshotPath(path: string, productionDir?: string): void;
export interface RunOptions {
    livePath?: string;
    apply: boolean;
    backupPath?: string;
    subjects?: string;
    /** Whether `backupPath` already exists. */
    backupExists: boolean;
}
/**
 * Why a run must not start, or null. `--apply` needs a fresh `--backup`
 * path (a stale file is not a backup of now) and a Network subject source.
 */
export declare function refusalFor(opts: RunOptions): string | null;
/** Subjects Live itself recorded for its users (linked_accounts, service 'network'). */
export declare function liveLinkedSubjects(live: Database.Database): Map<number, string[]>;
/**
 * The subject a Live user's rows go to, or why they are held. With a Network
 * answer the Network is the authority and Live's own record must agree; with
 * none (an informational dry run) Live's single recorded subject is used.
 */
export declare function decideSubject(liveUserId: number, linked: ReadonlyMap<number, string[]>, network: ReadonlyMap<number, string | null> | null): {
    subjectId: string;
} | {
    hold: HoldReason;
};
export interface PlanOptions {
    /** The Network's answer for each Live user id, or null to rely on Live's own record only. */
    network: NetworkSubjectLookup | null;
    subjectSource: string;
    dryRun: boolean;
}
/**
 * Reads the Live snapshot and decides every row. `world` may be null (a
 * fresh world with nothing imported yet) and is only read here.
 */
export declare function planLegacyImport(live: Database.Database, world: Database.Database | null, opts: PlanOptions): Promise<ImportPlan>;
/**
 * Writes the planned rows in one transaction. Existing keys are never
 * touched (ON CONFLICT DO NOTHING); the write count must equal the plan or
 * the transaction rolls back.
 */
export declare function applyLegacyImport(world: Database.Database, plan: ImportPlan, now: number): number;
/** Archived row counts per source table (post-apply verification). */
export declare function archivedCounts(world: Database.Database): Map<string, number>;
/**
 * Snapshot of world.db to `path` taken before anything is written, then
 * verified: PRAGMA integrity_check must answer `ok` and the snapshot must
 * hold the same players and archive rows as the source.
 */
export declare function backupAndVerify(world: Database.Database, path: string, open: (path: string) => Database.Database): Promise<void>;
/** The reconciliation report as text. */
export declare function formatReport(report: ImportReport): string;
export {};
//# sourceMappingURL=liveLegacyImport.d.ts.map