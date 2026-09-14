import { expect, test } from 'bun:test'
import type { MessagePart, ToolCallPart, ToolResultPart } from '@tanstack/ai'
import type { ChatUISelectedPart } from '@tanstack/ai-client/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { SelectedMessagePart, summarizeToolInput } from '../selected-message-part.tsx'

/**
 * The dispatch this file guards was DEAD for its whole prior life: TanStack routes tool
 * parts to `toolsComponents[name]` (exact name, no fallback), so the old
 * `partsComponents.toolCall` entry never rendered and an unregistered tool showed as
 * NOTHING plus a console warning. `SelectedMessagePart` exists so an unanticipated tool
 * name still renders through the textual contract — these tests are the CI guard for
 * that; the `?fixture` page is the visual one and nothing runs it in CI.
 */

const toolCallWith = (overrides: Partial<ToolCallPart>): ToolCallPart => ({
  type: 'tool-call',
  id: 'call-1',
  name: 'bash',
  arguments: '{}',
  state: 'complete' as ToolCallPart['state'],
  ...overrides,
})

const toolResultWith = (overrides: Partial<ToolResultPart>): ToolResultPart => ({
  type: 'tool-result',
  toolCallId: 'call-1',
  content: 'PLAIN TEXT FORM',
  state: 'complete' as ToolResultPart['state'],
  ...overrides,
})

const html = (selected: ChatUISelectedPart, isStreaming = false, runOpen = true): string =>
  renderToStaticMarkup(
    <SelectedMessagePart selected={selected} isStreaming={isStreaming} runOpen={runOpen} renderers={{}} />,
  )

test('a tool call from an UNREGISTERED name renders its name and result text', () => {
  const rendered = html({
    key: 'toolCall',
    part: toolCallWith({ name: 'mcp_tool_nobody_registered' }),
    result: toolResultWith({ content: 'the visible result text' }),
  })
  expect(rendered).toContain('mcp_tool_nobody_registered')
  expect(rendered).toContain('the visible result text')
})

test('a tool call with no result yet renders the visible pending state', () => {
  const rendered = html({
    key: 'toolCall',
    part: toolCallWith({ id: 'call-2', state: 'pending' as ToolCallPart['state'] }),
  })
  expect(rendered).toContain('bash')
  expect(rendered).toContain('running…')
})

// #130: the same call once its run has ended — a stop, the server gone, a torn tail on
// resume — is aborted. The row says so, still dot, closed (nothing to open: no result).
test('⚠ a tool call with no result in a run that has ENDED reads aborted, not running', () => {
  const rendered = html(
    { key: 'toolCall', part: toolCallWith({ id: 'call-3', state: 'pending' as ToolCallPart['state'] }) },
    false,
    false,
  )
  expect(rendered).toContain('data-zen-tool-call="aborted"')
  expect(rendered).toContain('>aborted<')
  expect(rendered).not.toContain('running…')
  expect(rendered).not.toContain('animate-pulse')
  expect(rendered).not.toContain(' open')
})

// ── the step row (#90 PR 2) ──────────────────────────────────────────────────
// A tool call is one compact row — dot, name, subject — with IN/OUT folded beneath.

test('the step row names the tool and its subject, and folds the output beneath', () => {
  const rendered = html({
    key: 'toolCall',
    part: toolCallWith({ name: 'read', arguments: '{"path":"packages/web/src/x.ts"}' }),
    input: { path: 'packages/web/src/x.ts' },
    result: toolResultWith({ content: 'the file body' }),
  })
  expect(rendered).toContain('data-zen-tool-call="done"')
  expect(rendered).toContain('packages/web/src/x.ts')
  // Folded: a done row is a closed <details>, its output still in the markup for a click.
  expect(rendered).not.toContain(' open=""')
  expect(rendered).toContain('the file body')
})

// ⚠ AN ERROR OPENS ITSELF. A failure behind a click is a failure missed.
test('an errored step is marked and opens itself', () => {
  const rendered = html({
    key: 'toolCall',
    part: toolCallWith({ name: 'bash' }),
    result: toolResultWith({ error: 'exit 1: no such file' }),
  })
  expect(rendered).toContain('data-zen-tool-call="error"')
  expect(rendered).toContain(' open=""')
  expect(rendered).toContain('exit 1: no such file')
})

