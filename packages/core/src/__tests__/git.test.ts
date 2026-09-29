import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Check } from 'typebox/value'
import { type GitRunner, readGitState, runGitIn } from '../git.ts'
import { EnsoGitState } from '../index.ts'
import { findRepoRoot } from '../paths.ts'

/**
 * #453: git read in a thread's cwd, against real repositories built in a temporary directory —
 * every baseline rule, the states a working tree can be in, and the settings that keep a read from
 * writing or running anything the repository configures.
 */

const gitPath = Bun.which('git')
if (gitPath === null) throw new Error('git is not on PATH')

/** A hermetic environment: no user or system config, a fixed identity, and git on PATH. */
const home = mkdtempSync(join(tmpdir(), 'enso-git-home-'))
const environment = {
  PATH: dirname(gitPath),
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Enso',
  GIT_AUTHOR_EMAIL: 'enso@example.invalid',
  GIT_COMMITTER_NAME: 'Enso',
  GIT_COMMITTER_EMAIL: 'enso@example.invalid',
}
const runGit: GitRunner = (args, cwd) => runGitIn(environment, args, cwd)

/** git as a person at a terminal would run it — setting a repository up, not reading it. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `enso-git-${name}-`))
}

/** A repository on `main` with one commit. */
function repository(): string {
  const directory = scratch('repo')
  git(directory, 'init', '--quiet', '-b', 'main')
  commit(directory, 'README.md', 'one\n')
  return directory
}

function commit(directory: string, file: string, body: string): string {
  writeFileSync(join(directory, file), body)
  git(directory, 'add', file)
  git(directory, 'commit', '--quiet', '-m', `write ${file}`)
  return git(directory, 'rev-parse', 'HEAD').trim()
}

/** A bare remote holding `main`, and a clone of it — `origin/HEAD` set, as `git clone` sets it. */
function cloned(): { remote: string; clone: string } {
  const seed = repository()
  const remote = join(scratch('remote'), 'origin.git')
  git(seed, 'clone', '--quiet', '--bare', seed, remote)
  const clone = join(scratch('clone'), 'work')
  git(dirname(clone), 'clone', '--quiet', remote, clone)
  return { remote, clone }
}

async function read(cwd: string): Promise<EnsoGitState> {
  const state = await readGitState(runGit, cwd)
  // Every answer is the declared shape: it crosses the wire as it is.
  expect(Check(EnsoGitState, state)).toBe(true)
  return state
}

async function repositoryAt(cwd: string): Promise<Extract<EnsoGitState, { kind: 'repository' }>> {
  const state = await read(cwd)
  if (state.kind !== 'repository') throw new Error(`expected a repository, got ${JSON.stringify(state)}`)
  return state
}

test('a directory outside every repository, and one inside a git directory, are not repositories', async () => {
  expect(await read(scratch('outside'))).toEqual({ kind: 'not-a-repository' })
  expect(await read(join(repository(), '.git'))).toEqual({ kind: 'not-a-repository' })
})

test('a repository with no commit has no head and no baseline; its files are untracked', async () => {
  const directory = scratch('unborn')
  git(directory, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(directory, 'draft.md'), 'draft\n')
  const state = await repositoryAt(directory)
  expect(state).toMatchObject({
    head: null,
    branch: 'main',
    upstream: null,
    baseline: { rule: 'none', ref: null, commit: null },
    ahead: 0,
    behind: 0,
    changes: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
    operation: null,
  })
})

test('with no remote the baseline is HEAD: only uncommitted work counts', async () => {
  const directory = repository()
  const head = git(directory, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(directory, 'README.md'), 'two\n')
  const state = await repositoryAt(directory)
  expect(state.root).toBe(git(directory, 'rev-parse', '--show-toplevel').trim())
  expect(state).toMatchObject({
    head,
    baseline: { rule: 'head', ref: null, commit: head },
    ahead: 0,
    behind: 0,
    changes: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
  })
})

test('with an upstream the baseline is the last push, and staged, unstaged and untracked files are counted', async () => {
  const { clone } = cloned()
  const pushed = git(clone, 'rev-parse', 'HEAD').trim()
  commit(clone, 'local.md', 'not pushed\n')
  writeFileSync(join(clone, 'README.md'), 'edited\n')
  git(clone, 'add', 'README.md')
  writeFileSync(join(clone, 'README.md'), 'edited again\n')
  writeFileSync(join(clone, 'new.md'), 'new\n')
  const state = await repositoryAt(join(clone))
  expect(state).toMatchObject({
    branch: 'main',
    upstream: 'origin/main',
    baseline: { rule: 'upstream', ref: 'origin/main', commit: pushed },
    ahead: 1,
    behind: 0,
    // README.md is both staged and changed again since.
    changes: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
  })

  git(clone, 'push', '--quiet')
  const afterPush = await repositoryAt(clone)
  expect(afterPush.baseline.commit).toBe(afterPush.head)
  expect(afterPush.ahead).toBe(0)
})

test("⚠ someone else's fetched commits leave the baseline at the merge-base and count as behind", async () => {
  const { remote, clone } = cloned()
  const shared = git(clone, 'rev-parse', 'HEAD').trim()
  const other = join(scratch('other'), 'work')
  git(dirname(other), 'clone', '--quiet', remote, other)
  commit(other, 'theirs.md', 'theirs\n')
  git(other, 'push', '--quiet')
  commit(clone, 'mine.md', 'mine\n')
  git(clone, 'fetch', '--quiet')
  expect(await repositoryAt(clone)).toMatchObject({
    baseline: { rule: 'upstream', ref: 'origin/main', commit: shared },
    ahead: 1,
    behind: 1,
  })
})

