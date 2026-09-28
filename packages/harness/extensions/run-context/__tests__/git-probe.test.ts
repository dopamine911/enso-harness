import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findRepoRoot } from '@enso/core/paths'
import { runGitIn } from '../index.ts'

/**
 * #435: the run-context git probe asks the SESSION's cwd, whatever repository the environment
 * names. git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to every hook and honours them over
 * its working directory, so a server started from a hook's shell recorded the hook's repository for
 * every session; found when the gate ran under a worktree's pre-commit hook.
 */

const repoRoot = findRepoRoot(import.meta.url)
const gitPath = Bun.which('git')
if (gitPath === null) throw new Error('git is not on PATH')
/** An environment naming THIS repository, as a hook's would — the only other variable is where git is. */
const hookEnvironment = {
  PATH: dirname(gitPath),
  GIT_DIR: execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  GIT_WORK_TREE: repoRoot,
}

test('⚠ an inherited GIT_DIR naming another repository does not reach the probe: a non-repository cwd has no revision', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'enso-git-probe-'))
  // The environment really does redirect git: honoured as-is, it answers this repository's HEAD.
  const leaked = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: outside, env: hookEnvironment, encoding: 'utf8' })
  expect(leaked.trim()).toMatch(/^[0-9a-f]{40}$/)
  expect((await runGitIn(hookEnvironment, ['rev-parse', 'HEAD'], outside)).code).not.toBe(0)
  // …and a cwd that IS a repository still answers its own revision.
  const inside = await runGitIn(hookEnvironment, ['rev-parse', 'HEAD'], repoRoot)
  expect(inside).toEqual({ code: 0, stdout: leaked })
})
