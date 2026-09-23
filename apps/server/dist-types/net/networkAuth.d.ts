/**
 * openvibe.network SSO adapter. Access tokens are JWTs issued by the openvibe.network
 * OAuth server; we validate by calling its /api/auth/me endpoint (which
 * verifies signature + ban state) rather than trusting the JWT locally.
 * The response nests the account under `user`; rank maps the network RBAC:
 * the configured owner account, then role admin / moderator (global_mod).
 */
export type OpenVibeRank = 'owner' | 'admin' | 'moderator' | null;
export interface NetworkUser {
    /** The Network's own account id (legacy; integer today). */
    id: string;
    name: string;
    rank: OpenVibeRank;
    /**
     * Canonical subject (`usr_…`, or `gst_…` for a Network guest) from the
     * token's `subject_id` claim; null only for tokens older than subjects.
     */
    subjectId: string | null;
}
export declare function isCanonicalSubject(value: unknown): value is string;
/** The account record as openvibe.network's /api/auth/me returns it. */
export interface NetworkAccount {
    id?: string | number;
    username?: string;
    role?: string;
    is_banned?: number;
    /** Canonical subject (Wave 1); mirrors the token's `subject_id` claim. */
    subject_id?: string;
    [key: string]: unknown;
}
/**
 * Fetches the raw account behind a bearer token from openvibe.network, or
 * null when the token is missing, rejected or the Network is unreachable.
 * The same-origin /auth/me endpoint hands this object to the shared navbar.
 */
export declare function fetchNetworkAccount(url: string | null, auth: string | undefined): Promise<NetworkAccount | null>;
export declare function resolveNetworkUser(url: string | null, auth: string | undefined): Promise<NetworkUser | null>;
export declare function canEditMap(rank: OpenVibeRank): boolean;
//# sourceMappingURL=networkAuth.d.ts.map