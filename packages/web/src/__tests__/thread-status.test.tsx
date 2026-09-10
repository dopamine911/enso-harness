import { expect, test } from 'bun:test'
import type { UIMessage } from '@tanstack/ai-client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThreadStats } from '../thread-stats.tsx'
import { countThread, describeActivity, ThreadStatusView } from '../thread-status.tsx'

/**
 * #90 PR 1: the always-on status bar. Activity and counts are derived from the message
 * list the page already holds; cost from the #45 store. Tested as the two pure functions
 * plus a static render of the view, the thread-debug.test.tsx pattern.
 */

const user = (id: string, content: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', content }] })
const assistant = (id: string, parts: UIMessage['parts']): UIMessage => ({ id, role: 'assistant', parts })
const call = (id: string, name: string): UIMessage['parts'][number] => ({
  type: 'tool-call',
  id,
  name,
  arguments: '{}',
  state: 'input-complete',
})
const result = (toolCallId: string): UIMessage['parts'][number] => ({
  type: 'tool-result',
  toolCallId,
  content: 'ok',
  state: 'complete',
})

const NO_STATS: ThreadStats = { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 }

// ── activity ─────────────────────────────────────────────────────────────────

test('not loading is idle, whatever the transcript holds', () => {
  const messages = [user('u1', 'hi'), assistant('a1', [call('c1', 'read')])]
  expect(describeActivity(messages, false)).toEqual({ kind: 'idle' })
})

// #119: after the follow ends the run flag is as of that moment — a run in flight may have
// finished, been aborted, or died with the server. The bar says the one thing it knows.
test('disconnected outranks the run flag: neither idle nor the tail is reported once the follow ended', () => {
  const midRun = [user('u1', 'hi'), assistant('a1', [call('c1', 'bash')])]
  expect(describeActivity(midRun, true, true)).toEqual({ kind: 'disconnected' })
  expect(describeActivity(midRun, false, true)).toEqual({ kind: 'disconnected' })
  expect(describeActivity(midRun, true, false)).toEqual({ kind: 'running', tool: 'bash' })
})

test('a run with no assistant output yet is working, not idle', () => {
  expect(describeActivity([user('u1', 'hi')], true)).toEqual({ kind: 'working' })
  expect(describeActivity([], true)).toEqual({ kind: 'working' })
})

// ⚠ THE DONE/PENDING RULE: a call is running until its result is paired — and pairing is
// TanStack's own selection across the whole list, not a `state` field we would have to
// keep in step with the library.
test('a tool call with no result is running <tool>; once its result lands the model is working again', () => {
  const pending = [user('u1', 'hi'), assistant('a1', [{ type: 'text', content: 'let me look' }, call('c1', 'read')])]
  expect(describeActivity(pending, true)).toEqual({ kind: 'running', tool: 'read' })
  const paired = [user('u1', 'hi'), assistant('a1', [call('c1', 'read'), result('c1')])]
  expect(describeActivity(paired, true)).toEqual({ kind: 'working' })
})

test('a thinking tail is thinking; a text tail is responding', () => {
  expect(describeActivity([user('u1', 'hi'), assistant('a1', [{ type: 'thinking', content: 'hm' }])], true)).toEqual({
    kind: 'thinking',
  })
  expect(describeActivity([user('u1', 'hi'), assistant('a1', [{ type: 'text', content: 'so' }])], true)).toEqual({
    kind: 'responding',
  })
})

// ⓘ Diverges from the transcript's render-everything policy on purpose: a one-word summary
// has no word for an image or an unmatched result, and `working` is true of both — the run
// is in flight, and the part itself is still visible in the transcript.
test('a tail the summary has no word for — an image, an unmatched result — is working', () => {
  const image = assistant('a1', [{ type: 'image', source: { type: 'url', value: 'x.png' } }])
  expect(describeActivity([user('u1', 'hi'), image], true)).toEqual({ kind: 'working' })
  // A result whose call never crossed: TanStack keeps it as an unmatched `toolResult` part.
  const orphanResult = assistant('a2', [result('never-called')])
  expect(describeActivity([user('u1', 'hi'), orphanResult], true)).toEqual({ kind: 'working' })
})

// ── counts ───────────────────────────────────────────────────────────────────

test('turns count user messages; tool calls count every call, paired or not', () => {
  const messages = [
    user('u1', 'one'),
    assistant('a1', [call('c1', 'read'), result('c1'), call('c2', 'bash')]),
    user('u2', 'two'),
    assistant('a2', [{ type: 'text', content: 'done' }]),
  ]
  expect(countThread(messages)).toEqual({ turns: 2, toolCalls: 2 })
  expect(countThread([])).toEqual({ turns: 0, toolCalls: 0 })
})

// ── the view ─────────────────────────────────────────────────────────────────

const render = (props: Partial<Parameters<typeof ThreadStatusView>[0]>): string =>
  renderToStaticMarkup(
    <ThreadStatusView
      activity={props.activity ?? { kind: 'idle' }}
      counts={props.counts ?? { turns: 0, toolCalls: 0 }}
      stats={props.stats ?? NO_STATS}
    />,
  )

// ⚠ ALWAYS VISIBLE. The #45 bar hid until the first request; this one is the place you look,
// so a fresh session must read as an empty session, not as nothing.
test('a fresh session renders idle with zeros — never an empty string', () => {
  const rendered = render({})
  expect(rendered).toContain('idle')
  expect(rendered).toContain('0 turns')
  expect(rendered).toContain('0 tool calls')
  expect(rendered).toContain('$0.0000')
  // No last-request figure before the first request: absent, not a fabricated zero.
  expect(rendered).not.toContain('tok in')
})

test('disconnected renders as its own word, not pulsing, with the recovery in the title', () => {
  const rendered = render({ activity: { kind: 'disconnected' } })
  expect(rendered).toContain('disconnected')
  expect(rendered).not.toContain('animate-pulse')
  expect(rendered).toContain('reload and resume from the rail')
})

test('the running tool is named, and counts read as English', () => {
  const rendered = render({ activity: { kind: 'running', tool: 'bash' }, counts: { turns: 1, toolCalls: 1 } })
  expect(rendered).toContain('running bash')
  expect(rendered).toContain('1 turn<')
  expect(rendered).toContain('1 tool call<')
})

test("cost and the last request's prompt size are labelled honestly", () => {
  const rendered = render({ stats: { totalCost: 0.0132, lastRequestInputTokens: 12_345, countedMessages: 1 } })
  expect(rendered).toContain('$0.0132')
  expect(rendered).toContain('12,345')
  // ⚠ "last … tok in", NOT "context": the window size does not cross the wire (#44), so a
  // context label would claim a measurement this bar does not have. Visible text only —
  // the hover title legitimately says "not a context-window percentage".
  const visibleText = rendered.replace(/<[^>]*>/g, ' ')
  expect(visibleText).not.toContain('context')
})
