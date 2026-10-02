/**
 * The per-thread snapshot store (#551 slice 1, after #146's source reads): a bare git repository
 * beside the thread's session that records what its tree looked like when each run began.
 *
 * ⚠ THE TREE'S OWN `.git` IS NEVER TOUCHED. Every git here runs with `GIT_DIR` at the store,
 * `GIT_WORK_TREE` at the tree and `GIT_INDEX_FILE` at the store's own index — the mechanic
 * `@ayulab/pi-checkpoint` uses (borrowed, not adopted: GPL-3.0). The user's index, refs and hooks
 * are not read for a write and not written at all. What the store does read from the tree's
 * repository, once, at mint: its object directory, named in `objects/info/alternates` so a base
 * snapshot writes no blob the checkout already holds; and its index, copied as the store's seed,
 * so `add -A` re-hashes only files whose stat changed (measured: a 3k-file tree mints in 2.2 s
 * unseeded, in milliseconds seeded — #551).
 *
 * ⚠ WHAT A SNAPSHOT IS: the checkout's tracked set plus the unignored untracked files — never a
 * force-add. Ignores apply to the untracked remainder only, so a tracked file that a later
 * `.gitignore` rule covers stays in (vx-pm: 4,696 of 5,701 tracked files are under an ignored
 * `screenshots/` directory), and `.env`-shaped files, ignored AND untracked, stay out of the store.
 * The tree's `.git` is excluded by git itself; a nested repository is a gitlink, its contents not
 * captured — stated, not hidden.
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
 * makes a tree's files exactly a snapshot's — the store's index, `checkout-index`, then `clean` of
 * the unignored untracked files the snapshot lacks — still through the store's own variables.
 * Ignored files are never touched: they are the tree's own (`.env`, build output), and no snapshot
 * ever held them.
 *
 * ⚠ node-only (`node:child_process`, `node:fs`): a subpath, `@enso/core/snapshot-store`, never the barrel.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exitCode, type GitResult, runGitIn, withoutGitLocalVariables } from './git.ts'

/**
 * How long one git of the store may take. A mint on an unseeded 100k-file tree is the slow case;
 * a seeded turn is milliseconds (#551's measurement).
 *
 * @group Snapshot store
 */
export const SNAPSHOT_TIMEOUT_MS = 60_000

const SNAPSHOT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

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

/**
 * git with the store as its repository and `tree` as its work tree; the tree's own `.git` is out of
 * the picture. `index` is the store's own index unless a caller names a scratch copy.
 */
function runStoreGit(
  environment: NodeJS.ProcessEnv,
  store: { readonly directory: string; readonly tree: string },
  args: readonly string[],
  index: string = join(store.directory, 'enso-index'),
): Promise<GitResult> {
  const env = {
    ...withoutGitLocalVariables(environment),
    GIT_DIR: store.directory,
    GIT_WORK_TREE: store.tree,
    GIT_INDEX_FILE: index,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  }
  const { promise, resolve } = Promise.withResolvers<GitResult>()
  execFile(
    'git',
    [...SNAPSHOT_CONFIG, ...args],
    { cwd: store.tree, env, timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_OUTPUT_BYTES },
    (error, stdout, stderr) => {
      resolve({ code: exitCode(error), stdout, stderr })
    },
  )
  return promise
}

/**
 * The tree's own object directory, index and object format, when the tree is a git checkout: the
 * alternates target, the index seed, and the format the store must share. Read through the
 * read-only runner, so a worktree's `.git` FILE resolves to the common directory as git does, not
 * as a path join would.
 */
async function treeRepository(
  environment: NodeJS.ProcessEnv,
  tree: string,
): Promise<{ objects: string; index: string; objectFormat: string } | undefined> {
  const objects = await runGitIn(environment, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], tree)
  const index = await runGitIn(environment, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], tree)
  if (objects.code !== 0 || index.code !== 0) return undefined
  // `--show-object-format` is git ≥ 2.32; a git without it has no sha256 repositories either, so
  // the alternates and the seed keep their fast path and the format is sha1.
  const format = await runGitIn(environment, ['rev-parse', '--show-object-format'], tree)
  return {
    objects: objects.stdout.trim(),
    index: index.stdout.trim(),
    objectFormat: format.code === 0 ? format.stdout.trim() : 'sha1',
  }
}

/**
 * Mint the store at `directory`: `git init --bare` in the format its objects must share, the
 * tree's object directory and `alternates` named in `objects/info/alternates`, the tree's index
 * copied as the seed. False when the directory or the init fails — never a half-made store to use.
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
  const objectDirectories = [...(repository === undefined ? [] : [repository.objects]), ...alternates]
  if (objectDirectories.length > 0) {
    mkdirSync(join(directory, 'objects', 'info'), { recursive: true })
    writeFileSync(join(directory, 'objects', 'info', 'alternates'), `${objectDirectories.join('\n')}\n`)
  }
  if (repository !== undefined && existsSync(repository.index)) {
    copyFileSync(repository.index, join(directory, 'enso-index'))
  }
  return true
}

/**
 * Open the store at `dir` for `tree`, minting it when absent: `git init --bare`, the tree's object
 * directory as an alternate and its index as the seed when the tree is a checkout. Opening an
 * existing store reads nothing from the tree's repository again. Refused as `undefined` when the
 * mint's git fails — the caller records no snapshot, never a half-made store.
 *
 * `alternates` are further object directories the mint names after the tree's own — a fork's
 * parent store's `objects`, so the parent's snapshots are reachable from the fork's store without
 * a copy. Ignored when the store exists.
 *
 * @group Snapshot store
 */
