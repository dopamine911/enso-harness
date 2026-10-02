import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  collectSnapshotGarbage,
  forksOfStore,
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

/**
 * A repository whose project is its subdirectory `packages/app` (#566): the repository's
 * `.gitignore` covers `.env`, `node_modules/` and `*.log`, its `info/exclude` names
 * `/packages/app/local.txt` — rules git applies to the project but finds only ABOVE it. In the
 * project: one of each ignored file, a tracked file `*.log` covers, a tracked source, and an
 * untracked unignored note.
 */
function subdirectoryProject(): { repository: string; project: string } {
  const repository = mkdtempSync(join(tmpdir(), 'enso-snap-mono-'))
  const project = join(repository, 'packages', 'app')
  git(repository, 'init', '--quiet')
  writeFileSync(join(repository, '.gitignore'), '.env\nnode_modules/\n*.log\n')
  writeFileSync(join(repository, '.git', 'info', 'exclude'), '/packages/app/local.txt\n')
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(project, 'src.ts'), 'export const one = 1\n')
  writeFileSync(join(project, 'kept.log'), 'tracked, though *.log covers it\n')
  git(repository, 'add', '--all')
  git(repository, 'add', '--force', 'packages/app/kept.log')
  git(repository, 'commit', '--quiet', '-m', 'one')
  writeFileSync(join(project, '.env'), 'SECRET=hunter2\n')
  writeFileSync(join(project, 'local.txt'), 'only info/exclude hides this\n')
  writeFileSync(join(project, 'node_modules', 'x', 'i.js'), 'installed\n')
  writeFileSync(join(project, 'notes.md'), 'untracked, not ignored\n')
  return { repository, project }
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
})

