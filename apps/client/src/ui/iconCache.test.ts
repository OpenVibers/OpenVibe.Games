import { describe, expect, it } from 'vitest'
import { ICON_RECIPE, IconCache, iconKey } from './iconCache.js'

/** A Storage with a byte quota, like a browser's. */
function fakeStorage(quota = Infinity) {
  const m = new Map<string, string>()
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0)
  return {
    m,
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (used() - (m.get(k)?.length ?? 0) + v.length + k.length > quota)
        throw new Error('QuotaExceededError')
      m.set(k, v)
    },
    removeItem: (k: string) => void m.delete(k),
  }
}

const PNG = 'data:image/png;base64,' + 'A'.repeat(300)

describe('iconKey', () => {
  it('names the look and the recipe, not only the item', () => {
    const box = { shape: { type: 'box', size: [1, 1, 1] }, color: '#aa6633' }
    expect(iconKey('crate', box)).toBe(iconKey('crate', { ...box }))
    expect(iconKey('crate', box)).not.toBe(iconKey('crate', { ...box, color: '#336699' }))
    expect(iconKey('crate', box)).not.toBe(iconKey('barrel', box))
    expect(iconKey('crate', box).startsWith(`ovg.icon.${ICON_RECIPE}.crate.`)).toBe(true)
  })
})

describe('IconCache', () => {
  it('keeps an icon across sessions and refuses what is not a picture', () => {
    const storage = fakeStorage()
    new IconCache(storage).set('ovg.icon.1.crate.0', PNG)
    expect(new IconCache(storage).get('ovg.icon.1.crate.0')).toBe(PNG)
    storage.setItem('ovg.icon.1.bad.0', 'not an image')
    expect(new IconCache(storage).get('ovg.icon.1.bad.0')).toBeNull()
  })

  it('drops the icons of older recipes and leaves other keys alone', () => {
    const storage = fakeStorage()
    storage.setItem(`ovg.icon.${ICON_RECIPE + 1000}.crate.0`, PNG)
    storage.setItem(`ovg.icon.${ICON_RECIPE}.crate.0`, PNG)
    storage.setItem('ovg_sso', 'keep')
    new IconCache(storage).clear(true)
    expect([...storage.m.keys()].sort()).toEqual([`ovg.icon.${ICON_RECIPE}.crate.0`, 'ovg_sso'])
  })

  it('when storage is full, clears its own icons once and stores the new one', () => {
    const storage = fakeStorage(1000)
    const cache = new IconCache(storage)
    cache.set('ovg.icon.1.a.0', PNG)
    cache.set('ovg.icon.1.b.0', PNG)
    storage.setItem('ovg_sso', 'keep')
    cache.set('ovg.icon.1.c.0', PNG)
    expect(cache.get('ovg.icon.1.c.0')).toBe(PNG)
    expect(cache.get('ovg.icon.1.a.0')).toBeNull()
    expect(storage.getItem('ovg_sso')).toBe('keep')
  })

  it('without storage, or with storage that throws, it is a cache that keeps nothing', () => {
    const none = new IconCache(null)
    none.set('k', PNG)
    expect(none.get('k')).toBeNull()
    const throwing = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => undefined,
    }
    const c = new IconCache(throwing)
    expect(() => c.set('k', PNG)).not.toThrow()
    expect(c.get('k')).toBeNull()
  })
})
