import { expect, test } from 'bun:test'
import { liveOrStored } from '../live-or-stored.ts'
import type { ThreadView } from '../thread-registry.ts'

/**
 * The analysis routes' one read rule (#45, #361), the rule `thread-read.ts` reads by: peek, read
 * the file if not live, re-peek. A thread built while the file was being read is answered from
 * memory, which is fresher than the file.
 */

test('a thread built during the file read is answered live, from memory, and the file is read once', async () => {
  const view = { threadId: 't1' } as ThreadView
  const peeks: Array<ThreadView | undefined> = [undefined, view]
  let fileReads = 0
  const answer = await liveOrStored(
    { peek: (): ThreadView | undefined => peeks.shift() },
    't1',
    (live: ThreadView) => ({ source: `memory of ${live.threadId}` }),
    () => {
      fileReads += 1
      return Promise.resolve({ source: 'file' })
    },
  )
  expect(answer).toEqual({ source: 'memory of t1', live: true })
  expect(fileReads).toBe(1)
})
