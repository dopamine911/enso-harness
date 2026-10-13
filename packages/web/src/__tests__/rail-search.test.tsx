import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { ThreadSummary } from '../thread-stores.ts'
import type * as ThreadsRailModule from '../threads-rail.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ThreadsRail }: typeof ThreadsRailModule = await import('../threads-rail.tsx')

/**
 * The rail's search and folds (#875), MOUNTED: what is typed keeps the threads whose title holds it
 * across every project, opening a section the reader folded and finding what a collapsed fold
 * holds; nothing matching says so, with a way back; Escape and the clear button empty it. A fold
 * expands in place, and opens on its own for the thread on screen.
 */

afterAll(releaseDom)
afterEach(() => globalThis.localStorage.removeItem('enso.rail.sections'))

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const APP: EnsoProject = { projectId: 'p-app', title: 'app', path: '/code/app', status: 'ok', launch: false }
const REPEAT = 'Reply with exactly three words.'

function stored(
  projectId: string,
  threadId: string,
  title: string,
  extra: Partial<EnsoStoredThread> = {},
): EnsoStoredThread {
  return {
    threadId,
    projectId,
    title,
    lastActivityAt: new Date().toISOString(),
    messageCount: 2,
    busy: false,
    waiting: false,
    ...extra,
  }
}

const noop = (): void => undefined

interface MountedRail {
  readonly rail: HTMLElement
  readonly search: () => HTMLInputElement
  /** The titles of the rows drawn, thread rows and folds alike, in order. */
  readonly rowTitles: () => string[]
  readonly button: (name: string) => HTMLButtonElement
  readonly type: (text: string) => Promise<void>
  readonly click: (target: HTMLElement) => Promise<void>
  readonly press: (key: string) => Promise<void>
  readonly unmount: () => Promise<void>
}

