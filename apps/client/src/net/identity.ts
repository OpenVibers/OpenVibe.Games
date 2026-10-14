/**
 * The browser's Games identity, shared by every game on the site: a guest token (letters and digits) kept in
 * localStorage with a long-lived cookie as backup, and the Network session the sign-in left in `ovg_sso`.
 */
/**
 * Guest identity token: localStorage primary, a long-lived cookie as backup
 * (survives localStorage wipes, and works where an in-app browser refuses storage).
 */
export function getIdentity(): { token: string; name: string | null } {
  const cookieTok = document.cookie
    .split('; ')
    .find((c) => c.startsWith('openvibe.token='))
    ?.slice('openvibe.token='.length)
  let stored: string | null = null
  let name: string | null = null
  try {
    stored = localStorage.getItem('openvibe.token')
    name = localStorage.getItem('openvibe.name')
  } catch {
    stored = null
  }
  let token = stored ?? cookieTok ?? null
  if (!token || !/^[a-z0-9]{8,64}$/i.test(token)) {
    token = crypto.randomUUID().replaceAll('-', '').slice(0, 32)
  }
  try {
    localStorage.setItem('openvibe.token', token)
  } catch {
    /* the cookie below still keeps it */
  }
  document.cookie = `openvibe.token=${token}; Path=/; Max-Age=${400 * 86400}; SameSite=Lax`
  return { token, name }
}

export function saveName(name: string): void {
  localStorage.setItem('openvibe.name', name)
}

/** The openvibe.network access token this browser holds for the site (set by /auth/callback), if any. */
export function sessionToken(): string | undefined {
  let stored: string | null = null
  try {
    stored = localStorage.getItem('ovg_sso')
  } catch {
    stored = null
  }
  const cookie = document.cookie
    .split('; ')
    .find((c) => c.startsWith('ovg_sso='))
    ?.slice('ovg_sso='.length)
  return stored ?? (cookie ? decodeURIComponent(cookie) : undefined)
}

/** Forgets a session the server called expired, so the page carries on as the guest. */
export function forgetSession(): void {
  try {
    localStorage.removeItem('ovg_sso')
  } catch {
    /* storage unavailable */
  }
  document.cookie = 'ovg_sso=; Path=/; Max-Age=0; SameSite=Lax'
}
