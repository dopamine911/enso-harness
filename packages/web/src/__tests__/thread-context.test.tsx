import { afterEach, expect, test } from 'bun:test'
import type { EnsoContextRequest, EnsoFileOperation, EnsoThreadContext } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadStoresContext } from '../store.ts'
import { ThreadContextView } from '../thread-context.tsx'
import { changeOf, displayPath, filesUpTo, lastRequestPerPrompt, totalOf } from '../thread-context-analysis.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'

afterEach(() => clearThreadsForTest())

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
  // The browser reads its request through the thread's stores; a static render runs no effect, so reads nothing.
  renderToStaticMarkup(
    <ThreadStoresContext.Provider value={mintThread()}>
      <ThreadContextView outcome={{ kind: 'read', payload: context }} />
    </ThreadStoresContext.Provider>,
  )
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&#x27;', "'")

const STORED: EnsoThreadContext = {
  threadId: 't1',
  live: false,
  usage: null,
  next: makeup(2000),
  events: [],
  files: [],
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

const operation = (turn: number, overrides: Partial<EnsoFileOperation>): EnsoFileOperation => ({
  path: 'src/a.ts',
  kind: 'read',
  tool: 'read',
  subject: '',
  added: 0,
  removed: 0,
  hits: 0,
  image: false,
  isError: false,
  turn,
  at: `2026-09-24T10:00:0${turn}.000Z`,
  ...overrides,
})

// #361 phase 4: the card counts what the agent had done BY the trend's picked request.
test("file activity sums each file's operations up to the picked request, newest first", () => {
  const operations = [
    operation(1, {}),
    operation(2, { kind: 'write', tool: 'edit', added: 3, removed: 1 }),
    operation(2, { path: 'shot.png', image: true }),
    operation(4, { kind: 'search', tool: 'grep', hits: 2 }),
  ]
  const [aFile, shot] = filesUpTo(operations, 2)
  expect(aFile).toMatchObject({ path: 'src/a.ts', reads: 1, writes: 1, searches: 0, added: 3, removed: 1 })
  expect(aFile?.operations.map((each) => each.turn)).toEqual([2, 1])
  expect(shot).toMatchObject({ images: 1 })
  expect(filesUpTo(operations, undefined)[0]?.searches).toBe(1)
})

test('a path under the thread tree reads ./-relative; one outside it as given', () => {
  expect(displayPath('/home/me/repo/src/a.ts', '/home/me/repo')).toBe('./src/a.ts')
  expect(displayPath('src/a.ts', '/home/me/repo')).toBe('./src/a.ts')
  expect(displayPath('/etc/hosts', '/home/me/repo')).toBe('/etc/hosts')
})