// #573: a store that BORROWED the checkout's objects lost them to the checkout's own gc — the
// user's `git gc`, `git maintenance`, an IDE — once the checkout stopped referencing them. A
// snapshot of files matching a commit later reset away, and one of a staged change staged over,
// must both still materialize after it.
test("⚠ a snapshot survives the checkout's own gc: files matching a commit later reset away, and a staged change later staged over, both still materialize (#573)", async () => {
  for (const kind of ['committed', 'staged'] as const) {
    const tree = checkout()
    writeFileSync(join(tree, 'src.ts'), `export const one = '${kind}'\n`)
    if (kind === 'committed') git(tree, 'commit', '--quiet', '-am', 'two')
    else git(tree, 'add', 'src.ts')
    const store = await opened(tree)
    const snapshot = await taken(store)
    if (kind === 'committed') git(tree, 'reset', '--quiet', '--hard', 'HEAD~1')
    else {
      writeFileSync(join(tree, 'src.ts'), 'export const one = 3\n')
      git(tree, 'add', 'src.ts')
    }
    git(tree, 'reflog', 'expire', '--expire=now', '--all')
    git(tree, 'gc', '--quiet', '--prune=now')
    writeFileSync(join(tree, 'src.ts'), 'export const one = 4\n')
    expect(await materializeSnapshot({ directory: store.directory, tree, hash: snapshot.hash, environment })).toEqual({
      kind: 'materialized',
    })
    expect(readFileSync(join(tree, 'src.ts'), 'utf8')).toBe(`export const one = '${kind}'\n`)
  }
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

test("⚠ the store takes the checkout's object format — a sha256 checkout snapshots with 64-digit hashes — whatever `init.defaultObjectFormat` says", async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-sha256-'))
  git(tree, 'init', '--quiet', '--object-format=sha256')
  writeFileSync(join(tree, 'a.txt'), 'a\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'a')
  // The user's default says the other format, through a global config file — `GIT_CONFIG_COUNT`
  // would be stripped by the runner as a repository-locating variable, and never reach git. The
  // checkout's format wins, else the seed's blobs could not be copied from its objects.
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

test('a tree that is no git checkout snapshots too — no seed, every file hashed', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-plain-'))
  writeFileSync(join(tree, 'a.txt'), 'a\n')
  writeFileSync(join(tree, '.gitignore'), 'skip.txt\n')
  writeFileSync(join(tree, 'skip.txt'), 'skipped\n')
  const store = await opened(tree)
  const first = await taken(store)
  expect((await snapshotPaths(environment, store, first.hash)).toSorted()).toEqual(['.gitignore', 'a.txt'])
  expect(existsSync(join(tree, '.git'))).toBe(false)
})

/** Whether git speaks German here: a machine without the locale or git's catalog prints English. */
function gitSpeaksGerman(): boolean {
  try {
    execFileSync('git', ['rev-parse'], {
      cwd: mkdtempSync(join(tmpdir(), 'enso-snap-locale-')),
      env: { PATH: environment.PATH, LC_ALL: 'de_DE.UTF-8' },
      stdio: 'pipe',
    })
    return false
  } catch (error) {
    return error instanceof Error && 'stderr' in error && String(error.stderr).includes('Kein Git-Repository')
  }
}

// PR #567 review: whether a tree is in a repository is read from git's words, which git translates.
test.skipIf(!gitSpeaksGerman())(
  'a tree in no repository snapshots under a locale git translates its messages into',
  async () => {
    const tree = mkdtempSync(join(tmpdir(), 'enso-snap-plain-'))
    writeFileSync(join(tree, 'a.txt'), 'a\n')
    const store = await openSnapshotStore({
      directory: join(mkdtempSync(join(tmpdir(), 'enso-snap-store-')), 'store'),
      tree,
      environment: { ...environment, LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' },
    })
    if (store === undefined) throw new Error('the store did not open')
    const first = await taken(store)
    expect(await snapshotPaths(environment, store, first.hash)).toEqual(['a.txt'])
  },
)

test('a mint that cannot write refuses the store as undefined, and a snapshot git that fails is refused by step, never thrown', async () => {
  const tree = checkout()
  const unwritable = join(mkdtempSync(join(tmpdir(), 'enso-snap-ro-')), 'ro')
  mkdirSync(unwritable, { mode: 0o500 })
  expect(await openSnapshotStore({ directory: join(unwritable, 'store'), tree, environment })).toBeUndefined()

  const store = await opened(tree)
  // The tree vanishes under the store: its first git, asking which rules apply, fails, and the
  // outcome says where.
  execFileSync('rm', ['-rf', tree])
  const outcome = await store.snapshot()
  expect(outcome.kind === 'refused' ? outcome.refused.step : outcome.taken.hash).toBe('rev-parse')
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

test("⚠ a subdirectory project snapshots under its repository's ignore rules — the `.gitignore` above it and `info/exclude` — and a materialize neither deletes nor overwrites a file they ignore (#566)", async () => {
  const { project } = subdirectoryProject()
  const store = await opened(project)
  const first = await taken(store)
  expect((await snapshotPaths(environment, store, first.hash)).toSorted()).toEqual(['kept.log', 'notes.md', 'src.ts'])
  const blobs = git(store.directory, 'cat-file', '--batch-all-objects', '--batch-check')
  expect(blobs).not.toContain(git(project, 'hash-object', '.env'))

  // Ignored files made since, and the ignored ones there were, all survive a materialize; the
  // unignored file it lacks goes.
  writeFileSync(join(project, 'debug.log'), 'made after the snapshot\n')
  writeFileSync(join(project, '.env'), 'SECRET=rotated\n')
  writeFileSync(join(project, 'stray.md'), 'unignored, untracked\n')
  const outcome = await materializeSnapshot({
    directory: store.directory,
    tree: project,
    hash: first.hash,
    environment,
  })
  expect(outcome).toEqual({ kind: 'materialized' })
  expect(existsSync(join(project, 'stray.md'))).toBe(false)
  expect(readFileSync(join(project, 'debug.log'), 'utf8')).toBe('made after the snapshot\n')
  expect(readFileSync(join(project, '.env'), 'utf8')).toBe('SECRET=rotated\n')
  expect(readFileSync(join(project, 'local.txt'), 'utf8')).toBe('only info/exclude hides this\n')
  expect(readFileSync(join(project, 'node_modules', 'x', 'i.js'), 'utf8')).toBe('installed\n')
  expect(await taken(store)).toEqual({ hash: first.hash, changed: false })
})

// PR #567 review: a path whose leading directory is a symlink is not the tree's. Removing it would
// remove what the link points at — outside the tree — and staging it is refused by git.
test('⚠ nothing is removed through a symlinked directory: a tracked directory replaced by a symlink snapshots as the symlink, and a materialize removes through neither that symlink nor one it checks out itself', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'enso-snap-outside-'))
  writeFileSync(join(outside, 'f.txt'), 'not the tree’s\n')

  // The tree's own symlink: `d/f.txt` is still in the checkout's index, `d` now points outside.
  const tree = checkout()
  const store = await opened(tree)
  const before = await taken(store)
  mkdirSync(join(tree, 'd'))
  writeFileSync(join(tree, 'd', 'f.txt'), 'tracked\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'd')
  rmSync(join(tree, 'd'), { recursive: true })
  symlinkSync(outside, join(tree, 'd'))
  const linked = await taken(store)
  expect(await snapshotPaths(environment, store, linked.hash)).toContain('d')
  expect(await snapshotPaths(environment, store, linked.hash)).not.toContain('d/f.txt')
  expect(await materializeSnapshot({ directory: store.directory, tree, hash: before.hash, environment })).toEqual({
    kind: 'materialized',
  })
  expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('not the tree’s\n')

  // A symlink the materialize itself checks out where the tree has a directory holding `f.txt`.
  const other = checkout()
  symlinkSync(outside, join(other, 'd'))
  const otherStore = await opened(other)
  const withLink = await taken(otherStore)
  rmSync(join(other, 'd'))
  mkdirSync(join(other, 'd'))
  writeFileSync(join(other, 'd', 'f.txt'), 'the tree’s own\n')
  expect(
    await materializeSnapshot({ directory: otherStore.directory, tree: other, hash: withLink.hash, environment }),
  ).toEqual({ kind: 'materialized' })
  expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('not the tree’s\n')
})

// PR #567 review: a sparse checkout leaves paths off disk that are still the commit's.
test('a sparse checkout snapshots the whole commit: a path it leaves off disk keeps the blob its index records', async () => {
  const tree = checkout()
  mkdirSync(join(tree, 'in'))
  mkdirSync(join(tree, 'out'))
  writeFileSync(join(tree, 'in', 'x'), 'x\n')
  writeFileSync(join(tree, 'out', 'y'), 'y\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'two directories')
  git(tree, 'sparse-checkout', 'set', 'in')
  expect(existsSync(join(tree, 'out', 'y'))).toBe(false)
  const store = await opened(tree)
  const first = await taken(store)
  expect(await snapshotPaths(environment, store, first.hash)).toContain('out/y')
  expect(git(store.directory, 'rev-parse', `${first.hash}:out/y`)).toBe(git(tree, 'rev-parse', 'HEAD:out/y'))
})

test("⚠ a fork's store, beside its parent's, materializes the parent's snapshot into a plain directory, in the parent's object format, and names the parent as what it was forked from", async () => {
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
    directory: join(dirname(parent.directory), 'fork'),
    tree: copy,
    environment,
    forkOf: parent.directory,
  })
  if (fork === undefined) throw new Error('did not open')
  expect(forksOfStore(parent.directory)).toEqual(['fork'])
  expect(forksOfStore(fork.directory)).toEqual([])
  expect(
    await materializeSnapshot({ directory: fork.directory, tree: copy, hash: snapshot.hash, environment }),
  ).toEqual({
    kind: 'materialized',
  })
  expect(readFileSync(join(copy, 'a.txt'), 'utf8')).toBe('a\n')
  expect(readFileSync(join(copy, 'b.txt'), 'utf8')).toBe('untracked\n')
  expect(existsSync(join(copy, '.git'))).toBe(false)
})

/** Every file under `directory` dated two hours back: past the collection's one-hour grace. */
function aged(directory: string): void {
  const then = new Date(Date.now() - 2 * 60 * 60_000)
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), then, then)
  }
}

