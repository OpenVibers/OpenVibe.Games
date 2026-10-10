import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy games` (OpenVibe.Host, strategy
 * pnpm-build; roadmap WS-N task 11). A fake ovhost records what the wrapper asks for.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WRAPPER = join(ROOT, 'deploy', 'scripts', 'deploy.sh')
const tmp = mkdtempSync(join(tmpdir(), 'games-deploy-wrapper-'))
const log = join(tmp, 'calls.log')
const ovhost = join(tmp, 'ovhost')
writeFileSync(
  ovhost,
  `#!/usr/bin/env bash
echo "ovhost $*" >> "${log}"
exit "\${FAKE_EXIT:-0}"
`,
)
chmodSync(ovhost, 0o755)
interface Run {
  code: number | null
  out: string
  calls: string[]
}

function run(args: string[] = [], env: Record<string, string> = {}): Run {
  rmSync(log, { force: true })
  const r = spawnSync('bash', [WRAPPER, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      OVHOST: ovhost,
      OVHOST_SUDO: '',
      ...env,
    },
    encoding: 'utf8',
  })
  let calls: string[] = []
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    calls = []
  }
  return { code: r.status, out: r.stdout + r.stderr, calls }
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('deploy/scripts/deploy.sh', () => {
  it('maps its flags onto ovhost deploy|rollback|plan games', () => {
    expect(run().calls).toEqual(['ovhost deploy games'])
    expect(run(['--wait-idle']).calls).toEqual(['ovhost deploy games --wait-idle'])
    expect(run(['--restart']).calls).toEqual(['ovhost deploy games --restart'])
    expect(run(['--rollback']).calls).toEqual(['ovhost rollback games'])
    expect(run([], { DRY_RUN: '1' }).calls).toEqual(['ovhost plan games'])
    expect(run([], { FAKE_EXIT: '3' }).code).toBe(3)
    expect(run(['--nope']).code).toBe(1)
  })

  it('exits with a clear error when ovhost is missing', () => {
    for (const args of [[], ['--rollback'], ['--wait-idle']]) {
      const r = run(args, { OVHOST: join(tmp, 'missing') })
      expect(r.code).toBe(1)
      expect(r.calls).toEqual([])
      expect(r.out).toMatch(/ovhost not found/)
    }
  })

  it('has no legacy deploy path', () => {
    expect(existsSync(join(ROOT, 'deploy', 'scripts', 'deploy-legacy.sh'))).toBe(false)
    expect(readFileSync(WRAPPER, 'utf8')).toMatch(/^set -euo pipefail$/m)
    expect(readFileSync(WRAPPER, 'utf8')).not.toMatch(/legacy|capabilities/i)
  })
})
