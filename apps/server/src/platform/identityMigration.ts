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
import type { PersistenceStore } from '@openvibe/persistence'
import type { IdentityClient } from 'openvibe-sdk/identity'
import { isCanonicalSubject } from '../net/networkAuth.js'
import { LEGACY_NETWORK_PREFIX } from './accounts.js'

export interface MigrationReport {
  /** Legacy account keys that still owned characters. */
  scanned: number
  /** Keys the Network resolved to a subject. */
  resolved: number
  /** Characters moved to their subject key. */
  moved: number
  /** Characters left under the legacy key because the subject already used that slot. */
  conflicts: number
  /** Keys the Network did not know (left untouched). */
  unresolved: string[]
  dryRun: boolean
}

export async function migrateLegacyAccounts(
  store: PersistenceStore,
  identity: Pick<IdentityClient, 'resolveBatch'>,
  opts: { dryRun?: boolean; batchSize?: number; now?: () => number } = {},
): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? false
  const batchSize = Math.min(Math.max(opts.batchSize ?? 200, 1), 500)
  const now = opts.now ?? Date.now
  const keys = store.identity.legacyAccountKeys(LEGACY_NETWORK_PREFIX)
  const report: MigrationReport = {
    scanned: keys.length,
    resolved: 0,
    moved: 0,
    conflicts: 0,
    unresolved: [],
    dryRun,
  }
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize)
    const ids = batch.map((k) => k.slice(LEGACY_NETWORK_PREFIX.length))
    const results = await identity.resolveBatch({ system: 'network', type: 'user', ids })
    for (const [n, key] of batch.entries()) {
      const projection = results[ids[n] ?? '']
      const subjectId = projection?.subject?.id
      if (!isCanonicalSubject(subjectId)) {
        report.unresolved.push(key)
        continue
      }
      report.resolved++
      if (dryRun) {
        report.moved += store.players.listByToken(key).length
        continue
      }
      const r = store.identity.adoptLegacyAccount(key, subjectId, 'network-batch', now())
      report.moved += r.moved
      report.conflicts += r.conflicts
    }
  }
  return report
}
