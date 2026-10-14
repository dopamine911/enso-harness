/**
 * The per-thread snapshot store (#551 slice 1, after #146's source reads): a bare git repository
 * beside the thread's session that records what its tree looked like when each run began.
 *
 * ⚠ THE TREE'S OWN `.git` IS NEVER WRITTEN. Every git that writes runs with `GIT_DIR` at the store,
 * `GIT_WORK_TREE` at the tree and `GIT_INDEX_FILE` at the store's own index — the mechanic
 * `@ayulab/pi-checkpoint` uses (borrowed, not adopted: GPL-3.0). The user's repository is only
 * read, with `GIT_OPTIONAL_LOCKS=0` as `@enso/core/git` reads it: at mint — when the tree is the
 * repository's top level — its index, copied as the store's seed, so a snapshot re-hashes only
 * files whose stat changed (measured: a 3k-file tree mints in 2.2 s unseeded, in milliseconds
 * seeded — #551), and the blobs that index names, copied out of its objects; at every snapshot,
 * the list of the files it holds.
 *
 * ⚠ THE PROJECT'S OBJECT STORE OWNS EVERY OBJECT (#573). The thread stores of one project
 * (`snapshots/<thread-id>`) keep their objects in one bare repository beside them,
 * `snapshots/.objects`: each store's `objects` is a symlink to its `objects`. Nothing is borrowed
 * from the checkout — a store that named the checkout's objects as an alternate lost every blob
 * and tree the checkout stopped referencing to the user's own `git gc`. A fork's store shares its
 * parent's snapshots through it, its lineage in `enso-forked-from`. No git prunes there but
 * {@link collectSnapshotGarbage}, which keeps every store's history; stores minted before #573 are
 * moved onto it by {@link migrateSnapshotStores}.
 *
 * ⚠ WHAT A SNAPSHOT IS: the checkout's tracked set plus its unignored untracked files — never a
 * force-add — AS THE TREE'S REPOSITORY LISTS THEM (`ls-files --cached --others --exclude-standard`),
 * then staged into the store's index exactly. The repository applies every ignore rule itself
 * (#566): the `.gitignore` files ABOVE a subdirectory project and `info/exclude` too, which the
 * store — its work tree the project — would never see. Ignores apply to the untracked remainder
 * only, so a tracked file that a later rule covers stays in (vx-pm: 4,696 of 5,701 tracked files
 * are under an ignored `screenshots/` directory), and `.env`-shaped files, ignored AND untracked,
 * stay out of the store. The tree's `.git` is excluded by git itself; a nested repository is a
 * gitlink, its contents not captured — stated, not hidden. A path a sparse checkout leaves off disk
 * (skip-worktree) keeps the blob its index records, so the snapshot is still the whole commit, and
 * a materialize leaves it off disk (#570); a path beyond a symlinked directory is not the tree's
 * (git calls it "beyond a symbolic link") — the symlink is snapshotted, never what it points at.
 * An untracked `node_modules` is ignored whatever the rules say (`DEFAULT_EXCLUDE`, #739); a
 * tracked one is the project's and stays.
 *
 * ⚠ A COPY HAS NO REPOSITORY: IT FOLLOWS ITS PROJECT'S (#566). A store told it holds a copy of a
 * project (`copyOf`, recorded in the store) lists the copy as the store's own tracked set plus the
 * copy's untracked files that neither the copy's own `.gitignore` files nor the PROJECT's
 * repository ignore (`check-ignore`, run in the project) — so a `node_modules` installed or a
 * `.env` written in a copy of `repo/packages/app` stays out, as it would in the checkout. A tree in
 * no repository, copy or not, has the store's own rules only: its `.gitignore` files and
 * `core.excludesFile`. ⚠ A copy's store minted before #566 names no project, and nothing writes
 * one later: it keeps the store's own rules — what a project ignores only above itself is captured
 * there — until the tree is minted again.
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
 * makes a tree's files exactly a snapshot's — the store's index, the tree's skip-worktree paths
 * marked again (#570: a sparse checkout stays sparse), `checkout-index`, then each file the tree
 * held under the same listing that the snapshot lacks, removed — still through the store's own
 * variables. Ignored files are never touched: they are the tree's own (`.env`, build output), and
 * no snapshot ever held them.
 *
 * ⚠ node-only (`node:child_process`, `node:fs`): a subpath, `@enso/core/snapshot-store`, never the barrel.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EnsoGitFileChange } from './git-state.ts'
import {
  type ChangedFilePaths,
  type ChangedFileTexts,
  execGit,
  type GitResult,
  type GitRunner,
  readFileTexts,
  readTreeChanges,
  runGitIn,
  withoutGitLocalVariables,
} from './git.ts'

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
 * `git init` with an empty template (#739, as the arena's projects since #740): a store is written
 * only by Enso's own gits, so git's 14 sample hooks (about 70 KB) and its `info/exclude` stub would
 * land in every thread's store for nothing — the hooks never run (`core.hooksPath=/dev/null`).
 */
const EMPTY_TEMPLATE = '--template='

/**
 * What every listing of the tree's untracked files leaves out, whatever its ignore rules (#739): a
 * project with no `.gitignore` had 34 MB of `node_modules` captured, 17 MB of objects in its store.
 * Passed on git's command line, so it holds for the tree's own repository's listing as for the
 * store's — the user's `.gitignore` and `info/exclude` are never written — and outranks every
 * ignore file, a `!node_modules/` negation included. ⚠ Untracked files only: a `node_modules` the
 * project TRACKS is its choice and stays in every snapshot. One flag on every `--others` listing,
 * taking and materializing alike, so a materialize never removes what a snapshot never took.
 */
const DEFAULT_EXCLUDE = '--exclude=node_modules/'

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
  /** The project's pre-#573 stores this open moved onto the object store, when it moved any (#573). */
  readonly migration?: StoreMigration
}

/** A store and the tree it is opened for. */
interface StorePlace {
  readonly directory: string
  readonly tree: string
}

/** A git that failed, as the step it was. */
type Refusal = { readonly kind: 'refused'; readonly refused: SnapshotRefused }

/**
 * git in `cwd` under `env`, with the store's config and bounds. `input`, when given, is its stdin:
 * a list as the NUL-ended records a `-z --stdin` reads, or text as it is; stdin is closed either way.
 */
