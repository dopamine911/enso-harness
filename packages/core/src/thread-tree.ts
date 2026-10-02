/**
 * A thread's own tree (#551 slice 2): the directory a thread works in, not the user's checkout.
 * Minted when the thread starts (or forks), put back to a snapshot on request, disposed when the
 * thread is done with.
 *
 * ⚠ THE ISOLATION IS OF WORKING FILES, NOT OF THE REPOSITORY (#564). A `worktree` shares the
 * checkout's git directory, so bash `git` in the tree still moves the user's refs, writes its
 * config and pushes from its remotes — exactly as a thread in the checkout could. The guards keep
 * the file tools inside the tree; nothing here confines a command.
 *
 * ⚠ IGNORED FILES ARE NOT IN A TREE. A tree holds the checkout's tracked and unignored untracked
 * files — never `node_modules`, `.env`, build output, or what `.git/info/exclude` lists, whether the
 * rule sits in the project or above it in its repository (#566) — so a build or test in a fresh
 * tree may need its install step first. By design: the snapshot store never force-adds an ignored
 * file. A copy's store records its project, so what its repository ignores stays out of the copy's
 * snapshots, and a restore never removes it.
 *
 * ⚠ THIS MODULE WRITES THE USER'S REPOSITORY — the only one that does (`@enso/core/git` reads, and
 * the snapshot store writes only its own bare repository). A `worktree` tree must be registered
 * with the checkout's repository and needs a branch of its own, so a mint writes exactly two things
 * there: `.git/worktrees/<name>` (`git worktree add`) and `refs/heads/<branch>` (its `-b`; the
 * host names it `enso/<thread-id>`). A dispose removes exactly those two again — the branch only
 * when no commit on it would be lost, unless forced. Nothing else of the checkout is written: its
 * HEAD, index, working files and config are as they were; its uncommitted edits reach the tree
 * through the snapshot store, read from the files, never by a stash or a commit.
 *
 * ⚠ TWO KINDS. `worktree`: the project must be its repository's top level with a commit
 * ({@link treeKindFor}) — the store's paths are relative to the project, a worktree is the whole
 * repository. `copy`: a plain directory with the snapshot's files and no `.git`.
 *
 * ⚠ A FAILED MINT LEAVES NOTHING. Every step's leftovers — the tree directory, the worktree's
 * registration, the new branch, a store this mint made — are removed before the refusal returns.
 *
 * ⚠ BOUNDED, NEVER `--force` BUT WHERE SAID. Each git is killed past {@link SNAPSHOT_TIMEOUT_MS};
 * the runner pins an identity, no signing, no hooks and no file monitor whatever the user's config
 * says. `--force`/`-D` run only on what this module made (a failed mint's own leftovers) and in a
 * dispose the caller forced.
 *
 * ⚠ node-only (`node:child_process`, `node:fs`): a subpath, `@enso/core/thread-tree`, never the barrel.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { exitCode, type GitResult, withoutGitLocalVariables } from './git.ts'
import {
  collectSnapshotGarbage,
  compareTreeWithSnapshots,
  materializeSnapshot,
  migrateSnapshotStores,
  openSnapshotStore,
  SNAPSHOT_TIMEOUT_MS,
  type SnapshotRefused,
  unmigratedForksOf,
} from './snapshot-store.ts'
import type { ThreadTreeKind, ThreadTreeRecord } from './thread-tree-record.ts'

const TREE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/** What every git here runs under, whatever the repository or the user configures. */
const TREE_CONFIG = [
  '-c',
  'user.name=enso',
  '-c',
  'user.email=enso@invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
]

