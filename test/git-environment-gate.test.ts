import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPOSITORY_ROOT, sourceFiles } from './gate-support.ts'

/**
 * ⚠ A TEST THAT RUNS `git init` GIVES ITS GIT AN ENVIRONMENT OF ITS OWN.
 *
 * The gate runs inside the pre-commit hook, where git exports `GIT_DIR` (and `GIT_INDEX_FILE`) naming
 * THIS repository. A git child that inherits them ignores its `cwd`: a `git init` meant for a scratch
 * folder re-initialises the real repository instead. On 2026-10-14 a test did exactly that and set
 * `core.bare = true` in the shared `.git/config`. From then on every checkout and worktree refused to
 * work ("this operation must be run in a work tree"), and the local review worker's reviews failed,
 * until the owner restored the setting by hand.
 *
 * So a test file that runs `git init` must pass its git calls an explicit environment: `env:` built
 * by the test, or `gitChildEnvironment()` / `withoutGitLocalVariables()` from
 * `packages/core/src/git.ts` (#453), which drop git's repository-locating variables.
 *
 * Its limit, named: this is a per-file check. A file with one `env:` somewhere and a different, bare
 * `git init` call would pass. Every file that runs `git init` today routes all its git calls through
 * one helper that sets the environment, which is the shape this check holds.
 */

/** A git call that initialises a repository: `'init'` as an argument, as every test here passes it. */
const GIT_INIT_ARGUMENT = /['"]init['"]/
/** What gives a git child its own environment. */
const EXPLICIT_GIT_ENVIRONMENT = /\benv:|gitChildEnvironment\(|withoutGitLocalVariables\(/
const ROOTS = ['packages', 'scripts', 'test'] as const

test('⚠ every test file that runs git init gives its git calls an environment of their own (no inherited GIT_DIR)', () => {
  const testFiles = ROOTS.flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root), true)).filter((path) =>
    /\.test\.tsx?$/.test(path),
  )
  const initializing = testFiles.filter((path) => GIT_INIT_ARGUMENT.test(readFileSync(path, 'utf8')))
  const offenders = initializing
    .filter((path) => !EXPLICIT_GIT_ENVIRONMENT.test(readFileSync(path, 'utf8')))
    .map((path) => relative(REPOSITORY_ROOT, path))
  expect(offenders).toEqual([])
  // A floor: a walk that found no git-initialising test would pass with nothing checked.
  expect(initializing.length).toBeGreaterThan(3)
})
