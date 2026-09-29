import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Check } from 'typebox/value'
import { type GitRunner, readGitChanges, readGitState, runGitIn } from '../git.ts'
import { EnsoGitFileChange, EnsoGitState } from '../index.ts'
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

// ── What changed since the baseline (#452) ────────────────────────────────────────────────────

async function changesAt(cwd: string): Promise<Awaited<ReturnType<typeof readGitChanges>>> {
  const read = await readGitChanges(runGit, await repositoryAt(cwd))
  for (const file of read.files) expect(Check(EnsoGitFileChange, file)).toBe(true)
  return read
}

test('every change since the last push is listed: unpushed commits, staged, unstaged, deleted, renamed, new', async () => {
  const { clone } = cloned()
  writeFileSync(join(clone, 'gone.md'), 'gone\n')
  writeFileSync(join(clone, 'old-name.md'), 'a\nb\nc\nd\ne\n')
  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', 'files to change')
  git(clone, 'push', '--quiet')
  commit(clone, 'committed.md', 'not pushed\n')
  writeFileSync(join(clone, 'README.md'), 'one\ntwo\n')
  git(clone, 'add', 'README.md')
  git(clone, 'rm', '--quiet', 'gone.md')
  git(clone, 'mv', 'old-name.md', 'new-name.md')
  writeFileSync(join(clone, 'fresh.md'), 'fresh\nfile\n')
  const { files, truncated } = await changesAt(clone)
  expect(truncated).toBe(false)
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
  expect(byPath['committed.md']).toMatchObject({ status: 'added', added: 1, removed: 0, omitted: null })
  expect(byPath['README.md']).toMatchObject({ status: 'modified', added: 1, removed: 0 })
  expect(byPath['README.md']?.patch).toContain('+two')
  expect(byPath['gone.md']).toMatchObject({ status: 'deleted', added: 0, removed: 1 })
  expect(byPath['new-name.md']).toMatchObject({ status: 'renamed', oldPath: 'old-name.md', added: 0, removed: 0 })
  expect(byPath['fresh.md']).toMatchObject({ status: 'untracked', added: 2, removed: 0, omitted: null })
  expect(byPath['fresh.md']?.patch).toContain('+fresh')
  // Each patch is its own file's, not a neighbour's.
  for (const file of files.filter((change) => change.patch !== null)) expect(file.patch).toContain(file.path)

  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', 'all of it')
  git(clone, 'push', '--quiet')
  expect((await changesAt(clone)).files).toEqual([])
})

test('a binary file is listed without a patch; a large new file is not read', async () => {
  const directory = repository()
  writeFileSync(join(directory, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git(directory, 'add', 'image.bin')
  writeFileSync(join(directory, 'big.log'), 'x'.repeat(2 * 1024 * 1024))
  const { files } = await changesAt(directory)
  expect(files.find((file) => file.path === 'image.bin')).toMatchObject({
    status: 'added',
    added: null,
    removed: null,
    patch: null,
    omitted: 'binary',
  })
  expect(files.find((file) => file.path === 'big.log')).toMatchObject({
    status: 'untracked',
    added: null,
    patch: null,
    omitted: 'too-large',
  })
})

test('with no commit yet everything is compared with the empty tree', async () => {
  const directory = scratch('unborn-changes')
  git(directory, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(directory, 'staged.md'), 'staged\n')
  git(directory, 'add', 'staged.md')
  writeFileSync(join(directory, 'loose.md'), 'loose\n')
  const { files } = await changesAt(directory)
  expect(files.map((file) => [file.path, file.status])).toEqual([
    ['staged.md', 'added'],
    ['loose.md', 'untracked'],
  ])
})

test("⚠ paths are the root's from a subdirectory cwd, whatever diff.relative says", async () => {
  const directory = repository()
  mkdirSync(join(directory, 'src'))
  commit(directory, 'src/app.ts', 'one\n')
  writeFileSync(join(directory, 'src', 'app.ts'), 'two\n')
  writeFileSync(join(directory, 'README.md'), 'changed\n')
  writeFileSync(join(directory, 'top.md'), 'new at the top\n')
  git(directory, 'config', 'diff.relative', 'true')
  const { files } = await changesAt(join(directory, 'src'))
  expect(files.map((file) => file.path).sort()).toEqual(['README.md', 'src/app.ts', 'top.md'])
})

test('⚠ an external diff or textconv program the repository configures does not run', async () => {
  const directory = repository()
  const ran = join(scratch('diff-program'), 'ran')
  const program = join(directory, 'diff-program.sh')
  writeFileSync(program, `#!/bin/sh\ntouch '${ran}'\ncat "$1"\n`, { mode: 0o755 })
  git(directory, 'config', 'diff.external', program)
  git(directory, 'config', 'diff.shout.textconv', program)
  writeFileSync(join(directory, '.gitattributes'), '*.md diff=shout\n')
  writeFileSync(join(directory, 'README.md'), 'changed\n')
  // The config really is live: git as a person runs it, the program runs.
  git(directory, 'diff')
  expect(existsSync(ran)).toBe(true)
  execFileSync('rm', [ran])
  const { files } = await changesAt(directory)
  expect(existsSync(ran)).toBe(false)
  expect(files.find((file) => file.path === 'README.md')?.patch).toContain('+changed')
})

test('a nested repository is not listed as a file', async () => {
  const directory = repository()
  const nested = join(directory, 'vendor')
  mkdirSync(nested)
  git(nested, 'init', '--quiet', '-b', 'main')
  commit(nested, 'lib.ts', 'x\n')
  expect((await changesAt(directory)).files).toEqual([])
})

test('⚠ counts that do not line up with the file list are never paired by position', async () => {
  const directory = repository()
  commit(directory, 'b.md', 'one\n')
  writeFileSync(join(directory, 'README.md'), 'one\ntwo\nthree\n')
  writeFileSync(join(directory, 'b.md'), 'changed\n')
  /** The real git, with one list cut short — the mismatch a pairing by position would get wrong. */
  const shortened =
    (flag: string): GitRunner =>
    async (args, cwd) => {
      const result = await runGit(args, cwd)
      if (!args.includes(flag)) return result
      return { ...result, stdout: flag === '--numstat' ? result.stdout.split('\0').slice(1).join('\0') : '' }
    }
  const repositoryState = await repositoryAt(directory)
  // numstat short by its first record: each file's counts come from its own patch.
  const fromPatch = await readGitChanges(shortened('--numstat'), repositoryState)
  expect(fromPatch.files.map((file) => [file.path, file.added, file.removed])).toEqual([
    ['README.md', 2, 0],
    ['b.md', 1, 1],
  ])
  // With no patch to count either (the patch run's output dropped), the counts are unknown.
  const cutBoth: GitRunner = async (args, cwd) => {
    const result = await shortened('--numstat')(args, cwd)
    const isPatchRun = args[0] === 'diff' && !args.includes('--numstat') && !args.includes('--name-status')
    return isPatchRun ? { ...result, stdout: '' } : result
  }
  const unknown = await readGitChanges(cutBoth, repositoryState)
  expect(unknown.files.map((file) => [file.path, file.added, file.removed, file.omitted])).toEqual([
    ['README.md', null, null, 'too-large'],
    ['b.md', null, null, 'too-large'],
  ])
})
