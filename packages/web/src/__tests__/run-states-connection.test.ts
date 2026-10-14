import { expect, test } from 'bun:test'
import type { EnsoRunStatesFrame } from '@enso/core'
import { watchRunStates } from '../run-states-connection.ts'

/**
 * The page's run-states watch on its own (#911, PR #995 review), over its `fetch` seam: what it
 * does with a refusal, a frame off its schema, and a stream that ends.
 */

const RELEASED: EnsoRunStatesFrame = { type: 'run-state', threadId: 'elsewhere', busy: false, waiting: false }

const stream = (...lines: string[]): Response =>
  new Response(lines.map((line) => `data: ${line}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

test('a refusal (4xx) is asked once and not again: the watch ends', async () => {
  let asked = 0
  await watchRunStates({
    signal: new AbortController().signal,
    onFrame: () => {
      throw new Error('a refusal carries no frame')
    },
    fetch: () => {
      asked += 1
      return Promise.resolve(new Response('not here', { status: 404 }))
    },
  })
  expect(asked).toBe(1)
})

test('a frame off its schema is skipped, the next one delivered', async () => {
  const leaving = new AbortController()
  const heard: EnsoRunStatesFrame[] = []
  await watchRunStates({
    signal: leaving.signal,
    onFrame: (frame) => {
      heard.push(frame)
      leaving.abort()
    },
    fetch: () => Promise.resolve(stream('{"type":"from-a-newer-server"}', JSON.stringify(RELEASED))),
  })
  expect(heard).toEqual([RELEASED])
})

test('a server that fails (5xx) is asked again, after the first backoff', async () => {
  const leaving = new AbortController()
  const answers = [new Response('down', { status: 503 }), stream(JSON.stringify(RELEASED))]
  let asked = 0
  const heard: EnsoRunStatesFrame[] = []
  await watchRunStates({
    signal: leaving.signal,
    onFrame: (frame) => {
      heard.push(frame)
      leaving.abort()
    },
    fetch: () => {
      const answer = answers[asked]
      asked += 1
      return answer === undefined ? Promise.reject(new TypeError('asked too often')) : Promise.resolve(answer)
    },
  })
  expect(asked).toBe(2)
  expect(heard).toEqual([RELEASED])
})
