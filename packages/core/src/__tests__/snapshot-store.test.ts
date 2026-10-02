import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  materializeSnapshot,
  openSnapshotStore,
  type SnapshotStore,
  type SnapshotTaken,
  snapshotPaths,
} from '../snapshot-store.ts'

/**
 * The per-thread snapshot store (#551 slice 1), on real git. ⚠ Every environment handed in carries
 * a foreign `GIT_DIR`: what the store must ignore (the tree's own repository is named by the work
 * tree, the store's by itself), as `@enso/core/git` does.
 */

/** A program on this process's PATH, by absolute path. */
function onPath(name: string): string {
  const found = Bun.which(name)
  if (found === null) throw new Error(`${name} is not on PATH`)
  return found
}

const environment: NodeJS.ProcessEnv = {
  PATH: `${dirname(onPath('git'))}:${dirname(onPath('rm'))}`,
  HOME: mkdtempSync(join(tmpdir(), 'enso-snap-home-')),
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
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-tree-'))
  git(tree, 'init', '--quiet')
  writeFileSync(join(tree, '.gitignore'), '.env\nbuild/\n')
  writeFileSync(join(tree, 'src.ts'), 'export const one = 1\n')
  writeFileSync(join(tree, 'README.md'), '# t\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'one')
  return tree
}

async function opened(tree: string, parent = mkdtempSync(join(tmpdir(), 'enso-snap-store-'))): Promise<SnapshotStore> {
  const store = await openSnapshotStore({ directory: join(parent, 'store'), tree, environment })
  if (store === undefined) throw new Error('the store did not open')
  return store
}

async function taken(store: SnapshotStore): Promise<SnapshotTaken> {
  const outcome = await store.snapshot()
  if (outcome.kind !== 'taken') throw new Error(`refused at ${outcome.refused.step}: ${outcome.refused.stderr}`)
  return outcome.taken
}

test('⚠ a snapshot is the tracked set plus the unignored untracked files: `.env` and an ignored directory never enter the store; the tree’s own repository is untouched', async () => {
  const tree = checkout()
  writeFileSync(join(tree, '.env'), 'SECRET=hunter2\n')
  mkdirSync(join(tree, 'build'))
  writeFileSync(join(tree, 'build', 'out.js'), 'built\n')
  writeFileSync(join(tree, 'notes.md'), 'untracked, not ignored\n')
  const headBefore = git(tree, 'rev-parse', 'HEAD')
  const statusBefore = git(tree, 'status', '--porcelain')
  const indexBefore = readFileSync(join(tree, '.git', 'index'))

  const store = await opened(tree)
  const first = await taken(store)
  expect(first.changed).toBe(true)
  expect((await snapshotPaths(environment, store, first.hash)).toSorted()).toEqual([
    '.gitignore',
    'README.md',
    'notes.md',
    'src.ts',
  ])
  // Nothing of the secret is in the store's objects: not as a path, not as a blob.
  const blobs = git(store.directory, 'cat-file', '--batch-all-objects', '--batch-check')
  const secretBlob = git(tree, 'hash-object', '.env')
  expect(blobs).not.toContain(secretBlob)
  // The tree's repository: same HEAD, same index bytes (read after the test's own `status`, which
  // refreshes it — the store's gits must not), same status.
  expect(git(tree, 'rev-parse', 'HEAD')).toBe(headBefore)
  expect(readFileSync(join(tree, '.git', 'index')).equals(indexBefore)).toBe(true)
  expect(git(tree, 'status', '--porcelain')).toBe(statusBefore)
  // The store leans on the checkout's objects: the alternates file names them, and the tracked
  // blobs are not duplicated.
  expect(readFileSync(join(store.directory, 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(
    join(tree, '.git', 'objects'),
  )
})

test('⚠ an idle turn is the same snapshot (`changed: false`, same hash); an edit is a new one with the old as parent', async () => {
  const tree = checkout()
  const store = await opened(tree)
  const first = await taken(store)
  const idle = await taken(store)
  expect(idle).toEqual({ hash: first.hash, changed: false })

  writeFileSync(join(tree, 'src.ts'), 'export const one = 2\n')
  const edited = await taken(store)
  expect(edited.changed).toBe(true)
  expect(edited.hash).not.toBe(first.hash)
  expect(git(store.directory, 'rev-parse', `${edited.hash}^`)).toBe(first.hash)
  expect(git(store.directory, 'show', `${edited.hash}:src.ts`)).toBe('export const one = 2')
  // Reopening the store reads it back: the next idle turn is still the same snapshot.
  const reopened = await openSnapshotStore({ directory: store.directory, tree, environment })
  if (reopened === undefined) throw new Error('did not reopen')
  expect(await taken(reopened)).toEqual({ hash: edited.hash, changed: false })
})

test('⚠ a tracked file a later .gitignore rule covers stays in the snapshot (the tracked set, not the ignore rules, is the base); a deleted tracked file leaves it', async () => {
  const tree = checkout()
  // Tracked first, ignored after — vx-pm's 4,696 screenshots (#551).
  mkdirSync(join(tree, 'shots'))
  writeFileSync(join(tree, 'shots', 'a.png'), 'png\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'shots')
  writeFileSync(join(tree, '.gitignore'), '.env\nbuild/\nshots/\n')
  const store = await opened(tree)
  const first = await taken(store)
  expect(await snapshotPaths(environment, store, first.hash)).toContain('shots/a.png')
  // A new file under the now-ignored directory is untracked and ignored: out.
  writeFileSync(join(tree, 'shots', 'b.png'), 'png\n')
  const second = await taken(store)
  expect(await snapshotPaths(environment, store, second.hash)).not.toContain('shots/b.png')
  // Deleting a tracked file: the snapshot no longer lists it.
  execFileSync('rm', [join(tree, 'README.md')])
  const third = await taken(store)
  expect(await snapshotPaths(environment, store, third.hash)).not.toContain('README.md')
})

test("⚠ the store takes the checkout's object format — a sha256 checkout snapshots with 64-digit hashes and still leans on its objects — whatever `init.defaultObjectFormat` says", async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-sha256-'))
  git(tree, 'init', '--quiet', '--object-format=sha256')
  writeFileSync(join(tree, 'a.txt'), 'a\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'a')
  // The user's default says the other format, through a global config file — `GIT_CONFIG_COUNT`
  // would be stripped by the runner as a repository-locating variable, and never reach git. The
  // checkout's format wins, else alternates could not be read.
  const globalConfig = join(mkdtempSync(join(tmpdir(), 'enso-snap-config-')), 'gitconfig')
  writeFileSync(globalConfig, '[init]\n\tdefaultObjectFormat = sha1\n')
  const store = await openSnapshotStore({
    directory: join(mkdtempSync(join(tmpdir(), 'enso-snap-store-')), 'store'),
    tree,
    environment: { ...environment, GIT_CONFIG_GLOBAL: globalConfig },
  })
  if (store === undefined) throw new Error('did not open')
  const first = await taken(store)
  expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(await snapshotPaths(environment, store, first.hash)).toEqual(['a.txt'])
  expect(readFileSync(join(store.directory, 'config'), 'utf8')).toContain('objectformat = sha256')
})

test('a tree that is no git checkout snapshots too — no alternates, no seed, every file hashed', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-plain-'))
  writeFileSync(join(tree, 'a.txt'), 'a\n')
  writeFileSync(join(tree, '.gitignore'), 'skip.txt\n')
  writeFileSync(join(tree, 'skip.txt'), 'skipped\n')
  const store = await opened(tree)
  const first = await taken(store)
  expect((await snapshotPaths(environment, store, first.hash)).toSorted()).toEqual(['.gitignore', 'a.txt'])
  expect(existsSync(join(store.directory, 'objects', 'info', 'alternates'))).toBe(false)
  expect(existsSync(join(tree, '.git'))).toBe(false)
})

test('a mint that cannot write refuses the store as undefined, and a snapshot git that fails is refused by step, never thrown', async () => {
  const tree = checkout()
  const unwritable = join(mkdtempSync(join(tmpdir(), 'enso-snap-ro-')), 'ro')
  mkdirSync(unwritable, { mode: 0o500 })
  expect(await openSnapshotStore({ directory: join(unwritable, 'store'), tree, environment })).toBeUndefined()

  const store = await opened(tree)
  // The tree vanishes under the store: `add` fails, and the outcome says where.
  execFileSync('rm', ['-rf', tree])
  const outcome = await store.snapshot()
  expect(outcome.kind === 'refused' ? outcome.refused.step : outcome.taken.hash).toBe('add')
})

test('⚠ materializing a snapshot makes the tree exactly it — an edit undone, a deleted file back, an unignored untracked file gone — and never touches an ignored file', async () => {
  const tree = checkout()
  const store = await opened(tree)
  const first = await taken(store)
  writeFileSync(join(tree, 'src.ts'), 'export const one = 2\n')
  execFileSync('rm', [join(tree, 'README.md')])
  mkdirSync(join(tree, 'scratch'))
  writeFileSync(join(tree, 'scratch', 'notes.md'), 'unignored, untracked\n')
  writeFileSync(join(tree, '.env'), 'SECRET=hunter2\n')

  const outcome = await materializeSnapshot({ directory: store.directory, tree, hash: first.hash, environment })
  expect(outcome).toEqual({ kind: 'materialized' })
  expect(readFileSync(join(tree, 'src.ts'), 'utf8')).toBe('export const one = 1\n')
  expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('# t\n')
  expect(existsSync(join(tree, 'scratch'))).toBe(false)
  expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('SECRET=hunter2\n')
  // The tree is the snapshot again: the next one is the same, not a new commit.
  expect(await taken(store)).toEqual({ hash: first.hash, changed: false })
  // An unknown hash is refused by step, the tree as it was.
  const unknown = await materializeSnapshot({ directory: store.directory, tree, hash: 'f'.repeat(40), environment })
  expect(unknown.kind === 'refused' ? unknown.refused.step : unknown.kind).toBe('read-tree')
})

test("⚠ a store minted with another store's objects as an alternate materializes that store's snapshot into a plain directory, in that store's object format", async () => {
  // A sha256 checkout: a store for a plain directory would otherwise be sha1, and could not read
  // the parent's objects at all.
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-sha256-'))
  git(tree, 'init', '--quiet', '--object-format=sha256')
  writeFileSync(join(tree, 'a.txt'), 'a\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'a')
  writeFileSync(join(tree, 'b.txt'), 'untracked\n')
  const parent = await opened(tree)
  const snapshot = await taken(parent)

  const copy = mkdtempSync(join(tmpdir(), 'enso-snap-copy-'))
  const fork = await openSnapshotStore({
    directory: join(mkdtempSync(join(tmpdir(), 'enso-snap-store-')), 'store'),
    tree: copy,
    environment,
    alternates: [join(parent.directory, 'objects')],
  })
  if (fork === undefined) throw new Error('did not open')
  expect(readFileSync(join(fork.directory, 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(
    join(parent.directory, 'objects'),
  )
  expect(
    await materializeSnapshot({ directory: fork.directory, tree: copy, hash: snapshot.hash, environment }),
  ).toEqual({
    kind: 'materialized',
  })
  expect(readFileSync(join(copy, 'a.txt'), 'utf8')).toBe('a\n')
  expect(readFileSync(join(copy, 'b.txt'), 'utf8')).toBe('untracked\n')
  expect(existsSync(join(copy, '.git'))).toBe(false)
})
