/**
 * git, read (#453) — THE one way Enso runs git: the run-context recorder's revision probe
 * (#435) and the web server's `GET /api/threads/:threadId/git` both come through {@link runGitIn}.
 * {@link readGitState} turns a cwd into an {@link EnsoGitState}, the last-push baseline included;
 * {@link readGitChanges} lists every file that differs from that baseline, with its patch (#452);
 * {@link readGitFileTexts} reads one of them whole, on both sides, for the Diff view to expand (#461).
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
 * repository's own config can name programs git runs on a read, and the agent can write
 * `.git/config`: `core.fsmonitor` runs on every `status`, and a clean or process filter runs on
 * every worktree file an attribute maps to it, whenever `status` or `diff` hashes that file (#901).
 * So `core.fsmonitor` is forced off on the command line, every filter driver the config defines is
 * emptied (`filterDriverOverrides`), the pager is `cat` and no prompt waits on a terminal.
 *
 * ⚠ THE COST OF EMPTIED FILTERS: a filtered file is read as its worktree bytes, not as the filter
 * would store it. A Git LFS file is listed as changed and diffs as its content against its
 * committed pointer, and a file an `ident`-like or formatting filter rewrites shows the rewrite as
 * a change. Every other
 * attribute still applies (`eol`/`text`, `-diff`/`binary`, `diff=<driver>` hunk headers) — the
 * reason this does not read attributes from an empty tree (`--attr-source`), which also leaves
 * `.git/info/attributes` in force. ⚠ One window stays open: a driver the agent defines between the
 * config read and the command it guards is not emptied for that one command.
 *
 * ⚠ BOUNDED. Each query is killed after {@link GIT_TIMEOUT_MS}; a killed or unstartable git is a
 * code of -1, which a reader turns into `unavailable`, never a hang.
 *
 * ⚠ node-only (`node:child_process`, `node:fs`): a subpath, `@enso/core/git`, never the barrel.
 *
 * @module
 */

import { type ChildProcess, execFile } from 'node:child_process'
import { constants, existsSync, lstatSync } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  EnsoGitBaseline,
  EnsoGitFileChange,
  EnsoGitFileText,
  EnsoGitOperation,
  EnsoGitRepository,
  EnsoGitState,
} from './git-state.ts'

/**
 * How long one git query may take.
 *
 * @group Git
 */
export const GIT_TIMEOUT_MS = 5000

/**
 * The most a query may print. A diff past it is killed like a timed-out one (code -1): its reader
 * says the patches were too large, never that nothing changed.
 */
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

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

/**
 * What every query runs under, whatever the environment says. `LC_ALL: 'C'` (#568): failures are
 * sorted by git's stderr (`NOT_A_WORKING_TREE`), which git translates, so under `de_DE` a directory
 * that is no repository read as `unavailable`. `C` overrides `LANGUAGE` too; the snapshot store
 * pins the same for its reads (#567).
 */
const GIT_READ_ONLY_VARIABLES = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' }

/**
 * Config forced on the command line, whatever the repository or the user sets. No program the
 * repository names runs on a read (`core.fsmonitor` here; filter drivers, whose names the
 * repository chooses, by {@link filterDriverOverrides}), and a diff reads the way its reader parses
 * it: a blank context line keeps its leading space (`diff.suppressBlankEmpty`), and a submodule is
 * one `diff --git` part like any other file (`diff.submodule`).
 */
const GIT_READ_ONLY_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'diff.submodule=short',
]

/** The exit code in an `execFile` error: git's own, or -1 for a git that never ran or was killed. */
function exitCode(error: (Error & { code?: unknown; killed?: boolean }) | null): number {
  if (error === null) return 0
  return typeof error.code === 'number' && error.killed !== true ? error.code : -1
}

/**
 * Where a git runs and what bounds it: its directory, its whole environment, and the timeout and
 * output size past which it is killed (code -1).
 *
 * @group Git
 */
export interface GitBounds {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeout: number
  readonly maxBuffer: number
}

/**
 * git with `args` under `bounds`, settled as a `GitResult`: a git that fails is its exit code,
 * never a throw. Every git core runs goes through here — the read-only queries below, the
 * snapshot store's and the thread trees' runners, each with its own config and bounds. `child` is
 * for the runner that writes git's stdin (the snapshot store's).
 *
 * @group Git
 */
