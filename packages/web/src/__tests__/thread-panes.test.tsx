import { afterEach, expect, test } from 'bun:test'
import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { besideRows, closePane, openBeside, openInFocused, singlePane } from '../pane-layout.ts'
import { PaneTabs } from '../thread-panes.tsx'
import { clearThreadsForTest, mintThread, type ThreadSummary, updateThreadSummary } from '../thread-stores.ts'

/** Threads side by side (#938): what the panes' moves make of the layout, the split menu offers, and the tabs say. */

afterEach(() => clearThreadsForTest())

const SHOP: EnsoProject = { projectId: 'p-shop', title: 'shop', path: '/code/shop', status: 'ok', launch: false }
const ARCADE: EnsoProject = { projectId: 'p-arcade', title: 'arcade', path: '/code/arcade', status: 'ok', launch: true }

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 14, 12, minute))
const summary = (
  threadId: string,
  minute: number,
  projectId: string,
  flags: Partial<ThreadSummary> = {},
): ThreadSummary => ({
  threadId,
  title: `prompt ${threadId}`,
  lastActivityAt: at(minute),
  busy: false,
  waiting: false,
  projectId,
  ...flags,
})
const stored = (
  threadId: string,
  minute: number,
  projectId: string,
  flags: Partial<EnsoStoredThread> = {},
): EnsoStoredThread => ({
  threadId,
  projectId,
  title: `prompt ${threadId}`,
  lastActivityAt: at(minute).toISOString(),
  messageCount: 2,
  busy: false,
  waiting: false,
  ...flags,
})

test('a pane opens beside the focused one and takes the focus; a fourth is refused; a plain open replaces the focused pane only', () => {
  const two = openBeside(singlePane('a'), 'b')
  expect(two).toEqual({ threadIds: ['a', 'b'], focused: 1 })
  if (two === undefined) throw new Error('expected two panes')
  const three = openBeside({ ...two, focused: 0 }, 'c')
  expect(three).toEqual({ threadIds: ['a', 'c', 'b'], focused: 1 })
  if (three === undefined) throw new Error('expected three panes')
  // Every pane taken: nothing opens — but a thread already in a pane is focused there.
  expect(openBeside(three, 'd')).toBeUndefined()
  expect(openBeside(three, 'b')).toEqual({ ...three, focused: 2 })
  // A rail click replaces the focused pane's thread, and the other panes stay.
  expect(openInFocused(three, 'd')).toEqual({ threadIds: ['a', 'd', 'b'], focused: 1 })
  // Closing the focused pane moves the focus to the pane that takes its place; the last pane never closes.
  expect(closePane(three, 1)).toEqual({ threadIds: ['a', 'b'], focused: 1 })
  expect(closePane(singlePane('a'), 0)).toEqual(singlePane('a'))
})

test('the split menu offers each project’s latest thread first, then the rest, never a thread already in a pane (#938)', () => {
  const rows = besideRows(
    {
      projects: [ARCADE, SHOP],
      pageThreads: [summary('a1', 30, 'p-arcade'), summary('a2', 20, 'p-arcade', { waiting: true })],
      stored: [stored('s1', 10, 'p-shop', { busy: true }), stored('s2', 5, 'p-shop')],
    },
    ['a1'],
  )
  expect(rows.map((row) => [row.threadId, row.projectTitle, row.state, row.onPage])).toEqual([
    ['a2', 'arcade', 'waiting', true],
    ['s1', 'shop', 'running', false],
    ['s2', 'shop', 'idle', false],
  ])
})

test('below the width the panes fit, each tab says its thread, its project and whether it waits on you or runs (#938)', () => {
  const waiting = mintThread(undefined, 'p-shop')
  const running = mintThread(undefined, 'p-arcade')
  updateThreadSummary(waiting.threadId, { title: 'which checkout?', busy: true, waiting: true })
  updateThreadSummary(running.threadId, { title: 'plan the arcade', busy: true, waiting: false })
  const markup = renderToStaticMarkup(
    <PaneTabs
      layout={{ threadIds: [waiting.threadId, running.threadId], focused: 1 }}
      onFocus={(): void => undefined}
      onClose={(): void => undefined}
    />,
  )
  const window = new Window({ url: 'http://localhost/' })
  window.document.body.innerHTML = markup
  const tabs = [
    ...(window.document as unknown as Document).querySelectorAll<HTMLButtonElement>(
      'button[aria-current], button:not([aria-label])',
    ),
  ]
  // The dot's word for a screen reader first, then the title and the project's line.
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'waiting on youwhich checkout? · waiting on you',
    'runningplan the arcade · running',
  ])
  expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, 'true'])
  const closes = [...(window.document as unknown as Document).querySelectorAll('button[aria-label^="close pane"]')]
  expect(closes.map((button) => button.getAttribute('aria-label'))).toEqual(['close pane 1', 'close pane 2'])
})
