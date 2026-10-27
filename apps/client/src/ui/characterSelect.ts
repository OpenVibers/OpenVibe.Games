import { MAX_CHARACTERS, type Appearance } from '@openvibe/protocol'

/**
 * Character select: your characters in this game, and a "New character" button. There is no slot count to unlock
 * (owner, 2026-10-27: the character slot restriction "shouldn't be one of the built-in features of the site"): signed in
 * or a guest, you keep as many as you like up to MAX_CHARACTERS, a technical ceiling. Signing in keeps them on every
 * device. Pure DOM overlay: resolves with the chosen slot and, for an existing character, its saved identity.
 */
export interface CharacterInfo {
  slot: number
  name: string
  appearance: Appearance | null
}

export function characterSelect(
  uiRoot: HTMLElement,
  characters: CharacterInfo[],
  authed: boolean,
): Promise<{ slot: number; existing: CharacterInfo | null }> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'customize-overlay'
    const panel = document.createElement('div')
    panel.className = 'customize-panel'
    panel.innerHTML = '<h1>CHOOSE YOUR SCRAPPER</h1>'
    const pick = (slot: number, existing: CharacterInfo | null) => {
      overlay.remove()
      resolve({ slot, existing })
    }
    const row = (label: string, sub: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cust-btn char-slot'
      const name = document.createElement('b')
      name.textContent = label
      const small = document.createElement('span')
      small.textContent = sub
      b.append(name, small)
      b.addEventListener('click', onClick)
      return b
    }
    const mine = [...characters].sort((a, b) => a.slot - b.slot)
    for (const c of mine) panel.appendChild(row(c.name, 'Play', () => pick(c.slot, c)))
    const used = new Set(mine.map((c) => c.slot))
    let free = 0
    while (free < MAX_CHARACTERS && used.has(free)) free++
    if (free < MAX_CHARACTERS) {
      panel.appendChild(row('＋ New character', mine.length ? 'Start another scrapper' : 'Make your scrapper', () => pick(free, null)))
    }
    if (authed) {
      const bar = document.createElement('div')
      bar.className = 'char-authbar'
      bar.innerHTML = '<span>✓ Signed in via OpenVibe</span>'
      const out = document.createElement('button')
      out.className = 'char-logout'
      out.textContent = 'Log out'
      out.addEventListener('click', () => {
        // Server-side sign-out: drops the session cookie, marks the browser a
        // guest for the network's silent sign-in, clears localStorage, reloads.
        location.href = `/auth/logout?next=${encodeURIComponent(location.pathname)}`
      })
      bar.appendChild(out)
      panel.appendChild(bar)
    }
    if (!authed) {
      const upsell = document.createElement('div')
      upsell.className = 'char-upsell'
      upsell.textContent =
        'As a guest, your characters live in this browser: they can be lost if its data is cleared. ' +
        'Sign in to keep them, and your progress, on every device.'
      panel.appendChild(upsell)
      const btn = document.createElement('button')
      btn.className = 'cust-btn char-sso-btn'
      btn.textContent = '🔑 Sign in with OpenVibe'
      btn.addEventListener('click', () => {
        location.href = '/auth/login'
      })
      panel.appendChild(btn)
    }
    overlay.appendChild(panel)
    uiRoot.appendChild(overlay)
  })
}
