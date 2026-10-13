import { afterAll, afterEach, expect, jest, setSystemTime, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { createClockStore } from '../page-clock.ts'
import { ThreadsRail } from '../threads-rail.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client evaluates, and again if another mounting file has already
// released the one this module registered; `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The page clock, and the rail's ages on it (#278).
 *
 * MOUNTED, because the bug was that nothing re-rendered: `ChatScreen` read `new Date()` in
 * its render and passed it down, so an age only moved when something unrelated changed on
 * the page. Measured before the fix: a page left alone for ten minutes still read `12s`.
 *
 * Fake timers, because the page's period is five seconds of real time. Bun's
 * `advanceTimersByTime` moves `Date` with the timers, so a tick reads a clock that has
 * advanced by the same amount; `setSystemTime` alone moves `Date` and fires nothing, which
 * is how the second test separates "the clock moved" from "the page re-rendered".
 */

const T0 = new Date('2026-09-18T12:00:00.000Z')

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
})
afterAll(releaseDom)

/** React's `act` with async work — typed so its Promise overload is the one seen (the `thread-pane.test.ts` note). */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const noop = (): void => {
  // The rail's callbacks are not what these tests read.
}

async function mountRail(lastActivityAt: Date): Promise<{
  readonly text: () => string
  readonly rerender: (earlierError: string) => Promise<void>
  readonly unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const view = (earlierError: string | undefined): React.ReactNode => (
    <ThreadsRail
      projects={[]}
      threads={[{ threadId: 't1', title: 'live', lastActivityAt, busy: false, waiting: false, projectId: undefined }]}
      activeThreadId="t1"
      earlier={[]}
      earlierError={earlierError}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onOpenProject={noop}
      onRemoveProject={noop}
      onProjectSettings={noop}
      onPage={noop}
      projectNotice={undefined}
    />
  )
  await flush(async () => {
    root.render(view(undefined))
  })
  return {
    text: () => container.textContent ?? '',
    rerender: async (earlierError: string): Promise<void> => {
      await flush(async () => {
        root.render(view(earlierError))
      })
    },
    unmount: async (): Promise<void> => {
      await flush(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

test('the clock ticks while something is subscribed, stops with the last subscriber, and refreshes on the next one', () => {
  jest.useFakeTimers()
  setSystemTime(T0)
  const clock = createClockStore(1000)
  const unsubscribe = clock.subscribe(() => {
    // The value is the contract; the wake is how React learns of it.
  })
  jest.advanceTimersByTime(2000)
  expect(clock.get()).toEqual(new Date(T0.getTime() + 2000))

  // ⚠ Nothing is subscribed, so nothing is scheduled: a page showing no age holds no timer.
  unsubscribe()
  jest.advanceTimersByTime(60_000)
  expect(clock.get()).toEqual(new Date(T0.getTime() + 2000))

  // And the next subscriber is not handed the minute-old reading the interval never took.
  clock.subscribe(() => {
    // As above.
  })()
  expect(clock.get()).toEqual(new Date(T0.getTime() + 62_000))
})

test('an idle page advances its ages on its own (#278)', async () => {
  jest.useFakeTimers()
  setSystemTime(T0)
  const rail = await mountRail(new Date(T0.getTime() - 12_000))
  expect(rail.text()).toContain('12s')

  // Ten minutes in which nothing else happens on the page: no frame, no store, no fetch.
  await flush(async () => {
    jest.advanceTimersByTime(10 * 60_000)
  })
  expect(rail.text()).toContain('10m')
  expect(rail.text()).not.toContain('12s')
  await rail.unmount()
})

test('a re-render does not read the clock: an age moves on the tick, not on the render', async () => {
  jest.useFakeTimers()
  setSystemTime(T0)
  const rail = await mountRail(new Date(T0.getTime() - 12_000))
  expect(rail.text()).toContain('12s')

  // The clock moves without a tick, then something unrelated re-renders the rail. Before the
  // fix this is where the age jumped to `1m` — the render was reading `new Date()` itself.
  setSystemTime(new Date(T0.getTime() + 90_000))
  await rail.rerender('connection refused')
  expect(rail.text()).toContain('connection refused')
  expect(rail.text()).toContain('12s')
  await rail.unmount()
})
