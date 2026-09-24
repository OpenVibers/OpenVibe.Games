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
/** The rank the staff map gives these (accepted) claims. */
export declare function rankOf(claims: Record<string, unknown>): OpenVibeRank;
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
/** The map editor and mod administration: staff.games.manage (rank owner or admin). */
export declare function canEditMap(rank: OpenVibeRank): boolean;
//# sourceMappingURL=networkAuth.d.ts.map