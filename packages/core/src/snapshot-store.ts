/**
 * The per-thread snapshot store (#551 slice 1, after #146's source reads): a bare git repository
 * beside the thread's session that records what its tree looked like when each run began.
 *
 * ⚠ THE TREE'S OWN `.git` IS NEVER WRITTEN. Every git that writes runs with `GIT_DIR` at the store,
 * `GIT_WORK_TREE` at the tree and `GIT_INDEX_FILE` at the store's own index — the mechanic
 * `@ayulab/pi-checkpoint` uses (borrowed, not adopted: GPL-3.0). The user's repository is only
 * read, with `GIT_OPTIONAL_LOCKS=0` as `@enso/core/git` reads it: at mint, its object directory,
 * named in `objects/info/alternates` so a base snapshot writes no blob the checkout already holds,
 * and — when the tree is the repository's top level — its index, copied as the store's seed, so a
 * snapshot re-hashes only files whose stat changed (measured: a 3k-file tree mints in 2.2 s
 * unseeded, in milliseconds seeded — #551); at every snapshot, the list of the files it holds.
 *
 * ⚠ WHAT A SNAPSHOT IS: the checkout's tracked set plus its unignored untracked files — never a
 * force-add — AS THE TREE'S REPOSITORY LISTS THEM (`ls-files --cached --others --exclude-standard`),
 * then staged into the store's index exactly. The repository applies every ignore rule itself
 * (#566): the `.gitignore` files ABOVE a subdirectory project and `info/exclude` too, which the
 * store — its work tree the project — would never see. Ignores apply to the untracked remainder
 * only, so a tracked file that a later rule covers stays in (vx-pm: 4,696 of 5,701 tracked files
 * are under an ignored `screenshots/` directory), and `.env`-shaped files, ignored AND untracked,
 * stay out of the store. The tree's `.git` is excluded by git itself; a nested repository is a
 * gitlink, its contents not captured — stated, not hidden.
 *
 * ⚠ A COPY HAS NO REPOSITORY: IT FOLLOWS ITS PROJECT'S (#566). A store told it holds a copy of a
 * project (`copyOf`, recorded in the store) lists the copy as the store's own tracked set plus the
 * copy's untracked files that neither the copy's own `.gitignore` files nor the PROJECT's
 * repository ignore (`check-ignore`, run in the project) — so a `node_modules` installed or a
 * `.env` written in a copy of `repo/packages/app` stays out, as it would in the checkout. A tree in
 * no repository, copy or not, has the store's own rules only: its `.gitignore` files and
 * `core.excludesFile`.
 *
 * ⚠ KEYED TO OUR RECORD, NOT pi's ENTRY (#555 rule 5). The store names a snapshot by its commit
 * hash alone; the link to a point in the conversation is the `enso-run-context` record that
 * carries the hash. Nothing here knows a session entry id.
 *
 * ⚠ BOUNDED, SERIALIZED, NEVER A THROW INTO A HOOK. Each git is killed past
 * {@link SNAPSHOT_TIMEOUT_MS}; the calls on one store run one at a time (git's own `index.lock`
 * would refuse a second anyway); a failure is a `GitResult` with a non-zero code for the caller to
 * record as `snapshot: null`.
 *
 * ⚠ MATERIALIZING WRITES THE TREE, NEVER ITS `.git` (#551 slice 2). {@link materializeSnapshot}
 * makes a tree's files exactly a snapshot's — the store's index, `checkout-index`, then each file
 * the tree held under the same listing that the snapshot lacks, removed — still through the
 * store's own variables. Ignored files are never touched: they are the tree's own (`.env`, build
 * output), and no snapshot ever held them.
 *
 * ⚠ node-only (`node:child_process`, `node:fs`): a subpath, `@enso/core/snapshot-store`, never the barrel.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { exitCode, type GitResult, runGitIn, withoutGitLocalVariables } from './git.ts'

/**
 * How long one git of the store may take. A mint on an unseeded 100k-file tree is the slow case;
 * a seeded turn is milliseconds (#551's measurement).
 *
 * @group Snapshot store
 */
