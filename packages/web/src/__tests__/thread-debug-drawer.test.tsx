import { afterAll, afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { ThreadStoresContext } from '../store.ts'
import { NO_FORK_POINT_YET, ThreadDebugDrawer } from '../thread-debug.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'
import { waitUntil } from './wait-until.ts'

/**
 * The drawer, mounted, reading its fork point (#435). PR #440 review: a manifest read that failed
 * used to clear the section and drop the reason — a schema mismatch, exactly the disagreement the
 * drawer exists to show, left no trace. Now the section says why; a 404 says the thread is not
 * stored yet, which a new thread before its first reply is.
 */

ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
afterEach(() => clearThreadsForTest())
afterAll(releaseDom)

/** The server as the drawer reads it: no live session (its own 404), and `manifest` for the fork point. */
function serverAnswering(manifest: () => Response): typeof fetch {
  return ((input: string | URL | Request): Promise<Response> => {
    const url = requestedUrl(input)
    if (url.endsWith('/manifest')) return Promise.resolve(manifest())
    return Promise.resolve(new Response('no live session', { status: 404 }))
  }) as typeof fetch
}

async function forkPointSectionUnder(server: typeof fetch): Promise<string> {
  globalThis.fetch = server
  const stores = mintThread()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ThreadStoresContext.Provider value={stores}>
        <ThreadDebugDrawer />
      </ThreadStoresContext.Provider>,
    )
  })
  const section = (): string =>
    [...container.querySelectorAll('section')].find((candidate) =>
      candidate.querySelector('h3')?.textContent?.includes('fork point'),
    )?.textContent ?? ''
  await waitUntil(() => !section().includes('reading…'))
  const text = section()
  await act(async () => root.unmount())
  container.remove()
  return text
}

test('a manifest the server refuses is said in the fork-point section, with its reason', async () => {
  const section = await forkPointSectionUnder(
    serverAnswering(() => new Response('the file is locked', { status: 500 })),
  )
  expect(section).toContain('500')
  expect(section).toContain('the file is locked')
})

test('a manifest that does not match its schema is said, not dropped', async () => {
  const section = await forkPointSectionUnder(serverAnswering(() => Response.json({ identity: 'nonsense' })))
  expect(section).toContain("the server's manifest payload did not match its schema")
})

test('a 404 reads as a thread not stored yet', async () => {
  const section = await forkPointSectionUnder(serverAnswering(() => new Response('no thread', { status: 404 })))
  expect(section).toContain(NO_FORK_POINT_YET)
})
