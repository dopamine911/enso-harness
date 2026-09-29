/**
 * git, read (#453) — THE one way Enso runs git: the run-context recorder's revision probe
 * (#435) and the web server's `GET /api/threads/:threadId/git` both come through {@link runGitIn}.
 * {@link readGitState} turns a cwd into an {@link EnsoGitState}, the last-push baseline included.
 *
 * ⚠ GIT IN THE GIVEN CWD, NOT THE ENVIRONMENT'S REPOSITORY. git honours an inherited `GIT_DIR` /
 * `GIT_WORK_TREE` / `GIT_INDEX_FILE` over its working directory, and git exports them to every
 * hook — so a server started from a hook's shell would read the hook's repository for every
 * session. The repository-locating variables are removed from the child's environment; found
 * under a worktree's pre-commit gate (#435).
 *
 * ⚠ READ-ONLY, AND NOTHING THE REPOSITORY CONFIGURES RUNS. Every command here only reads. The
 * agent works in the same tree and may be running git itself, so no query takes an optional lock
 * (`GIT_OPTIONAL_LOCKS=0` — `status` would otherwise refresh the index under `index.lock`). A
 * repository's own config can name programs git runs on a read: `core.fsmonitor` runs on every
 * `status`, and the agent can write `.git/config`. So `core.fsmonitor` is forced off on the
 * command line, the pager is `cat` and no prompt waits on a terminal.
 *
 * ⚠ BOUNDED. Each query is killed after {@link GIT_TIMEOUT_MS}; a killed or unstartable git is a
 * code of -1, which a reader turns into `unavailable`, never a hang.
 *
 * ⚠ node-only (`node:child_process`, `node:fs`): a subpath, `@enso/core/git`, never the barrel.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EnsoGitBaseline, EnsoGitOperation, EnsoGitRepository, EnsoGitState } from './git-state.ts'

/**
 * How long one git query may take.
 *
 * @group Git
 */
export const GIT_TIMEOUT_MS = 5000

/**
 * What a git query answered. `code` is git's exit code, or -1 when git could not be started or was
 * killed at the timeout.
 *
 * @group Git
 */
export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs git with `args` in `cwd` — the seam a test replaces.
 *
 * @group Git
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/**
 * git's repository-locating variables (`git rev-parse --local-env-vars`). ⚠ Dropped from the
 * child's environment: an inherited `GIT_DIR` — a git hook exports one, and so does anything run
 * from inside one — overrides `cwd`, and git would report THAT repository.
 */
const GIT_LOCAL_VARIABLES: Record<string, true> = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: true,
  GIT_CONFIG: true,
  GIT_CONFIG_PARAMETERS: true,
  GIT_CONFIG_COUNT: true,
  GIT_OBJECT_DIRECTORY: true,
  GIT_DIR: true,
  GIT_WORK_TREE: true,
  GIT_IMPLICIT_WORK_TREE: true,
  GIT_GRAFT_FILE: true,
  GIT_INDEX_FILE: true,
  GIT_NO_REPLACE_OBJECTS: true,
  GIT_REPLACE_REF_BASE: true,
  GIT_PREFIX: true,
  GIT_SHALLOW_FILE: true,
  GIT_COMMON_DIR: true,
}

/** What every query runs under, whatever the environment says. */
const GIT_READ_ONLY_VARIABLES = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }

/** Config forced on the command line: a program the repository names must not run on a read. */
const GIT_READ_ONLY_CONFIG = ['-c', 'core.fsmonitor=false']

/** The exit code in an `execFile` error: git's own, or -1 for a git that never ran or was killed. */
function exitCode(error: (Error & { code?: unknown; killed?: boolean }) | null): number {
  if (error === null) return 0
  return typeof error.code === 'number' && error.killed !== true ? error.code : -1
}

/**
 * git in `cwd`, under `environment` without its repository-locating variables and with the
 * read-only settings above. Exported as the test seam: a test hands in an environment, never the
 * process's.
 *
 * @group Git
 */
