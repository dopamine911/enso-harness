import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { openSnapshotStore, type SnapshotTaken } from '../snapshot-store.ts'
import type { ThreadTreeKind, ThreadTreeRecord } from '../thread-tree-record.ts'
import {
  disposeThreadTree,
  inventoryThreadTree,
  mintThreadTree,
  restoreThreadTree,
  sweepOrphanedStores,
  treeKindFor,
} from '../thread-tree.ts'

/**
 * A thread's own tree (#551 slice 2), on real git: temp checkouts only, never a worktree of this
 * repository. ⚠ Every environment handed in carries a foreign `GIT_DIR`, as the snapshot store's
 * tests do: the tree's repository is named by its directory, never by the environment.
 */

/** A program on this process's PATH, by absolute path. */
function onPath(name: string): string {
  const found = Bun.which(name)
  if (found === null) throw new Error(`${name} is not on PATH`)
  return found
}

const environment: NodeJS.ProcessEnv = {
  PATH: `${dirname(onPath('git'))}:${dirname(onPath('rm'))}`,
  HOME: mkdtempSync(join(tmpdir(), 'enso-tree-home-')),
  GIT_DIR: '/nowhere/.git',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: environment.PATH,
      HOME: environment.HOME,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    encoding: 'utf8',
  }).trim()
}

/** A checkout: two tracked files, a `.gitignore` that covers `.env` and `build/`, and one commit. */
function checkout(): string {
  const project = mkdtempSync(join(tmpdir(), 'enso-tree-project-'))
  git(project, 'init', '--quiet')
  writeFileSync(join(project, '.gitignore'), '.env\nbuild/\n')
  writeFileSync(join(project, 'src.ts'), 'export const one = 1\n')
  writeFileSync(join(project, 'README.md'), '# t\n')
  git(project, 'add', '--all')
  git(project, 'commit', '--quiet', '-m', 'one')
  return project
}

/** Where a home keeps one project's trees and stores. */
interface Home {
  tree(id: string): string
  store(id: string): string
}

function home(): Home {
  const root = mkdtempSync(join(tmpdir(), 'enso-tree-enso-'))
  return { tree: (id) => join(root, 'trees', id), store: (id) => join(root, 'snapshots', id) }
}