export const SNAPSHOT_TIMEOUT_MS = 60_000

/**
 * The most one git may print: a listing names every file the tree holds (#566). Past it the git is
 * killed (code -1) and the snapshot refused — never taken from half a list.
 */
const SNAPSHOT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * What the store writes under, whatever the tree or the user configures: an identity (a commit
 * needs one; `enso@invalid` is nobody's address), no signing, no file monitor, no hooks (the store
 * is bare and fresh, but `core.hooksPath` from the user's global config would still apply).
 */
const SNAPSHOT_CONFIG = [
  '-c',
  'user.name=enso',
  '-c',
  'user.email=enso@invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
]

/** The file in a store naming the project its tree is a copy of (#566), when it is one. */
const COPY_OF_FILE = 'enso-copy-of'

/**
 * One snapshot's outcome: the commit that names the tree as it was, and whether it differs from
 * the store's last one. The first snapshot of a store is `changed: true`.
 *
 * @group Snapshot store
 */
export interface SnapshotTaken {
  readonly hash: string
  readonly changed: boolean
}

/**
 * Why a snapshot could not be taken: the git that failed, with its exit code and stderr.
 *
 * @group Snapshot store
 */
export interface SnapshotRefused {
  readonly step: string
  readonly code: number
  readonly stderr: string
}

/**
 * A thread's store, open: snapshots of one tree into one bare repository.
 *
 * @group Snapshot store
 */
export interface SnapshotStore {
  /** The bare repository. */
  readonly directory: string
  /** The tree it snapshots — pi's cwd for the thread. */
  readonly tree: string
  /** The tree as it is now, as a commit: a new one when it differs from the last, else the last. */
  snapshot(): Promise<{ kind: 'taken'; taken: SnapshotTaken } | { kind: 'refused'; refused: SnapshotRefused }>
}

/** A store and the tree it is opened for. */
interface StorePlace {
  readonly directory: string
  readonly tree: string
}

/** A git that failed, as the step it was. */
type Refusal = { readonly kind: 'refused'; readonly refused: SnapshotRefused }

/**
 * git in `cwd` under `env`, with the store's config and bounds. `input`, when given, is its stdin
 * as the NUL-ended list a `-z --stdin` reads; stdin is closed either way.
 */
function spawnGit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: readonly string[],
): Promise<GitResult> {
  const { promise, resolve: settle } = Promise.withResolvers<GitResult>()
  const child = execFile(
    'git',
    [...SNAPSHOT_CONFIG, ...args],
    { cwd, env, timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_OUTPUT_BYTES },
    (error, stdout, stderr) => {
      settle({ code: exitCode(error), stdout, stderr })
    },
  )
  // A git that dies before reading its list breaks the pipe: its exit code says so, never a throw.
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(input?.map((record) => `${record}\0`).join(''))
  return promise
}

/**
 * git with the store as its repository and `tree` as its work tree; the tree's own `.git` is out of
 * the picture. `index` is the store's own index unless a caller names a scratch copy; `input` is a
 * list for its stdin.
 */
function runStoreGit(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  args: readonly string[],
  { index = join(store.directory, 'enso-index'), input }: { index?: string; input?: readonly string[] } = {},
): Promise<GitResult> {
  const env = {
    ...withoutGitLocalVariables(environment),
    GIT_DIR: store.directory,
    GIT_WORK_TREE: store.tree,
    GIT_INDEX_FILE: index,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  }
  return spawnGit(args, store.tree, env, input)
}

/**
 * git in `cwd` against the repository `cwd` is in — the USER's, read only: none of the store's
 * variables, and `GIT_OPTIONAL_LOCKS=0`, so not even a stat refresh of its index is written.
 * Bounded as the store's gits are: listing a large tree outlasts `@enso/core/git`'s query timeout.
 */
function readRepositoryGit(
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string,
  input?: readonly string[],
): Promise<GitResult> {
  const env = {
    ...withoutGitLocalVariables(environment),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  }
  return spawnGit(args, cwd, env, input)
}

/** A git that failed, as the step it was. */
function refusedBy(step: string, result: GitResult): Refusal {
  return { kind: 'refused', refused: { step, code: result.code, stderr: result.stderr.trim() } }
}

