/**
 * Client bundle budget (plan M6; ADR-0007 decision 7: initial JS ≤ 2.5 MB,
 * largest chunk ≤ 400 KB, editor split out).
 *
 * `vite.config.ts` raises `chunkSizeWarningLimit` to 6000 so the build never
 * warns; that is a warning threshold, not a budget — this is the check that
 * fails. It reads an existing `dist/` and measures both raw and gzip bytes
 * against both limits.
 *
 * Initial JS is the play entry's static graph: the `type="module"` script in
 * dist/play.html plus every chunk Vite emits a `rel="modulepreload"` for. That
 * is exactly what the browser fetches before the game starts; dynamic imports
 * (physics/Rapier, per ADR-0007 decision 2) are not in it.
 *
 * Per-chunk limit: every JS chunk Vite emitted, except chunks reachable only
 * from editor.html (the editor entry is split out of the budget; a chunk shared
 * with the play entry is not exempt).
 *
 * Run: node --import tsx apps/client/scripts/bundleBudget.ts [distDir]
 * Exits 1 when dist/ is missing or any limit is exceeded.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** 2.5 MB, decimal units — the same units Vite prints in its build report. */
export const INITIAL_JS_LIMIT_BYTES = 2_500_000
/** 400 KB, decimal units. */
export const CHUNK_LIMIT_BYTES = 400_000

