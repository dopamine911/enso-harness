import { afterEach, expect, test } from 'bun:test'
import type { EnsoContextRequest, EnsoFileOperation, EnsoThreadContext } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadStoresContext } from '../store.ts'
import { changeOf, displayPath, lastRequestPerPrompt, operationsUpTo, totalOf } from '../thread-context-analysis.ts'
import { ThreadContextView } from '../thread-context.tsx'
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
    .replaceAll('’', "'")

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
  expect(rendered).toContain('compacted from 9K')
  // The meter and the two numbers name the latest request the provider DID count — request 1, not the errored 2.
  expect(rendered).toContain('4K  request 1')
  expect(rendered).toContain('For request 1 pi estimated ≈4.6K; the provider counted 4K (−610)')
  const live = text({ ...STORED, live: true, usage: { tokens: 4100, window: 200_000, percent: 2 } })
  expect(live).toContain('≈4.1K  of 200K · 2%')
  expect(live).toContain("pi's context meter")
  expect(rendered).toContain('provider count')
  expect(live).toContain('3% of the 200K window, estimated')
})

// A full bar alone reads the same at 100% and at 140% of the window: past it, the text says so
// and what lies past the window's edge is tinted — on the Now card only, the one bar scaled to it.
test('a next request past the window is said, and its bar marks the window edge', () => {
  const markup = (window: number): string =>
    renderToStaticMarkup(
      <ThreadStoresContext.Provider value={mintThread()}>
        <ThreadContextView
          outcome={{ kind: 'read', payload: { ...STORED, live: true, usage: { tokens: 4100, window, percent: 100 } } }}
        />
      </ThreadStoresContext.Provider>,
    )
  const edges = (html: string): number => html.split('data-slot="scale-edge"').length - 1
  // ≈5.6K against a 4K window.
  const over = markup(4000)
  expect(over).toContain('140% of the 4K window, estimated — over it')
  expect(over).toContain('over the 4K window')
  expect(edges(over)).toBe(1)
  const under = markup(200_000)
  expect(under).not.toContain('over it')
  expect(edges(under)).toBe(0)
})

const operation = (turn: number, overrides: Partial<EnsoFileOperation>): EnsoFileOperation => ({
  key: `e${turn}#0.0`,
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

// #361 phase 4: the card lists what the agent had done BY the trend's picked request, newest first.
test('file activity lists the operations up to the picked request, newest first', () => {
  const operations = [
    operation(1, {}),
    operation(2, { kind: 'write', tool: 'edit', added: 3, removed: 1 }),
    operation(2, { path: 'shot.png', image: true }),
    operation(4, { kind: 'search', tool: 'grep', hits: 2 }),
  ]
  expect(operationsUpTo(operations, 2).map((listed) => [listed.turn, listed.kind, listed.path])).toEqual([
    [2, 'read', 'shot.png'],
    [2, 'write', 'src/a.ts'],
    [1, 'read', 'src/a.ts'],
  ])
  expect(operationsUpTo(operations, undefined).map((listed) => listed.turn)).toEqual([4, 2, 2, 1])
})

test('a path under the thread tree reads ./-relative; one outside it as given', () => {
  expect(displayPath('/home/me/repo/src/a.ts', '/home/me/repo')).toBe('./src/a.ts')
  expect(displayPath('src/a.ts', '/home/me/repo')).toBe('./src/a.ts')
  expect(displayPath('/etc/hosts', '/home/me/repo')).toBe('/etc/hosts')
  // The tree itself — a search over `.` — is `./`, never `./.` (#407).
  expect(displayPath('.', '/home/me/repo')).toBe('./')
  expect(displayPath('/home/me/repo', '/home/me/repo')).toBe('./')
})