/** A NUL-ended git list as its entries. */
function nulList(output: string): string[] {
  return output.split('\0').filter((field) => field !== '')
}

/** `path` with its symlinks resolved, else as resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The tree's own object directory, index, object format and place in its repository, when the tree
 * is a git checkout: the alternates target, the index seed, the format the store must share, and
 * whether the tree is the repository's top level (`--show-prefix` empty) — a subdirectory's index
 * names paths from the top level, no seed for a store whose paths start at the tree. Read through
 * the read-only runner, so a worktree's `.git` FILE resolves to the common directory as git does,
 * not as a path join would.
 */
async function treeRepository(
  environment: NodeJS.ProcessEnv,
  tree: string,
): Promise<{ objects: string; index: string; topLevel: boolean; objectFormat: string } | undefined> {
  const objects = await runGitIn(environment, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], tree)
  const index = await runGitIn(environment, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], tree)
  const prefix = await runGitIn(environment, ['rev-parse', '--show-prefix'], tree)
  if (objects.code !== 0 || index.code !== 0 || prefix.code !== 0) return undefined
  // `--show-object-format` is git ≥ 2.32; a git without it has no sha256 repositories either, so
  // the alternates and the seed keep their fast path and the format is sha1.
  const format = await runGitIn(environment, ['rev-parse', '--show-object-format'], tree)
  return {
    objects: objects.stdout.trim(),
    index: index.stdout.trim(),
    topLevel: prefix.stdout.trim() === '',
    objectFormat: format.code === 0 ? format.stdout.trim() : 'sha1',
  }
}

/**
 * Mint the store at `directory`: `git init --bare` in the format its objects must share, the
 * tree's object directory and `alternates` named in `objects/info/alternates`, and the tree's index
 * copied as the seed when the tree is its repository's top level. False when the directory or the
 * init fails — never a half-made store to use.
 */
async function mintStore(
  directory: string,
  tree: string,
  environment: NodeJS.ProcessEnv,
  alternates: readonly string[],
): Promise<boolean> {
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return false
  }
  // The checkout's repository first: its object FORMAT decides the store's (alternates cannot
  // mix sha1 and sha256 objects), never the user's `init.defaultObjectFormat`; a tree that is no
  // checkout takes the format of its first alternate's repository (`<repository>/objects`), else
  // sha1, said explicitly for the same reason.
  const repository = await treeRepository(environment, tree)
  const first = alternates[0]
  const alternateFormat =
    repository !== undefined || first === undefined
      ? undefined
      : await runGitIn(environment, ['--git-dir', dirname(first), 'rev-parse', '--show-object-format'], tree)
  const objectFormat =
    repository?.objectFormat ?? (alternateFormat?.code === 0 ? alternateFormat.stdout.trim() : 'sha1')
  const init = await runGitIn(
    environment,
    ['init', '--quiet', '--bare', `--object-format=${objectFormat}`, directory],
    tree,
  )
  if (init.code !== 0) return false
  // Deduplicated, order kept: a fork's flattened alternates repeat the checkout's objects.
  const objectDirectories = [...new Set([...(repository === undefined ? [] : [repository.objects]), ...alternates])]
  if (objectDirectories.length > 0) {
    mkdirSync(join(directory, 'objects', 'info'), { recursive: true })
    writeFileSync(join(directory, 'objects', 'info', 'alternates'), `${objectDirectories.join('\n')}\n`)
  }
  if (repository?.topLevel === true && existsSync(repository.index)) {
    copyFileSync(repository.index, join(directory, 'enso-index'))
  }
  return true
}

/**
 * Open the store at `dir` for `tree`, minting it when absent: `git init --bare`, the tree's object
 * directory as an alternate and its index as the seed when the tree is a checkout's top level.
 * Opening an existing store reads nothing from the tree's repository again. Refused as `undefined`
 * when the mint's git fails — the caller records no snapshot, never a half-made store.
 *
 * `alternates` are further object directories the mint names after the tree's own — a fork's
 * parent store's `objects`, so the parent's snapshots are reachable from the fork's store without
 * a copy. Ignored when the store exists.
 *
 * `copyOf` records, minting or not, that the store's trees are copies of that project (#566): a
 * tree other than the project then lists its untracked files under the project repository's ignore
 * rules too. Refused as `undefined` when it cannot be recorded.
 *
 * @group Snapshot store
 */