/** Every file under `directory` but a `.git`, by relative path, with its content. */
function files(directory: string): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else found[relative(directory, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(directory)
  return found
}

function minted(
  outcome: { kind: 'minted'; record: ThreadTreeRecord } | { kind: 'refused'; step: string; reason: string },
): ThreadTreeRecord {
  if (outcome.kind !== 'minted') throw new Error(`refused at ${outcome.step}: ${outcome.reason}`)
  return outcome.record
}

async function mintFromCheckout(
  project: string,
  where: Home,
  id: string,
  kind: ThreadTreeKind = 'worktree',
): Promise<ThreadTreeRecord> {
  return minted(
    await mintThreadTree({
      project,
      tree: where.tree(id),
      store: where.store(id),
      kind,
      branch: `enso/${id}`,
      from: { kind: 'checkout' },
      environment,
    }),
  )
}

async function snapshotOf(store: string, tree: string): Promise<SnapshotTaken> {
  const opened = await openSnapshotStore({ directory: store, tree, environment })
  if (opened === undefined) throw new Error('the store did not open')
  const outcome = await opened.snapshot()
  if (outcome.kind !== 'taken') throw new Error(`refused at ${outcome.refused.step}`)
  return outcome.taken
}

test("⚠ a tree minted from a dirty checkout is a worktree on its own branch holding the checkout's current files — the uncommitted edit and the untracked file, never `.env` — and the checkout is untouched", async () => {
  const project = checkout()
  writeFileSync(join(project, 'src.ts'), 'export const one = 2\n')
  writeFileSync(join(project, 'notes.md'), 'untracked, not ignored\n')
  writeFileSync(join(project, '.env'), 'SECRET=hunter2\n')
  const statusBefore = git(project, 'status', '--porcelain')
  const headBefore = git(project, 'rev-parse', 'HEAD')
  const indexBefore = readFileSync(join(project, '.git', 'index'))
  const where = home()

  const record = await mintFromCheckout(project, where, 't1')
  expect(record).toEqual({ kind: 'worktree', project, path: where.tree('t1'), branch: 'enso/t1', base: record.base })
  expect(git(record.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('enso/t1')
  expect(git(record.path, 'rev-parse', 'HEAD')).toBe(headBefore)
  expect(files(record.path)).toEqual({
    '.gitignore': '.env\nbuild/\n',
    'README.md': '# t\n',
    'notes.md': 'untracked, not ignored\n',
    'src.ts': 'export const one = 2\n',
  })
  // The checkout's edits arrive as edits in the worktree, not as a commit (status lines, trimmed).
  expect(
    git(record.path, 'status', '--porcelain')
      .split('\n')
      .map((line) => line.trim())
      .toSorted(),
  ).toEqual(['?? notes.md', 'M src.ts'])
  // The checkout: same HEAD, same index bytes, same status.
  expect(git(project, 'rev-parse', 'HEAD')).toBe(headBefore)
  expect(readFileSync(join(project, '.git', 'index')).equals(indexBefore)).toBe(true)
  expect(git(project, 'status', '--porcelain')).toBe(statusBefore)
  // The store, opened for the tree, is the same store: the tree is its base, unchanged.
  expect(await snapshotOf(where.store('t1'), record.path)).toEqual({ hash: record.base, changed: false })
})

test('⚠ a project that is no checkout mints a copy — its files, no `.git` — and a worktree for it, or for a subdirectory of a checkout, is refused at `kind`, leaving nothing', async () => {
  const project = mkdtempSync(join(tmpdir(), 'enso-tree-plain-'))
  writeFileSync(join(project, 'a.txt'), 'a\n')
  writeFileSync(join(project, '.gitignore'), 'skip.txt\n')
  writeFileSync(join(project, 'skip.txt'), 'skipped\n')
  const where = home()
  expect(await treeKindFor(project, 'worktree', environment)).toBe('copy')

  const refused = await mintThreadTree({
    project,
    tree: where.tree('w'),
    store: where.store('w'),
    kind: 'worktree',
    branch: 'enso/w',
    from: { kind: 'checkout' },
    environment,
  })
  expect(refused.kind === 'refused' ? refused.step : refused.kind).toBe('kind')
  expect(existsSync(where.tree('w')) || existsSync(where.store('w'))).toBe(false)

  const record = await mintFromCheckout(project, where, 'c', 'copy')
  expect(record).toMatchObject({ kind: 'copy', branch: null })
  expect(files(record.path)).toEqual({ '.gitignore': 'skip.txt\n', 'a.txt': 'a\n' })
  expect(existsSync(join(record.path, '.git'))).toBe(false)
  expect(await snapshotOf(where.store('c'), record.path)).toEqual({ hash: record.base, changed: false })

  // A checkout's subdirectory: the store's paths would be relative to it, a worktree is the whole repository.
  const repository = checkout()
  mkdirSync(join(repository, 'sub'))
  expect(await treeKindFor(join(repository, 'sub'), 'worktree', environment)).toBe('copy')
  expect(await treeKindFor(repository, 'worktree', environment)).toBe('worktree')
  expect(await treeKindFor(repository, 'copy', environment)).toBe('copy')
})

test("⚠ a fork minted from a parent's snapshot after the parent's tree was edited holds the edit, and the parent's tree and store are unchanged", async () => {
  const project = checkout()
  const where = home()
  const parent = await mintFromCheckout(project, where, 'parent')
  writeFileSync(join(parent.path, 'src.ts'), 'export const one = 3\n')
  writeFileSync(join(parent.path, 'added.md'), 'the parent wrote this\n')
  const atFork = await snapshotOf(where.store('parent'), parent.path)
  const parentFiles = files(parent.path)

  // The fork's tree path need not name its thread: nothing is derived from it.
  const fork = minted(
    await mintThreadTree({
      project,
      tree: where.tree('fork-of-parent'),
      store: where.store('child'),
      kind: 'worktree',
      branch: 'enso/child',
      from: {
        kind: 'snapshot',
        hash: atFork.hash,
        revision: git(project, 'rev-parse', 'HEAD'),
        storeDirectory: where.store('parent'),
      },
      environment,
    }),
  )
  expect(fork.base).toBe(atFork.hash)
  expect(files(fork.path)).toEqual(parentFiles)
  expect(files(fork.path)['src.ts']).toBe('export const one = 3\n')
  expect(git(fork.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('enso/child')
  expect(await snapshotOf(where.store('child'), fork.path)).toEqual({ hash: atFork.hash, changed: false })

  expect(files(parent.path)).toEqual(parentFiles)
  expect(await snapshotOf(where.store('parent'), parent.path)).toEqual({ hash: atFork.hash, changed: false })
})

test('⚠ a failed mint leaves nothing behind — no tree directory, no worktree registration, no branch, no store — and an existing branch is refused, never reused', async () => {
  const project = checkout()
  const where = home()
  const worktreesBefore = git(project, 'worktree', 'list', '--porcelain')
  const branchesBefore = git(project, 'branch', '--list')

  // Fails AFTER the worktree, its branch and the store are made: the snapshot does not exist.
  const parent = await mintFromCheckout(project, where, 'parent', 'copy')
  const failed = await mintThreadTree({
    project,
    tree: where.tree('t3'),
    store: where.store('t3'),
    kind: 'worktree',
    branch: 'enso/t3',
    from: { kind: 'snapshot', hash: 'f'.repeat(40), revision: null, storeDirectory: where.store('parent') },
    environment,
  })
  expect(failed.kind === 'refused' ? failed.step : failed.kind).toBe('materialize')
  expect(existsSync(where.tree('t3'))).toBe(false)
  expect(existsSync(where.store('t3'))).toBe(false)
  expect(git(project, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
  expect(git(project, 'branch', '--list')).toBe(branchesBefore)

  git(project, 'branch', 'enso/taken')
  const taken = await mintThreadTree({
    project,
    tree: where.tree('taken'),
    store: where.store('taken'),
    kind: 'worktree',
    branch: 'enso/taken',
    from: { kind: 'checkout' },
    environment,
  })
  expect(taken.kind === 'refused' ? taken.step : taken.kind).toBe('branch')
  expect(existsSync(where.tree('taken')) || existsSync(where.store('taken'))).toBe(false)
  expect(git(project, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
  expect(parent.kind).toBe('copy')
})

test('⚠ a restore puts the files back to an earlier snapshot — an extra unignored file removed, an ignored one kept — and its safety snapshot holds what was there; an unknown hash is refused and rolled back', async () => {
  const project = checkout()
  const where = home()
  const record = await mintFromCheckout(project, where, 'r')
  const baseFiles = files(record.path)
  writeFileSync(join(record.path, 'src.ts'), 'export const one = 4\n')
  writeFileSync(join(record.path, 'extra.md'), 'unignored, untracked\n')
  mkdirSync(join(record.path, 'build'))
  writeFileSync(join(record.path, 'build', 'out.js'), 'built\n')

  const restored = await restoreThreadTree({
    store: where.store('r'),
    tree: record.path,
    hash: record.base,
    environment,
  })
  if (restored.kind !== 'restored') throw new Error(`refused at ${restored.step}: ${restored.reason}`)
  expect(restored.hash).toBe(record.base)
  expect(restored.safety).not.toBe(record.base)
  expect(files(record.path)).toEqual({ ...baseFiles, 'build/out.js': 'built\n' })
  const store = where.store('r')
  expect(git(store, 'show', `${restored.safety}:src.ts`)).toBe('export const one = 4')
  expect(git(store, 'show', `${restored.safety}:extra.md`)).toBe('unignored, untracked')

  // Back to the safety: the edit returns; an unknown hash changes nothing and says it rolled back.
  writeFileSync(join(record.path, 'src.ts'), 'export const one = 5\n')
  const unknown = await restoreThreadTree({ store, tree: record.path, hash: 'f'.repeat(40), environment })
  expect(unknown.kind === 'refused' ? unknown.step : unknown.kind).toBe('restore')
  expect(unknown.kind === 'refused' ? unknown.reason : '').toContain('rolled back to the safety snapshot')
  expect(readFileSync(join(record.path, 'src.ts'), 'utf8')).toBe('export const one = 5\n')
})

test('⚠ a dispose refuses a tree holding an untracked file or a commit no other ref reaches, and names it; a clean tree (ignored files aside) disposes — worktree, merged branch and store gone; force disposes a dirty one', async () => {
  const project = checkout()
  const where = home()
  const record = await mintFromCheckout(project, where, 'd')
  const store = where.store('d')
  writeFileSync(join(record.path, '.env'), 'SECRET=hunter2\n')
  expect(await inventoryThreadTree({ record, store, environment })).toEqual({
    untracked: [],
    ignored: ['.env'],
    modified: [],
    unsnapshotted: [],
    unmergedCommits: 0,
    unreadable: [],
    dependents: [],
  })

  writeFileSync(join(record.path, 'stray.md'), 'not yet anywhere\n')
  const untracked = await disposeThreadTree({ record, store, force: false, environment })
  expect(untracked.kind === 'refused' ? untracked.reason : untracked.kind).toContain('stray.md')
  expect(untracked.kind === 'refused' ? untracked.inventory.untracked : []).toEqual(['stray.md'])

  git(record.path, 'add', 'stray.md')
  git(record.path, 'commit', '--quiet', '-m', 'on the branch only')
  await snapshotOf(store, record.path)
  const committed = await disposeThreadTree({ record, store, force: false, environment })
  expect(committed.kind === 'refused' ? committed.inventory.unmergedCommits : 0).toBe(1)
  expect(committed.kind === 'refused' ? committed.reason : committed.kind).toContain('1 commit')

  git(record.path, 'reset', '--quiet', '--hard', 'HEAD~1')
  await snapshotOf(store, record.path)
  expect(await disposeThreadTree({ record, store, force: false, environment })).toEqual({
    kind: 'disposed',
    store: { kind: 'removed' },
  })
  expect(existsSync(record.path)).toBe(false)
  expect(git(project, 'worktree', 'list', '--porcelain')).not.toContain(record.path)
  expect(git(project, 'branch', '--list', 'enso/d')).toBe('')
  expect(existsSync(store)).toBe(false)

  const dirty = await mintFromCheckout(project, where, 'forced')
  writeFileSync(join(dirty.path, 'stray.md'), 'lost on purpose\n')
  git(dirty.path, 'add', 'stray.md')
  git(dirty.path, 'commit', '--quiet', '-m', 'lost too')
  writeFileSync(join(dirty.path, 'README.md'), 'modified\n')
  const forced = await disposeThreadTree({ record: dirty, store: where.store('forced'), force: true, environment })
  expect(forced).toEqual({ kind: 'disposed', store: { kind: 'removed' } })
  expect(existsSync(dirty.path)).toBe(false)
  expect(git(project, 'branch', '--list', 'enso/forced')).toBe('')
  expect(existsSync(where.store('forced'))).toBe(false)
})

// #571: a parent's store holds the objects of every snapshot its forks were minted from (their
// alternates name it). Deleting the parent must not break them: the store stays until they go.
test("⚠ a parent a fork leans on disposes its tree but keeps its store, marked orphaned — the fork still restores to the parent's snapshot — and a sweep removes it once the fork is gone, never a live thread's store", async () => {
  const project = checkout()
  const where = home()
  const parent = await mintFromCheckout(project, where, 'parent', 'copy')
  const fork = minted(
    await mintThreadTree({
      project,
      tree: where.tree('child'),
      store: where.store('child'),
      kind: 'copy',
      branch: 'enso/child',
      from: { kind: 'snapshot', hash: parent.base, revision: null, storeDirectory: where.store('parent') },
      environment,
    }),
  )
  const live = await mintFromCheckout(project, where, 'live', 'copy')
  expect(await disposeThreadTree({ record: parent, store: where.store('parent'), force: false, environment })).toEqual({
    kind: 'disposed',
    store: { kind: 'kept', dependents: [where.store('child')] },
  })
  expect(existsSync(parent.path)).toBe(false)
  expect(existsSync(join(where.store('parent'), 'HEAD'))).toBe(true)
  // Nothing depends on it yet only through the fork, which is still here: the sweep keeps it.
  expect(sweepOrphanedStores(dirname(where.store('parent')))).toEqual([])

  // The fork's base is the parent's snapshot, reachable only through the kept store.
  writeFileSync(join(fork.path, 'src.ts'), 'export const one = 9\n')
  const restored = await restoreThreadTree({
    store: where.store('child'),
    tree: fork.path,
    hash: fork.base,
    environment,
  })
  expect(restored.kind).toBe('restored')
  expect(readFileSync(join(fork.path, 'src.ts'), 'utf8')).toBe('export const one = 1\n')

  writeFileSync(join(fork.path, 'new.md'), 'since the base\n')
  const unforced = await disposeThreadTree({ record: fork, store: where.store('child'), force: false, environment })
  expect(unforced.kind === 'refused' ? unforced.inventory.untracked : []).toEqual(['new.md'])
  expect(await disposeThreadTree({ record: fork, store: where.store('child'), force: true, environment })).toEqual({
    kind: 'disposed',
    store: { kind: 'removed' },
  })
  expect(sweepOrphanedStores(dirname(where.store('parent')))).toEqual([where.store('parent')])
  expect(existsSync(where.store('parent'))).toBe(false)
  expect(existsSync(join(where.store('live'), 'HEAD'))).toBe(true)
  expect(await snapshotOf(where.store('live'), live.path)).toEqual({ hash: live.base, changed: false })
})

// PR #572 review: a store gone by hand while a fork's alternates still name it. Marking it kept
// threw ENOENT on every attempt, so the thread could never be deleted.
test('a store already gone, though a fork still names it, releases as removed, and its tree still disposes', async () => {
  const project = checkout()
  const where = home()
  const parent = await mintFromCheckout(project, where, 'gone', 'copy')
  minted(
    await mintThreadTree({
      project,
      tree: where.tree('gone-fork'),
      store: where.store('gone-fork'),
      kind: 'copy',
      branch: 'enso/gone-fork',
      from: { kind: 'snapshot', hash: parent.base, revision: null, storeDirectory: where.store('gone') },
      environment,
    }),
  )
  rmSync(where.store('gone'), { recursive: true, force: true })
  expect(await disposeThreadTree({ record: parent, store: where.store('gone'), force: true, environment })).toEqual({
    kind: 'disposed',
    store: { kind: 'removed' },
  })
  expect(existsSync(parent.path) || existsSync(where.store('gone'))).toBe(false)
})

// PR #572 review: a delete that stopped after its worktree was removed (or a user's `git worktree
// prune`) left a tree git no longer knows; `worktree remove` refused it, and the thread could never
// be deleted. A tree neither on disk nor registered is already removed — a present one still refuses.
test('a worktree already removed and unregistered disposes: its branch and store go; one still on disk but unregistered is refused', async () => {
  const project = checkout()
  const where = home()
  const pruned = await mintFromCheckout(project, where, 'pruned')
  rmSync(pruned.path, { recursive: true, force: true })
  git(project, 'worktree', 'prune')
  expect(await disposeThreadTree({ record: pruned, store: where.store('pruned'), force: false, environment })).toEqual({
    kind: 'disposed',
    store: { kind: 'removed' },
  })
  expect(git(project, 'branch', '--list', 'enso/pruned')).toBe('')
  expect(existsSync(where.store('pruned'))).toBe(false)

  const stray = await mintFromCheckout(project, where, 'stray')
  rmSync(join(project, '.git', 'worktrees', basename(stray.path)), { recursive: true, force: true })
  const refused = await disposeThreadTree({ record: stray, store: where.store('stray'), force: true, environment })
  expect(refused.kind).toBe('refused')
  expect(existsSync(stray.path) && existsSync(join(where.store('stray'), 'HEAD'))).toBe(true)
})

test('⚠ a file the checkout ignores only through `.git/info/exclude` is never minted into a tree, and a restore leaves it in place — in the worktree and in a copy forked from it', async () => {
  const project = checkout()
  writeFileSync(join(project, '.git', 'info', 'exclude'), 'local.secret\n')
  writeFileSync(join(project, 'local.secret'), 'only info/exclude hides this\n')
  const where = home()

  const record = await mintFromCheckout(project, where, 'x')
  expect(existsSync(join(record.path, 'local.secret'))).toBe(false)

  writeFileSync(join(record.path, 'local.secret'), 'the tree’s own\n')
  const restored = await restoreThreadTree({
    store: where.store('x'),
    tree: record.path,
    hash: record.base,
    environment,
  })
  expect(restored.kind).toBe('restored')
  expect(readFileSync(join(record.path, 'local.secret'), 'utf8')).toBe('the tree’s own\n')

  // A copy has no repository to read the rule from: it carries on from the parent's store.
  const fork = minted(
    await mintThreadTree({
      project,
      tree: where.tree('x-copy'),
      store: where.store('x-copy'),
      kind: 'copy',
      branch: 'enso/x-copy',
      from: { kind: 'snapshot', hash: record.base, revision: null, storeDirectory: where.store('x') },
      environment,
    }),
  )
  writeFileSync(join(fork.path, 'local.secret'), 'the copy’s own\n')
  const restoredCopy = await restoreThreadTree({
    store: where.store('x-copy'),
    tree: fork.path,
    hash: fork.base,
    environment,
  })
  expect(restoredCopy.kind).toBe('restored')
  expect(readFileSync(join(fork.path, 'local.secret'), 'utf8')).toBe('the copy’s own\n')
})

test("⚠ a copy of a subdirectory project follows its repository's ignore rules (#566): none of its ignored files is minted, one made in the copy is never snapshotted, and a restore leaves it — in the copy and in a copy forked from it", async () => {
  const repository = checkout()
  writeFileSync(join(repository, '.gitignore'), '.env\nnode_modules/\n')
  writeFileSync(join(repository, '.git', 'info', 'exclude'), '/app/local.txt\n')
  const project = join(repository, 'app')
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(project, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(project, '.env'), 'SECRET=hunter2\n')
  writeFileSync(join(project, 'local.txt'), 'only info/exclude hides this\n')
  writeFileSync(join(project, 'node_modules', 'x', 'i.js'), 'installed\n')
  const where = home()
  expect(await treeKindFor(project, 'worktree', environment)).toBe('copy')

  const record = await mintFromCheckout(project, where, 'sub', 'copy')
  expect(files(record.path)).toEqual({ 'a.ts': 'export const a = 1\n' })

  const ignoredInCopy = (tree: string): void => {
    mkdirSync(join(tree, 'node_modules', 'y'), { recursive: true })
    writeFileSync(join(tree, 'node_modules', 'y', 'j.js'), 'installed in the copy\n')
    writeFileSync(join(tree, '.env'), 'SECRET=the copy’s own\n')
    writeFileSync(join(tree, 'local.txt'), 'the copy’s own\n')
    writeFileSync(join(tree, 'stray.md'), 'unignored, untracked\n')
  }
  const ignoredSurvived = (tree: string): void => {
    expect(files(tree)).toEqual({
      'a.ts': 'export const a = 1\n',
      '.env': 'SECRET=the copy’s own\n',
      'local.txt': 'the copy’s own\n',
      'node_modules/y/j.js': 'installed in the copy\n',
    })
  }
  ignoredInCopy(record.path)
  const restored = await restoreThreadTree({
    store: where.store('sub'),
    tree: record.path,
    hash: record.base,
    environment,
  })
  if (restored.kind !== 'restored') throw new Error(`refused at ${restored.step}: ${restored.reason}`)
  expect(git(where.store('sub'), 'ls-tree', '-r', '--name-only', restored.safety).split('\n').toSorted()).toEqual([
    'a.ts',
    'stray.md',
  ])
  ignoredSurvived(record.path)
  // The copy's inventory calls them ignored, never untracked: a dispose is not held by them.
  const inventory = await inventoryThreadTree({ record, store: where.store('sub'), environment })
  expect(inventory.untracked).toEqual([])
  expect(inventory.ignored.toSorted()).toEqual(['.env', 'local.txt', 'node_modules/y/j.js'])

  const fork = minted(
    await mintThreadTree({
      project,
      tree: where.tree('sub-fork'),
      store: where.store('sub-fork'),
      kind: 'copy',
      branch: 'enso/sub-fork',
      from: { kind: 'snapshot', hash: record.base, revision: null, storeDirectory: where.store('sub') },
      environment,
    }),
  )
  expect(files(fork.path)).toEqual({ 'a.ts': 'export const a = 1\n' })
  ignoredInCopy(fork.path)
  const restoredFork = await restoreThreadTree({
    store: where.store('sub-fork'),
    tree: fork.path,
    hash: fork.base,
    environment,
  })
  expect(restoredFork.kind).toBe('restored')
  ignoredSurvived(fork.path)
})

test('⚠ a chain of seven forks mints — the deepest tree holds every generation’s file, past git’s five-deep alternates limit — and deleted from the middle down, each kept store is swept only once no store names it', async () => {
  const project = mkdtempSync(join(tmpdir(), 'enso-tree-chain-'))
  writeFileSync(join(project, 'root.txt'), 'root\n')
  const where = home()
  const records = [await mintFromCheckout(project, where, 'g0', 'copy')]
  for (let generation = 1; generation <= 7; generation += 1) {
    const parent = records[generation - 1] as ThreadTreeRecord
    writeFileSync(join(parent.path, `g${generation - 1}.txt`), `generation ${generation - 1}\n`)
    const atFork = await snapshotOf(where.store(`g${generation - 1}`), parent.path)
    records.push(
      minted(
        await mintThreadTree({
          project,
          tree: where.tree(`g${generation}`),
          store: where.store(`g${generation}`),
          kind: 'copy',
          branch: `enso/g${generation}`,
          from: {
            kind: 'snapshot',
            hash: atFork.hash,
            revision: null,
            storeDirectory: where.store(`g${generation - 1}`),
          },
          environment,
        }),
      ),
    )
  }
  const deepest = records[7] as ThreadTreeRecord
  expect(files(deepest.path)).toEqual({
    'root.txt': 'root\n',
    ...Object.fromEntries(Array.from({ length: 7 }, (_, at) => [`g${at}.txt`, `generation ${at}\n`])),
  })

  // #571: g5 and g6 are kept for the generations below them; once g7 goes, the sweep removes g6,
  // then — a round later, nothing naming it any more — g5. The ancestors above are live threads'.
  const disposed = async (generation: number): Promise<unknown> => {
    const outcome = await disposeThreadTree({
      record: records[generation] as ThreadTreeRecord,
      store: where.store(`g${generation}`),
      force: true,
      environment,
    })
    return outcome.kind === 'disposed' ? outcome.store : outcome
  }
  expect(await disposed(5)).toEqual({ kind: 'kept', dependents: [where.store('g6'), where.store('g7')] })
  expect(await disposed(6)).toEqual({ kind: 'kept', dependents: [where.store('g7')] })
  expect(await disposed(7)).toEqual({ kind: 'removed' })
  expect(sweepOrphanedStores(dirname(where.store('g5')))).toEqual([where.store('g6'), where.store('g5')])
  expect(Array.from({ length: 5 }, (_, generation) => existsSync(join(where.store(`g${generation}`), 'HEAD')))).toEqual(
    [true, true, true, true, true],
  )
})