/** git in `cwd`, without the environment's repository-locating variables: `cwd` names the repository. */
function runTreeGit(environment: NodeJS.ProcessEnv, args: readonly string[], cwd: string): Promise<GitResult> {
  const env = { ...withoutGitLocalVariables(environment), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  const { promise, resolve: settle } = Promise.withResolvers<GitResult>()
  execFile(
    'git',
    [...TREE_CONFIG, ...args],
    { cwd, env, timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: TREE_MAX_OUTPUT_BYTES },
    (error, stdout, stderr) => {
      settle({ code: exitCode(error), stdout, stderr })
    },
  )
  return promise
}

/** git's first line of `stderr`, or its exit code when it said nothing. */
function firstLineOr(stderr: string, code: number): string {
  const line = stderr.trim().split('\n')[0] ?? ''
  return line === '' ? `git exited ${code}` : line
}

/** git's first line on stderr, or its exit code when it said nothing. */
function gitReason(result: GitResult): string {
  return firstLineOr(result.stderr, result.code)
}

/** A store's refusal, in words. */
function storeReason(refused: SnapshotRefused): string {
  return `${refused.step}: ${firstLineOr(refused.stderr, refused.code)}`
}

/** `path` with its symlinks resolved; for a path that is gone, its parent's, else as given. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return resolve(path)
    }
  }
}

/**
 * The kind of tree a project can have: `worktree` only when it was asked for AND the project is
 * its repository's top level with a commit; `copy` otherwise — a project that is a subdirectory
 * of a repository, or in none, or a repository with no commit yet.
 *
 * @group Thread tree
 */
export async function treeKindFor(
  project: string,
  requested: ThreadTreeKind,
  environment: NodeJS.ProcessEnv,
): Promise<ThreadTreeKind> {
  if (requested === 'copy') return 'copy'
  const top = await runTreeGit(environment, ['rev-parse', '--show-toplevel'], project)
  const head = await runTreeGit(environment, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], project)
  if (top.code !== 0 || head.code !== 0) return 'copy'
  return canonical(top.stdout.trim()) === canonical(project) ? 'worktree' : 'copy'
}

/** A mint's refusal: the step that failed and why. */
interface MintRefused {
  readonly kind: 'refused'
  readonly step: string
  readonly reason: string
}

/** Where one mint works: the checkout, the tree and store it makes, the branch a worktree takes. */
interface MintPlace {
  readonly project: string
  readonly tree: string
  readonly store: string
  readonly branch: string
  readonly kind: ThreadTreeKind
  readonly environment: NodeJS.ProcessEnv
}

/** What a mint has made so far — exactly what a refusal must remove again, and nothing more. */
interface MintMade {
  store: boolean
  tree: boolean
  worktree: boolean
}

/**
 * Everything checked before a mint makes anything, so most refusals leave nothing to undo: the
 * tree is new, a worktree's project can have one, its revision resolves and its branch is free (an
 * existing branch is someone's — never reused). The revision is undefined for a copy.
 */
async function mintPreconditions(
  place: MintPlace,
  kind: ThreadTreeKind,
  forkRevision: string | null,
): Promise<MintRefused | { readonly revision: string | undefined }> {
  const { project, tree, branch, environment } = place
  if (existsSync(tree)) return { kind: 'refused', step: 'tree', reason: `${tree} exists already` }
  if (kind === 'copy') return { revision: undefined }
  if ((await treeKindFor(project, 'worktree', environment)) !== 'worktree') {
    return {
      kind: 'refused',
      step: 'kind',
      reason: `${project} is not the top level of a git checkout with a commit: a worktree cannot be minted (a copy can)`,
    }
  }
  let revision = forkRevision
  if (revision === null) {
    const head = await runTreeGit(environment, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], project)
    if (head.code !== 0) return { kind: 'refused', step: 'revision', reason: `HEAD: ${gitReason(head)}` }
    revision = head.stdout.trim()
  }
  const existing = await runTreeGit(environment, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], project)
  if (existing.code === 0) return { kind: 'refused', step: 'branch', reason: `the branch ${branch} exists already` }
  return { revision }
}

/**
 * A failed mint's own leftovers removed, then the refusal: the tree directory, the worktree's
 * registration and its new branch, the store when this mint made it. `--force`/`-D` are safe here
 * because each names only what this mint created a moment ago.
 */