/** Whether the store at `directory` can read object `hash`. */
function holds(directory: string, hash: string): boolean {
  try {
    execFileSync('git', ['--git-dir', directory, 'cat-file', '-e', hash], { env: { PATH: environment.PATH } })
    return true
  } catch {
    return false
  }
}

test("⚠ a collection removes what only a deleted thread's store reached, and keeps every live store's history — a fork's included, back through the parent's snapshots it was forked from (#573)", async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const parent = await opened(tree, snapshots)
  writeFileSync(join(tree, 'parent-only.txt'), 'the parent wrote this\n')
  const forkedAt = await taken(parent)
  const fork = await openSnapshotStore({
    directory: join(snapshots, 'fork'),
    tree,
    environment,
    forkOf: parent.directory,
  })
  if (fork === undefined) throw new Error('did not open')
  execFileSync('git', ['--git-dir', fork.directory, 'update-ref', 'HEAD', forkedAt.hash], {
    env: { PATH: environment.PATH },
  })
  writeFileSync(join(tree, 'parent-only.txt'), 'the parent wrote this later\n')
  const later = await taken(parent)
  const laterBlob = git(tree, 'hash-object', 'parent-only.txt')

  rmSync(parent.directory, { recursive: true, force: true })
  aged(join(snapshots, '.objects', 'objects'))
  expect(await collectSnapshotGarbage(snapshots, environment)).toBe('collected')
  expect(holds(fork.directory, later.hash)).toBe(false)
  expect(holds(fork.directory, laterBlob)).toBe(false)
  const copy = mkdtempSync(join(tmpdir(), 'enso-snap-copy-'))
  expect(
    await materializeSnapshot({ directory: fork.directory, tree: copy, hash: forkedAt.hash, environment }),
  ).toEqual({
    kind: 'materialized',
  })
  expect(readFileSync(join(copy, 'parent-only.txt'), 'utf8')).toBe('the parent wrote this\n')
})