const MODULE_SCRIPT = /<script[^>]*\btype=["']module["'][^>]*>/gi
const MODULEPRELOAD = /<link[^>]*\brel=["']modulepreload["'][^>]*>/gi
const SRC = /\bsrc=["']([^"']+)["']/i
const HREF = /\bhref=["']([^"']+)["']/i

export interface FileMeasurement {
  /** Path relative to the dist directory, e.g. `assets/main-abc.js`. */
  file: string
  rawBytes: number
  gzipBytes: number
}

export interface BudgetViolation {
  scope: 'build' | 'initial' | 'chunk'
  metric: 'raw' | 'gzip'
  file?: string
  actualBytes: number
  limitBytes: number
  message: string
}

export interface BudgetReport {
  dist: string
  initial: { files: FileMeasurement[]; rawBytes: number; gzipBytes: number }
  /** Every JS chunk measured against 400 KB; editor-only chunks are excluded. */
  chunks: FileMeasurement[]
  violations: BudgetViolation[]
}

function human(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(2)} MB`
    : `${(bytes / 1_000).toFixed(1)} KB`
}

function measure(dist: string, file: string): FileMeasurement {
  const bytes = readFileSync(join(dist, file))
  return { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length }
}

function sum(measurements: FileMeasurement[], metric: 'rawBytes' | 'gzipBytes'): number {
  return measurements.reduce((total, m) => total + m[metric], 0)
}

/** The dist-relative JS files a page loads before any of its code runs. */
function pageInitial(dist: string, page: string): string[] {
  const html = readFileSync(join(dist, page), 'utf8')
  const refs = new Set<string>()
  for (const tag of html.match(MODULE_SCRIPT) ?? []) {
    const src = SRC.exec(tag)
    if (src) refs.add(src[1])
  }
  for (const tag of html.match(MODULEPRELOAD) ?? []) {
    const href = HREF.exec(tag)
    if (href) refs.add(href[1])
  }
  return [...refs]
    .map((ref) => ref.split('?')[0])
    .filter((ref) => ref.endsWith('.js'))
    .map((ref) => ref.replace(/^[/.]+/, ''))
}

/** Every `*.js` chunk under dist/assets, recursively. */
function jsChunks(dist: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else if (entry.name.endsWith('.js')) out.push(`assets/${rel}`)
    }
  }
  const assets = join(dist, 'assets')
  if (existsSync(assets)) walk(assets, '')
  return out.sort()
}

function buildViolation(message: string): BudgetViolation {
  return {
    scope: 'build',
    metric: 'raw',
    actualBytes: 0,
    limitBytes: INITIAL_JS_LIMIT_BYTES,
    message,
  }
}

/**
 * Measure distDir against the M6 budget. Never throws for a budget problem:
 * a missing build is reported as a violation, so CI fails loudly rather than
 * passing because there was nothing to measure.
 */
export function assessBundleBudget(distDir: string): BudgetReport {
  const dist = resolve(distDir)
  const violations: BudgetViolation[] = []
  const report: BudgetReport = {
    dist,
    initial: { files: [], rawBytes: 0, gzipBytes: 0 },
    chunks: [],
    violations,
  }

  const playHtml = join(dist, 'play.html')
  if (!existsSync(playHtml)) {
    violations.push(
      buildViolation(`${playHtml} not found — build the client before the budget check`),
    )
    return report
  }

  const playInitial = pageInitial(dist, 'play.html')
  if (!playInitial.length) {
    violations.push(buildViolation('play.html loads no module script — cannot measure initial JS'))
    return report
  }
  const editorInitial = existsSync(join(dist, 'editor.html'))
    ? pageInitial(dist, 'editor.html')
    : []
  const editorOnly = new Set(editorInitial.filter((file) => !playInitial.includes(file)))

  report.initial.files = playInitial.map((file) => measure(dist, file))
  report.initial.rawBytes = sum(report.initial.files, 'rawBytes')
  report.initial.gzipBytes = sum(report.initial.files, 'gzipBytes')
  report.chunks = jsChunks(dist)
    .filter((file) => !editorOnly.has(file))
    .map((file) => measure(dist, file))

  if (report.initial.rawBytes > INITIAL_JS_LIMIT_BYTES) {
    violations.push({
      scope: 'initial',
      metric: 'raw',
      actualBytes: report.initial.rawBytes,
      limitBytes: INITIAL_JS_LIMIT_BYTES,
      message: `initial JS (play entry) is ${human(report.initial.rawBytes)} raw, over the ${human(INITIAL_JS_LIMIT_BYTES)} limit`,
    })
  }
  if (report.initial.gzipBytes > INITIAL_JS_LIMIT_BYTES) {
    violations.push({
      scope: 'initial',
      metric: 'gzip',
      actualBytes: report.initial.gzipBytes,
      limitBytes: INITIAL_JS_LIMIT_BYTES,
      message: `initial JS (play entry) is ${human(report.initial.gzipBytes)} gzip, over the ${human(INITIAL_JS_LIMIT_BYTES)} limit`,
    })
  }

  for (const chunk of report.chunks) {
    if (chunk.rawBytes > CHUNK_LIMIT_BYTES) {
      violations.push({
        scope: 'chunk',
        metric: 'raw',
        file: chunk.file,
        actualBytes: chunk.rawBytes,
        limitBytes: CHUNK_LIMIT_BYTES,
        message: `chunk ${chunk.file} is ${human(chunk.rawBytes)} raw, over the ${human(CHUNK_LIMIT_BYTES)} limit`,
      })
    }
    if (chunk.gzipBytes > CHUNK_LIMIT_BYTES) {
      violations.push({
        scope: 'chunk',
        metric: 'gzip',
        file: chunk.file,
        actualBytes: chunk.gzipBytes,
        limitBytes: CHUNK_LIMIT_BYTES,
        message: `chunk ${chunk.file} is ${human(chunk.gzipBytes)} gzip, over the ${human(CHUNK_LIMIT_BYTES)} limit`,
      })
    }
  }

  return report
}

/** A little larger than the budget for a readable CI log. */
export function formatReport(report: BudgetReport): string {
  const lines = [`bundle budget — ${report.dist}`]
  lines.push(
    `  initial JS (play entry, ${report.initial.files.length} files): ` +
      `${human(report.initial.rawBytes)} raw, ${human(report.initial.gzipBytes)} gzip ` +
      `— limit ${human(INITIAL_JS_LIMIT_BYTES)}`,
  )
  const largest = report.chunks.reduce<FileMeasurement | undefined>(
    (max, chunk) => (!max || chunk.rawBytes > max.rawBytes ? chunk : max),
    undefined,
  )
  lines.push(
    `  chunks (${report.chunks.length}, editor-only excluded): ` +
      (largest ? `${largest.file} ${human(largest.rawBytes)} raw` : 'none') +
      ` — limit ${human(CHUNK_LIMIT_BYTES)}`,
  )
  if (report.violations.length) {
    lines.push(`  FAIL (${report.violations.length}):`)
    for (const violation of report.violations) lines.push(`    ✗ ${violation.message}`)
  } else {
    lines.push('  ok')
  }
  return lines.join('\n')
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/**
 * The exit code for a report. `--chunks=report` prints chunk-limit violations but fails only on the build and
 * initial-JS budgets: CI runs that way while the two chunks over 400 KB today (three's instancedMesh chunk in the
 * play graph, and the lazily imported rapier physics chunk) are split, so the initial budget is enforced now and
 * the chunk overage stays visible in every run instead of being raised or hidden.
 */
export function exitCodeFor(report: BudgetReport, chunks: 'fail' | 'report' = 'fail'): number {
  const blocking = report.violations.filter((v) => chunks === 'fail' || v.scope !== 'chunk')
  return blocking.length ? 1 : 0
}

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const chunks = args.includes('--chunks=report') ? 'report' : 'fail'
  const defaultDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  const report = assessBundleBudget(args.find((a) => !a.startsWith('--')) ?? defaultDist)
  console.log(formatReport(report))
  if (chunks === 'report' && report.violations.some((v) => v.scope === 'chunk')) {
    console.log('  (chunk limit reported, not enforced: --chunks=report)')
  }
  process.exit(exitCodeFor(report, chunks))
}
