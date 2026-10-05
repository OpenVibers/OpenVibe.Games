/**
 * The negative cases the budget check exists for: a synthetic dist/ with one
 * file over a limit must fail, and a chunk reachable only from the editor
 * entry must not (ADR-0007 decision 7: editor split out). The real dist/ is
 * measured by the CI step, not here.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHUNK_LIMIT_BYTES,
  INITIAL_JS_LIMIT_BYTES,
  assessBundleBudget,
  exitCodeFor,
  formatReport,
} from './bundleBudget.js'

const tmpDirs: string[] = []

function makeDist(files: Record<string, string | Buffer>): string {
  const dist = mkdtempSync(join(tmpdir(), 'ov-games-budget-'))
  tmpDirs.push(dist)
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dist, name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dist
}

/** A page whose module script is `entry` and whose static preloads are `preloads`. */
function page(entry: string, preloads: string[] = []): string {
  const links = preloads.map((href) => `<link rel="modulepreload" href="${href}">`).join('\n')
  return `<script type="module" crossorigin src="${entry}"></script>\n${links}\n`
}

const filler = (bytes: number, fill = 0x61): Buffer => Buffer.alloc(bytes, fill)

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('bundle budget', () => {
  it('report mode still fails an initial-JS overage', () => {
    const dist = makeDist({
      'play.html': page('/assets/main.js'),
      'assets/main.js': filler(INITIAL_JS_LIMIT_BYTES + 1),
    })
    const report = assessBundleBudget(dist)
    expect(report.violations.some((v) => v.scope === 'initial')).toBe(true)
    expect(exitCodeFor(report, 'report')).toBe(1)
  })

  it('passes within budget, and exempts a chunk only the editor entry loads', () => {
    const dist = makeDist({
      'play.html': page('/assets/main.js', ['/assets/vendor.js', '/assets/lazy.js']),
      'editor.html': page('/assets/editor.js', ['/assets/editor-only-big.js']),
      'assets/main.js': filler(1_000),
      'assets/vendor.js': filler(1_000),
      'assets/lazy.js': filler(10_000),
      'assets/editor.js': filler(1_000),
      'assets/editor-only-big.js': filler(CHUNK_LIMIT_BYTES + 1),
    })
    const report = assessBundleBudget(dist)
    expect(report.violations).toEqual([])
    expect(report.initial.files.map((f) => f.file)).toEqual([
      'assets/main.js',
      'assets/vendor.js',
      'assets/lazy.js',
    ])
    expect(report.chunks.map((c) => c.file)).not.toContain('assets/editor-only-big.js')
    expect(formatReport(report)).toContain('ok')
  })

  it('fails a play-path chunk over the raw chunk limit', () => {
    const dist = makeDist({
      'play.html': page('/assets/main.js'),
      'assets/main.js': filler(1_000),
      'assets/lazy.js': filler(CHUNK_LIMIT_BYTES + 1),
    })
    const report = assessBundleBudget(dist)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      scope: 'chunk',
      metric: 'raw',
      file: 'assets/lazy.js',
      limitBytes: CHUNK_LIMIT_BYTES,
    })
    expect(formatReport(report)).toContain('FAIL')
    expect(exitCodeFor(report)).toBe(1)
    expect(exitCodeFor(report, 'report')).toBe(0)
  })

  it('fails when the initial graph exceeds 2.5 MB even with every chunk under 400 KB', () => {
    // Seven chunks exactly at (not over) the chunk limit: 2.8 MB initial total.
    const preloads = Array.from({ length: 7 }, (_, i) => `/assets/v${i}.js`)
    const files: Record<string, string | Buffer> = {
      'play.html': page('/assets/main.js', preloads),
      'assets/main.js': filler(1_000),
    }
    for (const href of preloads) files[href.slice(1)] = filler(CHUNK_LIMIT_BYTES)
    const report = assessBundleBudget(makeDist(files))
    expect(report.initial.rawBytes).toBeGreaterThan(INITIAL_JS_LIMIT_BYTES)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({ scope: 'initial', metric: 'raw' })
  })

  it('fails a chunk over the gzip limit but under the raw limit', () => {
    const incompressible = randomBytes(CHUNK_LIMIT_BYTES - 1)
    const dist = makeDist({
      'play.html': page('/assets/main.js'),
      'assets/main.js': filler(1_000),
      'assets/lazy.js': incompressible,
    })
    const report = assessBundleBudget(dist)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      scope: 'chunk',
      metric: 'gzip',
      file: 'assets/lazy.js',
    })
  })

  it('fails instead of passing when there is no build to measure', () => {
    const dist = makeDist({ 'assets/main.js': filler(1_000) })
    const report = assessBundleBudget(dist)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].scope).toBe('build')
    expect(formatReport(report)).toContain('FAIL')
  })
})
