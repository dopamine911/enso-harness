import { expect, test } from 'bun:test'
import type { EnsoGitFileChange, EnsoGitRepository, EnsoGitState } from '@enso/core'
import type { ChangedFilePaths, ChangedFileTexts } from '@enso/core/git'
import type { ThreadTreePlace } from '../../host/thread-log-edits.ts'
import {
  type ChangedFileRoute,
  createThreadChangedFileRoute,
  createThreadChangesRoute,
  createThreadGitRoute,
} from '../thread-git-route.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * #453: one thread's git state — asked in the live thread's cwd, or the stored thread's, building
 * nothing to answer, and never in a directory the server does not serve. #452: the same, with every
 * changed file — asked only of a repository, and a diff git cannot make said as such.
 */

const REPOSITORY: EnsoGitRepository = {
  kind: 'repository',
  root: '/work/live',
  scope: '',
  head: 'f00d',
  branch: 'main',
  upstream: 'origin/main',
  baseline: { rule: 'upstream', ref: 'origin/main', commit: 'beef' },
  ahead: 1,
  behind: 0,
  changes: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 },
  operation: null,
}

function route(served: (directory: string) => boolean = () => true): {
  read: ReturnType<typeof createThreadGitRoute>
  asked: string[]
} {
  const asked: string[] = []
  const live = createFakeHostedThread({ inspect: { cwd: '/work/live' } })
  const read = createThreadGitRoute({
    threads: {
      peek: (threadId: string) => (threadId === 'live' ? ({ hosted: live.hosted } as ThreadView) : undefined),
    },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      stored: { transcript: [], modified: new Date(), firstMessage: '', cwd: '/work/stored' },
    }),
    servesDirectory: served,
    readGit: (cwd: string) => {
      asked.push(cwd)
      return Promise.resolve(cwd === '/work/live' ? REPOSITORY : { kind: 'not-a-repository' })
    },
  })
  return { read, asked }
}

test("a live thread is read in pi's cwd, a stored one in its file's; one held nowhere is no answer", async () => {
  const { read, asked } = route()
  expect(await read('live')).toEqual({ threadId: 'live', cwd: '/work/live', git: REPOSITORY })
  expect(await read('stored')).toEqual({ threadId: 'stored', cwd: '/work/stored', git: { kind: 'not-a-repository' } })
  expect(await read('nowhere')).toBeUndefined()
  expect(asked).toEqual(['/work/live', '/work/stored'])
})

test('⚠ a stored thread whose project is no longer served is no answer, and git is not run there', async () => {
  const { read, asked } = route((directory) => directory !== '/work/stored')
  expect(await read('stored')).toBeUndefined()
  expect(asked).toEqual([])
})

const CHANGE: EnsoGitFileChange = {
  path: 'src/app.ts',
  oldPath: null,
  status: 'modified',
  added: 1,
  removed: 1,
  patch: 'diff --git a/src/app.ts b/src/app.ts\n',
  omitted: null,
}

/** The stored thread's tree, by default none: a thread in its checkout. */
interface ChangesRouteOptions {
  readonly tree?: ThreadTreePlace
  readonly readCopyChanges?: (copy: ThreadTreePlace) => Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>
}

function changesRoute(
  readChanges: () => Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>,
  options: ChangesRouteOptions = {},
): {
  read: ReturnType<typeof createThreadChangesRoute>
  diffed: string[]
  copied: string[]
} {
  const diffed: string[] = []
  const copied: string[] = []
  const live = createFakeHostedThread({ inspect: { cwd: '/work/live' } })
  const read = createThreadChangesRoute({
    threads: {
      peek: (threadId: string) => (threadId === 'live' ? ({ hosted: live.hosted } as ThreadView) : undefined),
    },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      stored: { transcript: [], modified: new Date(), firstMessage: '', cwd: '/work/stored' },
    }),
    servesDirectory: () => true,
    readGit: (cwd: string) => Promise.resolve(cwd === '/work/live' ? REPOSITORY : { kind: 'not-a-repository' }),
    readChanges: (repository) => {
      diffed.push(repository.root)
      return readChanges()
    },
    threadTree: (threadId: string) => Promise.resolve(threadId === 'stored' ? options.tree : undefined),
    readCopyChanges: (copy) => {
      copied.push(copy.store)
      return options.readCopyChanges?.(copy) ?? Promise.reject(new Error('no copy to read'))
    },
  })
  return { read, diffed, copied }
}