export async function openSnapshotStore(options: {
  readonly directory: string
  readonly tree: string
  readonly environment: NodeJS.ProcessEnv
  readonly alternates?: readonly string[]
  readonly copyOf?: string | undefined
}): Promise<SnapshotStore | undefined> {
  const { directory, tree, environment, alternates = [], copyOf } = options
  const store = { directory, tree }
  if (!existsSync(join(directory, 'HEAD')) && !(await mintStore(directory, tree, environment, alternates))) {
    return undefined
  }
  if (copyOf !== undefined) {
    try {
      writeFileSync(join(directory, COPY_OF_FILE), `${copyOf}\n`)
    } catch {
      return undefined
    }
  }
  // One git at a time per store: a second `add` would meet the first's `index.lock`.
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    directory,
    tree,
    snapshot: () => serialized(() => takeSnapshot(environment, store)),
  }
}

/**
 * Whose ignore rules decide what of the tree a snapshot holds (#566):
 * - `repository`: the tree's own repository lists its files — a checkout, a subdirectory of one,
 *   a worktree;
 * - `copy`: the tree is a copy of `project`, which is in a repository — the store's tracked set and
 *   the copy's untracked files, less what the project's repository ignores;
 * - `store`: no repository — the store's own rules alone.
 */
type IgnoreRules =
  | { readonly kind: 'repository' }
  | { readonly kind: 'copy'; readonly project: string }
  | { readonly kind: 'store' }

/** Whether `directory` is in a repository's working tree; a git that fails otherwise is refused. */
async function inWorkTree(environment: NodeJS.ProcessEnv, directory: string): Promise<boolean | Refusal> {
  const asked = await readRepositoryGit(environment, ['rev-parse', '--is-inside-work-tree'], directory)
  if (asked.code === 0) return asked.stdout.trim() === 'true'
  if (/not a git repository/i.test(asked.stderr)) return false
  return refusedBy('rev-parse', asked)
}

/**
 * The rules for `store`'s tree: a copy's project when the store names one and the tree is not that
 * project itself (a copy's store is minted from a snapshot of the project), else the tree's own.
 * ⚠ A copy never asks the repository it may happen to sit in (an `ENSO_HOME` under a dotfiles
 * checkout): that repository is not the project's. A project gone is refused at `rev-parse`.
 */
async function ignoreRulesOf(environment: NodeJS.ProcessEnv, store: StorePlace): Promise<IgnoreRules | Refusal> {
  let copyOf: string | undefined
  try {
    copyOf = readFileSync(join(store.directory, COPY_OF_FILE), 'utf8').trim()
  } catch {
    copyOf = undefined
  }
  if (copyOf !== undefined && copyOf !== '' && canonical(copyOf) !== canonical(store.tree)) {
    const project = copyOf
    const inProject = await inWorkTree(environment, project)
    if (typeof inProject !== 'boolean') return inProject
    return inProject ? { kind: 'copy', project } : { kind: 'store' }
  }
  const inTree = await inWorkTree(environment, store.tree)
  if (typeof inTree !== 'boolean') return inTree
  return inTree ? { kind: 'repository' } : { kind: 'store' }
}

/**
 * The tree's files as a snapshot holds them, ready to stage: `paths` for `update-index --add
 * --remove` (a tracked path gone from disk is a removal), and `gitlinks` — submodules with no
 * checkout under them, which `update-index` cannot read — as the `--index-info` records their index
 * holds. `ignoredByProject`: a copy's untracked files only its project's repository ignores.
 */
interface TreeFiles {
  readonly paths: string[]
  readonly gitlinks: { readonly path: string; readonly record: string }[]
  readonly ignoredByProject: string[]
}

