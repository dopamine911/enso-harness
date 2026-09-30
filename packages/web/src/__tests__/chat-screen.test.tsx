import { afterEach, expect, test } from 'bun:test'
import type { EnsoDialogSpec } from '@enso/core'
import type { ChatUISelectedPart } from '@tanstack/ai-client/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DialogAnswerControls,
  describeAttachmentError,
  EnsoDialogCard,
  type KeyedPart,
  keyedParts,
  settleDialog,
  ThreadPane,
} from '../chat-screen.tsx'
import type { DialogAnswerOutcome, FollowConnection } from '../follow-connection.ts'
import { createStore } from '../store.ts'
import { adoptThread, clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { selectIn } from './static-markup.ts'

/**
 * #49, first pass: the dialog components had live receipts (#27, the e2e smoke) and no unit
 * render, so chat-screen.tsx sat at ~14% lines. These are static renders in the style of
 * selected-message-part.test.tsx — what each dialog METHOD puts on screen, and the visible
 * fallback for an interrupt the page cannot read. Click behaviour stays with the e2e smoke
 * (renderToStaticMarkup runs no handlers).
 */

afterEach(() => clearThreadsForTest())

const SELECT_DIALOG: EnsoDialogSpec = {
  method: 'select',
  title: 'Select permission mode',
  options: ['Default', 'Plan'],
}

function neverCalled(): void {
  // Static markup runs no handlers; the callbacks exist only to satisfy the props.
}

const answerControls = (dialog: EnsoDialogSpec): string =>
  renderToStaticMarkup(<DialogAnswerControls dialog={dialog} answer={neverCalled} disabled={false} />)

// --- one render per dialog method
test('confirm renders the message with Yes and No', () => {
  const rendered = answerControls({ method: 'confirm', title: 'Proceed?', message: 'Really overwrite?' })
  expect(rendered).toContain('Really overwrite?')
  expect(rendered).toContain('>Yes<')
  expect(rendered).toContain('>No<')
})

test('select renders one button per option, in order', () => {
  const rendered = answerControls(SELECT_DIALOG)
  expect(rendered.indexOf('>Default<')).toBeGreaterThan(-1)
  expect(rendered.indexOf('>Plan<')).toBeGreaterThan(rendered.indexOf('>Default<'))
  expect(rendered.match(/<button/g)).toHaveLength(2)
})

// #73: a permission prompt may arrive as a select carrying the detail a decision needs.
test('a select with detail renders it preformatted above the options — file content is text, never HTML', () => {
  const rendered = answerControls({
    method: 'select',
    title: 'Create file',
    options: ['Yes', 'No'],
    message: 'Do you want to create this file: a.html?\n\n<script>alert(1)</script>',
  })
  expect(rendered).toContain('<pre')
  expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(rendered).not.toContain('<script>')
  expect(rendered.indexOf('<pre')).toBeLessThan(rendered.indexOf('>Yes<'))
  // and a plain select — or one whose detail is empty — renders no detail block
  expect(answerControls(SELECT_DIALOG)).not.toContain('<pre')
  expect(answerControls({ ...SELECT_DIALOG, message: '' })).not.toContain('<pre')
})

test('input renders a single-line field with the placeholder and an Answer button', () => {
  // A credential is masked (#338 slice 3: `/login`'s API key); a plain input is not.
  const masked = answerControls({ method: 'input', title: 'API key', secret: true })
  expect(masked).toContain('type="password"')
  expect(masked).toContain('autoComplete="new-password"')
  const rendered = answerControls({ method: 'input', title: 'Name?', placeholder: 'your name' })
  expect(rendered).toContain('type="text"')
  expect(rendered).toContain('placeholder="your name"')
  expect(rendered).toContain('<input')
  expect(rendered).not.toContain('<textarea')
  expect(rendered).toContain('>Answer<')
})

test('editor renders a multi-line field prefilled with the draft', () => {
  const rendered = answerControls({ method: 'editor', title: 'Edit', prefill: 'draft text' })
  expect(rendered).toContain('<textarea')
  expect(rendered).toContain('draft text')
  expect(rendered).toContain('>Answer<')
})

// --- the card, and the slot that shows the thread's open question
test('the dialog card renders pi-is-asking with the title, the controls and a cancel', () => {
  const rendered = renderToStaticMarkup(
    <EnsoDialogCard dialogId="d1" dialog={SELECT_DIALOG} answer={neverCalled} cancel={neverCalled} disabled={false} />,
  )
  expect(rendered).toContain('pi is asking')
  expect(rendered).toContain('Select permission mode')
  expect(rendered).toContain('Cancel — decline the question')
  expect(rendered).toContain('>Default<')
})

// ⓘ `PendingDialog`'s render from the store is asserted through the MOUNTED pane in
// thread-pane.test.tsx (#118): the card appears from a wire frame and goes on its settle.

// PR #113 review: a REFUSED answer (422) leaves the question open on the server, so the card
// must stay; answered and gone (404) spend it. PR #120 review: so does a request that never
// arrived — nothing changed on the server.
test('⚠ settleDialog clears the question when it is spent and keeps it when the answer was refused or never arrived', async () => {
  const settle = async (outcome: DialogAnswerOutcome): Promise<boolean> => {
    const dialog = createStore<{ id: string; dialog: EnsoDialogSpec } | undefined>({ id: 'd1', dialog: SELECT_DIALOG })
    const connection = { answerDialog: () => Promise.resolve(outcome) } as unknown as FollowConnection
    await settleDialog({ connection, dialog }, { id: 'd1', value: 'Default' })
    return dialog.get() !== undefined
  }
  expect(await settle('answered')).toBe(false)
  expect(await settle('gone')).toBe(false)
  expect(await settle('refused')).toBe(true)
  expect(await settle('unreachable')).toBe(true)
})

// ── part keys are identities, not positions (#82) ─────────────────────────────
// The suppression these replace claimed the array index was fine because parts arrive in
// stable document order. Tool parts do NOT: the selection runs over the whole message list,
// so a result stamped onto another message re-pairs its call and shifts that call's index.

const textPart = (content: string): ChatUISelectedPart => ({ key: 'text', part: { type: 'text', content } })
const toolCallPart = (id: string): ChatUISelectedPart => ({
  key: 'toolCall',
  part: { type: 'tool-call', id, name: 'read', arguments: '{}', state: 'complete' },
})

test('⚠ a tool part keeps its key when its POSITION changes — an index key would remount it', () => {
  const call = toolCallPart('call-1')
  const first = keyedParts([call, textPart('after')])
  const shifted = keyedParts([textPart('before'), textPart('between'), call])
  const keyOf = (parts: KeyedPart[], id: string): string | undefined =>
    parts.find(({ selected }) => selected.key === 'toolCall' && selected.part.id === id)?.partKey
  expect(keyOf(first, 'call-1')).toBe(keyOf(shifted, 'call-1'))
})

test('two id-less parts of the same kind get distinct keys, so neither collides', () => {
  const keys = keyedParts([textPart('one'), textPart('two')]).map(({ partKey }) => partKey)
  expect(new Set(keys).size).toBe(2)
})

test('only the final part is the trailing one — what gates the streaming indicator', () => {
  const trailing = keyedParts([textPart('one'), toolCallPart('call-1'), textPart('two')]).map(
    ({ isTrailingPart }) => isTrailingPart,
  )
  expect(trailing).toEqual([false, false, true])
})

// ── the panes (#90 PR 3) ─────────────────────────────────────────────────────
// Every live thread's pane stays mounted (switching away must not abort its run), so
// anything gated on a page-level switch alone renders once PER THREAD. The debug column
// carries a fixed id and its own inspection fetches; it must exist in the active pane only.

test('⚠ two mounted panes with ?debug open render exactly ONE debug column, in the active pane', () => {
  const first = mintThread()
  const second = mintThread()
  const rendered = renderToStaticMarkup(
    <>
      <ThreadPane threadId={first.threadId} active={true} debugOpen={true} />
      <ThreadPane threadId={second.threadId} active={false} debugOpen={true} />
    </>,
  )
  expect(rendered.match(/id="thread-debug-pane"/g)).toHaveLength(1)
  // The active pane is shown; the other is off screen, not gone — its chat stays mounted, and
  // `inert` keeps it out of reach (#370: laid out under the shown one, not `display: none`).
  expect(rendered.match(/<div inert="" /g)).toHaveLength(1)
  expect(rendered.match(/id="thread-status"/g)).toHaveLength(2)
  // And with the switch off, no pane shows one.
  const closed = renderToStaticMarkup(<ThreadPane threadId={first.threadId} active={true} debugOpen={false} />)
  expect(closed).not.toContain('id="thread-debug-pane"')
})

test('a resumed pane mounts with the stored messages and the stored permission mode already visible', () => {
  const stored = adoptThread({
    threadId: 'stored-1',
    projectId: 'p-launch',
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'Earlier question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', content: 'Earlier answer' }] },
    ],
    permissionMode: { mode: 'plan', available: ['default', 'plan'] },
    sessionRisk: { level: 'low', signals: 0 },
  })
  const rendered = renderToStaticMarkup(<ThreadPane threadId={stored.threadId} active={true} debugOpen={false} />)
  expect(rendered).toContain('Earlier question')
  expect(rendered).toContain('Earlier answer')
  // The stored mode is the control's selection — not how React 19 happens to spell `selected`.
  expect(selectIn(rendered).selected).toBe('plan')
})

