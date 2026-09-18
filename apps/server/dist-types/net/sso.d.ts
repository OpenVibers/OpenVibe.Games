/**
 * openvibe.network SSO helpers for the /auth/* routes: where a sign-in may
 * send the browser afterwards, the cookies that carry the session and the
 * cross-site "is anyone signed in here?" hint, and the state cookie that ties
 * a callback to the login that started it.
 *
 * Kept free of http.Server types so the rules are unit-testable on their own.
 */
/** Name of the cookie holding the openvibe.network access token. */
export declare const SESSION_COOKIE = "ovg_sso";
/**
 * Cross-network hint read by the shared navbar: `account` means this browser
 * has signed in somewhere on OpenVibe (so a silent prompt=none sign-in is
 * worth attempting), `guest` means it signed out. JS-readable by design.
 */
export declare const SSO_HINT_COOKIE = "ov_sso_hint";
/** Short-lived, HttpOnly: pins the OAuth `state` and the post-login `next`. */
export declare const LOGIN_STATE_COOKIE = "ovg_login";
export declare function isSilentDenial(error: string | null | undefined): boolean;
export interface NextOrigins {
    /** openvibe.network — the sign-in-everywhere / sign-out-everywhere chains hop through it. */
    network: string;
    /** Our own public bases (apex + play host). */
    self: string[];
}
/**
 * Validates a `next` target. Accepts a same-site path (`/play`, never `//evil`)
 * or an absolute https URL on openvibe.network or one of our own hosts.
 * Anything else yields null so an open redirect is impossible.
 */
export declare function safeNext(raw: string | null | undefined, origins: NextOrigins): string | null;
/** Appends `sso=none` to a validated `next` so the landing page knows the silent attempt found nobody. */
export declare function withSsoNone(next: string): string;
export declare function parseCookies(header: string | undefined): Record<string, string>;
export interface LoginState {
    state: string;
    next: string | null;
    silent: boolean;
}
export declare function encodeLoginState(s: LoginState): string;
export declare function decodeLoginState(raw: string | undefined): LoginState | null;
export declare function sessionCookie(token: string, secure: boolean): string;
export declare function clearSessionCookie(): string;
export declare function ssoHintCookie(value: 'account' | 'guest', secure: boolean): string;
export declare function loginStateCookie(s: LoginState, secure: boolean): string;
export declare function clearLoginStateCookie(): string;
/**
 * Decodes a JWT's payload WITHOUT checking its signature. Only for reading
 * claims we cross-check locally (the FedCM nonce); never for trusting an
 * identity.
 */
export declare function decodeJwtPayload(token: string): Record<string, unknown> | null;
/** True when the assertion's `nonce` claim is exactly the nonce the page posted. */
export declare function fedcmNonceMatches(token: string, nonce: string): boolean;
export interface FedcmBody {
    token: string;
    nonce: string;
}
/** Max bytes a /auth/fedcm body may carry: an assertion JWT is a few KB at most. */
export declare const MAX_FEDCM_BODY_BYTES: number;
/**
 * Parses and validates the JSON body of POST /auth/fedcm. Returns an error
 * code (for a 400) instead of the body when it is malformed, incomplete or
 * its nonce does not match the assertion's.
 */
export declare function parseFedcmBody(raw: string): {
    body: FedcmBody;
} | {
    error: string;
};
/**
 * Remembers, briefly, which session tokens openvibe.network last confirmed so
 * the silent-login shortcut (`/auth/login?silent=1` with an ovg_sso cookie
 * that already resolves) does not cost a Network lookup on every page. Only
 * positive answers are kept: a miss just falls through to the normal
 * prompt=none round trip, which is the right answer for it anyway.
 */
export declare class SessionCheckCache {
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly hits;
    constructor(ttlMs?: number, maxEntries?: number);
    has(token: string, now?: number): boolean;
    remember(token: string, now?: number): void;
    forget(token: string): void;
}
/**
 * The page the callback answers with: it mirrors the session into
 * localStorage (the game client reads it from there) before moving on, so a
 * cross-origin `next` still leaves this origin signed in.
 */
export declare function sessionHandoffHtml(token: string | null, hint: 'account' | 'guest', dest: string): string;
//# sourceMappingURL=sso.d.ts.map