test('a branch pushed without an upstream is measured from its remote copy', async () => {
  const { clone } = cloned()
  git(clone, 'switch', '--quiet', '-c', 'feature')
  const pushed = commit(clone, 'feature.md', 'one\n')
  git(clone, 'push', '--quiet', 'origin', 'feature')
  commit(clone, 'feature.md', 'two\n')
  expect(await repositoryAt(clone)).toMatchObject({
    branch: 'feature',
    upstream: null,
    baseline: { rule: 'remote-branch', ref: 'origin/feature', commit: pushed },
    ahead: 1,
    behind: 0,
  })
})

test("a branch never pushed is measured from where it forked from the remote's default branch", async () => {
  const { clone } = cloned()
  const forked = git(clone, 'rev-parse', 'HEAD').trim()
  git(clone, 'switch', '--quiet', '-c', 'new-work')
  commit(clone, 'a.md', 'a\n')
  commit(clone, 'b.md', 'b\n')
  expect(await repositoryAt(clone)).toMatchObject({
    branch: 'new-work',
    upstream: null,
    baseline: { rule: 'remote-default', ref: 'origin/main', commit: forked },
    ahead: 2,
  })

  // With no `origin/HEAD` symref, `origin/main` is found by name.
  git(clone, 'remote', 'set-head', 'origin', '--delete')
  expect((await repositoryAt(clone)).baseline).toEqual({ rule: 'remote-default', ref: 'origin/main', commit: forked })
})

test('a detached HEAD has no branch; the baseline falls to the remote default branch', async () => {
  const { clone } = cloned()
  const head = git(clone, 'rev-parse', 'HEAD').trim()
  git(clone, 'switch', '--quiet', '--detach')
  expect(await repositoryAt(clone)).toMatchObject({
    head,
    branch: null,
    upstream: null,
    baseline: { rule: 'remote-default', ref: 'origin/main', commit: head },
  })
})

test('a merge stopped on a conflict names the operation and counts the conflicted file', async () => {
  const directory = repository()
  git(directory, 'switch', '--quiet', '-c', 'side')
  commit(directory, 'README.md', 'side\n')
  git(directory, 'switch', '--quiet', 'main')
  commit(directory, 'README.md', 'main\n')
  expect(() => git(directory, 'merge', '--quiet', 'side')).toThrow()
  expect(await repositoryAt(directory)).toMatchObject({
    operation: 'merge',
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 1 },
  })
})

test('a path holding a newline is one file', async () => {
  const directory = repository()
  writeFileSync(join(directory, 'two\nlines.md'), 'x\n')
  mkdirSync(join(directory, 'dir'))
  writeFileSync(join(directory, 'dir', 'nested.md'), 'x\n')
  expect((await repositoryAt(directory)).changes.untracked).toBe(2)
})

test('git that cannot be started is unavailable, with a reason', async () => {
  const noGit: GitRunner = (args, cwd) => runGitIn({ PATH: scratch('empty-path') }, args, cwd)
  const state = await readGitState(noGit, repository())
  expect(state.kind).toBe('unavailable')
  expect(Check(EnsoGitState, state)).toBe(true)
})

test('⚠ a program the repository configures as its fsmonitor does not run on a read', async () => {
  const directory = repository()
  const ran = join(scratch('fsmonitor'), 'ran')
  const hook = join(directory, 'fsmonitor.sh')
  writeFileSync(hook, `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 })
  git(directory, 'config', 'core.fsmonitor', hook)
  // The config really is live: git as a person runs it, the program runs.
  git(directory, 'status', '--porcelain')
  expect(existsSync(ran)).toBe(true)
  execFileSync('rm', [ran])
  await repositoryAt(directory)
  expect(existsSync(ran)).toBe(false)
})

test('⚠ an inherited GIT_DIR naming another repository does not reach the reader', async () => {
  // #435: git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to every hook and honours them
  // over its working directory, so a server started from a hook's shell read the hook's repository
  // for every session; found when the gate ran under a worktree's pre-commit hook.
  const repoRoot = findRepoRoot(import.meta.url)
  const hookEnvironment = {
    ...environment,
    GIT_DIR: execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    GIT_WORK_TREE: repoRoot,
  }
  const outside = scratch('hook')
  // The environment really does redirect git: honoured as-is, it answers this repository's HEAD.
  const leaked = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: outside, env: hookEnvironment, encoding: 'utf8' })
  expect(leaked.trim()).toMatch(/^[0-9a-f]{40}$/)
  const underHook: GitRunner = (args, cwd) => runGitIn(hookEnvironment, args, cwd)
  expect((await runGitIn(hookEnvironment, ['rev-parse', 'HEAD'], outside)).code).not.toBe(0)
  expect(await readGitState(underHook, outside)).toEqual({ kind: 'not-a-repository' })
  // …and a cwd that IS a repository still answers its own revision.
  expect(await runGitIn(hookEnvironment, ['rev-parse', 'HEAD'], repoRoot)).toMatchObject({ code: 0, stdout: leaked })
})