test('mid-stream, before the arguments parse, the row still shows the raw arguments', () => {
  const rendered = html({
    key: 'toolCall',
    part: toolCallWith({
      name: 'bash',
      arguments: '{"command":"ls -',
      state: 'input-streaming' as ToolCallPart['state'],
    }),
  })
  expect(rendered).toContain('data-zen-tool-call="pending"')
  expect(rendered).toContain('{&quot;command&quot;:&quot;ls -')
})

// The subject rule: pi's built-ins and the harness tools each name their subject one of
// five ways; anything else falls back to the first string, visibly, rather than to nothing.
test("the subject is the tool's own argument by precedence, else the first string", () => {
  expect(summarizeToolInput({ command: 'ls -la' })).toBe('ls -la')
  // grep carries both; the pattern is what you would ask about.
  expect(summarizeToolInput({ path: 'src', pattern: 'TODO' })).toBe('TODO')
  expect(summarizeToolInput({ subject: 'dynamic dispatch', count: 3 })).toBe('dynamic dispatch')
  expect(summarizeToolInput({ count: 3 })).toBeUndefined()
  expect(summarizeToolInput('not an object')).toBeUndefined()
})

test('a multi-line or long subject is clipped to one line with an ellipsis', () => {
  expect(summarizeToolInput({ command: 'sleep 4 && echo done\necho second line' })).toBe('sleep 4 && echo done…')
  const long = 'x'.repeat(200)
  expect(summarizeToolInput({ path: long })).toBe(`${'x'.repeat(80)}…`)
  expect(summarizeToolInput({ path: 'short' })).toBe('short')
})

test('an unmatched tool result renders through the same textual contract', () => {
  const rendered = html({
    key: 'toolResult',
    part: toolResultWith({ toolCallId: 'call-orphan', content: 'orphan result body' }),
    matched: false,
  })
  expect(rendered).toContain('orphan result body')
})

test('an unknown part kind renders visibly instead of vanishing', () => {
  // An image part, which no branch of the dispatcher claims — the generic member's
  // `part` is the broad `MessagePart` union, so this needs no cast.
  const imagePart: MessagePart = {
    type: 'image',
    source: { type: 'url', value: 'https://example.com/x.png' },
  }
  const rendered = html({ key: 'image', part: imagePart })
  expect(rendered).toContain('image')
})

test('a thinking part renders inside the Reasoning shell', () => {
  const thinkingPart: MessagePart = {
    type: 'thinking',
    content: 'the model reasoning text',
  }
  const rendered = html({ key: 'thinking', part: thinkingPart }, true)
  expect(rendered).toContain('the model reasoning text')
  expect(rendered).toContain('Thinking...')
})

// ⚠ NO NUMBER IT DOES NOT HAVE. A thinking block that was never observed streaming has no
// measured duration; upstream's "Thought for a few seconds" claimed one anyway.
test('a thinking block with no measured duration says Thought, with no invented seconds', () => {
  const thinkingPart: MessagePart = { type: 'thinking', content: 'done thinking' }
  const rendered = html({ key: 'thinking', part: thinkingPart }, false)
  expect(rendered).toContain('>Thought<')
  expect(rendered).not.toContain('few seconds')
})

// The text branch is the markdown pipeline of record (#53 S3: never rendered in a test).
test('a text part renders through the markdown pipeline inside the prose shell', () => {
  const textPart: MessagePart = { type: 'text', content: 'plain **bold** text' }
  const rendered = html({ key: 'text', part: textPart })
  expect(rendered).toContain('<strong>bold</strong>')
  expect(rendered).toContain('prose')
})

// The user's image (#68): inline bytes render as the image; a URL source stays visible as data, not fetched.
test('an image part with inline bytes renders as an <img>; a URL-sourced one falls through to the visible block, never an <img>', () => {
  const inline: MessagePart = { type: 'image', source: { type: 'data', value: 'iVBORw0KGgo=', mimeType: 'image/png' } }
  const rendered = html({ key: 'image', part: inline })
  expect(rendered).toContain('<img alt="attached by the user"')
  expect(rendered).toContain('src="data:image/png;base64,iVBORw0KGgo="')

  const remote: MessagePart = { type: 'image', source: { type: 'url', value: 'https://example.com/x.png' } }
  const fallen = html({ key: 'image', part: remote })
  expect(fallen).not.toContain('<img')
  expect(fallen).toContain('https://example.com/x.png')
})
