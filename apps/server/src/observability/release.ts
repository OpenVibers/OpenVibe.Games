import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * GET /release.json (ADR-016, roadmap D43): what this deployment is, in the manifest shape the other
 * OpenVibe services serve through openvibe-shared/release. The release id is RELEASE_SHA when set,
 * otherwise the checked-out commit read from .git (no child process). Public deployment facts only.
 */
export interface ReleaseManifest {
  service: string
  release: string
  released_at: string | null
  booted_at: string
  contracts_version: string | null
  packages: Record<string, string>
  min_client_release: string | null
  mixed_version_window_hours: number
  components: Record<string, { kind: string; version: string }>
  schema_generation: null
  schema_compatible_from: null
  contract_ranges: Record<string, string>
}

/** The commit checked out at `start` or the nearest parent with a .git (HEAD, a loose ref, or packed-refs), or null. */
export function gitCommit(start: string): string | null {
  let root = start
  for (let i = 0; i < 5 && !existsSync(join(root, '.git')); i++) root = dirname(root)
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1]
    if (!ref) return null
    try {
      const sha = readFileSync(join(root, '.git', ref), 'utf8').trim()
      if (/^[0-9a-f]{40}$/.test(sha)) return sha
    } catch {
      /* packed */
    }
    const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const [sha, name] = line.split(' ')
      if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha
    }
  } catch {
    /* not a checkout */
  }
  return null
}

function versionOf(req: NodeRequire, name: string): string | null {
  try {
    return (req(`${name}/package.json`) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

export function buildRelease(
  root: string,
  { env = process.env, now = () => new Date() }: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): ReleaseManifest {
  const sha = (env.RELEASE_SHA && /^[0-9a-f]{7,40}$/.test(env.RELEASE_SHA) ? env.RELEASE_SHA : gitCommit(root)) ?? 'unknown'
  const release = sha.slice(0, 12)
  const req = createRequire(import.meta.url)
  const packages: Record<string, string> = {}
  for (const name of ['openvibe-sdk', 'openvibe-contracts']) {
    const v = versionOf(req, name)
    if (v) packages[name] = v
  }
  return {
    service: 'games',
    release,
    released_at: null,
    booted_at: now().toISOString(),
    contracts_version: packages['openvibe-contracts'] ?? null,
    packages,
    min_client_release: env.MIN_CLIENT_RELEASE ?? null,
    mixed_version_window_hours: 24,
    components: { client: { kind: 'script', version: release }, server: { kind: 'server', version: release } },
    schema_generation: null,
    schema_compatible_from: null,
    contract_ranges: {},
  }
}

/** Answers GET /release.json (returns true), else false. */
export function releaseHandler(manifest: ReleaseManifest) {
  const body = JSON.stringify(manifest)
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if ((req.url ?? '').split('?')[0] !== '/release.json' || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }
}

/** A request from this machine that did not come through the proxy (nginx sets the client-IP headers). */
export function isDirectLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? ''
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  const h = req.headers
  return loop && !h['x-forwarded-for'] && !h['x-real-ip'] && !h['cf-connecting-ip']
}

/**
 * The metrics snapshot in Prometheus text format (Track O): every finite number becomes a gauge
 * games_<snake_case key>; nested objects and non-numbers are skipped.
 */
export function prometheusText(snapshot: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(snapshot)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const name = `games_${k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()}`
    lines.push(`# TYPE ${name} gauge`, `${name} ${v}`)
  }
  return `${lines.join('\n')}\n`
}

/** Does this scrape ask for the text format (Prometheus sends text/plain or OpenMetrics in Accept)? */
export function wantsPrometheus(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? '')
  const q = (req.url ?? '').split('?')[1] ?? ''
  return /text\/plain|openmetrics/i.test(accept) || /(^|&)format=prometheus(&|$)/.test(q)
}
