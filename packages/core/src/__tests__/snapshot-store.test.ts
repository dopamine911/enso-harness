import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  collectSnapshotGarbage,
  compareTreeWithSnapshots,
  forksOfStore,
  materializeSnapshot,
  migrateSnapshotStores,
  openSnapshotStore,
  readSnapshotChanges,
  readSnapshotFileTexts,
  readSnapshotTrees,
  type SnapshotStore,
  type SnapshotTaken,
  snapshotPaths,
} from '../snapshot-store.ts'
import { releaseThreadStore } from '../thread-tree.ts'

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

test('a store and its project object store are minted from an empty template: no sample hooks, no info stub (#739)', async () => {
  const store = await opened(checkout())
  await taken(store)
  for (const repository of [store.directory, join(dirname(store.directory), '.objects')]) {
    expect(existsSync(join(repository, 'HEAD'))).toBe(true)
    expect(existsSync(join(repository, 'hooks'))).toBe(false)
    expect(existsSync(join(repository, 'info'))).toBe(false)
  }
})

// #739: a project with no `.gitignore` had 34 MB of `node_modules` captured into its store.
test('⚠ an untracked node_modules is never captured, whatever the ignore rules, and a materialize leaves it; a tracked one stays in', async () => {
  const tree = checkout()
  mkdirSync(join(tree, 'vendor', 'node_modules'), { recursive: true })
  writeFileSync(join(tree, 'vendor', 'node_modules', 'kept.js'), 'tracked on purpose\n')
  git(tree, 'add', 'vendor/node_modules/kept.js')
  git(tree, 'commit', '--quiet', '-m', 'vendored')
  for (const installed of ['node_modules/x', 'packages/app/node_modules/y']) {
    mkdirSync(join(tree, installed), { recursive: true })
    writeFileSync(join(tree, installed, 'i.js'), 'installed\n')
  }
  const store = await opened(tree)
  const first = await taken(store)
  expect((await snapshotPaths(environment, store, first.hash)).toSorted()).toEqual([
    '.gitignore',
    'README.md',
    'src.ts',
    'vendor/node_modules/kept.js',
  ])

  writeFileSync(join(tree, 'stray.md'), 'unignored, untracked\n')
  const outcome = await materializeSnapshot({ directory: store.directory, tree, hash: first.hash, environment })
  expect(outcome).toEqual({ kind: 'materialized' })
  expect(existsSync(join(tree, 'stray.md'))).toBe(false)
  expect(readFileSync(join(tree, 'node_modules', 'x', 'i.js'), 'utf8')).toBe('installed\n')
  expect(readFileSync(join(tree, 'packages', 'app', 'node_modules', 'y', 'i.js'), 'utf8')).toBe('installed\n')

  // A tree in no repository, no `.gitignore` at all: the store's own listing leaves it out too.
  const plain = mkdtempSync(join(tmpdir(), 'enso-snap-plain-'))
  writeFileSync(join(plain, 'a.txt'), 'a\n')
  mkdirSync(join(plain, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(plain, 'node_modules', 'x', 'i.js'), 'installed\n')
  const plainStore = await opened(plain)
  expect(await snapshotPaths(environment, plainStore, (await taken(plainStore)).hash)).toEqual(['a.txt'])
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

// #570: `read-tree` carries no skip-worktree bit, so `checkout-index` wrote `out/y` back, and git,
// finding it present, dropped its `S` — the user's sparse checkout silently widened.
test('⚠ a materialize into a sparse checkout writes no path the sparse checkout leaves off disk, and git still marks each skip-worktree (#570)', async () => {
  const tree = checkout()
  mkdirSync(join(tree, 'in'))
  mkdirSync(join(tree, 'out'))
  writeFileSync(join(tree, 'in', 'x'), 'x\n')
  writeFileSync(join(tree, 'out', 'y'), 'y\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'two directories')
  git(tree, 'sparse-checkout', 'set', 'in')
  const store = await opened(tree)
  const first = await taken(store)
  writeFileSync(join(tree, 'in', 'x'), 'edited\n')

  expect(await materializeSnapshot({ directory: store.directory, tree, hash: first.hash, environment })).toEqual({
    kind: 'materialized',
  })
  expect(readFileSync(join(tree, 'in', 'x'), 'utf8')).toBe('x\n')
  expect(existsSync(join(tree, 'out'))).toBe(false)
  expect(git(tree, 'ls-files', '-t', 'out/y')).toBe('S out/y')
  expect(git(tree, 'status', '--porcelain')).toBe('')
})

// #569: the store never knows a directory only the project ignores, so a copy's `.venv/` was
// listed file by file and every path sent to `check-ignore` — past 64 MiB, every snapshot refused.
test('⚠ a copy lists a directory only its project ignores as one entry, none of its files in the snapshot, and still checks each file of a directory the project does not ignore (#569)', async () => {
  const project = checkout()
  writeFileSync(join(project, '.gitignore'), '.env\nbuild/\n.venv/\n*.pyc\n')
  git(project, 'commit', '--quiet', '-am', 'ignore .venv and *.pyc')
  const copy = mkdtempSync(join(tmpdir(), 'enso-snap-copy-'))
  writeFileSync(join(copy, 'src.ts'), 'export const one = 1\n')
  for (let library = 0; library < 50; library += 1) {
    mkdirSync(join(copy, '.venv', 'lib', `p${library}`), { recursive: true })
    writeFileSync(join(copy, '.venv', 'lib', `p${library}`, '__init__.py'), '\n')
  }
  mkdirSync(join(copy, 'pkg'))
  writeFileSync(join(copy, 'pkg', 'a.py'), 'a = 1\n')
  writeFileSync(join(copy, 'pkg', 'a.pyc'), 'compiled\n')
  const store = await openSnapshotStore({
    directory: join(mkdtempSync(join(tmpdir(), 'enso-snap-store-')), 'store'),
    tree: copy,
    environment,
    copyOf: project,
  })
  if (store === undefined) throw new Error('the store did not open')

  const first = await taken(store)
  expect((await snapshotPaths(environment, store, first.hash)).toSorted()).toEqual(['pkg/a.py', 'src.ts'])
  const compared = await compareTreeWithSnapshots({
    directory: store.directory,
    tree: copy,
    hashes: ['HEAD'],
    environment,
  })
  if (compared.kind !== 'compared') throw new Error(`refused at ${compared.refused.step}`)
  expect(compared.ignored.toSorted()).toEqual(['.venv/', 'pkg/a.pyc'])
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
function legacyStore(
  directory: string,
  tree: string,
  alternates: readonly string[] = [],
  objectFormat = 'sha1',
): string {
  const env = { PATH: environment.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  execFileSync('git', ['init', '--quiet', '--bare', `--object-format=${objectFormat}`, directory], { env })
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
  expect(reopened?.migration).toEqual({
    migrated: [join(snapshots, 'fork'), join(snapshots, 'parent')],
    pruned: [],
    unmigrated: [],
  })
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

/** `store`'s HEAD made unreadable while `during` runs — exit 128, as a timeout, a spawn failure or a permission error would be, never the unborn HEAD's 1 — then put back. */
async function withUnreadableHead<T>(store: string, during: () => Promise<T>): Promise<T> {
  const head = readFileSync(join(store, 'HEAD'), 'utf8')
  writeFileSync(join(store, 'HEAD'), 'not a ref\n')
  try {
    return await during()
  } finally {
    writeFileSync(join(store, 'HEAD'), head)
  }
}

/** The step a store-wide operation was refused at, or what it returned instead. */
function refusedStep(outcome: unknown): unknown {
  return typeof outcome === 'object' && outcome !== null && 'refused' in outcome
    ? (outcome as { refused: { step: string } }).refused.step
    : outcome
}

// #575 review: a HEAD read that failed was taken for "no history", so the collection named no ref
// for that store and pruned every snapshot of a live thread.
test("⚠ a collection refuses, every object kept, when a live store's HEAD cannot be read (#573)", async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const live = await opened(tree, snapshots)
  writeFileSync(join(tree, 'live-only.txt'), 'only the live thread has this\n')
  const kept = await taken(live)
  aged(join(snapshots, '.objects', 'objects'))
  const collected = await withUnreadableHead(live.directory, () => collectSnapshotGarbage(snapshots, environment))
  expect(refusedStep(collected)).toBe('rev-parse')
  expect(holds(live.directory, kept.hash)).toBe(true)
})

// #575 review: the same read in a migration was taken for "nothing to pack", and the store's own
// objects — never packed — were deleted with its old `objects` directory.
test("⚠ a migration refuses, the store as it was, when a pre-#573 store's HEAD cannot be read (#573)", async () => {
  const tree = checkout()
  writeFileSync(join(tree, 'own.txt'), 'only in the old store\n')
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const old = join(snapshots, 'old')
  const at = legacyStore(old, tree)
  const migrated = await withUnreadableHead(old, () => migrateSnapshotStores(snapshots, environment))
  // Per store: the store is reported, left as it was, and retried at the next migration.
  expect(
    typeof migrated === 'object' && 'unmigrated' in migrated
      ? migrated.unmigrated.map((stuck) => stuck.store)
      : migrated,
  ).toEqual([old])
  expect(lstatSync(join(old, 'objects')).isSymbolicLink()).toBe(false)
  expect(holds(old, at)).toBe(true)
})

/**
 * A pre-#573 store in `snapshots` (whose object store exists) as a migration left it between the
 * rename of its `objects` and the link: its own objects set aside, unpacked — what a snapshot
 * written after the migration's pack leaves too.
 */
function interruptedStore(snapshots: string, tree: string, objectFormat = 'sha1'): { store: string; at: string } {
  const store = join(snapshots, 'interrupted')
  const at = legacyStore(store, tree, [], objectFormat)
  renameSync(join(store, 'objects'), join(store, 'objects.legacy-crashed'))
  return { store, at }
}

// #575 review: the set-aside objects were deleted once linked — and with them every object a
// snapshot wrote there after the pack, by a handle opened before the migration.
test('⚠ a migration keeps the objects it finds set aside, unpacked: a snapshot written after the pack is still readable (#573)', async () => {
  const tree = checkout()
  writeFileSync(join(tree, 'late.txt'), 'written after the pack\n')
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  await opened(tree, snapshots)
  const { store, at } = interruptedStore(snapshots, tree)
  expect(await migrateSnapshotStores(snapshots, environment)).toEqual({ migrated: [store], pruned: [], unmigrated: [] })
  expect(holds(store, at)).toBe(true)
})

test('⚠ a store a migration left between rename and link is healed by its own open, and snapshots again (#573)', async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  await opened(tree, snapshots)
  const { store, at } = interruptedStore(snapshots, tree)
  const reopened = await openSnapshotStore({ directory: store, tree, environment })
  if (reopened === undefined) throw new Error('did not open')
  writeFileSync(join(tree, 'src.ts'), 'export const one = 5\n')
  const next = await taken(reopened)
  // The new snapshot's parent is the store's last, which only the set-aside objects held.
  expect(
    execFileSync('git', ['--git-dir', store, 'rev-parse', `${next.hash}^`], {
      encoding: 'utf8',
      env: { PATH: environment.PATH },
    }).trim(),
  ).toBe(at)
})

test("⚠ an interrupted store of a sha256 project heals: the object store's own format decides, never sha1 assumed (#573)", async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-snap-sha256-'))
  git(tree, 'init', '--quiet', '--object-format=sha256')
  writeFileSync(join(tree, 'a.txt'), 'a\n')
  git(tree, 'add', '--all')
  git(tree, 'commit', '--quiet', '-m', 'a')
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  await opened(tree, snapshots)
  const { store, at } = interruptedStore(snapshots, tree, 'sha256')
  expect(await migrateSnapshotStores(snapshots, environment)).toEqual({ migrated: [store], pruned: [], unmigrated: [] })
  expect(holds(store, at)).toBe(true)
})

test('a pre-#573 store whose migration cannot link it opens as `undefined`, never a thrown open (#573)', async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const old = join(snapshots, 'old')
  legacyStore(old, tree)
  chmodSync(old, 0o555)
  try {
    expect(await openSnapshotStore({ directory: old, tree, environment })).toBeUndefined()
  } finally {
    chmodSync(old, 0o755)
  }
})

// #575 review: a busy migration was ignored and the old store handed out, its next snapshot
// written where the migration was about to set aside.
test('a pre-#573 store opens as `undefined` while another migration holds the project, and migrated once it is free (#573)', async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const old = join(snapshots, 'old')
  legacyStore(old, tree)
  mkdirSync(join(snapshots, '.lock'))
  expect(await openSnapshotStore({ directory: old, tree, environment })).toBeUndefined()
  rmSync(join(snapshots, '.lock'), { recursive: true })
  expect((await openSnapshotStore({ directory: old, tree, environment }))?.migration?.migrated).toEqual([old])
})

// #575 review: a `snapshots/` that could not be listed read as "no stores", and the collection
// pruned every live history.
test("⚠ a collection refuses, every object kept, when the project's stores cannot be listed (#573)", async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const live = await opened(tree, snapshots)
  writeFileSync(join(tree, 'live-only.txt'), 'only the live thread has this\n')
  const kept = await taken(live)
  aged(join(snapshots, '.objects', 'objects'))
  // Writable and searchable — the lock can be taken — but not readable.
  chmodSync(snapshots, 0o333)
  let collected: unknown
  try {
    collected = await collectSnapshotGarbage(snapshots, environment)
  } finally {
    chmodSync(snapshots, 0o755)
  }
  expect(refusedStep(collected)).toBe('list')
  expect(holds(live.directory, kept.hash)).toBe(true)
})

// #575 review: git answers an unreadable branch ref as it answers an unborn HEAD (exit 1), and the
// collection pruned that live history.
test("⚠ a collection refuses, every object kept, when a live store's branch ref cannot be read (#573)", async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const live = await opened(tree, snapshots)
  writeFileSync(join(tree, 'live-only.txt'), 'only the live thread has this\n')
  const kept = await taken(live)
  aged(join(snapshots, '.objects', 'objects'))
  const branch = join(live.directory, readFileSync(join(live.directory, 'HEAD'), 'utf8').replace('ref: ', '').trim())
  chmodSync(branch, 0o000)
  let collected: unknown
  try {
    collected = await collectSnapshotGarbage(snapshots, environment)
  } finally {
    chmodSync(branch, 0o644)
  }
  expect(refusedStep(collected)).toBe('for-each-ref')
  expect(holds(live.directory, kept.hash)).toBe(true)
})

// #575 review: one store that could not be linked refused the whole migration, every time — and
// the old stores sorting after it never opened again.
test('⚠ a pre-#573 store that cannot be linked holds back no other: the rest migrate and open, it stays as it was and is reported (#573)', async () => {
  const tree = checkout()
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const stuck = join(snapshots, 'thread-0')
  const other = join(snapshots, 'thread-a')
  const stuckAt = legacyStore(stuck, tree)
  legacyStore(other, tree)
  chmodSync(stuck, 0o555)
  try {
    const reopened = await openSnapshotStore({ directory: other, tree, environment })
    expect(reopened?.migration?.migrated).toEqual([other])
    expect(reopened?.migration?.unmigrated.map((failed) => failed.store)).toEqual([stuck])
    expect(await openSnapshotStore({ directory: other, tree, environment })).toBeDefined()
    // The stuck store still works the pre-#573 way: its own objects, its alternates.
    expect(holds(stuck, stuckAt)).toBe(true)
  } finally {
    chmodSync(stuck, 0o755)
  }
})

// #575 review: an old fork left unlinked reads its parent's snapshots through `<parent>/objects`
// in its alternates; removing the parent's store would break it.
test("⚠ a store an unmigrated fork's alternates still name is never released: the delete is refused, naming the fork (#573)", async () => {
  const tree = checkout()
  writeFileSync(join(tree, 'parent.txt'), 'the parent wrote this\n')
  const snapshots = mkdtempSync(join(tmpdir(), 'enso-snap-project-'))
  const parent = join(snapshots, 'parent')
  const parentAt = legacyStore(parent, tree)
  const fork = join(snapshots, 'fork')
  legacyStore(fork, tree, [join(parent, 'objects')])
  execFileSync('git', ['--git-dir', fork, 'update-ref', 'HEAD', parentAt], { env: { PATH: environment.PATH } })
  chmodSync(fork, 0o555)
  let released: unknown
  try {
    released = await releaseThreadStore(parent, environment)
  } finally {
    chmodSync(fork, 0o755)
  }
  expect(released).toMatchObject({ kind: 'refused', reason: expect.stringContaining(fork) })
  expect(lstatSync(join(parent, 'objects')).isSymbolicLink()).toBe(true)
  expect(holds(fork, parentAt)).toBe(true)
})

/** Every file under `directory`, by relative path, as its bytes — a symlink as `link`, a directory as `directory`. */
function bytesUnder(directory: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const kind = entry.isSymbolicLink() ? 'link' : 'directory'
    found[path.slice(directory.length)] = entry.isFile() ? readFileSync(path).toString('base64') : kind
  }
  return found
}

