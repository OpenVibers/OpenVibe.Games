/**
 * Editor credential resolution (ADR-0007 "Deleted": the shared editor key is gone).
 *
 * The editor is a Network staff session with `staff.games.manage`. The same
 * `ovg_sso` cookie the rest of the site sets is what the editor uses; the
 * page sends it as a Bearer token on every request. No key prompt, no
 * manual override.
 */

export function ssoToken(): string {
  // The shared navbar / OAuth callback stores the Network access token as
  // `ovg_sso` (see main.ts and frame.js); it also arrives as a cookie. The
  // editor is same-origin as /play, so it reads the same value back here.
  const stored = localStorage.getItem('ovg_sso')
  if (stored) return stored
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('ovg_sso='))
  return cookie ? decodeURIComponent(cookie.slice('ovg_sso='.length)) : ''
}

/** What every editor call carries as Authorization: Bearer …. */
export function editorToken(): string {
  return ssoToken()
}