// A file the composer would not take is SAID, with how many and the cap by name (#68) — never dropped silently.
test('an attachment the form refuses is a notice saying how many and naming the cap: the kinds, the size, the count', () => {
  expect(describeAttachmentError({ code: 'accept', message: '', count: 1 })).toBe(
    '1 file was not attached: only images are attached here (png, jpeg, gif, webp)',
  )
  expect(describeAttachmentError({ code: 'max_file_size', message: '', count: 2 })).toBe(
    '2 files were not attached: an image is at most 5 MB',
  )
  expect(describeAttachmentError({ code: 'max_files', message: '', count: 3 })).toBe(
    '3 files were not attached: at most 20 images on one prompt',
  )
})

// #388: a login's code question is the FALLBACK to signing in on the provider's page, so the card
// must say what to paste and offer that page — in a new tab of this browser, where the login
// happens. The schema admits only http(s); the card refuses any other URL as an href all the same.
test('a login’s code question says what to paste and links the login page in a new tab', () => {
  const rendered = answerControls({
    method: 'input',
    title: 'Finish logging in to Faux',
    message: 'Open the login page and sign in.',
    link: { url: 'https://login.faux.invalid/authorize?state=1', label: 'Open login page' },
  })
  expect(rendered).toContain('Open the login page and sign in.')
  expect(rendered).toContain('href="https://login.faux.invalid/authorize?state=1"')
  expect(rendered).toContain('target="_blank"')
  expect(rendered).toContain('rel="noopener noreferrer"')
  expect(rendered).toContain('Open login page')
  const hostile = answerControls({
    method: 'input',
    title: 'x',
    link: { url: 'javascript:alert(1)', label: 'Open login page' },
  })
  expect(hostile).not.toContain('href=')
})