function spawnGit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: readonly string[] | string,
): Promise<GitResult> {
  const { child, result } = execGit([...SNAPSHOT_CONFIG, ...args], {
    cwd,
    env,
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_OUTPUT_BYTES,
  })
  // A git that dies before reading its list breaks the pipe: its exit code says so, never a throw.
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(typeof input === 'string' ? input : input?.map((record) => `${record}\0`).join(''))
  return result
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
    // git translates its messages; `inWorkTree` reads one. `C` also overrides `LANGUAGE`.
    LC_ALL: 'C',
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
 * is a git checkout: where the seed's objects are read from, the index seed, the format the store
 * must share, and whether the tree is the repository's top level (`--show-prefix` empty) — a
 * subdirectory's index names paths from the top level, no seed for a store whose paths start at
 * the tree. Read through the read-only runner, so a worktree's `.git` FILE resolves to the common
 * directory as git does, not as a path join would.
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
  // the seed keeps its fast path and the format is sha1.
  const format = await runGitIn(environment, ['rev-parse', '--show-object-format'], tree)
  return {
    objects: objects.stdout.trim(),
    index: index.stdout.trim(),
    topLevel: prefix.stdout.trim() === '',
    objectFormat: format.code === 0 ? format.stdout.trim() : 'sha1',
  }
}

/**
 * The project's object store (#573), beside its thread stores: a bare repository that OWNS every
 * object any of the project's snapshots need. A thread store's `objects` is a symlink to its
 * `objects`. A dot name, so it is never a thread's (`snapshots/<thread-id>`).
 */
const OBJECT_STORE = '.objects'

/** The lock one migration or garbage collection of a project's stores holds (a directory: `mkdir` is atomic). */
const STORES_LOCK = '.lock'

/** A lock older than this is a crashed holder's: every git under it is bounded by {@link SNAPSHOT_TIMEOUT_MS}. */
const STALE_LOCK_MS = 10 * 60_000

/** The file in a fork's store naming its ancestors' thread ids, nearest last, one per line (#573). */
const FORKED_FROM_FILE = 'enso-forked-from'

/** The file a pre-#573 store kept for its forks carried (#571): its thread was deleted. */
const LEGACY_ORPHANED_FILE = 'enso-orphaned'

/**
 * Never git's own pruning in a store or the object store: a `git gc` run there by hand would see
 * one store's refs and prune every other thread's objects. Written into each repository's config,
 * so it holds for any git, Enso's or a person's; {@link collectSnapshotGarbage} prunes explicitly.
 */
const NO_PRUNING_CONFIG = '[gc]\n\tauto = 0\n\tpruneExpire = never\n'

function objectStoreOf(snapshotsDir: string): string {
  return join(snapshotsDir, OBJECT_STORE)
}

/** git against the project's object store, no work tree; `alternate` an object directory it may read from. */
function runObjectStoreGit(
  environment: NodeJS.ProcessEnv,
  objectStore: string,
  args: readonly string[],
  { alternate, input }: { alternate?: string; input?: string } = {},
): Promise<GitResult> {
  const env = {
    ...withoutGitLocalVariables(environment),
    GIT_DIR: objectStore,
    ...(alternate === undefined ? {} : { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate }),
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  }
  return spawnGit(args, objectStore, env, input)
}

async function objectFormatOf(environment: NodeJS.ProcessEnv, repository: string): Promise<string | undefined> {
  const format = await runObjectStoreGit(environment, repository, ['rev-parse', '--show-object-format'])
  return format.code === 0 ? format.stdout.trim() : undefined
}

/** The project's object store, minted in `objectFormat` when absent; its format, or undefined when it cannot be made. */
async function ensureObjectStore(
  environment: NodeJS.ProcessEnv,
  objectStore: string,
  objectFormat: string,
): Promise<string | undefined> {
  if (!existsSync(join(objectStore, 'HEAD'))) {
    const init = await runGitIn(
      environment,
      ['init', '--quiet', '--bare', EMPTY_TEMPLATE, `--object-format=${objectFormat}`, objectStore],
      dirname(objectStore),
    )
    if (init.code !== 0) return undefined
    try {
      appendFileSync(join(objectStore, 'config'), NO_PRUNING_CONFIG)
    } catch {
      return undefined
    }
  }
  return objectFormatOf(environment, objectStore)
}

/** `store`'s `objects` made the symlink to the project's object store's, and git's pruning turned off there. */
function linkObjects(store: string): void {
  symlinkSync(join('..', OBJECT_STORE, 'objects'), join(store, 'objects'))
  appendFileSync(join(store, 'config'), NO_PRUNING_CONFIG)
}