/**
 * `ls-files --stage -z` records and untracked paths as {@link TreeFiles}. An unmerged path's three
 * stages are one path; an untracked nested repository's trailing `/` is dropped, so it stages as a
 * gitlink.
 */
function treeFilesOf(
  tree: string,
  staged: string,
  untracked: readonly string[],
  ignoredByProject: string[],
): TreeFiles {
  const paths = new Set<string>()
  const gitlinks = new Map<string, string>()
  for (const record of nulList(staged)) {
    // `<mode> <hash> <stage>\t<path>`
    const tab = record.indexOf('\t')
    const [mode, hash] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    if (mode === '160000' && !existsSync(join(tree, path, '.git'))) gitlinks.set(path, `160000 ${hash}\t${path}`)
    else paths.add(path)
  }
  for (const path of untracked) paths.add(path.endsWith('/') ? path.slice(0, -1) : path)
  return {
    paths: [...paths],
    gitlinks: [...gitlinks].map(([path, record]) => ({ path, record })),
    ignoredByProject,
  }
}

/**
 * The tree's files under `rules`, read without writing anything: the tree's repository's own
 * listing, or the store's index (`index`) and the store's untracked listing — a copy's then less
 * what its project's repository ignores.
 */
async function listTreeFiles(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  rules: IgnoreRules,
  index: string,
): Promise<TreeFiles | Refusal> {
  const tracked = ['ls-files', '--cached', '--stage', '-z']
  const untracked = ['ls-files', '--others', '--exclude-standard', '-z']
  if (rules.kind === 'repository') {
    const staged = await readRepositoryGit(environment, tracked, store.tree)
    if (staged.code !== 0) return refusedBy('ls-files', staged)
    const others = await readRepositoryGit(environment, untracked, store.tree)
    if (others.code !== 0) return refusedBy('ls-files', others)
    return treeFilesOf(store.tree, staged.stdout, nulList(others.stdout), [])
  }
  const staged = await runStoreGit(environment, store, tracked, { index })
  if (staged.code !== 0) return refusedBy('ls-files', staged)
  const others = await runStoreGit(environment, store, untracked, { index })
  if (others.code !== 0) return refusedBy('ls-files', others)
  const candidates = nulList(others.stdout)
  if (rules.kind === 'store' || candidates.length === 0) return treeFilesOf(store.tree, staged.stdout, candidates, [])
  // The copy's paths are the project's: `check-ignore` in the project answers for them, its index
  // too (a path the project tracks is never ignored). Exit 1: none ignored.
  const checked = await readRepositoryGit(environment, ['check-ignore', '-z', '--stdin'], rules.project, candidates)
  if (checked.code !== 0 && checked.code !== 1) return refusedBy('check-ignore', checked)
  const ignored = nulList(checked.stdout)
  const ignoredSet = new Set(ignored)
  const kept = candidates.filter((path) => !ignoredSet.has(path))
  return treeFilesOf(store.tree, staged.stdout, kept, ignored)
}

/**
 * The index at `index` made exactly `files`: entries the listing lacks force-removed, the listed
 * paths added, refreshed or (gone from disk) removed — `update-index` reads each path literally,
 * never as a pathspec, and re-hashes only a file whose stat changed — then the bare gitlinks
 * recorded as listed.
 */
async function stageTreeFiles(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  files: TreeFiles,
  index: string,
): Promise<Refusal | undefined> {
  const indexed = await runStoreGit(environment, store, ['ls-files', '-z'], { index })
  if (indexed.code !== 0) return refusedBy('ls-files', indexed)
  const listed = new Set([...files.paths, ...files.gitlinks.map((gitlink) => gitlink.path)])
  const stale = [...new Set(nulList(indexed.stdout))].filter((path) => !listed.has(path))
  const steps: [readonly string[], readonly string[]][] = [
    [['update-index', '--force-remove', '-z', '--stdin'], stale],
    [['update-index', '--add', '--remove', '-z', '--stdin'], files.paths],
    [['update-index', '-z', '--index-info'], files.gitlinks.map((gitlink) => gitlink.record)],
  ]
  for (const [args, entries] of steps) {
    if (entries.length === 0) continue
    const updated = await runStoreGit(environment, store, args, { index, input: entries })
    if (updated.code !== 0) return refusedBy('update-index', updated)
  }
  return undefined
}

