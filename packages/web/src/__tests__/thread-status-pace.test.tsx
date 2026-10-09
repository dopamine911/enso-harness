import { afterAll, afterEach, expect, jest, test } from 'bun:test'
import type { UIMessage } from '@tanstack/ai-client'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ThreadStoresContext } from '../store.ts'
import { ThreadStatusBar } from '../thread-status.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client evaluates; `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * #739: the status bar's `/git` and `/tree` reads are paced — at most one per 5 s per pane, the last
 * change of a burst read at the window's end. Before, every settled tool result asked both routes
 * again, and each read walks the project's files.
 *
 * MOUNTED, because the pace lives in the effects that ask (`read-on-usage.ts`); fake timers, because
 * the window is five seconds of real time.
 */

afterEach(() => {
  jest.useRealTimers()
  clearThreadsForTest()
})
afterAll(releaseDom)

/** React's `act` with async work — typed so its Promise overload is the one seen (the `thread-pane.test.ts` note). */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const noView = (): void => {
  // The risk word's view request is not what these tests read.
}

/** A transcript holding `settled` settled tool results, each one a moment the tree may have moved. */
function transcriptWith(settled: number): UIMessage[] {
  const parts: UIMessage['parts'] = []
  for (let call = 0; call < settled; call += 1) {
    parts.push(
      { type: 'tool-call', id: `c${call}`, name: 'edit', arguments: '{}', state: 'input-complete' },
      { type: 'tool-result', toolCallId: `c${call}`, content: 'ok', state: 'complete' },
    )
  }
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'go' }] },
    { id: 'a1', role: 'assistant', parts },
  ]
}

test('⚠ a burst of settled tool results reads /git and /tree once at once and once at the window end, not once each (#739)', async () => {
  jest.useFakeTimers()
  const reads = { git: 0, tree: 0 }
  const stores = mintThread((input) => {
    if (input.endsWith('/git')) reads.git += 1
    if (input.endsWith('/tree')) reads.tree += 1
    return Promise.resolve(new Response('scripted', { status: 500 }))
  })
  // A thread with a session (#620), on a tree of its own: the bar shows the tree's control.
  stores.readable.set(true)
  stores.cwd.set('/work/shop-api')
  stores.tree.set(true)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const show = (settled: number): Promise<void> =>
    flush(async () => {
      root.render(
        <ThreadStoresContext.Provider value={stores}>
          <ThreadStatusBar messages={transcriptWith(settled)} generating openView={noView} shown />
        </ThreadStoresContext.Provider>,
      )
    })
  try {
    // Mounting is a new question: read at once, and no window opened by it.
    await show(0)
    expect(reads).toEqual({ git: 1, tree: 1 })

    // Twenty results settle inside 4 s, a usage update among them: the first is read at once, the
    // rest are held for the window's end.
    for (let settled = 1; settled <= 20; settled += 1) {
      await show(settled)
      if (settled === 10) await flush(async () => stores.usage.set(stores.usage.get()))
      await flush(async () => {
        jest.advanceTimersByTime(200)
      })
    }
    expect(reads).toEqual({ git: 2, tree: 2 })

    // The window ends: the rest of the burst is read once, so the readout shows the last change.
    await flush(async () => {
      jest.advanceTimersByTime(1000)
    })
    expect(reads).toEqual({ git: 3, tree: 3 })

    // Nothing asked since: the next window passes without a read.
    await flush(async () => {
      jest.advanceTimersByTime(10_000)
    })
    expect(reads).toEqual({ git: 3, tree: 3 })

    // A quiet bar asks at once again — the pace holds back bursts, never a lone change.
    await show(21)
    expect(reads).toEqual({ git: 4, tree: 4 })
  } finally {
    await flush(async () => {
      root.unmount()
    })
    container.remove()
  }
})