export function execGit(
  args: readonly string[],
  bounds: GitBounds,
): { readonly child: ChildProcess; readonly result: Promise<GitResult> } {
  const { promise, resolve } = Promise.withResolvers<GitResult>()
  const child = execFile('git', args, bounds, (error, stdout, stderr) => {
    resolve({ code: exitCode(error), stdout, stderr })
  })
  return { child, result: promise }
}

/**
 * `environment` without git's repository-locating variables — what every git this package runs
 * starts from, so an inherited `GIT_DIR` (a hook's shell) never names the repository. The
 * snapshot store sets its own three on top (`snapshot-store.ts`).
 *
 * @group Git
 */
export function withoutGitLocalVariables(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => GIT_LOCAL_VARIABLES[name] !== true))
}

/**
 * A repository git is pointed at rather than finds from its cwd: a bare `gitDirectory`, the
 * `workTree` it holds the files of and the `index` it reads — a thread's snapshot store
 * (`snapshot-store.ts`).
 *
 * @group Git
 */
export interface GitPlace {
  readonly gitDirectory: string
  readonly workTree: string
  readonly index: string
}

/**
 * git in `cwd`, under `environment` without its repository-locating variables and with the
 * read-only settings above — or, given a `place`, with exactly that repository's three (never an
 * inherited one). Exported as the test seam: a test hands in an environment, never the process's.
 *
 * @group Git
 */
export async function runGitIn(
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string,
  place?: GitPlace,
): Promise<GitResult> {
  const located =
    place === undefined
      ? {}
      : { GIT_DIR: place.gitDirectory, GIT_WORK_TREE: place.workTree, GIT_INDEX_FILE: place.index }
  const env = { ...withoutGitLocalVariables(environment), ...located, ...GIT_READ_ONLY_VARIABLES }
  const bounds = { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES }
  const drivers = await execGit([...GIT_READ_ONLY_CONFIG, ...FILTER_DRIVER_KEYS], bounds).result
  // 1 is "no key matched": no driver to empty. Anything else that is not an answer fails the read
  // closed, rather than running the command with a driver left live.
  if (drivers.code !== 0 && drivers.code !== 1) return drivers
  const overrides = filterDriverOverrides(drivers.code === 0 ? drivers.stdout : '')
  return execGit([...GIT_READ_ONLY_CONFIG, ...args], { ...bounds, env: { ...env, ...overrides } }).result
}

/**
 * The query naming every filter key the config defines, NUL-separated. A config read runs no
 * program; `--includes` is git's default outside `--file`, so included files count too.
 */
const FILTER_DRIVER_KEYS = ['config', '--null', '--name-only', '--get-regexp', '^filter\\.']

/**
 * Every filter driver named in `keys` (`filter.<driver>.<key>`, NUL-separated: the output of
 * {@link FILTER_DRIVER_KEYS}), emptied: no `clean`, `smudge` or `process` program, and not
 * `required`, so a file its attribute maps to is read as its worktree bytes (#901). ⚠ Passed as
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, not `-c`: a driver name may hold
 * `=`, which `-c name=value` would split at. An inherited `GIT_CONFIG_COUNT` is already dropped
 * ({@link withoutGitLocalVariables}).
 */
function filterDriverOverrides(keys: string): Record<string, string> {
  const drivers = new Set<string>()
  for (const key of keys.split('\0')) {
    const last = key.lastIndexOf('.')
    // `filter.<key>` with no driver between is no driver; git ignores it.
    if (last > 'filter.'.length) drivers.add(key.slice('filter.'.length, last))
  }
  const settings: Array<readonly [string, string]> = []
  for (const driver of drivers) {
    for (const program of ['clean', 'smudge', 'process']) settings.push([`filter.${driver}.${program}`, ''])
    settings.push([`filter.${driver}.required`, 'false'])
  }
  const overrides: Record<string, string> = {}
  if (settings.length === 0) return overrides
  overrides.GIT_CONFIG_COUNT = String(settings.length)
  for (const [settingIndex, [configKey, configValue]] of settings.entries()) {
    overrides[`GIT_CONFIG_KEY_${settingIndex}`] = configKey
    overrides[`GIT_CONFIG_VALUE_${settingIndex}`] = configValue
  }
  return overrides
}

/**
 * git under this process's environment — the runner production uses. The environment is read per
 * call (the quarantine may have scrubbed it since load), and is on the environment allowlist
 * (`scripts/lint/process-environment.ts`) as the seam itself: every other caller injects one.
 *
 * @group Git
 */