test("a repository's changes come with its state; outside one there is nothing to diff, and git is not asked", async () => {
  const { read, diffed, copied } = changesRoute(() => Promise.resolve({ files: [CHANGE], truncated: false }))
  expect(await read('live')).toEqual({
    threadId: 'live',
    cwd: '/work/live',
    git: REPOSITORY,
    files: [CHANGE],
    truncated: false,
    copy: null,
  })
  expect(await read('stored')).toEqual({
    threadId: 'stored',
    cwd: '/work/stored',
    git: { kind: 'not-a-repository' },
    files: [],
    truncated: false,
    copy: null,
  })
  expect(await read('nowhere')).toBeUndefined()
  expect(diffed).toEqual(['/work/live'])
  expect(copied).toEqual([])
})

test('⚠ a diff git cannot make reads as git unavailable with its reason, never as nothing changed', async () => {
  const { read } = changesRoute(() => Promise.reject(new Error('fatal: bad object f00d')))
  expect(await read('live')).toEqual({
    threadId: 'live',
    cwd: '/work/live',
    git: { kind: 'unavailable', reason: 'fatal: bad object f00d' },
    files: [],
    truncated: false,
    copy: null,
  })
})

const COPY_TREE: ThreadTreePlace = {
  record: { kind: 'copy', project: '/work/shop-api', path: '/work/stored', branch: null, base: 'a'.repeat(40) },
  store: '/enso/snapshots/stored',
}

const ADDED: EnsoGitFileChange = { ...CHANGE, path: 'src/new.ts', status: 'added', added: 1, removed: 0 }

// #650: a project with no commit yet runs in a copy, whose cwd git calls no repository.
test("⚠ a thread whose tree is a copy answers its store's changes since `base`, naming the project; `git` stays what git said", async () => {
  const { read, diffed, copied } = changesRoute(() => Promise.reject(new Error('git is not asked')), {
    tree: COPY_TREE,
    readCopyChanges: () => Promise.resolve({ files: [CHANGE, ADDED], truncated: true }),
  })
  expect(await read('stored')).toEqual({
    threadId: 'stored',
    cwd: '/work/stored',
    git: { kind: 'not-a-repository' },
    files: [CHANGE, ADDED],
    truncated: true,
    copy: { project: '/work/shop-api', base: 'a'.repeat(40) },
  })
  expect(copied).toEqual(['/enso/snapshots/stored'])
  expect(diffed).toEqual([])
})

test("⚠ a copy's store that cannot be read is git unavailable with its reason, never nothing changed (#650)", async () => {
  const { read } = changesRoute(() => Promise.reject(new Error('git is not asked')), {
    tree: COPY_TREE,
    readCopyChanges: () => Promise.reject(new Error('ls-files: fatal: not a git repository')),
  })
  expect(await read('stored')).toEqual({
    threadId: 'stored',
    cwd: '/work/stored',
    git: { kind: 'unavailable', reason: 'ls-files: fatal: not a git repository' },
    files: [],
    truncated: false,
    copy: null,
  })
})

test("a worktree's tree outside a repository reads as before: nothing to diff, no store asked (#650)", async () => {
  const { read, copied } = changesRoute(() => Promise.reject(new Error('git is not asked')), {
    tree: { ...COPY_TREE, record: { ...COPY_TREE.record, kind: 'worktree', branch: 'enso/stored' } },
  })
  expect(await read('stored')).toEqual({
    threadId: 'stored',
    cwd: '/work/stored',
    git: { kind: 'not-a-repository' },
    files: [],
    truncated: false,
    copy: null,
  })
  expect(copied).toEqual([])
})

// ── #461: one changed file whole ─────────────────────────────────────────────────────────────

const TEXTS: ChangedFileTexts = { oldText: { kind: 'text', text: 'a\n' }, newText: { kind: 'text', text: 'b\n' } }

