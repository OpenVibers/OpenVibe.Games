import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Repository hygiene: no `node_modules` is tracked.
 *
 * pnpm can leave a project's `node_modules` as a symlink — the agent worktrees point theirs at a
 * sibling checkout. `.gitignore` spells the rule without the trailing slash because git does not
 * treat a symlink as a directory, so `node_modules/` would leave those symlinks visible to
 * `git add -A`. One committed by accident reaches CI as a dangling link, and
 * `pnpm install --frozen-lockfile` then dies in linkDirectDepsOfProject with ENOENT before a single
 * test runs. The ignore rule keeps them out; this is what fails if one is tracked anyway.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('repository hygiene', () => {
  it('tracks no node_modules', () => {
    if (!existsSync(join(ROOT, '.git'))) return // an exported copy has no index to check
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
    expect(tracked.filter((path) => path.split('/').includes('node_modules'))).toEqual([])
  })
})