async function mountRail(
  threads: readonly ThreadSummary[],
  earlier: readonly EnsoStoredThread[],
  activeThreadId?: string,
): Promise<MountedRail> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(
      <ThreadsRail
        projects={[LAUNCH, APP]}
        threads={threads}
        activeThreadId={activeThreadId}
        earlier={earlier}
        earlierError={undefined}
        onSelect={noop}
        onResume={noop}
        onNew={noop}
        onOpenProject={noop}
        onRemoveProject={noop}
        onProjectSettings={noop}
        onPage={noop}
        projectNotice={undefined}
      />,
    )
  })
  const rail = container.querySelector<HTMLElement>('nav[aria-label="threads"]')
  if (rail === null) throw new Error('expected the rail')
  const search = (): HTMLInputElement => {
    const found = rail.querySelector<HTMLInputElement>('input[aria-label="Search threads"]')
    if (found === null) throw new Error('expected the search box')
    return found
  }
  return {
    rail,
    search,
    rowTitles: () =>
      [...rail.querySelectorAll<HTMLButtonElement>('ol button')].map((row) =>
        row.dataset.threadId === undefined
          ? `${row.title} (fold)`
          : (row.querySelector('span.truncate')?.textContent ?? ''),
      ),
    button: (name: string) => {
      const found = [...rail.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name,
      )
      if (found === undefined) throw new Error(`expected the ${name} button`)
      return found
    },
    type: async (text: string) => {
      await flush(async () => {
        Reflect.set(HTMLInputElement.prototype, 'value', text, search())
        search().dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
      })
    },
    click: async (target: HTMLElement) => {
      await flush(async () => {
        target.click()
        await tick()
      })
    },
    press: async (key: string) => {
      await flush(async () => {
        search().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        await tick()
      })
    },
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

test('⚠ search finds threads in a section the reader folded and in a collapsed fold, case aside; the fold is kept for after (#875)', async () => {
  // The app section closed by the reader, across reloads (#876).
  globalThis.localStorage.setItem('enso.rail.sections', JSON.stringify({ [APP.projectId]: false }))
  const mounted = await mountRail(
    [],
    [
      stored('p-launch', 'l1', REPEAT),
      stored('p-launch', 'l2', REPEAT),
      stored('p-launch', 'l3', 'fix the login bug'),
      stored('p-app', 'a1', 'deploy the API'),
      stored('p-app', 'a2', 'write the changelog'),
    ],
  )
  // Folded: the app's threads are not drawn; the repeats are one row.
  expect(mounted.rowTitles()).toEqual([`${REPEAT} (fold)`, 'fix the login bug'])

  await mounted.type('DEPLOY')
  // Only the match, in its section, opened; the other section has none and is not shown.
  expect(mounted.rowTitles()).toEqual(['deploy the API'])
  expect(mounted.rail.querySelector('section[aria-label="enso"]')).toBeNull()
  expect(
    mounted.rail.querySelector('section[aria-label="app"] button[aria-expanded]')?.getAttribute('aria-expanded'),
  ).toBe('true')

  // Inside a fold: the fold is what matches, its count with it; it expands to its threads.
  await mounted.type('three words')
  expect(mounted.rowTitles()).toEqual([`${REPEAT} (fold)`])
  const fold = mounted.rail.querySelector<HTMLButtonElement>(`button[aria-expanded][title="${REPEAT}"]`)
  if (fold === null) throw new Error('expected the fold')
  expect(fold.textContent).toContain('2 threads')
  await mounted.click(fold)
  expect(mounted.rowTitles()).toEqual([`${REPEAT} (fold)`, REPEAT, REPEAT])
  expect(
    [...mounted.rail.querySelectorAll<HTMLButtonElement>('button[data-thread-id]')].map((row) => row.dataset.threadId),
  ).toEqual(['l1', 'l2'])

  // Cleared, the rail is as the reader left it: app folded again.
  await mounted.click(mounted.button('clear search'))
  expect(mounted.search().value).toBe('')
  expect(document.activeElement).toBe(mounted.search())
  expect(mounted.rowTitles()).not.toContain('deploy the API')
  expect(
    mounted.rail.querySelector('section[aria-label="app"] button[aria-expanded]')?.getAttribute('aria-expanded'),
  ).toBe('false')
  await mounted.unmount()
})

test('nothing matching says so, with Clear search; Escape empties the box (#875)', async () => {
  const mounted = await mountRail([], [stored('p-launch', 'l1', 'fix the login bug')])
  await mounted.type('  nowhere  ')
  const empty = mounted.rail.querySelector('[role="status"]')
  expect(empty?.textContent).toContain('No threads match “nowhere”.')
  expect(mounted.rail.querySelectorAll('section')).toHaveLength(0)
  await mounted.click(mounted.button('Clear search'))
  expect(mounted.search().value).toBe('')
  expect(document.activeElement).toBe(mounted.search())
  expect(mounted.rowTitles()).toEqual(['fix the login bug'])

  await mounted.type('login')
  expect(mounted.rowTitles()).toEqual(['fix the login bug'])
  await mounted.press('Escape')
  expect(mounted.search().value).toBe('')
  await mounted.unmount()
})

test('a section closed during a search stays closed until the query changes (#875)', async () => {
  const mounted = await mountRail(
    [],
    [stored('p-launch', 'l1', 'fix the login bug'), stored('p-launch', 'l2', 'fix the logout')],
  )
  await mounted.type('fix')
  const header = (): HTMLButtonElement => {
    const found = mounted.rail.querySelector<HTMLButtonElement>('section[aria-label="enso"] button[aria-expanded]')
    if (found === null) throw new Error('expected the section header')
    return found
  }
  await mounted.click(header())
  expect(header().getAttribute('aria-expanded')).toBe('false')
  expect(mounted.rowTitles()).toEqual([])
  await mounted.type('fix the')
  expect(header().getAttribute('aria-expanded')).toBe('true')
  expect(mounted.rowTitles()).toEqual(['fix the login bug', 'fix the logout'])
  // The reader's own open and closed were never touched.
  expect(JSON.parse(globalThis.localStorage.getItem('enso.rail.sections') ?? '{}')).toEqual({})
  await mounted.unmount()
})

test('a fold expands in place and collapses again; one holding the thread on screen opens on its own (#875)', async () => {
  const now = new Date()
  const live: ThreadSummary = {
    threadId: 'live',
    title: REPEAT,
    lastActivityAt: now,
    busy: false,
    waiting: false,
    projectId: 'p-launch',
  }
  const others = [stored('p-launch', 's1', REPEAT), stored('p-launch', 's2', REPEAT)]
  const shown = await mountRail([live], others, 'live')
  const fold = shown.rail.querySelector<HTMLButtonElement>(`button[aria-expanded][title="${REPEAT}"]`)
  if (fold === null) throw new Error('expected the fold')
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(shown.rail.querySelector('button[data-thread-id="live"]')?.getAttribute('aria-current')).toBe('true')
  await shown.click(fold)
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(shown.rail.querySelector('button[data-thread-id="live"]')).toBeNull()
  await shown.unmount()

  const elsewhere = await mountRail([live], others, undefined)
  const closed = elsewhere.rail.querySelector<HTMLButtonElement>(`button[aria-expanded][title="${REPEAT}"]`)
  if (closed === null) throw new Error('expected the fold')
  expect(closed.getAttribute('aria-expanded')).toBe('false')
  await elsewhere.click(closed)
  expect(
    [...elsewhere.rail.querySelectorAll<HTMLButtonElement>('button[data-thread-id]')].map(
      (row) => row.dataset.threadId,
    ),
  ).toEqual(['live', 's1', 's2'])
  await elsewhere.unmount()
})