/** The route over a live thread in `git`, recording every path it was asked to read. */
function changedFileRoute(
  git: EnsoGitState,
  options: { readonly tree?: ThreadTreePlace } = {},
): { read: ChangedFileRoute; asked: ChangedFilePaths[] } {
  const asked: ChangedFilePaths[] = []
  const live = createFakeHostedThread({ inspect: { cwd: '/work/live' } })
  const read = createThreadChangedFileRoute({
    threads: {
      peek: (threadId: string) => (threadId === 'live' ? ({ hosted: live.hosted } as ThreadView) : undefined),
    },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build'))),
    servesDirectory: () => true,
    readGit: () => Promise.resolve(git),
    readFileTexts: (_repository, paths) => {
      asked.push(paths)
      return Promise.resolve(TEXTS)
    },
    threadTree: () => Promise.resolve(options.tree),
    readCopyFileTexts: (_copy, paths) => {
      asked.push(paths)
      return Promise.resolve(TEXTS)
    },
  })
  return { read, asked }
}

/** A project inside a dotfiles repository at `$HOME`: its scope is its own directory. */
const DOTFILES: EnsoGitRepository = { ...REPOSITORY, root: '/home/me', scope: 'work/shop/' }

test('a file under the scope is read whole, both sides, with its old path for a rename', async () => {
  const { read, asked } = changedFileRoute(DOTFILES)
  expect(await read('live', { path: 'work/shop/src/app.ts', oldPath: 'work/shop/src/old.ts' })).toEqual({
    kind: 'file',
    file: { threadId: 'live', path: 'work/shop/src/app.ts', oldPath: 'work/shop/src/old.ts', ...TEXTS },
  })
  expect(asked).toEqual([{ path: 'work/shop/src/app.ts', oldPath: 'work/shop/src/old.ts' }])
  expect(await read('nowhere', { path: 'work/shop/src/app.ts', oldPath: null })).toBeUndefined()
})

// ⚠ #456's limit, held for a path the page names: nothing outside the project's scope is read.
test('⚠ a path outside the scope is refused with a 400 and never read — as either side, by any spelling', async () => {
  const { read, asked } = changedFileRoute(DOTFILES)
  const outside: ChangedFilePaths[] = [
    { path: '.ssh/id_ed25519', oldPath: null },
    { path: 'work/shop-other/x.ts', oldPath: null },
    { path: 'work/shop/../../.ssh/id_ed25519', oldPath: null },
    { path: 'work/shop/./src/app.ts', oldPath: null },
    { path: 'work/shop//src/app.ts', oldPath: null },
    { path: '/home/me/.ssh/id_ed25519', oldPath: null },
    { path: 'work/shop/src/app.ts', oldPath: '.bashrc' },
    { path: 'work/shop/src/app.ts\0', oldPath: null },
  ]
  for (const paths of outside) {
    const answer = await read('live', paths)
    expect(answer).toMatchObject({ kind: 'refused', status: 400 })
    expect(answer?.kind === 'refused' ? answer.reason : '').toContain('is not a file under work/shop/')
  }
  expect(asked).toEqual([])
  // From the top level the scope is the whole tree, and a climb out of it is still refused.
  const top = changedFileRoute({ ...DOTFILES, scope: '' })
  expect(await top.read('live', { path: '../etc/passwd', oldPath: null })).toMatchObject({ status: 400 })
  expect(await top.read('live', { path: '.bashrc', oldPath: null })).toMatchObject({ kind: 'file' })
})

test("a copy's file is read from its store under the copy's whole tree; no repository and no copy is a 409", async () => {
  const copy = changedFileRoute({ kind: 'not-a-repository' }, { tree: COPY_TREE })
  expect(await copy.read('live', { path: 'src/app.ts', oldPath: null })).toMatchObject({ kind: 'file' })
  expect(await copy.read('live', { path: '../outside.ts', oldPath: null })).toMatchObject({ status: 400 })
  expect(copy.asked).toEqual([{ path: 'src/app.ts', oldPath: null }])
  const nowhere = changedFileRoute({ kind: 'not-a-repository' })
  expect(await nowhere.read('live', { path: 'src/app.ts', oldPath: null })).toMatchObject({ status: 409 })
  const broken = changedFileRoute({ kind: 'unavailable', reason: 'fatal: dubious ownership' })
  expect(await broken.read('live', { path: 'src/app.ts', oldPath: null })).toEqual({
    kind: 'refused',
    status: 409,
    reason: 'git could not answer: fatal: dubious ownership',
  })
})