/**
 * A store as #560 minted it: its own `objects`, the checkout's named in `objects/info/alternates`
 * (and `alternates` after them), the checkout's index as its seed, one snapshot taken by hand.
 */
function legacyStore(directory: string, tree: string, alternates: readonly string[] = []): string {
  const env = { PATH: environment.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  execFileSync('git', ['init', '--quiet', '--bare', directory], { env })
  writeFileSync(
    join(directory, 'objects', 'info', 'alternates'),
    `${[join(tree, '.git', 'objects'), ...alternates].join('\n')}\n`,
  )
  const storeEnv = { ...env, GIT_DIR: directory, GIT_WORK_TREE: tree, GIT_INDEX_FILE: join(directory, 'enso-index') }
  execFileSync('cp', [join(tree, '.git', 'index'), join(directory, 'enso-index')])
  execFileSync('git', ['add', '--all'], { cwd: tree, env: storeEnv })
  const written = execFileSync('git', ['write-tree'], { cwd: tree, env: storeEnv, encoding: 'utf8' }).trim()
  const commit = execFileSync(
    'git',
    ['-c', 'user.name=e', '-c', 'user.email=e@e', 'commit-tree', written, '-m', 'snapshot'],
    { cwd: tree, env: storeEnv, encoding: 'utf8' },
  ).trim()
  execFileSync('git', ['--git-dir', directory, 'update-ref', 'HEAD', commit], { env })
  return commit
}

test("⚠ a pre-#573 store is migrated when opened: its snapshots borrowed from the checkout survive the checkout's gc, a fork's lineage is read off its alternates, and a store kept for a deleted thread's forks goes (#573)", async () => {
  const tree = checkout()
  writeFileSync(join(tree, 'src.ts'), 'export const one = 2\n')
  git(tree, 'commit', '--quiet', '-am', 'two')
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const parentAt = legacyStore(join(snapshots, 'parent'), tree)
  // The deleted thread wrote a file of its own: only its store holds that blob.
  writeFileSync(join(tree, 'orphan.txt'), 'only the deleted thread had this\n')
  const orphanAt = legacyStore(join(snapshots, 'orphan'), tree)
  rmSync(join(tree, 'orphan.txt'))
  writeFileSync(join(snapshots, 'orphan', 'enso-orphaned'), 'kept for fork\n')
  legacyStore(join(snapshots, 'fork'), tree, [
    join(snapshots, 'orphan', 'objects'),
    join(snapshots, 'parent', 'objects'),
  ])
  execFileSync('git', ['--git-dir', join(snapshots, 'fork'), 'update-ref', 'HEAD', orphanAt], {
    env: { PATH: environment.PATH },
  })

  const reopened = await openSnapshotStore({ directory: join(snapshots, 'parent'), tree, environment })
  expect(reopened?.migration).toEqual({ migrated: [join(snapshots, 'fork'), join(snapshots, 'parent')], pruned: [] })
  expect(existsSync(join(snapshots, 'orphan'))).toBe(false)
  expect(forksOfStore(join(snapshots, 'parent'))).toEqual(['fork'])
  expect(readFileSync(join(snapshots, 'fork', 'enso-forked-from'), 'utf8')).toBe('orphan\nparent\n')

  git(tree, 'reset', '--quiet', '--hard', 'HEAD~1')
  git(tree, 'reflog', 'expire', '--expire=now', '--all')
  git(tree, 'gc', '--quiet', '--prune=now')
  for (const [store, hash] of [
    ['parent', parentAt],
    ['fork', orphanAt],
  ] as const) {
    const copy = mkdtempSync(join(tmpdir(), 'enso-snap-copy-'))
    expect(await materializeSnapshot({ directory: join(snapshots, store), tree: copy, hash, environment })).toEqual({
      kind: 'materialized',
    })
    expect(readFileSync(join(copy, 'src.ts'), 'utf8')).toBe('export const one = 2\n')
  }
})
