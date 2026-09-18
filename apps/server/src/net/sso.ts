/**
 * openvibe.network SSO helpers for the /auth/* routes: where a sign-in may
 * send the browser afterwards, the cookies that carry the session and the
 * cross-site "is anyone signed in here?" hint, and the state cookie that ties
 * a callback to the login that started it.
 *
 * Kept free of http.Server types so the rules are unit-testable on their own.
 */

/** Name of the cookie holding the openvibe.network access token. */
export const SESSION_COOKIE = 'ovg_sso'
/**
 * Cross-network hint read by the shared navbar: `account` means this browser
 * has signed in somewhere on OpenVibe (so a silent prompt=none sign-in is
 * worth attempting), `guest` means it signed out. JS-readable by design.
 */
export const SSO_HINT_COOKIE = 'ov_sso_hint'
/** Short-lived, HttpOnly: pins the OAuth `state` and the post-login `next`. */
export const LOGIN_STATE_COOKIE = 'ovg_login'

const YEAR_SECONDS = 365 * 86400
const SESSION_SECONDS = 7 * 86400
const LOGIN_STATE_SECONDS = 600

/** OAuth error codes that mean "nobody is signed in" for a prompt=none request. */
const SILENT_DENIALS = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
  'account_selection_required',
])

export function isSilentDenial(error: string | null | undefined): boolean {
  return !!error && SILENT_DENIALS.has(error)
}

export interface NextOrigins {
  /** openvibe.network — the sign-in-everywhere / sign-out-everywhere chains hop through it. */
  network: string
  /** Our own public bases (apex + play host). */
  self: string[]
}

/**
 * Validates a `next` target. Accepts a same-site path (`/play`, never `//evil`)
 * or an absolute https URL on openvibe.network or one of our own hosts.
 * Anything else yields null so an open redirect is impossible.
 */
export function safeNext(raw: string | null | undefined, origins: NextOrigins): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (value.length === 0 || value.length > 2048) return null
  if (value.startsWith('/')) {
    // Protocol-relative (`//host`) and backslash tricks are not paths.
    if (value.startsWith('//') || value.startsWith('/\\')) return null
    return value
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const allowed = [origins.network, ...origins.self]
    .map((o) => {
      try {
        return new URL(o).origin
      } catch {
        return null
      }
    })
    .filter((o): o is string => o !== null)
  return allowed.includes(url.origin) ? url.toString() : null
}

/** Appends `sso=none` to a validated `next` so the landing page knows the silent attempt found nobody. */
export function withSsoNone(next: string): string {
  const abs = /^https?:\/\//i.test(next)
  const url = new URL(next, 'http://ovg.invalid')
  url.searchParams.set('sso', 'none')
  return abs ? url.toString() : `${url.pathname}${url.search}${url.hash}`
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      out[k] = part.slice(eq + 1).trim()
    }
  }
  return out
}

export interface LoginState {
  state: string
  next: string | null
  silent: boolean
}

export function encodeLoginState(s: LoginState): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64url')
}

export function decodeLoginState(raw: string | undefined): LoginState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<LoginState>
    if (typeof parsed.state !== 'string') return null
    return {
      state: parsed.state,
      next: typeof parsed.next === 'string' ? parsed.next : null,
      silent: parsed.silent === true,
    }
  } catch {
    return null
  }
}

// ── Set-Cookie builders ────────────────────────────────────────────────
// `secure` is false only for plain-http local development, where browsers
// drop Secure cookies outright.

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

export function ssoHintCookie(value: 'account' | 'guest', secure: boolean): string {
  return `${SSO_HINT_COOKIE}=${value}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function loginStateCookie(s: LoginState, secure: boolean): string {
  return `${LOGIN_STATE_COOKIE}=${encodeLoginState(s)}; Path=/auth; Max-Age=${LOGIN_STATE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function clearLoginStateCookie(): string {
  return `${LOGIN_STATE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax`
}

/** A JS string literal that cannot close the <script> it sits in. */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * The page the callback answers with: it mirrors the session into
 * localStorage (the game client reads it from there) before moving on, so a
 * cross-origin `next` still leaves this origin signed in.
 */
export function sessionHandoffHtml(
  token: string | null,
  hint: 'account' | 'guest',
  dest: string,
): string {
  const setToken = token
    ? `localStorage.setItem('${SESSION_COOKIE}', ${jsString(token)});`
    : `localStorage.removeItem('${SESSION_COOKIE}');`
  const title = token ? 'Signing in…' : 'Signing out…'
  return `<!doctype html><title>${title}</title><script>
try { ${setToken} localStorage.setItem('${SSO_HINT_COOKIE}', ${jsString(hint)}); } catch (e) {}
location.replace(${jsString(dest)});
</script><noscript><a href="${dest.replace(/"/g, '&quot;')}">Continue</a></noscript>`
}