export function runGitIn(environment: NodeJS.ProcessEnv, args: readonly string[], cwd: string): Promise<GitResult> {
  const env = {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => GIT_LOCAL_VARIABLES[name] !== true)),
    ...GIT_READ_ONLY_VARIABLES,
  }
  const { promise, resolve } = Promise.withResolvers<GitResult>()
  execFile(
    'git',
    [...GIT_READ_ONLY_CONFIG, ...args],
    { cwd, env, timeout: GIT_TIMEOUT_MS },
    (error, stdout, stderr) => {
      resolve({ code: exitCode(error), stdout, stderr })
    },
  )
  return promise
}

/**
 * git under this process's environment — the runner production uses. The environment is read per
 * call (the quarantine may have scrubbed it since load), and is on the environment allowlist
 * (`scripts/lint/process-environment.ts`) as the seam itself: every other caller injects one.
 *
 * @group Git
 */
export const runGit: GitRunner = (args, cwd) => runGitIn(process.env, args, cwd)

// ── Reading a repository ───────────────────────────────────────────────────────────────────────

/** git's first line on stderr, for an `unavailable` reason; a git that never ran says so. */
function reasonOf(result: GitResult): string {
  const line = result.stderr.trim().split('\n')[0]?.trim()
  if (line !== undefined && line !== '') return line
  return result.code === -1 ? `git did not answer within ${GIT_TIMEOUT_MS} ms, or could not be started` : 'git failed'
}

/**
 * git's words for a cwd with no working tree (`setup.c`): outside every repository, or inside a
 * bare one or a `.git` directory, where `--show-toplevel` has nothing to name.
 */
const NOT_A_WORKING_TREE = /not a git repository|must be run in a work tree/i

/** The `git status --porcelain=v2 --branch -z` fields this reads. */
interface StatusFacts {
  head: string | null
  branch: string | null
  upstream: string | null
  changes: EnsoGitRepository['changes']
}

/**
 * `git status --porcelain=v2 --branch -z`: the `# branch.*` headers, then one record per changed
 * path. `-z` ends every record with NUL, so a path holding a newline is still one record; a
 * rename (`2`) carries its original path as a second NUL-ended field, which is skipped.
 */
function parseStatus(output: string): StatusFacts {
  const facts: StatusFacts = {
    head: null,
    branch: null,
    upstream: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  }
  const records = output.split('\0')
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex] ?? ''
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length)
      facts.head = oid === '(initial)' ? null : oid
    } else if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length)
      facts.branch = head === '(detached)' ? null : head
    } else if (record.startsWith('# branch.upstream ')) {
      facts.upstream = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      if (record[2] !== '.') facts.changes.staged += 1
      if (record[3] !== '.') facts.changes.unstaged += 1
      if (record.startsWith('2 ')) recordIndex += 1
    } else if (record.startsWith('u ')) {
      facts.changes.conflicted += 1
    } else if (record.startsWith('? ')) {
      facts.changes.untracked += 1
    }
  }
  return facts
}

/** The marker each stopped operation leaves in the git directory, checked in this order. */
const OPERATION_MARKERS: ReadonlyArray<readonly [string, EnsoGitOperation]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

/** The operation git stopped in, off the per-worktree git directory's markers. */
function operationIn(gitDirectory: string): EnsoGitOperation | null {
  for (const [marker, operation] of OPERATION_MARKERS) {
    if (existsSync(join(gitDirectory, marker))) return operation
  }
  return null
}

/** The remote a branch would push to when nothing says: `origin`, else the only remote. */
async function defaultRemote(runGit: GitRunner, cwd: string): Promise<string | null> {
  const listed = await runGit(['remote'], cwd)
  if (listed.code !== 0) return null
  const remotes = listed.stdout.split('\n').filter((remoteName) => remoteName !== '')
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? (remotes[0] ?? null) : null
}

/** `ref`'s merge-base with HEAD, or null when the ref does not resolve or shares no history. */
async function mergeBase(runGit: GitRunner, cwd: string, ref: string): Promise<string | null> {
  const base = await runGit(['merge-base', 'HEAD', ref], cwd)
  const commit = base.stdout.trim()
  return base.code === 0 && commit !== '' ? commit : null
}

