import { expect, test } from 'bun:test'
import type { EnsoSessionUsage } from '@enso/core'
import type { BranchContext } from '../../host/branch-context.ts'
import { createThreadContextRoute } from '../thread-context-route.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * #361: one thread's context — pi's branch and pi's meter, from memory for a live thread and
 * from the file otherwise, building nothing to answer.
 */

const MAKEUP = { system: 10, tools: 20, user: 3, injected: 0, assistant: 4, toolResults: 5 }
const CONTEXT: BranchContext = { next: MAKEUP, requests: [] }
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
  })
  expect(await route('stored')).toMatchObject({ threadId: 'stored', live: false, usage: null, next: MAKEUP })
  expect(await route('nowhere')).toBeUndefined()
})