export const runGit: GitRunner = (args, cwd) => runGitIn(process.env, args, cwd)

/**
 * The environment a git child runs under, as `runGit` gives it: this process's, without git's
 * repository-locating variables. For a caller that spawns git itself, synchronously (the arena's
 * recorder, score and report). ⚠ Under a git hook — a commit's gate — `GIT_DIR` and
 * `GIT_INDEX_FILE` name the hook's repository, and a git in any other directory would read it.
 *
 * @group Git
 */
export function gitChildEnvironment(): NodeJS.ProcessEnv {
  return withoutGitLocalVariables(process.env)
}

// ── Reading a repository ───────────────────────────────────────────────────────────────────────

/**
 * git answering a read with a failure — its words, or that it never ran or answered in time — as
 * the read throws it: a caller may refuse this, and let any other fault of the read throw on.
 *
 * @group Git
 */
export class GitReadError extends Error {
  override readonly name = 'GitReadError'
}

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
    if (record.startsWith('# ')) readHeader(facts, record)
    else countChange(facts.changes, record)
    if (record.startsWith('2 ')) recordIndex += 1
  }
  return facts
}

/** A `# branch.*` header: HEAD's commit (`(initial)` before one), its branch (`(detached)`), the upstream. */
function readHeader(facts: StatusFacts, record: string): void {
  const [, key, value = ''] = /^# (branch\.\w+) (.*)$/s.exec(record) ?? []
  if (key === 'branch.oid') facts.head = value === '(initial)' ? null : value
  else if (key === 'branch.head') facts.branch = value === '(detached)' ? null : value
  else if (key === 'branch.upstream') facts.upstream = value
}

