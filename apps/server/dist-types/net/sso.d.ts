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
 * The page the callback answers with: it mirrors the session into
 * localStorage (the game client reads it from there) before moving on, so a
 * cross-origin `next` still leaves this origin signed in.
 */
export declare function sessionHandoffHtml(token: string | null, hint: 'account' | 'guest', dest: string): string;
//# sourceMappingURL=sso.d.ts.map