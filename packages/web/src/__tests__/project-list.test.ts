import { expect, test } from 'bun:test'
import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { threadAfterDelete } from '../project-list.ts'
import type { ThreadSummary } from '../thread-stores.ts'

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const OTHER: EnsoProject = { projectId: 'p-other', title: 'site', path: '/code/site', status: 'ok', launch: false }
const PROJECTS = [LAUNCH, OTHER]

/** A thread on this page: no `projectId` is the launch project's, as the rail reads it. */
const onPage = (
  threadId: string,
  minute: number,
  projectId?: string,
  title: string | undefined = 'a prompt',
): ThreadSummary => ({
  threadId,
  title,
  lastActivityAt: new Date(Date.UTC(2026, 9, 7, 12, minute)),
  busy: false,
  waiting: false,
  projectId,
})

/** A stored thread, not on this page. */
const stored = (threadId: string, minute: number, projectId: string, messageCount = 4): EnsoStoredThread => ({
  threadId,
  projectId,
  lastActivityAt: new Date(Date.UTC(2026, 9, 7, 12, minute)).toISOString(),
  messageCount,
  busy: false,
  waiting: false,
})

// ⚠ #663, measured in the arena: deleting the thread on screen — one of two approaches — opened a new
// empty thread and its Start dialog, though the other approach was right there in the rail.
test('⚠ after a delete, the page shows its project’s most recent other thread, on this page or stored; a fresh one only when there is none (#663)', () => {
  // The launch project's: B on this page (no projectId) and C stored under its id, C the more recent.
  const pageThreads = [onPage('A', 10), onPage('B', 20), onPage('S', 50, 'p-other')]
  expect(
    threadAfterDelete('A', undefined, { projects: PROJECTS, pageThreads, stored: [stored('C', 30, 'p-launch')] }),
  ).toEqual({
    threadId: 'C',
    onPage: false,
  })
  // On this page and more recent: shown at once.
  expect(
    threadAfterDelete('A', undefined, { projects: PROJECTS, pageThreads, stored: [stored('C', 15, 'p-launch')] }),
  ).toEqual({
    threadId: 'B',
    onPage: true,
  })
  // Another project's thread, however recent, is not this one's.
  expect(
    threadAfterDelete('A', undefined, {
      projects: PROJECTS,
      pageThreads: [onPage('A', 10), onPage('S', 50, 'p-other')],
      stored: [],
    }),
  ).toBeUndefined()
  // Nothing in it — a minted thread with no prompt, a stored one with no messages — is no thread to go to.
  expect(
    threadAfterDelete('A', undefined, {
      projects: PROJECTS,
      // A default parameter would turn `undefined` back into a title: the untitled thread is built whole.
      pageThreads: [onPage('A', 10), { ...onPage('E', 40), title: undefined }],
      stored: [stored('Z', 45, 'p-launch', 0)],
    }),
  ).toBeUndefined()
  // A stored row of a thread already on this page is that page thread, not a second candidate.
  expect(
    threadAfterDelete('A', undefined, {
      projects: PROJECTS,
      pageThreads: [onPage('A', 10), onPage('B', 20)],
      stored: [stored('B', 55, 'p-launch'), stored('A', 59, 'p-launch')],
    }),
  ).toEqual({ threadId: 'B', onPage: true })
  // A thread in a project the page no longer lists has nowhere to look.
  expect(threadAfterDelete('A', 'p-gone', { projects: PROJECTS, pageThreads, stored: [] })).toBeUndefined()
})