/** One changed path: `1`/`2` ordinary or renamed with its index and tree columns, `u` unmerged, `?` untracked. */
function countChange(changes: StatusFacts['changes'], record: string): void {
  const kind = record.slice(0, 2)
  if (kind === 'u ') changes.conflicted += 1
  else if (kind === '? ') changes.untracked += 1
  else if (kind === '1 ' || kind === '2 ') {
    if (record[2] !== '.') changes.staged += 1
    if (record[3] !== '.') changes.unstaged += 1
  }
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
  const located = await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix'], cwd)
  if (located.code !== 0) {
    return NOT_A_WORKING_TREE.test(located.stderr)
      ? { kind: 'not-a-repository' }
      : { kind: 'unavailable', reason: reasonOf(located) }
  }
  // `--show-prefix` prints an empty line at the top level.
  const [root, gitDirectory, scope = ''] = located.stdout.split('\n')
  if (root === undefined || root === '' || gitDirectory === undefined || gitDirectory === '') {
    return { kind: 'unavailable', reason: 'git named no working tree' }
  }
  const statusResult = await runGit(['status', '--porcelain=v2', '--branch', '-z', '--', scopePathspec(scope)], cwd)
  if (statusResult.code !== 0) return { kind: 'unavailable', reason: reasonOf(statusResult) }
  const status = parseStatus(statusResult.stdout)
  const baseline = await resolveBaseline(runGit, cwd, status)
  const { ahead, behind } = await aheadBehind(runGit, cwd, baseline)
  return {
    kind: 'repository',
    root,
    scope,
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

/**
 * The files under `scope` and nothing else: from the top level whatever the cwd (`top`), and
 * character for character, so a directory named `[x]` or `*` is not a pattern (`literal`). An empty
 * scope is the whole working tree. The one spelling of a path given to git — the snapshot store's
 * too.
 *
 * @group Git
 */
export function scopePathspec(scope: string): string {
  return `:(top,literal)${scope}`
}

// ── What changed since the baseline (#452) ─────────────────────────────────────────────────────

/** The most files a page is sent; the rest are counted as `truncated`. */
const MAX_CHANGED_FILES = 500
/** The largest patch sent for one file, in characters; a larger one is `too-large`. */
const MAX_PATCH_CHARS = 512 * 1024
/** The most patch text one answer carries; files past it are `too-large`. */
const MAX_TOTAL_PATCH_CHARS = 8 * 1024 * 1024
/** An untracked file larger than this is not read at all: `too-large`, its counts unknown. */
const MAX_UNTRACKED_BYTES = 1024 * 1024

/**
 * The diff options every changes query takes. ⚠ Nothing the repository or the user configures may
 * change what is read or run: no external diff program, no textconv filter (both run programs the
 * config names), no colour, and paths from the root whatever `diff.relative` says.
 */
const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--find-renames']

const STATUS_LETTERS: Readonly<Record<string, EnsoGitFileChange['status']>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
}

interface ListedFile {
  path: string
  oldPath: string | null
  status: EnsoGitFileChange['status']
}

/** A file's added and removed lines: null for a binary file, or when git did not count them. */
interface LineCounts {
  added: number | null
  removed: number | null
}

const UNCOUNTED: LineCounts = { added: null, removed: null }

/**
 * `git diff --raw --numstat [--patch] -z`: every file's raw record (`:modes hashes status`, then its
 * path — two paths for a rename or copy, whose status carries a similarity score, `R087`), then every
 * file's numstat record (`-` counts for a binary file; a rename's `added\tremoved\t` with its two
 * paths as their own fields), then — with `--patch` — an empty field and the unified diff, split
 * into its `diff --git` parts.
 *
 * ⚠ One run is one walk of one diff: the lists are the same files in the same order, so the
 * position pairs them (`patchesFor`). Separate runs do not — the working tree moves under a run
 * between them, and a file that stopped differing while another started would get that file's
 * patch. A status this reader does not know keeps its place, as `undefined`, and is dropped by the
 * caller.
 */
function parseDiff(output: string): {
  listed: Array<ListedFile | undefined>
  counts: LineCounts[]
  parts: string[]
} {
  const fields = output.split('\0')
  const cursor = { at: 0 }
  const listed: Array<ListedFile | undefined> = []
  while (fields[cursor.at]?.startsWith(':') === true) listed.push(readRawRecord(fields, cursor))
  const counts: LineCounts[] = []
  while (counts.length < listed.length) {
    const record = readNumstatRecord(fields, cursor)
    if (record === undefined) break
    counts.push(record)
  }
  // `--patch` separates the unified diff from the records with one empty field.
  if (fields[cursor.at] === '') cursor.at += 1
  return { listed, counts, parts: splitPatches(fields.slice(cursor.at).join('\0')) }
}

/** The raw record at the cursor, which it steps past; `undefined` for a status this reader does not know. */
function readRawRecord(fields: readonly string[], cursor: { at: number }): ListedFile | undefined {
  const score = fields[cursor.at]?.split(' ').at(-1) ?? ''
  const status = STATUS_LETTERS[score.slice(0, 1)]
  const twoPaths = status === 'renamed' || status === 'copied'
  const first = fields[cursor.at + 1] ?? ''
  cursor.at += twoPaths ? 3 : 2
  if (status === undefined) return undefined
  return twoPaths
    ? { path: fields[cursor.at - 1] ?? '', oldPath: first, status }
    : { path: first, oldPath: null, status }
}

/** The numstat record at the cursor, which it steps past; `undefined`, not stepping, when there is none. */
function readNumstatRecord(fields: readonly string[], cursor: { at: number }): LineCounts | undefined {
  const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[cursor.at] ?? '')
  if (match === null) return undefined
  // An empty path field means the two paths of a rename follow as their own fields.
  cursor.at += match[3] === '' ? 3 : 1
  return { added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]) }
}

/** One unified diff split per file: every file's part starts at its `diff --git` line. */
function splitPatches(output: string): string[] {
  return output.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '))
}