async function undoMint(place: MintPlace, made: MintMade, step: string, reason: string): Promise<MintRefused> {
  const { project, tree, store, branch, environment } = place
  if (made.tree || made.worktree) rmSync(tree, { recursive: true, force: true })
  if (made.worktree) {
    // The directory is gone, so a plain `remove` unregisters it; then the branch is free to go.
    await runTreeGit(environment, ['worktree', 'remove', '--force', tree], project)
    await runTreeGit(environment, ['branch', '-D', branch], project)
  }
  if (made.store) rmSync(store, { recursive: true, force: true })
  return { kind: 'refused', step, reason }
}

/**
 * The tree directory: a worktree on its new branch at `revision`, or an empty directory for a
 * copy. Undefined when made, else why not — as the step the refusal names.
 */
async function makeTree(
  place: MintPlace,
  revision: string | undefined,
  made: MintMade,
): Promise<{ readonly step: string; readonly reason: string } | undefined> {
  const { project, tree, branch, environment } = place
  if (revision === undefined) {
    made.tree = true
    try {
      mkdirSync(tree, { recursive: true })
    } catch (error) {
      return { step: 'tree', reason: String(error) }
    }
    return undefined
  }
  // Made before git runs: a half-done `worktree add` (a branch created, a checkout failed) is undone too.
  made.worktree = true
  const added = await runTreeGit(
    environment,
    ['worktree', 'add', '--quiet', '--no-track', '-b', branch, tree, revision],
    project,
  )
  return added.code === 0 ? undefined : { step: 'worktree', reason: gitReason(added) }
}

/**
 * A new thread's base: the checkout snapshotted into the new store BEFORE the tree is made, so
 * the store's work tree — and its index seed — is the checkout's; then the tree.
 */
async function seedFromCheckout(
  place: MintPlace,
  revision: string | undefined,
  made: MintMade,
): Promise<string | { readonly step: string; readonly reason: string }> {
  const { project, store, kind, environment } = place
  const opened = await openSnapshotStore({
    directory: store,
    tree: project,
    environment,
    copyOf: kind === 'copy' ? project : undefined,
  })
  if (opened === undefined) return { step: 'store', reason: `the snapshot store could not be minted at ${store}` }
  const taken = await opened.snapshot()
  if (taken.kind === 'refused') return { step: 'snapshot', reason: storeReason(taken.refused) }
  return (await makeTree(place, revision, made)) ?? taken.taken.hash
}

/**
 * A fork's base is the parent's snapshot, already in the project's object store (#573): the tree
 * first, then the new store minted for it, its lineage the parent's — after the tree exists, since
 * the store's mint reads the tree's repository (a worktree's is the project's). A copy's store
 * names the project, whose repository's ignore rules it follows (#566).
 */
async function seedFromSnapshot(
  place: MintPlace,
  from: { readonly hash: string; readonly storeDirectory: string },
  revision: string | undefined,
  made: MintMade,
): Promise<string | { readonly step: string; readonly reason: string }> {
  const { project, tree, store, kind, environment } = place
  const failed = await makeTree(place, revision, made)
  if (failed !== undefined) return failed
  const opened = await openSnapshotStore({
    directory: store,
    tree,
    environment,
    forkOf: from.storeDirectory,
    copyOf: kind === 'copy' ? project : undefined,
  })
  if (opened === undefined) return { step: 'store', reason: `the snapshot store could not be minted at ${store}` }
  return from.hash
}

/**
 * Mint a thread's tree at `tree`, which must not exist, with the content of a snapshot: the
 * checkout's current state (`from: checkout` — snapshotted into `store` first, so the checkout's
 * snapshot`, a fork — `store` is minted beside the parent's store, its snapshots shared through the
 * project's object store). A
 * worktree is on its own new `branch` at the checkout's HEAD or the fork's `revision`; a branch
 * that exists already is refused, never reused.
 *
 * Afterwards `openSnapshotStore({ directory: store, tree, environment })` opens the same store and
 * its next snapshot is `record.base`, `changed: false`. A refusal names the step and leaves no tree
 * directory, worktree registration, branch or store of its own making behind.
 *
 * @group Thread tree
 */
