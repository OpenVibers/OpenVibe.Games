/**
 * Sign-out everywhere reaches Games (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after).
 *
 * POST /internal/events is the endpoint of Games' Events subscription to that topic, signed with
 * GAMES_EVENTS_SECRET (signature v2 only) and loopback only (a request carrying a forwarding header
 * came through nginx and is refused). A delivery moves the person's cutoff in the SDK's revocation
 * store (only ever forward; anything not from Network is ignored), then `onRevoked` closes the game
 * sessions they opened with an older sign-in. New sign-ins already fail: Games checks every token with
 * the Network's /api/auth/me, which applies the same cutoff.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@openvibe/shared';
interface RevocationStore {
    apply(event: unknown): string;
    isRevoked(claims: {
        iat?: number;
        subject_id?: string;
    } | null | undefined): boolean;
    cutoffFor(subject: string): number;
}
export declare const TOPIC = "network.user.token_valid_after";
export interface RevocationEvents {
    /** Answers POST /internal/events (returns true when the request was ours). */
    handle(req: IncomingMessage, res: ServerResponse): boolean;
    store: RevocationStore;
    stats: {
        received: number;
        revoked: number;
        closed: number;
        refused: number;
        ignored: number;
    };
}
export declare function createRevocationEvents(opts: {
    db: unknown;
    secrets: string[];
    onRevoked: (subjectId: string, validAfterMs: number) => number;
    log: Logger;
}): RevocationEvents;
/**
 * Create Games' subscription to TOPIC at Events if it is missing (idempotent: an existing one, even
 * disabled by an operator, is left as it is). Needs the grant games events.subscription.manage.
 */
export declare function ensureRevocationSubscription(opts: {
    eventsUrl: string;
    endpoint: string;
    secret: string;
    tokens: {
        getToken(ctx?: {
            audience?: string;
            scope?: string;
        }): Promise<string>;
    };
    fetchImpl?: typeof fetch;
    log: Logger;
}): Promise<'exists' | 'created'>;
export {};
//# sourceMappingURL=revocationEvents.d.ts.map