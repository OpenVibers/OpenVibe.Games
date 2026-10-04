/**
 * ADR-0007 completion audit: the authoritative server is Babylon-free.
 *
 * Deleting Havok (ADR-0007 decision 2) removes `@babylonjs/core` and the
 * NullEngine scene from the server; the server now runs Rapier only. That win
 * is invisible to the type checker and to behavioural tests — a stray Babylon
 * import "works" — so it needs a test of its own or the renderer quietly creeps
 * back into the authoritative process.
 *
 * Only ACTIVE code counts: a mention in a comment is not an import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = new URL('../../../', import.meta.url).pathname
const ROOT = 'apps/server'

/** Server sources that legitimately mention Babylon: only this audit, which names the forbidden module. */
const ALLOWED = ['apps/server/src/architectureAudit.audit.ts']

interface SourceFile {
  path: string
  text: string
}

function collect(): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-types') continue
        walk(full)
        continue
      }
      if (!['.ts', '.tsx'].includes(extname(entry))) continue
      const rel = relative(REPO, full)
      if (ALLOWED.some((a) => rel === a)) continue
      out.push({ path: rel, text: readFileSync(full, 'utf8') })
    }
  }
  walk(join(REPO, ROOT))
  return out
}

const FILES = collect()

/** Occurrences outside comments — a mention in prose is not an import. */
function activeHits(needle: RegExp): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = []
  for (const f of FILES) {
    let inBlockComment = false
    f.text.split('\n').forEach((raw, i) => {
      const line = raw.trim()
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false
        return
      }
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlockComment = true
        return
      }
      if (line.startsWith('//') || line.startsWith('*')) return
      if (needle.test(raw)) hits.push({ path: f.path, line: i + 1, text: line.slice(0, 110) })
    })
  }
  return hits
}

const report = (hits: { path: string; line: number; text: string }[]): string =>
  hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join('\n')

describe('architecture audit: the server is Babylon-free (ADR-0007)', () => {
  it('scans a meaningful number of server source files', () => {
    expect(FILES.length).toBeGreaterThan(40)
  })

  it('imports no @babylonjs/* anywhere in the server', () => {
    expect(report(activeHits(/@babylonjs\//))).toBe('')
  })

  it('drives Rapier (not Havok) and has no Havok loader', () => {
    // Positive half of the claim: the server names Rapier and nothing else.
    const main = FILES.find((f) => f.path === 'apps/server/src/main.ts')
    expect(main, 'server main.ts should exist').toBeDefined()
    expect(main!.text).toContain('@openvibe/physics/rapier')
    expect(main!.text).not.toMatch(/havok/i)
  })
})