export async function mintThreadTree(options: {
  readonly project: string
  readonly tree: string
  readonly store: string
  readonly kind: ThreadTreeKind
  readonly branch: string
  readonly from:
    | { readonly kind: 'checkout' }
    | {
        readonly kind: 'snapshot'
        readonly hash: string
        readonly revision: string | null
        readonly storeDirectory: string
      }
  readonly environment: NodeJS.ProcessEnv
}): Promise<{ kind: 'minted'; record: ThreadTreeRecord } | MintRefused> {
  const { project, tree, store, kind, branch, from, environment } = options
  const place: MintPlace = { project, tree, store, branch, kind, environment }
  const checked = await mintPreconditions(place, kind, from.kind === 'snapshot' ? from.revision : null)
  if ('kind' in checked) return checked
  const { revision } = checked

  const made: MintMade = { store: !existsSync(join(store, 'HEAD')), tree: false, worktree: false }
  const base =
    from.kind === 'checkout'
      ? await seedFromCheckout(place, revision, made)
      : await seedFromSnapshot(place, from, revision, made)
  if (typeof base !== 'string') return undoMint(place, made, base.step, base.reason)
  const materialized = await materializeSnapshot({ directory: store, tree, hash: base, environment })
  if (materialized.kind === 'refused') return undoMint(place, made, 'materialize', storeReason(materialized.refused))
  if (from.kind === 'snapshot') {
    // The fork's store has no snapshot of its own yet: the parent's, in the shared objects, is
    // its last, so the next snapshot of the unchanged tree is `base` again.
    const pointed = await runTreeGit(environment, ['--git-dir', store, 'update-ref', 'HEAD', base], tree)
    if (pointed.code !== 0) return undoMint(place, made, 'update-ref', gitReason(pointed))
  }
  return {
    kind: 'minted',
    record: { kind, project, path: tree, branch: kind === 'worktree' ? branch : null, base },
  }
}

/**
 * Put `tree`'s files back to the snapshot `hash`: a safety snapshot of the files as they are
 * first, then the snapshot materialized. A materialize that fails puts the safety snapshot back,
 * and the refusal says so. The conversation is not touched.
 *
 * @group Thread tree
 */
