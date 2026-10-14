/**
 * Baked inventory icons (plan M6). The icon factory renders each item's model into a 128 px picture; this keeps the
 * pictures in the browser's storage, so a returning player's hotbar and inventory show them at once and the first
 * seconds of a session no longer spend render passes on them.
 *
 * Items come from content packs and mods at runtime, so icons cannot be baked at build time: they are baked here, the
 * first time each one is drawn. A key names what the picture shows (the item's visual: its tool kind, or its shape
 * and colour) and how it is drawn (ICON_RECIPE), never only the item id: an item whose look changes, or a change to
 * the lighting or camera, gets a new key and is drawn again. Storage that is missing, full or refusing (private
 * windows, blocked site data) only means drawing every time, as before.
 */

/** Bump when the icon scene's lighting, camera or size changes: every stored icon is drawn again. */
export const ICON_RECIPE = 1
const PREFIX = 'ovg.icon.'

type IconStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/** FNV-1a, 32 bits, as 8 hex characters: a short stable name for a visual description. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** The storage key of one item's icon: its id, the hash of what it looks like, and the recipe. */
export function iconKey(defId: string, visual: unknown): string {
  return `${PREFIX}${ICON_RECIPE}.${defId}.${hash(JSON.stringify(visual ?? null))}`
}

function storageOrNull(): IconStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export class IconCache {
  constructor(private readonly storage: IconStorage | null = storageOrNull()) {}

  get(key: string): string | null {
    try {
      const v = this.storage?.getItem(key) ?? null
      return v && v.startsWith('data:image/') ? v : null
    } catch {
      return null
    }
  }

  /** Store one icon; storage full → drop every stored icon once and try again, then give up quietly. */
  set(key: string, dataUrl: string): void {
    if (!this.storage) return
    try {
      this.storage.setItem(key, dataUrl)
    } catch {
      this.clear()
      try {
        this.storage.setItem(key, dataUrl)
      } catch {
        // Still refused: this browser keeps no icons; they are drawn each session.
      }
    }
  }

  /** Remove every stored icon, or (`olderRecipesOnly`) those drawn by another recipe, which nothing reads again. */
  clear(olderRecipesOnly = false): void {
    if (!this.storage) return
    const current = `${PREFIX}${ICON_RECIPE}.`
    try {
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i)
        if (k?.startsWith(PREFIX) && !(olderRecipesOnly && k.startsWith(current))) keys.push(k)
      }
      for (const k of keys) this.storage.removeItem(k)
    } catch {
      // Storage went away: nothing to clear.
    }
  }
}