/** Whether `store`'s objects are its own directory: a store minted before #573, not yet migrated. */
function isLegacyStore(store: string): boolean {
  try {
    return !lstatSync(join(store, 'objects')).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The thread stores in a project's `snapshots/`, by path: every directory but the dot ones. ⚠ Only
 * a `snapshots/` that does not exist is no stores (#575 review): one that cannot be read is a
 * refusal, never an empty list a collection would take for "nothing to keep".
 */
function listThreadStores(snapshotsDir: string): string[] | Refusal {
  try {
    return readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((storeDirectory) => storeDirectory.isDirectory() && !storeDirectory.name.startsWith('.'))
      .map((storeDirectory) => join(snapshotsDir, storeDirectory.name))
      .toSorted()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return refusedBy('list', { code: 1, stdout: '', stderr: String(error) })
  }
}

/** {@link listThreadStores} for a reader that decides nothing destructive: none when unreadable. */
function threadStoresIn(snapshotsDir: string): string[] {
  const listed = listThreadStores(snapshotsDir)
  return Array.isArray(listed) ? listed : []
}

/**
 * `store`'s `HEAD` commit, or `undefined` for a store with no history yet. ⚠ git answers a branch
 * ref it cannot read as it answers an unborn HEAD — exit 1, nothing said (#575 review) — so a store
 * is unborn only when it has no ref at all and git warned of none; any other answer is a refusal,
 * never "no history".
 */
async function readHead(
  environment: NodeJS.ProcessEnv,
  store: string,
): Promise<{ readonly hash: string | undefined } | Refusal> {
  const head = await runObjectStoreGit(environment, store, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.code === 0) return { hash: head.stdout.trim() }
  if (head.code !== 1) return refusedBy('rev-parse', head)
  const refs = await runObjectStoreGit(environment, store, ['for-each-ref'])
  if (refs.code === 0 && refs.stdout.trim() === '' && refs.stderr.trim() === '') return { hash: undefined }
  return refusedBy('for-each-ref', { ...refs, code: refs.code === 0 ? 1 : refs.code })
}

/**
 * The pre-#573 stores beside `store` whose alternates still name its objects, by path (#575
 * review): forks a migration could not move, which read their parent's snapshots through
 * `<parent>/objects` — so `store` must not be removed while any is left.
 *
 * @group Snapshot store
 */
export function unmigratedForksOf(store: string): string[] {
  const self = canonical(store)
  return threadStoresIn(dirname(store)).filter((sibling) => {
    if (sibling === store || !isLegacyStore(sibling)) return false
    try {
      return readFileSync(join(sibling, 'objects', 'info', 'alternates'), 'utf8')
        .split('\n')
        .some((line) => line.trim() !== '' && canonical(dirname(line.trim())) === self)
    } catch {
      return false
    }
  })
}

/**
 * `work` while holding the project's stores lock; `busy` when another holds it. A lock older than
 * {@link STALE_LOCK_MS} is taken over once.
 */
async function withStoresLock<T>(snapshotsDir: string, work: () => Promise<T>): Promise<T | 'busy'> {
  const lock = join(snapshotsDir, STORES_LOCK)
  const take = (): boolean => {
    try {
      mkdirSync(lock)
      return true
    } catch {
      return false
    }
  }
  let taken = take()
  if (!taken) {
    let stale = false
    try {
      stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS
    } catch {
      stale = true
    }
    if (stale) {
      rmSync(lock, { recursive: true, force: true })
      taken = take()
    }
  }
  if (!taken) return 'busy'
  try {
    return await work()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Copy into the object store every blob the store's seeded index names that it lacks, read from the
 * tree's repository through an alternate given to this one git only — the repository is read,
 * never written (`pack-objects` writes its pack into the object store). False when it cannot: the
 * caller then drops the seed, and the first snapshot hashes every file itself. ⚠ Listed from the
 * COPIED index, never the tree's own: a stage between the two would leave an entry whose blob was
 * never copied, which a snapshot would trust by its stat and commit without.
 */
async function seedObjects(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  objectStore: string,
  repositoryObjects: string,
): Promise<boolean> {
  const listed = await runStoreGit(environment, store, ['ls-files', '--stage', '-z'])
  if (listed.code !== 0) return false
  // A gitlink names a commit of another repository: never an object of this one.
  const blobs = [
    ...new Set(
      nulList(listed.stdout)
        .filter((treeLine) => !treeLine.startsWith('160000 '))
        .map((treeLine) => treeLine.split(' ')[1] ?? ''),
    ),
  ]
  if (blobs.length === 0) return true
  const present = await runObjectStoreGit(environment, objectStore, ['cat-file', '--batch-check=%(objectname)'], {
    input: `${blobs.join('\n')}\n`,
  })
  if (present.code !== 0) return false
  const missing = present.stdout
    .split('\n')
    .filter((line) => line.endsWith(' missing'))
    .map((line) => line.slice(0, -' missing'.length))
  if (missing.length === 0) return true
  const packed = await runObjectStoreGit(
    environment,
    objectStore,
    ['pack-objects', '--quiet', join(objectStore, 'objects', 'pack', 'pack')],
    { alternate: repositoryObjects, input: `${missing.join('\n')}\n` },
  )
  return packed.code === 0
}

/**
 * Mint the store at `directory`: `git init --bare` in the format of the project's object store —
 * minted first, in the checkout's format, else sha1 — with its `objects` the object store's; the
 * tree's index copied as the seed when the tree is its repository's top level, its blobs copied
 * into the object store. A fork's store records its lineage (`forkOf`, the parent's store). False
 * when the directory, the init or a format that does not match fails — never a half-made store to
 * use.
 */
async function mintStore(
  directory: string,
  tree: string,
  environment: NodeJS.ProcessEnv,
  forkOf: string | undefined,
): Promise<boolean> {
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return false
  }
  // The checkout's object FORMAT decides the object store's, never the user's
  // `init.defaultObjectFormat`; a store whose checkout disagrees with the project's object store
  // cannot share it, and is refused.
  const repository = await treeRepository(environment, tree)
  const objectStore = objectStoreOf(dirname(directory))
  const objectFormat = await ensureObjectStore(environment, objectStore, repository?.objectFormat ?? 'sha1')
  if (objectFormat === undefined) return false
  if (repository !== undefined && repository.objectFormat !== objectFormat) return false
  const init = await runGitIn(
    environment,
    ['init', '--quiet', '--bare', EMPTY_TEMPLATE, `--object-format=${objectFormat}`, directory],
    tree,
  )
  if (init.code !== 0) return false
  try {
    rmSync(join(directory, 'objects'), { recursive: true, force: true })
    linkObjects(directory)
    if (forkOf !== undefined) {
      writeFileSync(join(directory, FORKED_FROM_FILE), [...lineageOf(forkOf), basename(forkOf)].join('\n') + '\n')
    }
  } catch {
    return false
  }
  if (repository?.topLevel === true && existsSync(repository.index)) {
    const seed = join(directory, 'enso-index')
    copyFileSync(repository.index, seed)
    if (!(await seedObjects(environment, { directory, tree }, objectStore, repository.objects)))
      rmSync(seed, { force: true })
  }
  return true
}

/** The thread ids a store's fork lineage names, farthest first; none for a store that is no fork. */
function lineageOf(store: string): string[] {
  try {
    return readFileSync(join(store, FORKED_FROM_FILE), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

/**
 * The thread ids of the stores beside `store` forked from it, at any depth (#571, #573): their
 * histories reach its snapshots up to where each was forked, so deleting it keeps those.
 *
 * @group Snapshot store
 */
export function forksOfStore(store: string): string[] {
  const threadId = basename(store)
  return threadStoresIn(dirname(store))
    .filter((sibling) => sibling !== store && lineageOf(sibling).includes(threadId))
    .map((sibling) => basename(sibling))
}

/**
 * What a migration of a project's pre-#573 stores did: the stores moved onto the object store, by
 * path; those that had lost objects to the checkout's gc before it, with how many, by path; those it
 * could not move, with why — each left as it was, working the pre-#573 way, retried at the next.
 *
 * @group Snapshot store
 */
export interface StoreMigration {
  readonly migrated: string[]
  readonly pruned: { readonly store: string; readonly missing: number }[]
  readonly unmigrated: { readonly store: string; readonly reason: string }[]
}

/**
 * Move every pre-#573 store in `snapshotsDir` (one project's `snapshots/`) onto the project's
 * object store (#573), so the checkout's gc can no longer take objects its snapshots borrowed:
 * 1. each store's history, borrowed objects included, packed into the object store — an object
 *    already pruned is counted, never fatal (`--missing=allow-any`);
 * 2. only once all are packed, each packed store's `objects` replaced by the symlink — a fork's
 *    alternates name its parent's `objects`, so a parent moved first still serves the fork; a
 *    fork's lineage is read off its alternates first;
 * 3. the stores kept for forks of deleted threads (#571) removed — their forks' histories, packed,
 *    hold what they kept — but only when every store moved: an unmoved fork may still read them.
 *
 * ⚠ PER STORE (#575 review): a store whose pack or link fails is `unmigrated`, left as it was, and
 * holds no other back. `busy` while another migration or a garbage collection holds the project's
 * stores; refused when the stores cannot be listed or the object store cannot be made. A store a
 * crash left between step 2's rename and link is linked.
 *
 * @group Snapshot store
 */
export async function migrateSnapshotStores(
  snapshotsDir: string,
  environment: NodeJS.ProcessEnv,
): Promise<StoreMigration | 'busy' | Refusal> {
  const pendingIn = (stores: readonly string[]): string[] =>
    stores.filter((store) => isLegacyStore(store) || interruptedMigration(store))
  const before = listThreadStores(snapshotsDir)
  if (!Array.isArray(before)) return before
  if (pendingIn(before).length === 0) return { migrated: [], pruned: [], unmigrated: [] }
  return withStoresLock(snapshotsDir, async () => {
    const listed = listThreadStores(snapshotsDir)
    if (!Array.isArray(listed)) return listed
    const stores = pendingIn(listed)
    const objectStore = objectStoreOf(snapshotsDir)
    const format = await migrationFormat(environment, objectStore, stores.filter(isLegacyStore))
    if (typeof format !== 'string') return format
    const { packed, pruned, unmigrated } = await packPendingStores(environment, objectStore, stores, format)
    // A line of a fork's alternates is `<store>/objects`: matched by the store, never through the
    // objects path, which for a store migrated already resolves to the object store's.
    const storeIds = new Map(listed.map((store) => [canonical(store), basename(store)]))
    const migrated = linkPackedStores(packed, objectStore, storeIds, unmigrated)
    if (unmigrated.length === 0) {
      for (const store of stores) {
        if (existsSync(join(store, LEGACY_ORPHANED_FILE))) rmSync(store, { recursive: true, force: true })
      }
    }
    return { migrated, pruned, unmigrated }
  })
}

/**
 * Step 1 of a migration: each pending store's history packed into the object store — a store left
 * between rename and link has nothing to pack — skipping stores kept for forks of deleted threads.
 * A store whose pack is refused is `unmigrated`; one that reached pruned objects is `pruned`.
 */
async function packPendingStores(
  environment: NodeJS.ProcessEnv,
  objectStore: string,
  stores: readonly string[],
  format: string,
): Promise<{
  packed: string[]
  pruned: { store: string; missing: number }[]
  unmigrated: { store: string; reason: string }[]
}> {
  const pruned: { store: string; missing: number }[] = []
  const unmigrated: { store: string; reason: string }[] = []
  const packed: string[] = []
  for (const store of stores) {
    if (existsSync(join(store, LEGACY_ORPHANED_FILE))) continue
    const outcome = isLegacyStore(store) ? await packLegacyStore(environment, objectStore, store, format) : 0
    if (typeof outcome !== 'number') {
      unmigrated.push({ store, reason: refusalText(outcome) })
      continue
    }
    if (outcome > 0) pruned.push({ store, missing: outcome })
    packed.push(store)
  }
  return { packed, pruned, unmigrated }
}

/**
 * Step 2 of a migration: each packed store's lineage recorded off its alternates (a pre-#573 store)
 * and its `objects` linked to the object store. The stores linked; one whose link throws is pushed
 * onto `unmigrated`.
 */
function linkPackedStores(
  packed: readonly string[],
  objectStore: string,
  storeIds: ReadonlyMap<string, string>,
  unmigrated: { store: string; reason: string }[],
): string[] {
  const migrated: string[] = []
  for (const store of packed) {
    try {
      if (isLegacyStore(store)) recordLegacyLineage(store, storeIds)
      linkMigratedStore(store, objectStore)
      migrated.push(store)
    } catch (error) {
      unmigrated.push({ store, reason: `link: ${String(error)}` })
    }
  }
  return migrated
}

/** A refusal as one line: its step and git's words. */
function refusalText(refusal: Refusal): string {
  return `${refusal.refused.step}: ${refusal.refused.stderr}`
}

/**
 * The format a migration's object store has: its own when it exists — a store left between rename
 * and link has none to read — else the first pre-#573 store's, else sha1. Refused when the object
 * store cannot be made in it.
 */
async function migrationFormat(
  environment: NodeJS.ProcessEnv,
  objectStore: string,
  legacy: readonly string[],
): Promise<string | Refusal> {
  const existing = existsSync(join(objectStore, 'HEAD')) ? await objectFormatOf(environment, objectStore) : undefined
  const first = legacy[0]
  const format = existing ?? (first === undefined ? undefined : await objectFormatOf(environment, first)) ?? 'sha1'
  if ((await ensureObjectStore(environment, objectStore, format)) !== format) {
    return refusedBy('object-store', {
      code: 1,
      stdout: '',
      stderr: `the object store at ${objectStore} is not ${format}`,
    })
  }
  return format
}

/**
 * Whether a crash left `store` between a migration's rename of its objects and their link: a
 * `HEAD`, and no `objects` at all.
 */
function interruptedMigration(store: string): boolean {
  if (!existsSync(join(store, 'HEAD'))) return false
  try {
    lstatSync(join(store, 'objects'))
    return false
  } catch {
    return true
  }
}

/**
 * A pre-#573 store's history, borrowed objects included, packed into the object store, read
 * through the store's own objects (and so its alternates) for this one git; how many objects it
 * reaches are missing — pruned by the checkout's gc before the migration.
 */
async function packLegacyStore(
  environment: NodeJS.ProcessEnv,
  objectStore: string,
  store: string,
  format: string,
): Promise<number | Refusal> {
  const own = await objectFormatOf(environment, store)
  if (own !== undefined && own !== format) {
    return refusedBy('object-format', { code: 1, stdout: '', stderr: `the store is ${own}, its project's ${format}` })
  }
  const head = await readHead(environment, store)
  if ('kind' in head) return head
  if (head.hash === undefined) return 0
  const alternate = join(store, 'objects')
  const packed = await runObjectStoreGit(
    environment,
    objectStore,
    ['pack-objects', '--revs', '--missing=allow-any', '--quiet', join(objectStore, 'objects', 'pack', 'pack')],
    { alternate, input: `${head.hash}\n` },
  )
  if (packed.code !== 0) return refusedBy('pack-objects', packed)
  const walked = await runObjectStoreGit(
    environment,
    objectStore,
    ['rev-list', '--objects', '--missing=print', head.hash],
    { alternate },
  )
  if (walked.code !== 0) return refusedBy('rev-list', walked)
  return walked.stdout.split('\n').filter((line) => line.startsWith('?')).length
}

/** A pre-#573 fork's lineage, read off the alternates naming its ancestors' stores (`storeIds`, by canonical path). */
function recordLegacyLineage(store: string, storeIds: ReadonlyMap<string, string>): void {
  if (existsSync(join(store, FORKED_FROM_FILE))) return
  let alternates: string[]
  try {
    alternates = readFileSync(join(store, 'objects', 'info', 'alternates'), 'utf8').split('\n')
  } catch {
    return
  }
  const ancestors = alternates.flatMap((line) => {
    const id = line.trim() === '' ? undefined : storeIds.get(canonical(dirname(line.trim())))
    return id === undefined ? [] : [id]
  })
  if (ancestors.length > 0) writeFileSync(join(store, FORKED_FROM_FILE), `${ancestors.join('\n')}\n`)
}

/** The old object directories a migration set `store`'s own aside as, by path. */
function setAsideOf(store: string): string[] {
  try {
    return readdirSync(store)
      .filter((fileName) => fileName.startsWith(SET_ASIDE_PREFIX))
      .map((fileName) => join(store, fileName))
  } catch {
    return []
  }
}

/** The directory a migration sets a pre-#573 store's own objects aside as, before its link. */
const SET_ASIDE_PREFIX = 'objects.legacy-'

/**
 * A packed pre-#573 store's own objects set aside, the link to the object store's made, then every
 * object set aside MOVED into the object store — never deleted: a handle opened before the
 * migration may have written a snapshot there after the pack (#575 review). The emptied directory
 * stays until {@link collectSnapshotGarbage} finds nothing new in it for the grace.
 */
function linkMigratedStore(store: string, objectStore: string): void {
  if (isLegacyStore(store)) renameSync(join(store, 'objects'), join(store, `${SET_ASIDE_PREFIX}${randomUUID()}`))
  if (interruptedMigration(store)) linkObjects(store)
  for (const aside of setAsideOf(store)) moveObjects(aside, join(objectStore, 'objects'))
}

/**
 * Every object in the object directory `from` moved into `to`: each loose object, then each pack —
 * its index last, since git finds a pack by its index. One `to` holds already is dropped from
 * `from` (same name, same content); git's temporary files are left.
 */
function moveObjects(from: string, to: string): void {
  const move = (source: string, target: string): void => {
    if (existsSync(target)) rmSync(source, { force: true })
    else renameSync(source, target)
  }
  for (const fanOut of readdirSync(from, { withFileTypes: true })) {
    if (!fanOut.isDirectory() || !/^[0-9a-f]{2}$/.test(fanOut.name)) continue
    mkdirSync(join(to, fanOut.name), { recursive: true })
    for (const objectName of readdirSync(join(from, fanOut.name))) {
      if (/^[0-9a-f]+$/.test(objectName)) move(join(from, fanOut.name, objectName), join(to, fanOut.name, objectName))
    }
  }
  let packs: string[]
  try {
    packs = readdirSync(join(from, 'pack')).filter((fileName) => fileName.startsWith('pack-'))
  } catch {
    return
  }
  mkdirSync(join(to, 'pack'), { recursive: true })
  for (const packFile of [
    ...packs.filter((pack) => !pack.endsWith('.idx')),
    ...packs.filter((pack) => pack.endsWith('.idx')),
  ]) {
    move(join(from, 'pack', packFile), join(to, 'pack', packFile))
  }
}

/** The newest change under a set-aside directory: itself, its fan-out directories and its packs'. */
function newestChangeIn(directory: string): number {
  let newest = statSync(directory).mtimeMs
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory()) newest = Math.max(newest, statSync(join(directory, child.name)).mtimeMs)
  }
  return newest
}

/**
 * Each store's set-aside objects moved into the object store again — what a late writer put there
 * since — and a set-aside directory removed once nothing has changed in it for the grace.
 */
function settleSetAside(stores: readonly string[], objectStore: string): void {
  for (const store of stores) {
    for (const aside of setAsideOf(store)) {
      moveObjects(aside, join(objectStore, 'objects'))
      if (Date.now() - newestChangeIn(aside) > COLLECTION_GRACE_MS) rmSync(aside, { recursive: true, force: true })
    }
  }
}

/** How long an object no ref reaches is kept: a snapshot in flight writes its objects before its HEAD. */
const COLLECTION_GRACE_MS = 60 * 60_000

/**
 * Remove the objects in `snapshotsDir`'s object store that no thread store's history reaches (#573):
 * each store's `HEAD` written as `refs/enso/<thread-id>` — a ref for a store gone is deleted — then
 * `git gc --prune=1.hour.ago`, so an object a snapshot in flight just wrote, which no `HEAD` names
 * yet, is kept. `busy` while a migration or another collection holds the project's stores; a
 * store still pre-#573 holds its own objects, so the collection waits for its migration.
 *
 * @group Snapshot store
 */
export async function collectSnapshotGarbage(
  snapshotsDir: string,
  environment: NodeJS.ProcessEnv,
): Promise<'collected' | 'busy' | Refusal> {
  const objectStore = objectStoreOf(snapshotsDir)
  if (!existsSync(join(objectStore, 'HEAD'))) return 'collected'
  return withStoresLock(snapshotsDir, async () => {
    const stores = listThreadStores(snapshotsDir)
    if (!Array.isArray(stores)) return stores
    if (stores.some((store) => isLegacyStore(store) || interruptedMigration(store))) return 'busy'
    try {
      settleSetAside(stores, objectStore)
    } catch (error) {
      return refusedBy('set-aside', { code: 1, stdout: '', stderr: String(error) })
    }
    const heads = new Map<string, string>()
    for (const store of stores) {
      // A history unread is never "none": refused before a ref is touched, every object kept.
      const head = await readHead(environment, store)
      if ('kind' in head) return head
      if (head.hash !== undefined) heads.set(`refs/enso/${basename(store)}`, head.hash)
    }
    const listed = await runObjectStoreGit(environment, objectStore, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/enso/',
    ])
    if (listed.code !== 0) return refusedBy('for-each-ref', listed)
    // Only a store that is gone loses its ref: one still here keeps what its last collection pinned.
    const present = new Set(stores.map((store) => `refs/enso/${basename(store)}`))
    const stale = listed.stdout.split('\n').filter((ref) => ref !== '' && !present.has(ref))
    const commands = [
      ...stale.map((ref) => `delete ${ref}`),
      ...[...heads].map(([ref, hash]) => `update ${ref} ${hash}`),
    ]
    if (commands.length > 0) {
      const updated = await runObjectStoreGit(environment, objectStore, ['update-ref', '--stdin'], {
        input: `${commands.join('\n')}\n`,
      })
      if (updated.code !== 0) return refusedBy('update-ref', updated)
    }
    const collected = await runObjectStoreGit(environment, objectStore, ['gc', '--quiet', '--prune=1.hour.ago'])
    return collected.code === 0 ? 'collected' : refusedBy('gc', collected)
  })
}

/**
 * Open the store at `dir` for `tree`, minting it when absent: `git init --bare` with its objects in
 * the project's object store (#573), and the tree's index as the seed when the tree is a
 * checkout's top level. Opening an existing store reads nothing from the tree's repository again.
 * Refused as `undefined` when the mint's git fails — the caller records no snapshot, never a
 * half-made store.
 *
 * A mint, or an open of a store from before #573 (or one a migration left between rename and
 * link), first migrates the project's pre-#573 stores ({@link migrateSnapshotStores}): a fork's
 * base must be in the object store, and a store must not keep borrowing from the checkout. What it
 * did is `migration` on the store. ⚠ An old store whose migration is busy or refused opens as
 * `undefined` (#575 review): a snapshot it took would land where the migration sets aside.
 *
 * `forkOf`, the parent thread's store, records a minted fork's lineage ({@link forksOfStore}); its
 * snapshots are in the object store already. Ignored when the store exists.
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
  readonly forkOf?: string | undefined
  readonly copyOf?: string | undefined
}): Promise<SnapshotStore | undefined> {
  const { directory, tree, environment, forkOf, copyOf } = options
  const store = { directory, tree }
  const minting = !existsSync(join(directory, 'HEAD'))
  const unmigrated = (): boolean => isLegacyStore(directory) || interruptedMigration(directory)
  const needsMigration = !minting && unmigrated()
  const migrated = minting || needsMigration ? await migrateSnapshotStores(dirname(directory), environment) : undefined
  const migration =
    migrated !== undefined && typeof migrated === 'object' && 'migrated' in migrated ? migrated : undefined
  // Decided by this store's own state (#575 review): another store that could not move holds it
  // back no more; this one, unmoved — busy, refused or failed — would snapshot where a migration
  // sets aside.
  if (needsMigration && unmigrated()) return undefined
  if (minting && !(await mintStore(directory, tree, environment, forkOf))) return undefined
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
    ...(migration === undefined || migration.migrated.length + migration.unmigrated.length === 0 ? {} : { migration }),
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
 * --remove` (a tracked path gone from disk is a removal), and `recorded` — entries `update-index`
 * cannot read from disk, as the `--index-info` records their index holds: a submodule with no
 * checkout under it, a path a sparse checkout leaves off disk. `sparse`: those last paths — tag
 * `S`, skip-worktree — which a materialize keeps off disk (#570). `ignoredByProject`: a copy's
 * untracked files only its project's repository ignores, a wholly ignored directory as `dir/`.
 */
interface TreeFiles {
  readonly paths: string[]
  readonly recorded: { readonly path: string; readonly record: string }[]
  readonly sparse: string[]
  readonly ignoredByProject: string[]
}

/**
 * Whether a leading directory of `path` under `tree` is a symlink — the path is then "beyond a
 * symbolic link", as git says: not the tree's to stage, and removing it would remove what the link
 * points at, outside the tree. `checked` caches the directories one pass has looked at.
 */
function beyondSymlink(tree: string, path: string, checked: Map<string, boolean>): boolean {
  let directory = tree
  for (const part of path.split('/').slice(0, -1)) {
    directory = join(directory, part)
    let linked = checked.get(directory)
    if (linked === undefined) {
      try {
        linked = lstatSync(directory).isSymbolicLink()
      } catch {
        linked = false
      }
      checked.set(directory, linked)
    }
    if (linked) return true
  }
  return false
}

/**
 * `ls-files --stage -t -z` records and untracked paths as {@link TreeFiles}, less every path beyond
 * a symlinked directory. An unmerged path's three stages are one path; an untracked nested
 * repository's trailing `/` is dropped, so it stages as a gitlink.
 */
function treeFilesOf(
  tree: string,
  staged: string,
  untracked: readonly string[],
  ignoredByProject: string[],
): TreeFiles {
  const checked = new Map<string, boolean>()
  const paths = new Set<string>()
  const recorded = new Map<string, { readonly record: string; readonly sparse: boolean }>()
  for (const record of nulList(staged)) {
    // `<tag> <mode> <hash> <stage>\t<path>`; tag `S`: skip-worktree, not on disk.
    const tab = record.indexOf('\t')
    const [tag, mode, hash] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    if (beyondSymlink(tree, path, checked)) continue
    if (tag === 'S' || (mode === '160000' && !existsSync(join(tree, path, '.git')))) {
      recorded.set(path, { record: `${mode} ${hash}\t${path}`, sparse: tag === 'S' })
    } else paths.add(path)
  }
  for (const listed of untracked) {
    const path = listed.endsWith('/') ? listed.slice(0, -1) : listed
    if (!beyondSymlink(tree, path, checked)) paths.add(path)
  }
  return {
    paths: [...paths].filter((path) => !recorded.has(path)),
    recorded: [...recorded].map(([path, entry]) => ({ path, record: entry.record })),
    sparse: [...recorded].filter(([, entry]) => entry.sparse).map(([path]) => path),
    ignoredByProject,
  }
}

/** The store's listing of the tree's untracked files against `index`, `extra` flags and all. */
async function listStoreOthers(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  index: string,
  extra: readonly string[],
): Promise<string[] | Refusal> {
  const others = await runStoreGit(
    environment,
    store,
    ['ls-files', '--others', '--exclude-standard', DEFAULT_EXCLUDE, '-z', ...extra],
    { index },
  )
  return others.code === 0 ? nulList(others.stdout) : refusedBy('ls-files', others)
}

/**
 * `paths` split by the project's repository: `check-ignore` in the project answers for a copy's
 * paths, its index too (a path the project tracks is never ignored, nor a directory holding one).
 * Exit 1: none ignored.
 */
async function splitByProject(
  environment: NodeJS.ProcessEnv,
  project: string,
  paths: readonly string[],
): Promise<{ readonly kept: string[]; readonly ignored: string[] } | Refusal> {
  if (paths.length === 0) return { kept: [], ignored: [] }
  const checked = await readRepositoryGit(environment, ['check-ignore', '-z', '--stdin'], project, paths)
  if (checked.code !== 0 && checked.code !== 1) return refusedBy('check-ignore', checked)
  const ignored = nulList(checked.stdout)
  const ignoredSet = new Set(ignored)
  return { kept: paths.filter((path) => !ignoredSet.has(path)), ignored }
}

/**
 * The tree's untracked files by the store's own listing against `index`, less — for a copy — what
 * its project's repository ignores: `kept`, and `ignored`, the paths only the project ignores, a
 * wholly ignored directory as one `dir/` entry.
 *
 * ⚠ A COPY IS LISTED BY DIRECTORY FIRST (#569). The store never knows a directory only the
 * project ignores (`.venv/`, `dist/`, `target/`): listed file by file, every path went to
 * `check-ignore` — 100k files took 430 ms a snapshot, and past 64 MiB of listing every snapshot of
 * the copy was refused. `--directory` collapses a wholly untracked directory to `dir/`, the
 * project's `check-ignore` drops the ignored ones whole, and only the rest is listed again, file
 * by file (`:(literal)`: a directory named `a*` is no glob), for the project to answer per file.
 * An untracked nested repository is `dir/` in both listings, a gitlink as before. ⚠ An ignored
 * directory INSIDE a wholly untracked one (a new `pkg/` holding its own `.venv/`) is still listed
 * file by file: git collapses only the outermost untracked directory.
 */
async function storeUntrackedFiles(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  rules: IgnoreRules,
  index: string,
): Promise<{ readonly kept: string[]; readonly ignored: string[] } | Refusal> {
  if (rules.kind !== 'copy') {
    const candidates = await listStoreOthers(environment, store, index, [])
    return 'refused' in candidates ? candidates : { kept: candidates, ignored: [] }
  }
  const collapsed = await listStoreOthers(environment, store, index, ['--directory', '--no-empty-directory'])
  if ('refused' in collapsed) return collapsed
  const outer = await splitByProject(environment, rules.project, collapsed)
  if ('refused' in outer) return outer
  const directories = outer.kept.filter((path) => path.endsWith('/'))
  if (directories.length === 0) return outer
  const pathspecs = directories.map((directory) => `:(literal)${directory}`)
  const expanded = await listStoreOthers(environment, store, index, ['--', ...pathspecs])
  if ('refused' in expanded) return expanded
  const inner = await splitByProject(environment, rules.project, expanded)
  if ('refused' in inner) return inner
  return {
    kept: [...outer.kept.filter((path) => !path.endsWith('/')), ...inner.kept],
    ignored: [...outer.ignored, ...inner.ignored],
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
  const tracked = ['ls-files', '--cached', '--stage', '-t', '-z']
  if (rules.kind === 'repository') {
    const staged = await readRepositoryGit(environment, tracked, store.tree)
    if (staged.code !== 0) return refusedBy('ls-files', staged)
    const others = await readRepositoryGit(
      environment,
      ['ls-files', '--others', '--exclude-standard', DEFAULT_EXCLUDE, '-z'],
      store.tree,
    )
    if (others.code !== 0) return refusedBy('ls-files', others)
    return treeFilesOf(store.tree, staged.stdout, nulList(others.stdout), [])
  }
  const staged = await runStoreGit(environment, store, tracked, { index })
  if (staged.code !== 0) return refusedBy('ls-files', staged)
  const untracked = await storeUntrackedFiles(environment, store, rules, index)
  if ('refused' in untracked) return untracked
  return treeFilesOf(store.tree, staged.stdout, untracked.kept, untracked.ignored)
}

/**
 * The index at `index` made exactly `files`: entries the listing lacks force-removed, the listed
 * paths added, refreshed or (gone from disk) removed — `update-index` reads each path literally,
 * never as a pathspec, and re-hashes only a file whose stat changed — then the entries it cannot
 * read from disk set as recorded.
 */
async function stageTreeFiles(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  files: TreeFiles,
  index: string,
): Promise<Refusal | undefined> {
  const indexed = await runStoreGit(environment, store, ['ls-files', '-z'], { index })
  if (indexed.code !== 0) return refusedBy('ls-files', indexed)
  const listed = new Set([...files.paths, ...files.recorded.map((indexEntry) => indexEntry.path)])
  const stale = [...new Set(nulList(indexed.stdout))].filter((path) => !listed.has(path))
  const steps: [readonly string[], readonly string[]][] = [
    [['update-index', '--force-remove', '-z', '--stdin'], stale],
    [['update-index', '--add', '--remove', '-z', '--stdin'], files.paths],
    [['update-index', '-z', '--index-info'], files.recorded.map((indexEntry) => indexEntry.record)],
  ]
  for (const [args, entries] of steps) {
    if (entries.length === 0) continue
    const updated = await runStoreGit(environment, store, args, { index, input: entries })
    if (updated.code !== 0) return refusedBy('update-index', updated)
  }
  return undefined
}

/** The tree's rules and its files under them, listed against `index`; or the step that failed. */
async function listTree(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  index: string,
): Promise<{ readonly rules: IgnoreRules; readonly files: TreeFiles } | Refusal> {
  const rules = await ignoreRulesOf(environment, store)
  if ('refused' in rules) return rules
  const files = await listTreeFiles(environment, store, rules, index)
  return 'refused' in files ? files : { rules, files }
}

/** The tree's files under its rules, staged into `index`; the listing, or the step that failed. */
async function stageTree(
  environment: NodeJS.ProcessEnv,
  store: StorePlace,
  index: string,
): Promise<{ readonly kind: 'staged'; readonly rules: IgnoreRules; readonly files: TreeFiles } | Refusal> {
  const listed = await listTree(environment, store, index)
  if ('refused' in listed) return listed
  const staged = await stageTreeFiles(environment, store, listed.files, index)
  return staged ?? { kind: 'staged', ...listed }
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
 * is no failure. ⚠ A path beyond a symlinked directory is never removed, looked at NOW, not at
 * listing: `checkout-index` may have just put a snapshot's symlink where a directory was, and
 * removing through it would remove a file outside the tree. The first other failure, in words.
 */
function removeFiles(tree: string, paths: readonly string[]): string | undefined {
  const checked = new Map<string, boolean>()
  for (const path of paths) {
    const absolute = join(tree, path)
    try {
      if (beyondSymlink(tree, path, checked) || lstatSync(absolute).isDirectory()) continue
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
 * from — and a nested repository is left where it is. ⚠ A path a sparse checkout left off disk
 * stays off (#570): `read-tree` carries no skip-worktree bit, so `checkout-index` wrote every such
 * path, widening the sparse checkout — and git, finding the file present, dropped the path's `S`
 * in the user's index. The paths the tree's listing tagged `S` are marked skip-worktree in the
 * store's index before `checkout-index`, which skips them. The store's HEAD is not moved: the next
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
  const listed = await listTree(environment, store, index)
  if ('refused' in listed) return listed
  const before = listed.files
  const read = await runStoreGit(environment, store, ['read-tree', hash])
  if (read.code !== 0) return refusedBy('read-tree', read)
  const held = await runStoreGit(environment, store, ['ls-files', '-z'])
  if (held.code !== 0) return refusedBy('ls-files', held)
  const inSnapshot = new Set(nulList(held.stdout))
  // Only a path the snapshot holds can be marked: `update-index` refuses one the index lacks.
  const sparse = before.sparse.filter((path) => inSnapshot.has(path))
  if (sparse.length > 0) {
    const marked = await runStoreGit(environment, store, ['update-index', '--skip-worktree', '-z', '--stdin'], {
      input: sparse,
    })
    if (marked.code !== 0) return refusedBy('update-index', marked)
  }
  const checkedOut = await runStoreGit(environment, store, ['checkout-index', '--all', '--force', '--index'])
  if (checkedOut.code !== 0) return refusedBy('checkout-index', checkedOut)
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
    // The default exclusion counts as ignored here too: what no snapshot takes is the tree's own.
    const listIgnored = ['ls-files', '--others', '--ignored', '--exclude-standard', DEFAULT_EXCLUDE, '-z']
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

/**
 * A copy's files changed since `base` (#650) — the snapshot of the tree as the copy was made — as
 * the Diff view reads a repository's (`readTreeChanges`): git with the store as its repository,
 * the copy as its work tree and the store's own index, whose stat facts spare a re-hash, through
 * `@enso/core/git`'s read-only runner (`GIT_OPTIONAL_LOCKS=0`, no inherited `GIT_DIR`). Its
 * untracked files are the ones a snapshot would take (`ignoreRulesOf`): what the project's
 * repository ignores — a `node_modules` it installed — is not listed. A file new since `base` is
 * `added`: a copy has no repository of its own to leave a file untracked in.
 *
 * ⚠ WRITES NOTHING — no index refresh, no lock, no object: `diff` and `ls-files` only read, and
 * a file new since the last snapshot is diffed with `--no-index`, never hashed into the store.
 * Throws, with the step and git's words, when the store cannot be read.
 *
 * @group Snapshot store
 */
export async function readCopyChanges(options: {
  readonly directory: string
  readonly tree: string
  readonly base: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<{ files: EnsoGitFileChange[]; truncated: boolean }> {
  const { directory, tree, base, environment } = options
  const store = { directory, tree }
  const index = join(directory, 'enso-index')
  const read = await readTreeChanges(
    (args, cwd) => runGitIn(environment, args, cwd, { gitDirectory: directory, workTree: tree, index }),
    {
      root: tree,
      scope: '',
      base,
      listUntracked: async () => {
        const rules = await ignoreRulesOf(environment, store)
        if ('refused' in rules) throw new Error(refusalText(rules))
        const untracked = await storeUntrackedFiles(environment, store, rules, index)
        if ('refused' in untracked) throw new Error(refusalText(untracked))
        return untracked.kept
      },
    },
  )
  return {
    files: read.files.map((file) => (file.status === 'untracked' ? { ...file, status: 'added' } : file)),
    truncated: read.truncated,
  }
}

/**
 * One of a copy's changed files whole, on both sides (#461), as {@link readCopyChanges} reads the
 * copy: the old side at `base` in the store, the new side in the copy — if the copy's changes would
 * list it: in the store's index, or untracked and kept by the copy's ignore rules. Writes nothing.
 *
 * @group Snapshot store
 */
export function readCopyFileTexts(options: {
  readonly directory: string
  readonly tree: string
  readonly base: string
  readonly environment: NodeJS.ProcessEnv
  readonly paths: ChangedFilePaths
}): Promise<ChangedFileTexts> {
  const { directory, tree, base, environment } = options
  const store = { directory, tree }
  const index = join(directory, 'enso-index')
  const runStore: GitRunner = (args, cwd) =>
    runGitIn(environment, args, cwd, { gitDirectory: directory, workTree: tree, index })
  const listed = async (path: string): Promise<boolean> => {
    const tracked = await runStore(['ls-files', '-z', '--cached', '--', `:(top,literal)${path}`], tree)
    if (tracked.code === 0 && tracked.stdout.split('\0').includes(path)) return true
    const rules = await ignoreRulesOf(environment, store)
    if ('refused' in rules) return false
    const untracked = await storeUntrackedFiles(environment, store, rules, index)
    return !('refused' in untracked) && untracked.kept.includes(path)
  }
  return readFileTexts(runStore, { root: tree, base, listed }, options.paths)
}