export async function restoreThreadTree(options: {
  readonly store: string
  readonly tree: string
  readonly hash: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<{ kind: 'restored'; hash: string; safety: string } | { kind: 'refused'; step: string; reason: string }> {
  const { store, tree, hash, environment } = options
  // Never a mint here: a restore without its store has nothing to restore from.
  if (!existsSync(join(store, 'HEAD')))
    return { kind: 'refused', step: 'store', reason: `no snapshot store at ${store}` }
  const opened = await openSnapshotStore({ directory: store, tree, environment })
  if (opened === undefined)
    return { kind: 'refused', step: 'store', reason: `the snapshot store at ${store} did not open` }
  const taken = await opened.snapshot()
  if (taken.kind === 'refused') return { kind: 'refused', step: 'safety', reason: storeReason(taken.refused) }
  const safety = taken.taken.hash
  const restored = await materializeSnapshot({ directory: store, tree, hash, environment })
  if (restored.kind === 'materialized') return { kind: 'restored', hash, safety }
  const back = await materializeSnapshot({ directory: store, tree, hash: safety, environment })
  return {
    kind: 'refused',
    step: 'restore',
    reason:
      back.kind === 'materialized'
        ? `${storeReason(restored.refused)}; the tree was rolled back to the safety snapshot ${safety}`
        : `${storeReason(restored.refused)}; rolling back to the safety snapshot ${safety} failed too: ${storeReason(back.refused)}`,
  }
}

/**
 * What disposing a tree would lose, and what holds it.
 * - `untracked`, `modified`: a worktree's untracked files and tracked changes against its branch's
 *   commit (`git status`); a copy's files added and changed since `record.base`.
 * - `ignored`: ignored files — regenerable, named, never a reason to refuse.
 * - `unsnapshotted`: paths where the tree differs from the store's last snapshot.
 * - `unmergedCommits`: commits on the worktree's branch that no other branch or remote reaches.
 * - `unreadable`: a listing git that failed — refuses like work, never reads as "clean".
 *
 * @group Thread tree
 */
export interface ThreadTreeInventory {
  readonly untracked: string[]
  readonly ignored: string[]
  readonly modified: string[]
  readonly unsnapshotted: string[]
  readonly unmergedCommits: number
  readonly unreadable: string[]
}

/**
 * A worktree's own view of what it holds, from the checkout's repository: untracked, ignored and
 * modified-against-its-branch, which is exactly what `git worktree remove` without `--force`
 * would refuse on. Into `inventory`; a failed status is recorded as unreadable, never as clean.
 */
async function readWorktreeStatus(
  environment: NodeJS.ProcessEnv,
  tree: string,
  inventory: ThreadTreeInventory,
): Promise<void> {
  const status = await runTreeGit(
    environment,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames'],
    tree,
  )
  if (status.code !== 0) {
    inventory.unreadable.push(`status: ${gitReason(status)}`)
    return
  }
  // `-z`: `XY path`, NUL-ended; `--no-renames`, so never a second path.
  for (const line of status.stdout.split('\0')) {
    if (line === '') continue
    const state = line.slice(0, 2)
    const path = line.slice(3)
    if (state === '??') inventory.untracked.push(path)
    else if (state === '!!') inventory.ignored.push(path)
    else inventory.modified.push(path)
  }
}

/**
 * The tree against its store: what the last snapshot lacks (the store goes with the dispose), and
 * for a copy, which has no repository of its own, its untracked, modified and ignored files
 * against `record.base`. Into `inventory`; a missing store or a failed comparison is unreadable.
 */
async function compareWithStore(
  environment: NodeJS.ProcessEnv,
  record: ThreadTreeRecord,
  store: string,
  inventory: ThreadTreeInventory,
): Promise<void> {
  if (!existsSync(join(store, 'HEAD'))) {
    inventory.unreadable.push(`no snapshot store at ${store}`)
    return
  }
  const compared = await compareTreeWithSnapshots({
    directory: store,
    tree: record.path,
    hashes: record.kind === 'copy' ? ['HEAD', record.base] : ['HEAD'],
    environment,
  })
  if (compared.kind === 'refused') {
    inventory.unreadable.push(`snapshot comparison: ${storeReason(compared.refused)}`)
    return
  }
  const [sinceSnapshot, sinceBase] = compared.differences
  inventory.unsnapshotted.push(...(sinceSnapshot?.added ?? []), ...(sinceSnapshot?.changed ?? []))
  inventory.unsnapshotted.sort()
  if (record.kind === 'copy') {
    inventory.untracked.push(...(sinceBase?.added ?? []))
    inventory.modified.push(...(sinceBase?.changed ?? []))
    inventory.ignored.push(...compared.ignored)
  }
}

/**
 * Commits on a worktree's branch that no other branch or remote reaches — what `branch -D` would
 * lose. 0 for a copy or a branch already gone; a failed count is pushed to `unreadable`.
 */
async function unmergedCommitsOf(
  environment: NodeJS.ProcessEnv,
  record: ThreadTreeRecord,
  unreadable: string[],
): Promise<number> {
  if (record.kind !== 'worktree' || record.branch === null) return 0
  const branchRef = `refs/heads/${record.branch}`
  const exists = await runTreeGit(environment, ['rev-parse', '--verify', '--quiet', branchRef], record.project)
  if (exists.code !== 0) return 0
  // `--exclude` takes the name as `--branches` sees it: without `refs/heads/`.
  const counted = await runTreeGit(
    environment,
    ['rev-list', '--count', branchRef, '--not', `--exclude=${record.branch}`, '--branches', '--remotes'],
    record.project,
  )
  if (counted.code === 0) return Number(counted.stdout.trim())
  unreadable.push(`rev-list: ${gitReason(counted)}`)
  return 0
}

/**
 * The inventory of a tree, for a dispose or a surface to show. A tree directory that is gone has
 * nothing to lose; its branch is still counted. Never throws.
 *
 * @group Thread tree
 */
export async function inventoryThreadTree(options: {
  readonly record: ThreadTreeRecord
  readonly store: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<ThreadTreeInventory> {
  const { record, store, environment } = options
  const inventory: ThreadTreeInventory = {
    untracked: [],
    ignored: [],
    modified: [],
    unsnapshotted: [],
    unmergedCommits: 0,
    unreadable: [],
  }
  if (existsSync(record.path)) {
    if (record.kind === 'worktree') await readWorktreeStatus(environment, record.path, inventory)
    await compareWithStore(environment, record, store, inventory)
  }
  return { ...inventory, unmergedCommits: await unmergedCommitsOf(environment, record, inventory.unreadable) }
}

/** Up to five paths, then how many more. */
function named(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(', ')
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown
}

/**
 * What in an inventory holds a dispose that is not forced; undefined when nothing does. The
 * dispose's own rule, for a caller that must ask before it does anything else (#571's delete).
 *
 * @group Thread tree
 */
export function holdingReason(inventory: ThreadTreeInventory): string | undefined {
  const holds = [
    inventory.untracked.length > 0 ? `untracked: ${named(inventory.untracked)}` : undefined,
    inventory.modified.length > 0 ? `modified: ${named(inventory.modified)}` : undefined,
    inventory.unsnapshotted.length > 0 ? `not in the last snapshot: ${named(inventory.unsnapshotted)}` : undefined,
    inventory.unmergedCommits > 0
      ? `${inventory.unmergedCommits} commit(s) on the branch no other ref reaches`
      : undefined,
    inventory.unreadable.length > 0 ? `could not be read: ${named(inventory.unreadable)}` : undefined,
  ].filter((hold) => hold !== undefined)
  return holds.length > 0 ? `the tree holds work — ${holds.join('; ')}` : undefined
}

/**
 * Whether the checkout's repository still lists `record.path` among its worktrees; undefined when
 * the listing failed — never read as "not registered".
 */
async function worktreeRegistered(
  record: ThreadTreeRecord,
  environment: NodeJS.ProcessEnv,
): Promise<boolean | undefined> {
  const listed = await runTreeGit(environment, ['worktree', 'list', '--porcelain'], record.project)
  if (listed.code !== 0) return undefined
  const path = canonical(record.path)
  return listed.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && canonical(line.slice('worktree '.length)) === path)
}

/**
 * The worktree's registration and directory removed, then its branch: `-d`, so a branch git does
 * not see merged into HEAD is kept (`-D` only when forced). Undefined when removed, else why not
 * — a failed `remove` leaves the branch and store alone, for the caller to refuse. ⚠ A tree
 * neither on disk nor registered is ALREADY removed (PR #572 review: a delete that stopped after
 * this step, or a user's `git worktree prune`) — the dispose goes on to its branch and store; a
 * tree still on disk is removed by git or refused, never assumed gone.
 */
async function removeWorktree(
  record: ThreadTreeRecord,
  force: boolean,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const alreadyGone = !existsSync(record.path) && (await worktreeRegistered(record, environment)) === false
  if (!alreadyGone) {
    // A tree directory that is gone still has its registration: `remove` drops it all the same.
    const removed = await runTreeGit(
      environment,
      ['worktree', 'remove', ...(force ? ['--force'] : []), record.path],
      record.project,
    )
    if (removed.code !== 0) return `git worktree remove: ${gitReason(removed)}`
  }
  if (record.branch === null) return undefined
  const exists = await runTreeGit(
    environment,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`],
    record.project,
  )
  // The tree is gone either way; a kept branch is not a failed dispose.
  if (exists.code === 0) await runTreeGit(environment, ['branch', force ? '-D' : '-d', record.branch], record.project)
  return undefined
}

/**
 * Let go of a deleted thread's store (#571, #573): the project's pre-#573 stores migrated first —
 * a fork's alternates may still name this one's objects — then the store removed, and the project's
 * object store collected, so what only this thread's snapshots reached goes. Its forks keep their
 * histories, the parent's snapshots up to where each forked among them. The store is kept — `busy`
 * while another migration or collection holds the project's stores, refused when the migration
 * fails or a fork it could not move still reads this store's objects through its alternates (#575
 * review). Refused, never thrown, when the store cannot be removed — what of it is left keeps its
 * last-pinned ref. A collection that is busy or fails leaves the garbage for the next,
 * `uncollected` saying why.
 *
 * @group Thread tree
 */
export async function releaseThreadStore(
  store: string,
  environment: NodeJS.ProcessEnv,
): Promise<
  | { readonly kind: 'removed'; readonly uncollected?: string }
  | { readonly kind: 'busy' | 'refused'; readonly reason: string }
> {
  const held = await prepareRelease(store, environment)
  if (held !== undefined) return held
  // A store that cannot be removed (another user's, a read-only directory) is a refusal, never a
  // throw (#575 review); what of it is left still holds its last-pinned ref.
  try {
    rmSync(store, { recursive: true, force: true })
  } catch (error) {
    return { kind: 'refused', reason: `the snapshot store could not be removed: ${String(error)}` }
  }
  const collected = await collectSnapshotGarbage(dirname(store), environment)
  if (collected === 'collected') return { kind: 'removed' }
  return {
    kind: 'removed',
    uncollected:
      collected === 'busy'
        ? 'the snapshot stores are busy, or one is not yet migrated'
        : `the object store: ${storeReason(collected.refused)}`,
  }
}

/**
 * The project's pre-#573 stores migrated (#573), and no fork the migration could not move still
 * reading `store`'s objects; undefined when the store may go, else what holds it.
 */
async function prepareRelease(
  store: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly kind: 'busy' | 'refused'; readonly reason: string } | undefined> {
  const migrated = await migrateSnapshotStores(dirname(store), environment)
  if (migrated === 'busy')
    return { kind: 'busy', reason: 'the snapshot stores are being migrated or collected; try again' }
  if ('kind' in migrated) {
    return { kind: 'refused', reason: `the snapshot stores could not be migrated: ${storeReason(migrated.refused)}` }
  }
  const forks = unmigratedForksOf(store)
  if (forks.length === 0) return undefined
  return {
    kind: 'refused',
    reason: `the snapshot store is kept: ${forks.join(', ')} could not be migrated and still read its objects`,
  }
}

/**
 * Dispose of a thread's tree: the store's release prepared first ({@link releaseThreadStore}:
 * `busy` or refused, nothing removed, when it cannot go), then the inventory, refused while it holds
 * work (unless `force`). Then the worktree is removed with its registration (`--force` only when
 * forced), its branch deleted when merged (`-D` only when forced; an unmerged branch is otherwise
 * kept), a copy's directory removed, and the store released.
 *
 * @group Thread tree
 */
export async function disposeThreadTree(options: {
  readonly record: ThreadTreeRecord
  readonly store: string
  readonly force: boolean
  readonly environment: NodeJS.ProcessEnv
}): Promise<
  | { kind: 'disposed'; uncollected?: string }
  | { kind: 'busy'; reason: string }
  | { kind: 'refused'; inventory?: ThreadTreeInventory; reason: string }
> {
  const { record, store, force, environment } = options
  const held = await prepareRelease(store, environment)
  if (held !== undefined)
    return held.kind === 'busy' ? { kind: 'busy', reason: held.reason } : { kind: 'refused', reason: held.reason }
  const inventory = await inventoryThreadTree({ record, store, environment })
  const holding = force ? undefined : holdingReason(inventory)
  if (holding !== undefined) return { kind: 'refused', inventory, reason: holding }
  if (record.kind === 'worktree') {
    const failed = await removeWorktree(record, force, environment)
    if (failed !== undefined) return { kind: 'refused', inventory, reason: failed }
  } else {
    rmSync(record.path, { recursive: true, force: true })
  }
  const released = await releaseThreadStore(store, environment)
  if (released.kind !== 'removed') {
    // The tree is gone: no inventory, so the host answers a refusal, never work to force.
    return released.kind === 'busy'
      ? { kind: 'busy', reason: released.reason }
      : { kind: 'refused', reason: released.reason }
  }
  return released.uncollected === undefined
    ? { kind: 'disposed' }
    : { kind: 'disposed', uncollected: released.uncollected }
}