/** The tree's files under its rules, staged into `index`; the listing, or the step that failed. */
async function stageTree(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  index: string,
): Promise<{ readonly kind: 'staged'; readonly rules: IgnoreRules; readonly files: TreeFiles } | Refusal> {
  const rules = await ignoreRulesOf(environment, store)
  if ('refused' in rules) return rules
  const files = await listTreeFiles(environment, store, rules, index)
  if ('refused' in files) return files
  const staged = await stageTreeFiles(environment, store, files, index)
  return staged ?? { kind: 'staged', rules, files }
}

async function takeSnapshot(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
): Promise<{ kind: 'taken'; taken: SnapshotTaken } | Refusal> {
  // The tracked set and the unignored untracked files, into the store's index — never the tree's.
  const staged = await stageTree(environment, store, join(store.directory, 'enso-index'))
  if (staged.kind === 'refused') return staged
  const written = await runStoreGit(environment, store, ['write-tree'])
  if (written.code !== 0) return refusedBy('write-tree', written)
  const treeHash = written.stdout.trim()
  // The last snapshot's tree, when there is one: the same tree is the same snapshot, no commit.
  const head = await runStoreGit(environment, store, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const parent = head.code === 0 ? head.stdout.trim() : undefined
  if (parent !== undefined) {
    const headTree = await runStoreGit(environment, store, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'])
    if (headTree.code === 0 && headTree.stdout.trim() === treeHash) {
      return { kind: 'taken', taken: { hash: parent, changed: false } }
    }
  }
  const committed = await runStoreGit(environment, store, [
    'commit-tree',
    treeHash,
    ...(parent === undefined ? [] : ['-p', parent]),
    '-m',
    'enso snapshot',
  ])
  if (committed.code !== 0) return refusedBy('commit-tree', committed)
  const hash = committed.stdout.trim()
  const updated = await runStoreGit(environment, store, [
    'update-ref',
    'HEAD',
    hash,
    ...(parent === undefined ? [] : [parent]),
  ])
  if (updated.code !== 0) return refusedBy('update-ref', updated)
  return { kind: 'taken', taken: { hash, changed: true } }
}

/**
 * The paths a snapshot holds, for a test or an inventory: `ls-tree -r --name-only` of the commit.
 *
 * @group Snapshot store
 */
export async function snapshotPaths(
  environment: NodeJS.ProcessEnv,
  store: Pick<SnapshotStore, 'directory' | 'tree'>,
  hash: string,
): Promise<string[]> {
  const listed = await runStoreGit(environment, store, ['ls-tree', '-r', '--name-only', hash])
  return listed.code === 0 ? listed.stdout.split('\n').filter((line) => line !== '') : []
}

/**
 * Each of `paths` under `tree` removed, then each directory that leaves empty, up to the tree. A
 * directory on the list — a nested repository, a gitlink — is left where it is; a path already gone
 * is no failure. The first other failure, in words.
 */
function removeFiles(tree: string, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const absolute = join(tree, path)
    try {
      if (lstatSync(absolute).isDirectory()) continue
      unlinkSync(absolute)
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      if (failure.code === 'ENOENT') continue
      return `${path}: ${failure.message}`
    }
    for (
      let parent = dirname(absolute);
      parent.length > tree.length && parent.startsWith(tree);
      parent = dirname(parent)
    ) {
      try {
        rmdirSync(parent)
      } catch {
        break
      }
    }
  }
  return undefined
}

/**
 * Make `tree`'s content exactly the snapshot `hash` held in (or reachable from) the store at
 * `directory`: the tree's files listed under its rules first, then `read-tree` into the store's
 * index, `checkout-index --all --force --index` (the index's stat facts become the tree's, so the
 * next snapshot re-hashes nothing), and each listed file the snapshot lacks removed. ⚠ Only a
 * listed file is ever removed — never one the rules ignore (#566), whatever repository they come
 * from — and a nested repository is left where it is. The store's HEAD is not moved: the next
 * snapshot is the tree as it then is, the last one its parent. Never throws.
 *
 * @group Snapshot store
 */
export async function materializeSnapshot(options: {
  readonly directory: string
  readonly tree: string
  readonly hash: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<{ kind: 'materialized' } | Refusal> {
  const { directory, tree, hash, environment } = options
  const store = { directory, tree }
  const index = join(directory, 'enso-index')
  const rules = await ignoreRulesOf(environment, store)
  if ('refused' in rules) return rules
  const before = await listTreeFiles(environment, store, rules, index)
  if ('refused' in before) return before
  const read = await runStoreGit(environment, store, ['read-tree', hash])
  if (read.code !== 0) return refusedBy('read-tree', read)
  const checkedOut = await runStoreGit(environment, store, ['checkout-index', '--all', '--force', '--index'])
  if (checkedOut.code !== 0) return refusedBy('checkout-index', checkedOut)
  const held = await runStoreGit(environment, store, ['ls-files', '-z'])
  if (held.code !== 0) return refusedBy('ls-files', held)
  const inSnapshot = new Set(nulList(held.stdout))
  const failed = removeFiles(
    tree,
    before.paths.filter((path) => !inSnapshot.has(path)),
  )
  if (failed !== undefined) return { kind: 'refused', refused: { step: 'remove', code: -1, stderr: failed } }
  return { kind: 'materialized' }
}

/**
 * Where a tree differs from one snapshot: the paths it has that the snapshot lacks, and the paths
 * that changed or went.
 *
 * @group Snapshot store
 */
export interface SnapshotDifference {
  readonly added: string[]
  readonly changed: string[]
}

/**
 * `tree` as it is now against each of `hashes` (a hash, or `HEAD` for the store's last snapshot),
 * and the ignored files it holds under its rules — without moving the store: the tree staged into
 * a scratch copy of the store's index (its stat facts spare the re-hash), `diff-index --cached` per
 * hash, `ls-files --others --ignored` by the rules' repository (a copy's: the store's, and what its
 * project's repository ignores besides). The scratch index is removed whatever happens. Never
 * throws.
 *
 * @group Snapshot store
 */
export async function compareTreeWithSnapshots(options: {
  readonly directory: string
  readonly tree: string
  readonly hashes: readonly string[]
  readonly environment: NodeJS.ProcessEnv
}): Promise<{ kind: 'compared'; differences: SnapshotDifference[]; ignored: string[] } | Refusal> {
  const { directory, tree, hashes, environment } = options
  const store = { directory, tree }
  const scratch = join(directory, `enso-index-scratch-${randomUUID()}`)
  try {
    const index = join(directory, 'enso-index')
    if (existsSync(index)) copyFileSync(index, scratch)
    const staged = await stageTree(environment, store, scratch)
    if (staged.kind === 'refused') return staged
    const differences: SnapshotDifference[] = []
    for (const hash of hashes) {
      const compared = await runStoreGit(environment, store, ['diff-index', '--cached', '--name-status', '-z', hash], {
        index: scratch,
      })
      if (compared.code !== 0) return refusedBy('diff-index', compared)
      // `-z`: a status field, then its path, each NUL-ended.
      const fields = compared.stdout.split('\0')
      const difference: SnapshotDifference = { added: [], changed: [] }
      for (let at = 0; at + 1 < fields.length; at += 2) {
        const path = fields[at + 1] ?? ''
        if (fields[at] === 'A') difference.added.push(path)
        else difference.changed.push(path)
      }
      differences.push(difference)
    }
    const listIgnored = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']
    const ignored =
      staged.rules.kind === 'repository'
        ? await readRepositoryGit(environment, listIgnored, tree)
        : await runStoreGit(environment, store, listIgnored, { index: scratch })
    if (ignored.code !== 0) return refusedBy('ls-files', ignored)
    return { kind: 'compared', differences, ignored: [...nulList(ignored.stdout), ...staged.files.ignoredByProject] }
  } catch (error) {
    return { kind: 'refused', refused: { step: 'scratch-index', code: -1, stderr: String(error) } }
  } finally {
    rmSync(scratch, { force: true })
  }
}
