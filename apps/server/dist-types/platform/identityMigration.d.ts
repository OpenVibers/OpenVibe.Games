/**
 * Batch adoption of legacy accounts (ADR-0006): every account still keyed by
 * `ovn:<network user id>` is resolved to its canonical subject through the
 * Network identity service (capability identity.subject.resolve, audience
 * openvibe.network, the `games` service token) and moved over.
 *
 * Sign-in adopts an account on its own; this pass covers the accounts that
 * have not signed in since. Idempotent: adopted keys own no characters any
 * more, so a second run finds nothing to do.
 */
import type { PersistenceStore } from '@openvibe/persistence';
import type { IdentityClient } from 'openvibe-sdk/identity';
export interface MigrationReport {
    /** Legacy account keys that still owned characters. */
    scanned: number;
    /** Keys the Network resolved to a subject. */
    resolved: number;
    /** Characters moved to their subject key. */
    moved: number;
    /** Characters left under the legacy key because the subject already used that slot. */
    conflicts: number;
    /** Keys the Network did not know (left untouched). */
    unresolved: string[];
    dryRun: boolean;
}
export declare function migrateLegacyAccounts(store: PersistenceStore, identity: Pick<IdentityClient, 'resolveBatch'>, opts?: {
    dryRun?: boolean;
    batchSize?: number;
    now?: () => number;
}): Promise<MigrationReport>;
//# sourceMappingURL=identityMigration.d.ts.map