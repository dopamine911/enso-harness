import { expect, test } from 'bun:test'
import { type EnsoThreadHistory, NO_SESSION_INCIDENTS } from '@enso/core'
import {
  createResumeRequests,
  createStoredThreadsStore,
  describeFailedResponse,
  FAILURE_DETAIL_MAX_LENGTH,
  storedThreadsNotOnThisPage,
} from '../stored-threads.ts'

// #103 receipt, step 8: the dev proxy answered a dead API with Bun's whole HTML error page,
// and quoting it filled the rail. One line, bounded, status first.
test('a failed response is described as its status and a bounded first line of the body', async () => {
  expect(await describeFailedResponse(new Response('thread t1 is running\nsecond line', { status: 409 }))).toBe(
    '409 thread t1 is running',
  )
  expect(await describeFailedResponse(new Response('', { status: 502 }))).toBe('502')
  const page = `<!doctype html>${'x'.repeat(500)}`
  const described = await describeFailedResponse(new Response(page, { status: 500 }))
  expect(described.startsWith('500 <!doctype html>')).toBe(true)
  expect(described.length).toBe('500 '.length + FAILURE_DETAIL_MAX_LENGTH + 1)
  expect(described.endsWith('…')).toBe(true)
})

/** #95: a failed refresh remains visible without erasing the last known resumable sessions. */
test('the resumable-session store validates listings and preserves the last good rows on failure', async () => {
  let answer: unknown = [
    {
      threadId: 'stored-1',
      projectId: 'p-launch',
      title: 'earlier work',
      lastActivityAt: '2026-09-08T12:00:00.000Z',
      messageCount: 2,
      busy: false,
      waiting: false,
    },
  ]
  const store = createStoredThreadsStore(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })

  await store.refresh()
  expect(store.get()).toMatchObject({ rows: [{ threadId: 'stored-1', title: 'earlier work' }], error: undefined })

  answer = new Error('connection refused')
  await store.refresh()
  expect(store.get().rows).toHaveLength(1)
  expect(store.get().error).toBe('connection refused')

  answer = [{ threadId: 'missing-fields' }]
  await store.refresh()
  expect(store.get().rows).toHaveLength(1)
  expect(store.get().error).toContain('did not match its schema')
})

test('the earlier list excludes every session already owned by this page', () => {
  const stored = [
    {
      threadId: 'here',
      projectId: 'p-launch',
      lastActivityAt: '2026-09-08T12:00:00.000Z',
      messageCount: 2,
      busy: true,
      waiting: false,
    },
    {
      threadId: 'earlier',
      projectId: 'p-launch',
      lastActivityAt: '2026-09-08T11:00:00.000Z',
      messageCount: 4,
      busy: false,
      waiting: false,
    },
  ]
  expect(storedThreadsNotOnThisPage(stored, new Set(['here'])).map((session) => session.threadId)).toEqual(['earlier'])
})

// ── last click wins (PR #104 review) ─────────────────────────────────────────

interface Deferred {
  promise: Promise<EnsoThreadHistory | undefined>
  resolve: (history: EnsoThreadHistory | undefined) => void
  reject: (error: Error) => void
}

/**
 * A history fetch the test settles by hand, per thread id, in whatever order it wants.
 * `settled(id)` resolves after the coordinator's own handlers have run — they were attached
 * to the same promise first — so no timer stands in for "the response was processed".
 */
function controlledHistory(): {
  fetch: (threadId: string) => Promise<EnsoThreadHistory | undefined>
  resolve: (threadId: string) => Promise<void>
  /** The server holds nothing under the id (#378): the fetch's 404. */
  absent: (threadId: string) => Promise<void>
  reject: (threadId: string, message: string) => Promise<void>
} {
  const pending = new Map<string, Deferred>()
  const settled = (threadId: string): Promise<void> =>
    (pending.get(threadId)?.promise ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    )
  return {
    fetch: (threadId: string) => {
      const deferred = Promise.withResolvers<EnsoThreadHistory | undefined>()
      pending.set(threadId, deferred)
      return deferred.promise
    },
    resolve: (threadId: string) => {
      pending.get(threadId)?.resolve({
        threadId,
        projectId: 'p-launch',
        messages: [],
        permissionMode: { mode: 'default', available: [] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      })
      return settled(threadId)
    },
    absent: (threadId: string) => {
      pending.get(threadId)?.resolve(undefined)
      return settled(threadId)
    },
    reject: (threadId: string, message: string) => {
      pending.get(threadId)?.reject(new Error(message))
      return settled(threadId)
    },
  }
}

test('⚠ two clicks before the first history lands: the FIRST response is dropped even though it arrives last', async () => {
  const history = controlledHistory()
  const applied: string[] = []
  const failures: string[] = []
  const resume = createResumeRequests(
    history.fetch,
    (next) => applied.push(next.threadId),
    (m) => failures.push(m),
    (absentId) => failures.push(`absent ${absentId}`),
  )
  resume('first', undefined)
  resume('second', undefined)
  // The slow first response arrives AFTER the second click: superseded, not applied.
  await history.resolve('first')
  expect(applied).toEqual([])
  await history.resolve('second')
  expect(applied).toEqual(['second'])
  expect(failures).toEqual([])
})

test("a superseded request's failure is not shown; the latest request's failure is", async () => {
  const history = controlledHistory()
  const applied: string[] = []
  const failures: string[] = []
  const resume = createResumeRequests(
    history.fetch,
    (next) => applied.push(next.threadId),
    (m) => failures.push(m),
    (absentId) => failures.push(`absent ${absentId}`),
  )
  resume('first', undefined)
  resume('second', undefined)
  await history.reject('first', 'first went away')
  await history.reject('second', '409 second is running on this server')
  expect(applied).toEqual([])
  expect(failures).toEqual(['409 second is running on this server'])
  // After the latest settles, a new click is a fresh request, not a stale one.
  resume('third', undefined)
  await history.resolve('third')
  expect(applied).toEqual(['third'])
})

// The boot's resume and a rail click can overlap (PR #143 review): each outcome must carry
// what ITS request meant, never what the latest request meant. Absent (#378) is its own outcome —
// neither a history nor a failure — and a superseded one is dropped like the others.
test("each outcome carries its own request's intent, not the latest request's — absent included", async () => {
  const history = controlledHistory()
  const seen: Array<[string, string]> = []
  const resume = createResumeRequests<string>(
    history.fetch,
    (next, intent) => seen.push([`history ${next.threadId}`, intent]),
    (message, intent) => seen.push([`failure ${message}`, intent]),
    (threadId, intent) => seen.push([`absent ${threadId}`, intent]),
  )
  resume('first', 'pop')
  await history.resolve('first')
  resume('second', 'push')
  await history.reject('second', 'second went away')
  resume('unused', 'pop')
  resume('clicked', 'push')
  await history.absent('unused') // superseded by the click: dropped, not started
  await history.absent('clicked')
  expect(seen).toEqual([
    ['history first', 'pop'],
    ['failure second went away', 'push'],
    ['absent clicked', 'push'],
  ])
})
