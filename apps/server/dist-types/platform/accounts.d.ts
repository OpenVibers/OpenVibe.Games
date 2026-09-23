/**
 * Account keys (ADR-0006).
 *
 * A signed-in account is keyed by its canonical openvibe.network subject
 * (`usr_…`, or `gst_…` for a Network guest) taken from the token's
 * `subject_id` claim. Before subjects existed Games keyed it by
 * `ovn:<network user id>`; those characters are adopted into the subject key
 * the first time the account signs in (or by scripts/migrateIdentity.ts), and
 * the mapping is kept in `identity_legacy_map`.
 *
 * Local guests keep their browser token (ADR-0004). A guest token may use
 * letters, digits, `_` and `-` only (the client mints alphanumerics), and
 * may not start with a subject prefix, so it can never equal a subject or a
 * legacy key: a guest presenting `usr_…` or `ovn:…` as its token cannot open
 * someone else's characters.
 */
import type { IdentityRepository, PlayerRepository } from '@openvibe/persistence';
import type { NetworkUser } from '../net/networkAuth.js';
/** Prefix of pre-subject account keys: `ovn:<openvibe.network user id>`. */
export declare const LEGACY_NETWORK_PREFIX = "ovn:";
export declare function isGuestToken(token: unknown): token is string;
export declare function legacyNetworkKey(networkUserId: string): string;
export interface AccountResolution {
    /** The players.token value the account's characters live under. */
    key: string;
    /** Canonical subject, or null for a token older than subjects. */
    subjectId: string | null;
    /** Characters moved from the legacy key by this call. */
    adopted: number;
}
export interface AccountStores {
    identity: IdentityRepository;
    players: PlayerRepository;
}
/**
 * The account key for a signed-in Network user, adopting any characters
 * still under its legacy key. Idempotent.
 */
export declare function accountForNetworkUser(stores: AccountStores, user: NetworkUser, now: number, onConflict?: (info: {
    legacyKey: string;
    subjectId: string;
    error: string;
}) => void): AccountResolution;
//# sourceMappingURL=accounts.d.ts.map