export async function openSnapshotStore(options: {
  readonly directory: string
  readonly tree: string
  readonly environment: NodeJS.ProcessEnv
  readonly alternates?: readonly string[]
}): Promise<SnapshotStore | undefined> {
  const { directory, tree, environment, alternates = [] } = options
  const store = { directory, tree }
  if (!existsSync(join(directory, 'HEAD')) && !(await mintStore(directory, tree, environment, alternates))) {
    return undefined
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

/** A git that failed, as the step it was. */
function refusedBy(step: string, result: GitResult): { kind: 'refused'; refused: SnapshotRefused } {
  return { kind: 'refused', refused: { step, code: result.code, stderr: result.stderr.trim() } }
}

async function takeSnapshot(
  environment: NodeJS.ProcessEnv,
  store: { readonly directory: string; readonly tree: string },
): Promise<{ kind: 'taken'; taken: SnapshotTaken } | { kind: 'refused'; refused: SnapshotRefused }> {
  // The tracked set and the unignored untracked files, into the store's index — never the tree's.
  const added = await runStoreGit(environment, store, ['add', '--all', '--', '.'])
  if (added.code !== 0) return refusedBy('add', added)
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
 * Make `tree`'s content exactly the snapshot `hash` held in (or reachable from) the store at
 * `directory`: `read-tree` into the store's index, `checkout-index --all --force --index` (the
 * index's stat facts become the tree's, so the next snapshot re-hashes nothing), then `clean -d`
 * of every unignored untracked file the snapshot lacks. ⚠ Ignored files are never touched, and a
 * nested repository is left where it is (`clean` with one `--force` keeps it). The store's HEAD is
 * not moved: the next snapshot is the tree as it then is, the last one its parent. Never throws.
 *
 * @group Snapshot store
 */
export async function materializeSnapshot(options: {
  readonly directory: string
  readonly tree: string
  readonly hash: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<{ kind: 'materialized' } | { kind: 'refused'; refused: SnapshotRefused }> {
  const { directory, tree, hash, environment } = options
  const store = { directory, tree }
  const read = await runStoreGit(environment, store, ['read-tree', hash])
  if (read.code !== 0) return refusedBy('read-tree', read)
  const checkedOut = await runStoreGit(environment, store, ['checkout-index', '--all', '--force', '--index'])
  if (checkedOut.code !== 0) return refusedBy('checkout-index', checkedOut)
  const cleaned = await runStoreGit(environment, store, ['clean', '--force', '-d', '--quiet', '--', '.'])
  if (cleaned.code !== 0) return refusedBy('clean', cleaned)
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
 * and the ignored files it holds — without moving the store: `add --all` into a scratch copy of
 * the store's index (its stat facts spare the re-hash), `diff-index --cached` per hash, `ls-files
 * --others --ignored`. The scratch index is removed whatever happens. Never throws.
 *
 * @group Snapshot store
 */
export async function compareTreeWithSnapshots(options: {
  readonly directory: string
  readonly tree: string
  readonly hashes: readonly string[]
  readonly environment: NodeJS.ProcessEnv
}): Promise<
  | { kind: 'compared'; differences: SnapshotDifference[]; ignored: string[] }
  | { kind: 'refused'; refused: SnapshotRefused }
> {
  const { directory, tree, hashes, environment } = options
  const store = { directory, tree }
  const scratch = join(directory, `enso-index-scratch-${randomUUID()}`)
  try {
    const index = join(directory, 'enso-index')
    if (existsSync(index)) copyFileSync(index, scratch)
    const added = await runStoreGit(environment, store, ['add', '--all', '--', '.'], scratch)
    if (added.code !== 0) return refusedBy('add', added)
    const differences: SnapshotDifference[] = []
    for (const hash of hashes) {
      const compared = await runStoreGit(
        environment,
        store,
        ['diff-index', '--cached', '--name-status', '-z', hash],
        scratch,
      )
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
    const ignored = await runStoreGit(
      environment,
      store,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      scratch,
    )
    if (ignored.code !== 0) return refusedBy('ls-files', ignored)
    return { kind: 'compared', differences, ignored: ignored.stdout.split('\0').filter((path) => path !== '') }
  } catch (error) {
    return { kind: 'refused', refused: { step: 'scratch-index', code: -1, stderr: String(error) } }
  } finally {
    rmSync(scratch, { force: true })
  }
}
