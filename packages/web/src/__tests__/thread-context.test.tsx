import { expect, test } from 'bun:test'
import type { EnsoContextRequest, EnsoThreadContext } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadContextView } from '../thread-context.tsx'
import { changeOf, lastRequestPerPrompt, totalOf } from '../thread-context-analysis.ts'

/**
 * #361: the Context view — its derivations as pure functions, and a static render of what it
 * says it estimated, what the provider counted, and what it does not know.
 */

const makeup = (toolResults: number): EnsoContextRequest['estimated'] => ({
  system: 800,
  tools: 2700,
  user: 10,
  injected: 0,
  assistant: 100,
  toolResults,
})

const request = (turn: number, prompt: number, overrides: Partial<EnsoContextRequest> = {}): EnsoContextRequest => ({
  turn,
  prompt,
  at: '2026-09-24T10:00:00.000Z',
  model: 'claude-test',
  estimated: makeup(turn * 1000),
  actual: { prompt: 4000, output: 50, cacheRead: 3000 },
  brief: { prompt: 'list files', added: [], moreAdded: 0, reply: 'done', toolCalls: [] },
  ...overrides,
})

test("prompt granularity is each prompt's last request; a delta is the signed change from the bar before", () => {
  const requests = [request(1, 1), request(2, 1), request(3, 2)]
  expect(lastRequestPerPrompt(requests).map((each) => each.turn)).toEqual([2, 3])
  expect(changeOf(makeup(500), makeup(2000)).toolResults).toBe(-1500)
  expect(changeOf(makeup(500), undefined)).toEqual(makeup(500))
  expect(totalOf(makeup(0))).toBe(3610)
})

const text = (context: EnsoThreadContext): string =>
  renderToStaticMarkup(<ThreadContextView outcome={{ kind: 'read', payload: context }} />)
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&#x27;', "'")

const STORED: EnsoThreadContext = {
  threadId: 't1',
  live: false,
  usage: null,
  next: makeup(2000),
  requests: [
    request(1, 1),
    request(2, 1, {
      actual: { prompt: 0, output: 0, cacheRead: 0 },
      compaction: { tokensBefore: 9000 },
    }),
  ],
}

test('estimates are written ≈, the provider count is named, and what is not known is said', () => {
  const rendered = text(STORED)
  expect(rendered).toContain('≈5.6K')
  // A stored thread has no meter until it is live: no window is invented.
  expect(rendered).toContain("the model's window is known once the thread is live")
  // The picked bar is the latest: its provider count is absent, and its compaction is said.
  expect(rendered).toContain('no count from the provider')
  expect(rendered).toContain('compacted before this request')
  const live = text({ ...STORED, live: true, usage: { tokens: 4100, window: 200_000, percent: 2 } })
  expect(live).toContain('/ 200K window')
  expect(live).toContain('last request, by the provider:')
})
