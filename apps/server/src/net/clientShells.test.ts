import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Every client shell defers the shared scripts (the inline colours above cover the first paint) and
// preconnects to openvibe.network once, with crossorigin, before theme-loader runs.
const clientDir = join(dirname(fileURLToPath(import.meta.url)), '../../../client')
const shells = readdirSync(clientDir).filter((f) => f.endsWith('.html')).sort()

describe('client shells', () => {
  it('has shells to check', () => {
    expect(shells.length).toBeGreaterThanOrEqual(8)
  })
  for (const name of shells) {
    it(`${name}: deferred shared scripts + one crossorigin preconnect`, () => {
      const html = readFileSync(join(clientDir, name), 'utf8')
      for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
        const tag = m[0]
        if (!/\ssrc\s*=\s*"\/shared\//.test(tag)) continue
        expect(/\bdefer\b|\basync\b/.test(tag) || /type\s*=\s*"module"/.test(tag)).toBe(true)
      }
      const pcs = [...html.matchAll(/<link rel="preconnect" href="https:\/\/openvibe\.network"[^>]*>/g)]
      expect(pcs.length).toBe(1)
      expect(pcs[0][0]).toContain('crossorigin')
      expect(html).toContain('<script src="/shared/theme-loader.js" defer></script>')
      expect(html).toContain('<script src="/shared/navbar.js" defer></script>')
    })
  }
})
