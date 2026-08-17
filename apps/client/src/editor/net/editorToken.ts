/**
 * Editor credential resolution. An explicitly typed admin token always wins
 * (the EDITOR_KEY shared-secret path still works without SSO); otherwise the
 * OpenVibe SSO session from the game (`ovg_sso`, same origin as /play) is
 * used, so admins and owners never have to paste anything — the server
 * validates the token against OpenVibe and checks admin/owner rank.
 */

export function ssoToken(): string {
  const stored = localStorage.getItem('ovg_sso')
  if (stored) return stored
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('ovg_sso='))
  return cookie ? decodeURIComponent(cookie.slice('ovg_sso='.length)) : ''
}

export function editorToken(): string {
  const manual =
    (document.getElementById('key') as HTMLInputElement | null)?.value.trim() ?? ''
  return manual || ssoToken()
}