/** The remote's default branch, short (`origin/main`): its `HEAD` symref, else `main`, else `master`. */
async function remoteDefaultBranch(runGit: GitRunner, cwd: string, remote: string): Promise<string | null> {
  const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], cwd)
  if (symbolic.code === 0 && symbolic.stdout.trim() !== '') return symbolic.stdout.trim()
  for (const branchName of ['main', 'master']) {
    const probe = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branchName}`], cwd)
    if (probe.code === 0) return `${remote}/${branchName}`
  }
  return null
}

/**
 * The baseline, by the first rule that finds a ref sharing history with HEAD. Every ref reaches
 * git as a full `refs/remotes/…` name, which no option or ambiguous branch name can shadow.
 */
async function resolveBaseline(runGit: GitRunner, cwd: string, status: StatusFacts): Promise<EnsoGitBaseline> {
  if (status.head === null) return { rule: 'none', ref: null, commit: null }
  if (status.upstream !== null) {
    const commit = await mergeBase(runGit, cwd, '@{upstream}')
    if (commit !== null) return { rule: 'upstream', ref: status.upstream, commit }
  }
  const remote = await defaultRemote(runGit, cwd)
  if (remote !== null && status.branch !== null) {
    const commit = await mergeBase(runGit, cwd, `refs/remotes/${remote}/${status.branch}`)
    if (commit !== null) return { rule: 'remote-branch', ref: `${remote}/${status.branch}`, commit }
  }
  if (remote !== null) {
    const ref = await remoteDefaultBranch(runGit, cwd, remote)
    const commit = ref === null ? null : await mergeBase(runGit, cwd, `refs/remotes/${ref}`)
    if (ref !== null && commit !== null) return { rule: 'remote-default', ref, commit }
  }
  return { rule: 'head', ref: null, commit: status.head }
}

/** Commits on HEAD that the baseline's ref lacks, and on the ref that HEAD lacks. */
async function aheadBehind(
  runGit: GitRunner,
  cwd: string,
  baseline: EnsoGitBaseline,
): Promise<{ ahead: number; behind: number }> {
  if (baseline.ref === null) return { ahead: 0, behind: 0 }
  const ref = baseline.rule === 'upstream' ? '@{upstream}' : `refs/remotes/${baseline.ref}`
  const counted = await runGit(['rev-list', '--left-right', '--count', `${ref}...HEAD`], cwd)
  const [behind, ahead] = counted.stdout.trim().split(/\s+/).map(Number)
  return counted.code === 0 && Number.isInteger(ahead) && Number.isInteger(behind)
    ? { ahead: ahead ?? 0, behind: behind ?? 0 }
    : { ahead: 0, behind: 0 }
}

/**
 * The git state of `cwd`: `not-a-repository` outside one, `unavailable` with git's reason when
 * git could not answer, otherwise the repository with its last-push baseline (`git-state.ts`).
 *
 * @group Git
 */
export async function readGitState(runGit: GitRunner, cwd: string): Promise<EnsoGitState> {
  const located = await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], cwd)
  if (located.code !== 0) {
    return NOT_A_WORKING_TREE.test(located.stderr)
      ? { kind: 'not-a-repository' }
      : { kind: 'unavailable', reason: reasonOf(located) }
  }
  const [root, gitDirectory] = located.stdout.trim().split('\n')
  if (root === undefined || root === '' || gitDirectory === undefined) {
    return { kind: 'unavailable', reason: 'git named no working tree' }
  }
  const statusResult = await runGit(['status', '--porcelain=v2', '--branch', '-z'], cwd)
  if (statusResult.code !== 0) return { kind: 'unavailable', reason: reasonOf(statusResult) }
  const status = parseStatus(statusResult.stdout)
  const baseline = await resolveBaseline(runGit, cwd, status)
  const { ahead, behind } = await aheadBehind(runGit, cwd, baseline)
  return {
    kind: 'repository',
    root,
    head: status.head,
    branch: status.branch,
    upstream: status.upstream,
    baseline,
    ahead,
    behind,
    changes: status.changes,
    operation: operationIn(gitDirectory),
  }
}
