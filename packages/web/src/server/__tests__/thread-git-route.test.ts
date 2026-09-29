import { expect, test } from 'bun:test'
import type { EnsoGitFileChange, EnsoGitState } from '@enso/core'
import { createThreadChangesRoute, createThreadGitRoute } from '../thread-git-route.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * #453: one thread's git state — asked in the live thread's cwd, or the stored thread's, building
 * nothing to answer, and never in a directory the server does not serve. #452: the same, with every
 * changed file — asked only of a repository, and a diff git cannot make said as such.
 */

const REPOSITORY: EnsoGitState = {
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

function changesRoute(readChanges: () => Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>): {
  read: ReturnType<typeof createThreadChangesRoute>
  diffed: string[]
} {
  const diffed: string[] = []
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
  })
  return { read, diffed }
}

test("a repository's changes come with its state; outside one there is nothing to diff, and git is not asked", async () => {
  const { read, diffed } = changesRoute(() => Promise.resolve({ files: [CHANGE], truncated: false }))
  expect(await read('live')).toEqual({
    threadId: 'live',
    cwd: '/work/live',
    git: REPOSITORY,
    files: [CHANGE],
    truncated: false,
  })
  expect(await read('stored')).toEqual({
    threadId: 'stored',
    cwd: '/work/stored',
    git: { kind: 'not-a-repository' },
    files: [],
    truncated: false,
  })
  expect(await read('nowhere')).toBeUndefined()
  expect(diffed).toEqual(['/work/live'])
})

test('⚠ a diff git cannot make reads as git unavailable with its reason, never as nothing changed', async () => {
  const { read } = changesRoute(() => Promise.reject(new Error('fatal: bad object f00d')))
  expect(await read('live')).toEqual({
    threadId: 'live',
    cwd: '/work/live',
    git: { kind: 'unavailable', reason: 'fatal: bad object f00d' },
    files: [],
    truncated: false,
  })
})
