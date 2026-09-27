import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy games` (OpenVibe.Host, strategy
 * pnpm-build; roadmap WS-N task 11), with deploy-legacy.sh (the production procedure as it was run by
 * hand) as its fallback. A fake ovhost records what the wrapper asks for; a fake legacy script records
 * the fallback.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WRAPPER = join(ROOT, 'deploy', 'scripts', 'deploy.sh')
const tmp = mkdtempSync(join(tmpdir(), 'games-deploy-wrapper-'))
const log = join(tmp, 'calls.log')
const ovhost = join(tmp, 'ovhost')
writeFileSync(
  ovhost,
  `#!/usr/bin/env bash
if [ "$1" = capabilities ]; then
  [ -n "$FAKE_OLD" ] && exit 1
  printf '%b\\n' "\${FAKE_CAPS:-ovhost=0.3.0\\ndeploy-api=1\\nservice=games\\nstrategy=pnpm-build\\nmanaged=yes\\nlayout=git}"
  exit 0
fi
echo "ovhost $*" >> "${log}"
exit "\${FAKE_EXIT:-0}"
`,
)
chmodSync(ovhost, 0o755)
const legacy = join(tmp, 'legacy.sh')
writeFileSync(legacy, `#!/usr/bin/env bash\necho "legacy" >> "${log}"\n`)
chmodSync(legacy, 0o755)

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
      DEPLOY_LEGACY: legacy,
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

  it('falls back to deploy-legacy.sh when ovhost is missing, too old or not deploying games with pnpm-build', () => {
    let r = run([], { FAKE_OLD: '1' })
    expect(r.calls).toEqual(['legacy'])
    expect(r.out).toMatch(/too old/)
    r = run([], { FAKE_CAPS: 'deploy-api=1\\nstrategy=none\\nmanaged=no' })
    expect(r.calls).toEqual(['legacy'])
    expect(r.out).toMatch(/does not deploy games with strategy pnpm-build \(none\)/)
    expect(run([], { OVHOST: join(tmp, 'missing') }).calls).toEqual(['legacy'])
    // The legacy procedure cannot roll back, wait for idle or plan: nothing runs rather than something else.
    for (const args of [['--rollback'], ['--wait-idle']]) {
      r = run(args, { OVHOST_LEGACY: '1' })
      expect(r.code).toBe(1)
      expect(r.calls).toEqual([])
    }
  })

  it('keeps the production procedure as the fallback', () => {
    const text = readFileSync(join(ROOT, 'deploy', 'scripts', 'deploy-legacy.sh'), 'utf8')
    for (const step of [
      'sudo git -c safe.directory="$REPO" pull',
      'pnpm install --frozen-lockfile',
      'pnpm build',
      'sudo systemctl restart openvibe-games',
    ]) {
      expect(text).toContain(step)
    }
    expect(readFileSync(WRAPPER, 'utf8')).toMatch(/^set -euo pipefail$/m)
  })
})
