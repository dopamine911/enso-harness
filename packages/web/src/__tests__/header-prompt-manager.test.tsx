import { afterAll, afterEach, expect, test } from 'bun:test'
import { ENSO_PROJECT_HEADER } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as ChatScreenModule from '../chat-screen.tsx'
import type * as ThreadStoresModule from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — the manager is a Radix dialog.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { HeaderPromptManager }: typeof ChatScreenModule = await import('../chat-screen.tsx')
const { clearThreadsForTest, mintThread, threadListStore }: typeof ThreadStoresModule =
  await import('../thread-stores.ts')

/**
 * #470, PR #563 review: the header's prompt manager asks with the thread on screen's OWN fetch, so
 * every request names the thread's project (`X-Enso-Project`) — the header renders outside the
 * thread's stores, and without it the server answered a thread it had not built from the launch
 * project's library. While no thread is on screen, nothing is asked about one.
 */

afterAll(releaseDom)

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount()
  clearThreadsForTest()
})

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}

/** Every request the page made, with the project it named. */
interface Asked {
  readonly path: string
  readonly project: string | null
}

/** Mount the header's manager for `active` and open it; answers every request with a 404. */
async function openManager(active: ThreadStoresModule.ThreadSummary | undefined): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => root.render(<HeaderPromptManager active={active} />))
  mounted.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="prompts"]')
  if (trigger === null) throw new Error('expected the prompts button')
  await act(async () => {
    trigger.click()
    await tick()
  })
}

function recording(asked: Asked[]): (input: string, init?: RequestInit) => Promise<Response> {
  return (input: string, init?: RequestInit): Promise<Response> => {
    asked.push({ path: input, project: new Headers(init?.headers).get(ENSO_PROJECT_HEADER) })
    return Promise.resolve(new Response('not scripted', { status: 404 }))
  }
}

test("⚠ the header's manager asks about the thread on screen with its project named — the project-prompts listing included", async () => {
  const asked: Asked[] = []
  const thread = mintThread(recording(asked), 'p-other')
  const active = threadListStore.get().find((summary) => summary.threadId === thread.threadId)
  await openManager(active)
  await act(tick)
  const projectPrompts = asked.filter((request) => request.path.endsWith('/project-prompts'))
  expect(projectPrompts).toEqual([
    { path: `/api/threads/${encodeURIComponent(thread.threadId)}/project-prompts`, project: 'p-other' },
  ])
  // Every request the manager made went through the thread's fetch, so each names the project.
  expect(asked.every((request) => request.project === 'p-other')).toBe(true)
})

test('while no thread is on screen (still resuming), the manager asks nothing about a thread', async () => {
  const asked: Asked[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = recording(asked) as typeof fetch
  try {
    await openManager(undefined)
    await act(tick)
  } finally {
    globalThis.fetch = realFetch
  }
  expect(asked.some((request) => request.path.startsWith('/api/threads/'))).toBe(false)
})