/** A patch's own counts: its `+` and `-` lines, headers aside. */
function countPatch(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) added += 1
    else if (inHunk && line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

const isBinaryPatch = (patch: string): boolean => /^(Binary files .* differ|GIT binary patch)$/m.test(patch)

/** A file's change as sent: its patch while the answer has room, `too-large` once it has not. */
function withPatch(
  file: ListedFile,
  counts: { added: number | null; removed: number | null },
  patch: string | undefined,
  budget: { left: number },
): EnsoGitFileChange {
  const change = { ...file, ...counts }
  if (patch === undefined) return { ...change, patch: null, omitted: 'unavailable' }
  if (isBinaryPatch(patch)) return { ...change, added: null, removed: null, patch: null, omitted: 'binary' }
  if (patch.length > MAX_PATCH_CHARS || patch.length > budget.left) {
    return { ...change, patch: null, omitted: 'too-large' }
  }
  budget.left -= patch.length
  return { ...change, patch, omitted: null }
}

/**
 * Each listed file's patch, in order; `undefined` when the parts do not account for the list.
 * ⚠ A type change (a file that became a symlink, or back) is TWO parts under one header — git
 * writes the old file's deletion, then the new one's creation — and is sent as both.
 */
function patchesFor(listed: ReadonlyArray<ListedFile | undefined>, parts: readonly string[]): string[] | undefined {
  const patches: string[] = []
  let partIndex = 0
  for (const file of listed) {
    const part = parts[partIndex] ?? ''
    const next = parts[partIndex + 1]
    const header = part.slice(0, part.indexOf('\n') + 1)
    const twoParts = file?.status === 'type-changed' && next?.startsWith(header) === true
    patches.push(twoParts ? part + next : part)
    partIndex += twoParts ? 2 : 1
  }
  return partIndex === parts.length ? patches : undefined
}

/** The tree git compares an unborn branch with: the empty tree, in this repository's hash. */
async function emptyTree(runGit: GitRunner, root: string): Promise<string | null> {
  const hashed = await runGit(['hash-object', '-t', 'tree', '/dev/null'], root)
  return hashed.code === 0 ? hashed.stdout.trim() : null
}

/**
 * The files `git diff <range>` lists, run from `root`, each with its patch while `budget` has room:
 * the work tree against a base (`[base, '--', scope]`), or one commit against another.
 */
async function diffedFiles(
  runGit: GitRunner,
  root: string,
  range: readonly string[],
  budget: { left: number },
): Promise<EnsoGitFileChange[]> {
  const listing = ['diff', ...DIFF_OPTIONS, '--raw', '--numstat', '-z']
  const whole = await runGit([...listing, '--patch', ...range], root)
  // Too much output to hold, or no answer in time: the files and their counts, without patches.
  const read = whole.code === 0 ? whole : await runGit([...listing, ...range], root)
  if (read.code !== 0) throw new GitReadError(reasonOf(read))
  const { listed, counts, parts } = parseDiff(read.stdout)
  // A split that does not account for the list sends no patch rather than risk pairing a file
  // with another's.
  const patches = read === whole ? patchesFor(listed, parts) : undefined
  return listed.flatMap((file, fileIndex) =>
    file === undefined || file.path === ''
      ? []
      : [withPatch(file, counts[fileIndex] ?? UNCOUNTED, patches?.[fileIndex], budget)],
  )
}

/**
 * Every file that differs between two commits of the repository `runGit` reads, `from` to `to`
 * (#553): the work tree is not looked at, so the answer is the two commits' alone, however the
 * tree has moved since. Each with its patch while the answer has room (`MAX_*` above). Throws, with
 * git's words, when either commit cannot be read.
 *
 * @group Git
 */
export async function readCommitChanges(
  runGit: GitRunner,
  place: { readonly root: string; readonly from: string; readonly to: string },
): Promise<{ files: EnsoGitFileChange[]; truncated: boolean }> {
  const files = await diffedFiles(runGit, place.root, [place.from, place.to, '--'], {
    left: MAX_TOTAL_PATCH_CHARS,
  })
  return { files: files.slice(0, MAX_CHANGED_FILES), truncated: files.length > MAX_CHANGED_FILES }
}

/**
 * One file that differs between two commits, whole on both sides (#553): the old side at `from`,
 * read from `oldPath` for a rename or copy, the new side at `to` — both from the repository's
 * objects, never the work tree. ⚠ The caller holds both paths to the tree first ({@link isPathInScope}).
 *
 * @group Git
 */
export async function readCommitFileTexts(
  runGit: GitRunner,
  place: { readonly root: string; readonly from: string; readonly to: string },
  paths: ChangedFilePaths,
): Promise<ChangedFileTexts> {
  const [oldText, newText] = await Promise.all([
    readCommittedText(runGit, place.root, place.from, paths.oldPath ?? paths.path),
    readCommittedText(runGit, place.root, place.to, paths.path),
  ])
  return { oldText, newText }
}

/**
 * One untracked file read, not yet charged against the answer's budget: `skipped` when it is too
 * big to diff at all, else its patch (`undefined` when git could not diff it) and counts.
 */
type UntrackedRead =
  | { readonly kind: 'skipped'; readonly change: EnsoGitFileChange }
  | {
      readonly kind: 'diffed'
      readonly file: ListedFile
      readonly counts: { added: number | null; removed: number | null }
      readonly patch: string | undefined
    }

/** A file git does not track yet, diffed against nothing — read only when it is small enough. */
async function readUntracked(runGit: GitRunner, root: string, path: string): Promise<UntrackedRead> {
  const file: ListedFile = { path, oldPath: null, status: 'untracked' }
  const size = lstatSync(join(root, path), { throwIfNoEntry: false })?.size ?? 0
  if (size > MAX_UNTRACKED_BYTES) {
    return { kind: 'skipped', change: { ...file, added: null, removed: null, patch: null, omitted: 'too-large' } }
  }
  // `--no-index` exits 1 when the two differ — which a new file always does against nothing.
  const diffed = await runGit(['diff', ...DIFF_OPTIONS, '--no-index', '--', '/dev/null', path], root)
  const patch = diffed.code === 0 || diffed.code === 1 ? diffed.stdout : undefined
  const counts = patch === undefined ? { added: null, removed: null } : countPatch(patch)
  return { kind: 'diffed', file, counts, patch }
}

/**
 * How many untracked files are diffed at once (#463). One git process per file, one after another,
 * cost about 1.5 ms each: 757 ms for 500 files, on every refresh of an open Changes view. Bounded,
 * so a tree of 500 new files never starts 500 processes. Exported for the test that orders the
 * answers against this limit.
 *
 * @group Git
 */
export const UNTRACKED_DIFF_CONCURRENCY = 8

/** `map` over `inputs`, at most `limit` at a time, the results in the inputs' order. */
async function mappedConcurrently<Input, Output>(
  inputs: readonly Input[],
  limit: number,
  map: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = Array.from({ length: inputs.length })
  let next = 0
  const work = async (): Promise<void> => {
    while (next < inputs.length) {
      const index = next
      next += 1
      results[index] = await map(inputs[index] as Input)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, work))
  return results
}

/**
 * What {@link readTreeChanges} compares: the work tree at `root` — the files under `scope`, `''`
 * for all of them — against `base`, a commit or tree, with the files there git does not track as
 * `listUntracked` names them.
 *
 * @group Git
 */
export interface TreeComparison {
  readonly root: string
  readonly scope: string
  readonly base: string
  /**
   * The untracked files under `scope`, relative to `root`, asked after the tracked diff. Throws
   * when they cannot be listed: no list is not an empty one — the view would say nothing differs.
   */
  readonly listUntracked: () => Promise<readonly string[]>
}

/**
 * Every file of `comparison`'s work tree that differs from its `base` — through `runGit`, run from
 * `root` so every path is the root's — and every untracked file `listUntracked` names, each with
 * its patch while the answer has room (`MAX_*` above). {@link readGitChanges} over a repository's
 * own git; a thread's copy over its snapshot store (#650, `snapshot-store.ts`).
 *
 * @group Git
 */
export async function readTreeChanges(
  runGit: GitRunner,
  comparison: TreeComparison,
): Promise<{ files: EnsoGitFileChange[]; truncated: boolean }> {
  const budget = { left: MAX_TOTAL_PATCH_CHARS }
  // Tracked files under `scope` that differ from `base`, in the working tree: committed, staged or not.
  const tracked = await diffedFiles(
    runGit,
    comparison.root,
    [comparison.base, '--', scopePathspec(comparison.scope)],
    budget,
  )
  // A nested repository is listed as its directory (`vendor/lib/`), which has no diff of its own.
  const untrackedPaths = (await comparison.listUntracked()).filter((path) => path !== '' && !path.endsWith('/'))
  const room = Math.max(0, MAX_CHANGED_FILES - tracked.length)
  const reads = await mappedConcurrently(untrackedPaths.slice(0, room), UNTRACKED_DIFF_CONCURRENCY, (path) =>
    readUntracked(runGit, comparison.root, path),
  )
  // Charged in list order, after every diff is back: which file runs out of room never depends
  // on which git process finished first.
  const untracked = reads.map((read) =>
    read.kind === 'skipped' ? read.change : withPatch(read.file, read.counts, read.patch, budget),
  )
  return {
    files: [...tracked.slice(0, MAX_CHANGED_FILES), ...untracked],
    truncated: tracked.length > MAX_CHANGED_FILES || untrackedPaths.length > room,
  }
}

/**
 * Every file under `repository.scope` that differs from its baseline commit — commits not yet
 * pushed, staged and unstaged edits, deletions, renames — and every untracked file there, each with
 * its patch while the answer has room (`MAX_*` above). ⚠ Only the scope: a project inside a larger
 * repository (a dotfiles repository at `$HOME`) sends its own files, never its neighbours'. Run from
 * the repository's root, so every path is the root's. A baseline of `none` (no commit yet) compares
 * with the empty tree.
 *
 * @group Git
 */
export async function readGitChanges(
  runGit: GitRunner,
  repository: EnsoGitRepository,
): Promise<{ files: EnsoGitFileChange[]; truncated: boolean }> {
  const { root, scope } = repository
  const base = repository.baseline.commit ?? (await emptyTree(runGit, root))
  if (base === null) throw new Error('git could not name the empty tree to compare with')
  return readTreeChanges(runGit, {
    root,
    scope,
    base,
    listUntracked: async () => {
      const listed = await runGit(
        ['ls-files', '--others', '--exclude-standard', '-z', '--', scopePathspec(scope)],
        root,
      )
      if (listed.code !== 0) throw new Error(reasonOf(listed))
      return listed.stdout.split('\0')
    },
  })
}

// ── One changed file, whole (#461) ─────────────────────────────────────────────────────────────

/**
 * The largest file whose text is sent, either side, in bytes — the 512 KiB one file's patch may be
 * ({@link MAX_PATCH_CHARS}). A side past it is `too-large`; the Diff view cannot expand a file
 * whose old side is past it (the runs come from the old side alone), and says so.
 */
const MAX_FILE_TEXT_BYTES = 512 * 1024

/**
 * Whether `path` names a file under `scope` and nothing else (#461): relative to the root,
 * `/`-separated, no empty, `.` or `..` segment, no NUL, and starting with `scope` — `''` for the
 * whole tree, else `/`-ended ({@link EnsoGitRepository}'s `scope`). ⚠ THE LIMIT #456 SET, held for
 * a file the page names: a project inside a dotfiles repository at `$HOME` reads its own files,
 * never another file under home.
 *
 * @group Git
 */
export function isPathInScope(scope: string, path: string): boolean {
  if (path.includes('\0') || !path.startsWith(scope)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * A changed file's two paths: now, and at the baseline when it was renamed or copied.
 *
 * @group Git
 */
export interface ChangedFilePaths {
  readonly path: string
  readonly oldPath: string | null
}

/**
 * A changed file's two sides, each its text or why not.
 *
 * @group Git
 */
export interface ChangedFileTexts {
  readonly oldText: EnsoGitFileText
  readonly newText: EnsoGitFileText
}

/**
 * Whether the work tree's file is one the changes may list: listed, not listed (ignored), or the
 * listing failed, in git's or the store's words.
 *
 * @group Git
 */
export type WorkTreeListing = 'listed' | 'not-listed' | { readonly failed: string }

/**
 * Where {@link readFileTexts} reads a changed file: from `root`, the old side at `base` — `null`
 * before the first commit, where there is no old side — and the new side in the work tree.
 *
 * @group Git
 */
export interface FileTextPlace {
  readonly root: string
  readonly base: string | null
  /**
   * Whether the work tree's `path` is a file the changes may list — tracked, or untracked and not
   * ignored. One that is not is never read: an ignored `.env` is no more shown than listed.
   */
  readonly listed: (path: string) => Promise<WorkTreeListing>
}

const NO_FILE: EnsoGitFileText = { kind: 'none' }

const unreadable = (reason: string): EnsoGitFileText => ({ kind: 'unavailable', reason })

/** A file's text as sent: binary when it holds a NUL, as git decides it. */
const textOf = (text: string): EnsoGitFileText => (text.includes('\0') ? { kind: 'binary' } : { kind: 'text', text })

/** `git ls-tree -l -z` records: `<mode> <type> <object> <size>\t<path>`, NUL-ended. */
const TREE_ENTRY = /^\d+ (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s

/** The blob `path` names in `ls-tree`'s output, with its size; `undefined` for none. */
function blobIn(listing: string, path: string): { readonly object: string; readonly size: number } | undefined {
  for (const record of listing.split('\0')) {
    const entry = TREE_ENTRY.exec(record)
    if (entry?.[1] === 'blob' && entry[4] === path) return { object: entry[2] ?? '', size: Number(entry[3]) }
  }
  return undefined
}

/**
 * `path`'s text at `base`. ⚠ `cat-file blob` prints the object as stored: no textconv, filter or
 * eol conversion runs unless asked for (`--textconv`, `--filters`), so nothing the repository
 * configures runs here — the guarantee `git show --no-textconv` would give, with the size read first.
 */
async function readCommittedText(
  runGit: GitRunner,
  root: string,
  base: string,
  path: string,
): Promise<EnsoGitFileText> {
  const listed = await runGit(['ls-tree', '-l', '-z', base, '--', scopePathspec(path)], root)
  if (listed.code !== 0) return unreadable(reasonOf(listed))
  const blob = blobIn(listed.stdout, path)
  if (blob === undefined) return NO_FILE
  if (blob.size > MAX_FILE_TEXT_BYTES) return { kind: 'too-large', bytes: blob.size }
  const shown = await runGit(['cat-file', 'blob', blob.object], root)
  return shown.code === 0 ? textOf(shown.stdout) : unreadable(reasonOf(shown))
}

const LINKED = unreadable('a symbolic link, which is not followed')

/**
 * `path`'s text in the work tree; none when nothing is there — a deleted file, or one under a
 * directory that became a file. ⚠ NEVER THROUGH A SYMBOLIC LINK: a link inside the scope can point
 * anywhere, so the file's real path must be the one asked for — no link on the way — and it is
 * opened `O_NOFOLLOW`. That guards only the last name, and the agent writes the tree meanwhile: a
 * directory on the way may become a link between the check and the open. So the check runs again
 * after the open, and the path must still name the very file opened (its device and inode). Then
 * it is held to a regular file of at most {@link MAX_FILE_TEXT_BYTES}, and no more than its size
 * at the open is read. A file the changes would not list is not read.
 */
async function readWorkTreeText(place: FileTextPlace, path: string): Promise<EnsoGitFileText> {
  const asked = join(await realpath(place.root), path)
  try {
    if ((await realpath(asked)) !== asked) return LINKED
    const listing = await place.listed(path)
    if (listing === 'not-listed') return unreadable('not a file the changes list: an ignored one')
    if (listing !== 'listed') return unreadable(`whether the changes list it is unknown: ${listing.failed}`)
    const file = await open(asked, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const facts = await file.stat()
      if ((await realpath(asked)) !== asked) return LINKED
      const there = await lstat(asked)
      if (there.dev !== facts.dev || there.ino !== facts.ino) return unreadable('the file moved while it was read')
      if (!facts.isFile()) return unreadable('not a regular file')
      if (facts.size > MAX_FILE_TEXT_BYTES) return { kind: 'too-large', bytes: facts.size }
      return await textUpTo(file, facts.size)
    } finally {
      await file.close()
    }
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') return NO_FILE
    return unreadable(error instanceof Error ? error.message : String(error))
  }
}

/**
 * The open `file`'s text, `size` bytes as its stat gave — one byte more is asked for, so a file
 * that grew since is caught rather than read on past the cap.
 */
async function textUpTo(file: FileHandle, size: number): Promise<EnsoGitFileText> {
  const buffer = Buffer.alloc(size + 1)
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  if (filled > size) return unreadable('the file grew while it was read')
  return textOf(buffer.toString('utf8', 0, filled))
}

/**
 * One changed file whole, on both sides (#461): the old side at `place.base`, read from `oldPath`
 * for a rename or copy, and the new side in the work tree — what the Diff view expands the lines
 * between hunks from. Each side is its text, or why not: none there, too large, binary, unreadable.
 * ⚠ The caller holds both paths to the scope first ({@link isPathInScope}); this reads what it is given.
 *
 * @group Git
 */
export async function readFileTexts(
  runGit: GitRunner,
  place: FileTextPlace,
  paths: ChangedFilePaths,
): Promise<ChangedFileTexts> {
  const [oldText, newText] = await Promise.all([
    place.base === null ? NO_FILE : readCommittedText(runGit, place.root, place.base, paths.oldPath ?? paths.path),
    readWorkTreeText(place, paths.path),
  ])
  return { oldText, newText }
}

/**
 * One changed file of `repository` whole ({@link readFileTexts}): the old side at the baseline
 * commit — none before the first commit — and the new side if git lists it: tracked, or untracked
 * and not ignored, as {@link readGitChanges} lists files.
 *
 * @group Git
 */
export function readGitFileTexts(
  runGit: GitRunner,
  repository: EnsoGitRepository,
  paths: ChangedFilePaths,
): Promise<ChangedFileTexts> {
  const { root } = repository
  return readFileTexts(
    runGit,
    {
      root,
      base: repository.baseline.commit,
      listed: async (path) => {
        const found = await runGit(
          ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', scopePathspec(path)],
          root,
        )
        if (found.code !== 0) return { failed: reasonOf(found) }
        return found.stdout.split('\0').includes(path) ? 'listed' : 'not-listed'
      },
    },
    paths,
  )
}