// #553: the Diff Viewer compares two snapshots, never the live tree, and browsing writes nothing.
test('⚠ two snapshots compare as they were taken, whatever the tree holds since — an idle pair is one tree, a hash the store lacks is absent — and neither the store nor the tree is written (#553)', async () => {
  const tree = checkout()
  const store = await opened(tree)
  const before = await taken(store)
  writeFileSync(join(tree, 'src.ts'), 'export const one = 2\n')
  writeFileSync(join(tree, 'new.ts'), 'export const two = 2\n')
  rmSync(join(tree, 'README.md'))
  const after = await taken(store)
  // A second commit of the same files: one tree, as a fork's first run snapshots its inherited files.
  const again = git(store.directory, 'commit-tree', `${after.hash}^{tree}`, '-m', 'same files')
  // The tree moves on after the turn: none of it is in either snapshot.
  writeFileSync(join(tree, 'src.ts'), 'export const one = 3\n')
  writeFileSync(join(tree, 'later.ts'), 'later\n')
  const storeBytes = bytesUnder(dirname(store.directory))
  const treeBytes = bytesUnder(tree)

  const read = await readSnapshotChanges({ directory: store.directory, from: before.hash, to: after.hash, environment })
  expect(read.truncated).toBe(false)
  expect(read.files.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
    ['README.md', 'deleted', 0, 1],
    ['new.ts', 'added', 1, 0],
    ['src.ts', 'modified', 1, 1],
  ])
  expect(read.files.find((file) => file.path === 'src.ts')?.patch).toContain('+export const one = 2')
  expect(
    await readSnapshotFileTexts({
      directory: store.directory,
      from: before.hash,
      to: after.hash,
      environment,
      paths: { path: 'src.ts', oldPath: null },
    }),
  ).toEqual({
    oldText: { kind: 'text', text: 'export const one = 1\n' },
    newText: { kind: 'text', text: 'export const one = 2\n' },
  })
  const missing = 'f'.repeat(40)
  const trees = await readSnapshotTrees({
    directory: store.directory,
    hashes: [before.hash, after.hash, again, missing],
    environment,
  })
  expect(trees.get(after.hash)).toBe(trees.get(again))
  expect(trees.get(before.hash)).not.toBe(trees.get(after.hash))
  expect(trees.has(missing)).toBe(false)
  await expect(
    readSnapshotChanges({ directory: store.directory, from: missing, to: after.hash, environment }),
  ).rejects.toThrow(/bad object|unknown revision|bad revision/i)

  expect(bytesUnder(dirname(store.directory))).toEqual(storeBytes)
  expect(bytesUnder(tree)).toEqual(treeBytes)
})
