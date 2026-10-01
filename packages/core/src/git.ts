/**
 * git, read (#453) — THE one way Enso runs git: the run-context recorder's revision probe
 * (#435) and the web server's `GET /api/threads/:threadId/git` both come through {@link runGitIn}.
 * {@link readGitState} turns a cwd into an {@link EnsoGitState}, the last-push baseline included;
 * {@link readGitChanges} lists every file that differs from that baseline, with its patch (#452).
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
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EnsoGitBaseline,
  EnsoGitFileChange,
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

/** What every query runs under, whatever the environment says. */
const GIT_READ_ONLY_VARIABLES = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }

/**
 * Config forced on the command line, whatever the repository or the user sets. No program the
 * repository names runs on a read (`core.fsmonitor`), and a diff reads the way its reader parses
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
 * git in `cwd`, under `environment` without its repository-locating variables and with the
 * read-only settings above. Exported as the test seam: a test hands in an environment, never the
 * process's.
 *
 * @group Git
 */
export function runGitIn(environment: NodeJS.ProcessEnv, args: readonly string[], cwd: string): Promise<GitResult> {
  const env = { ...withoutGitLocalVariables(environment), ...GIT_READ_ONLY_VARIABLES }
  const { promise, resolve } = Promise.withResolvers<GitResult>()
  execFile(
    'git',
    [...GIT_READ_ONLY_CONFIG, ...args],
    { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES },
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
 * scope is the whole working tree.
 */
function scopePathspec(scope: string): string {
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

/** Tracked files under `scope` that differ from `base`, in the working tree: committed, staged or not. */
async function trackedChanges(
  runGit: GitRunner,
  repository: EnsoGitRepository,
  base: string,
  budget: { left: number },
): Promise<EnsoGitFileChange[]> {
  const listing = ['diff', ...DIFF_OPTIONS, '--raw', '--numstat', '-z']
  const range = [base, '--', scopePathspec(repository.scope)]
  const whole = await runGit([...listing, '--patch', ...range], repository.root)
  // Too much output to hold, or no answer in time: the files and their counts, without patches.
  const read = whole.code === 0 ? whole : await runGit([...listing, ...range], repository.root)
  if (read.code !== 0) throw new Error(reasonOf(read))
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

/** A file git does not track yet, diffed against nothing — read only when it is small enough. */
async function untrackedChange(
  runGit: GitRunner,
  root: string,
  path: string,
  budget: { left: number },
): Promise<EnsoGitFileChange> {
  const file: ListedFile = { path, oldPath: null, status: 'untracked' }
  const size = lstatSync(join(root, path), { throwIfNoEntry: false })?.size ?? 0
  if (size > MAX_UNTRACKED_BYTES) return { ...file, added: null, removed: null, patch: null, omitted: 'too-large' }
  // `--no-index` exits 1 when the two differ — which a new file always does against nothing.
  const diffed = await runGit(['diff', ...DIFF_OPTIONS, '--no-index', '--', '/dev/null', path], root)
  const patch = diffed.code === 0 || diffed.code === 1 ? diffed.stdout : undefined
  const counts = patch === undefined ? { added: null, removed: null } : countPatch(patch)
  return withPatch(file, counts, patch, budget)
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
  const { root } = repository
  const base = repository.baseline.commit ?? (await emptyTree(runGit, root))
  if (base === null) throw new Error('git could not name the empty tree to compare with')
  const budget = { left: MAX_TOTAL_PATCH_CHARS }
  const tracked = await trackedChanges(runGit, repository, base, budget)
  const listed = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', scopePathspec(repository.scope)],
    root,
  )
  // No list is not an empty one: the view would say nothing differs.
  if (listed.code !== 0) throw new Error(reasonOf(listed))
  // A nested repository is listed as its directory (`vendor/lib/`), which has no diff of its own.
  const untrackedPaths = listed.stdout.split('\0').filter((path) => path !== '' && !path.endsWith('/'))
  const room = Math.max(0, MAX_CHANGED_FILES - tracked.length)
  const untracked: EnsoGitFileChange[] = []
  for (const path of untrackedPaths.slice(0, room)) untracked.push(await untrackedChange(runGit, root, path, budget))
  return {
    files: [...tracked.slice(0, MAX_CHANGED_FILES), ...untracked],
    truncated: tracked.length > MAX_CHANGED_FILES || untrackedPaths.length > room,
  }
}
