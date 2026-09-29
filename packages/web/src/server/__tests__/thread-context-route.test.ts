import { expect, test } from 'bun:test'
import type { EnsoSessionUsage } from '@enso/core'
import type { BranchContext, BranchRequestDetail } from '../../host/branch-context.ts'
import { createContextRequestRoute, createThreadContextRoute } from '../thread-context-route.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * #361: one thread's context — pi's branch and pi's meter, from memory for a live thread and
 * from the file otherwise, building nothing to answer.
 */

const MAKEUP = { system: 10, tools: 20, user: 3, injected: 0, assistant: 4, toolResults: 5 }
const CONTEXT: BranchContext = { next: MAKEUP, requests: [], events: [], files: [], systemPrompt: null }
const USAGE: EnsoSessionUsage = {
  cost: 0.1,
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  context: { tokens: 1200, window: 200_000, percent: 0.6 },
}

test('a live thread answers from memory with its meter; a stored one from its file; one held nowhere, nothing', async () => {
  const live = createFakeHostedThread({ context: { ...CONTEXT, next: { ...MAKEUP, user: 99 } } })
  live.record.sessionUsage = USAGE
  const route = createThreadContextRoute({
    threads: {
      peek: (threadId: string) => (threadId === 'live' ? ({ hosted: live.hosted } as ThreadView) : undefined),
    },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      stored: { transcript: [], modified: new Date(), firstMessage: '', context: CONTEXT },
    }),
  })
  expect(await route('live')).toEqual({
    threadId: 'live',
    live: true,
    usage: USAGE.context,
    next: { ...MAKEUP, user: 99 },
    requests: [],
    events: [],
    files: [],
    systemPrompt: null,
  })
  expect(await route('stored')).toMatchObject({ threadId: 'stored', live: false, usage: null, next: MAKEUP })
  expect(await route('nowhere')).toBeUndefined()
})

const DETAIL: BranchRequestDetail = { elements: [], left: [{ category: 'user', label: 'gone', key: 'e1#0' }] }

// #361 phase 3: one request's detail, by turn or `next` — and a 404 for a turn the branch lacks,
// not an empty context that would read as "this request held nothing".
test("a request's detail answers by turn or next; a turn the branch lacks is no answer", async () => {
  const route = createContextRequestRoute({
    threads: { peek: (): ThreadView | undefined => undefined },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      stored: { transcript: [], modified: new Date(), firstMessage: '', details: { '2': DETAIL, next: DETAIL } },
    }),
  })
  expect(await route('stored', 2)).toEqual({ threadId: 'stored', request: 2, ...DETAIL })
  expect(await route('stored', 'next')).toMatchObject({ request: 'next' })
  expect(await route('stored', 3)).toBeUndefined()
  expect(await route('nowhere', 2)).toBeUndefined()
})
