import { expect, test } from 'bun:test'
import {
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_PERMISSION_DENIAL_ENTRY,
  ENSO_RUN_STOPPED_ENTRY,
  ENSO_PROVIDER_REFUSAL_KEY,
  ENSO_TOOL_REFUSAL_KEY,
  ENSO_TOOL_RESULT_KEY,
  type EnsoInterruptedTail,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { transcriptOf } from '../../host/transcript.ts'
import { interruptedTail, stoppedAfter, transcriptToMessages } from '../transcript-to-messages.ts'

/**
 * #95: a stored branch mounts as the messages a live run would have left behind. Shapes are
 * pi's session entries, carried verbatim from a real file; what is pinned is what a resumed
 * transcript SHOWS — text, thinking, tool rows with their results paired — and what it does
 * not invent. Since L2 (#162 workstream 4) the host decodes the file into the transcript of
 * ours and this reader assembles it, so each case runs the two together: the file in, the
 * messages out, exactly as the history route composes them.
 */
const branchToMessages = (branch: readonly unknown[]): UIMessage[] => transcriptToMessages(transcriptOf(branch))

/** A stored pi session entry as a branch holds it — the shape the host's `transcriptOf` reads. */
interface BranchEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  message: Record<string, unknown>
}

const entry = (id: string, message: Record<string, unknown>, timestamp = '2026-09-08T12:00:00.000Z'): BranchEntry => ({
  type: 'message',
  id,
  parentId: null,
  timestamp,
  message,
})

test('user and assistant messages map in branch order, with text, thinking and tool calls as parts', () => {
  const messages = branchToMessages([
    { type: 'model_change', id: 'm0', parentId: null, timestamp: '', provider: 'x', modelId: 'y' },
    entry('u1', { role: 'user', content: 'fix the login bug', timestamp: 1 }),
    entry('a1', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'look at auth first' },
        { type: 'text', text: 'Reading auth.ts.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'auth.ts' } },
      ],
    }),
  ])
  expect(messages.map((message) => [message.id, message.role])).toEqual([
    ['u1', 'user'],
    ['a1', 'assistant'],
  ])
  expect(messages[0]?.parts).toEqual([{ type: 'text', content: 'fix the login bug' }])
  expect(messages[0]?.createdAt?.toISOString()).toBe('2026-09-08T12:00:00.000Z')
  expect(messages[1]?.parts).toEqual([
    { type: 'thinking', content: 'look at auth first' },
    { type: 'text', content: 'Reading auth.ts.' },
    {
      type: 'tool-call',
      id: 'c1',
      name: 'read',
      arguments: '{"path":"auth.ts"}',
      input: { path: 'auth.ts' },
      state: 'input-complete',
    },
  ])
})

// TanStack's own normalised shape: the result sits in the assistant message that holds the
// call, and the call reads complete with the result as its output — so a resumed step row
// (#93) renders exactly like a live one.
// @pins resume/transcript-ours
test('a user message pi stored with an image beside its text comes back as text + image parts (#68) — the bytes are in the file', () => {
  const messages = branchToMessages([
    entry('u1', {
      role: 'user',
      content: [
        { type: 'text', text: 'what does this say?' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'audio', data: 'x' },
      ],
      timestamp: 1,
    }),
  ])
  expect(messages[0]?.parts).toEqual([
    { type: 'text', content: 'what does this say?' },
    { type: 'image', source: { type: 'data', value: 'iVBORw0KGgo=', mimeType: 'image/png' } },
    // An unknown kind is a visible marker, as `contentToText` renders one — never a silent skip.
    { type: 'text', content: '[audio content]' },
  ])
})

test('⚠ a tool result is paired into the assistant message holding its call; the call completes with that output', () => {
  const messages = branchToMessages([
    entry('u1', { role: 'user', content: 'ls', timestamp: 1 }),
    entry('a1', {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
    }),
    entry('r1', {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'a.ts\nb.ts' }],
      isError: false,
      // pi's TruncationResult fields the mapper reads; the host's mapper tests build the whole
      // thing with pi's own truncation (#411), and this side is not allowed to name the vendor.
      details: { truncation: { truncated: true, truncatedBy: 'lines', outputLines: 2000, totalLines: 2500 } },
    }),
    entry('a2', { role: 'assistant', content: [{ type: 'text', text: 'Two files.' }] }),
  ])
  expect(messages).toHaveLength(3)
  const withCall = messages[1]
  expect(withCall?.parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result'])
  expect(withCall?.parts[0]).toMatchObject({ type: 'tool-call', state: 'complete', output: 'a.ts\nb.ts' })
  expect(withCall?.parts[1]).toMatchObject({
    type: 'tool-result',
    toolCallId: 'c1',
    name: 'bash',
    content: 'a.ts\nb.ts',
    state: 'complete',
    metadata: {
      [ENSO_TOOL_RESULT_KEY]: { kind: 'pi.tool.bash', truncated: { shown: 2000, total: 2500, unit: 'lines' } },
    },
  })
  expect(withCall?.parts[1]).not.toHaveProperty('error')
})

// @pins guarded-tool-call/refusal-is-error-result
test('a refused tool call (isError) reads as an error on both the call and the result — a denial must not render as success', () => {
  const messages = branchToMessages([
    entry('a1', {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'env' } }],
    }),
    entry('r1', {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'refused' }],
      isError: true,
    }),
  ])
  expect(messages[0]?.parts[0]).toMatchObject({ type: 'tool-call', state: 'error' })
  expect(messages[0]?.parts[1]).toMatchObject({ type: 'tool-result', state: 'error', error: 'refused' })
})

// #387's fixture: the same `bash` call, refused by a guard and failing on its own. Both are
// `isError` with a reason as the text — pi builds them identically — and only the refusing
// custom entry, written before the result, tells them apart after a reload: the guard's (#387)
// and the engine's (#523), each read as who refused. A marker that is malformed, names a call it
// does not precede, or is an engine refusal naming no call marks nothing.
// @pins guarded-tool-call/denial-entry
test('⚠ a refusal rides its own result as metadata, naming who refused; a failed call with the same shape carries none (#387, #523)', () => {
  const bashCall = (id: string): BranchEntry =>
    entry(`a-${id}`, {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'cat ~/.aws/credentials' } }],
    })
  const errorResult = (id: string, text: string): BranchEntry =>
    entry(`r-${id}`, {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError: true,
    })
  const custom = (id: string, customType: string, data: unknown): unknown => ({
    type: 'custom',
    customType,
    data,
    id,
    parentId: null,
    timestamp: '',
  })
  const engine = { requestId: 'req', surface: 'bash', value: 'cat ~/.aws/credentials' }
  const messages = branchToMessages([
    bashCall('refused'),
    custom('d1', ENSO_GUARD_DENIAL_ENTRY, { toolCallId: 'refused', rule: 'secret-path' }),
    errorResult('refused', 'bash command refused: "~/.aws/credentials" names credential material'),
    bashCall('failed'),
    custom('d2', ENSO_GUARD_DENIAL_ENTRY, { toolCallId: 'failed', rule: 'not-a-rule' }),
    errorResult('failed', 'cat: /home/me/.aws/credentials: No such file or directory'),
    bashCall('said-no'),
    custom('d3', ENSO_PERMISSION_DENIAL_ENTRY, { ...engine, toolCallId: 'said-no', resolution: 'user_denied' }),
    errorResult('said-no', 'Permission denied by the user'),
    bashCall('ruled'),
    custom('d4', ENSO_PERMISSION_DENIAL_ENTRY, { ...engine, toolCallId: 'ruled', resolution: 'policy_deny' }),
    errorResult('ruled', 'Permission denied by rule'),
    bashCall('probe'),
    custom('d5', ENSO_PERMISSION_DENIAL_ENTRY, { ...engine, resolution: 'user_denied' }),
    errorResult('probe', 'an engine refusal naming no call'),
  ])
  const resultOf = (id: string): unknown =>
    messages.flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === id)
  expect(resultOf('refused')).toMatchObject({
    state: 'error',
    metadata: { [ENSO_TOOL_REFUSAL_KEY]: { by: 'guard', rule: 'secret-path' } },
  })
  expect(resultOf('said-no')).toMatchObject({
    state: 'error',
    metadata: { [ENSO_TOOL_REFUSAL_KEY]: { by: 'operator' } },
  })
  expect(resultOf('ruled')).toMatchObject({ state: 'error', metadata: { [ENSO_TOOL_REFUSAL_KEY]: { by: 'rule' } } })
  expect(resultOf('failed')).toMatchObject({ state: 'error' })
  expect(resultOf('failed')).not.toHaveProperty('metadata')
  expect(resultOf('probe')).not.toHaveProperty('metadata')
})

test('a result whose call is not on the branch is dropped, not rendered as a stray row', () => {
  const messages = branchToMessages([
    entry('u1', { role: 'user', content: 'hi', timestamp: 1 }),
    entry('r1', { role: 'toolResult', toolCallId: 'gone', toolName: 'bash', content: [{ type: 'text', text: 'x' }] }),
  ])
  expect(messages).toHaveLength(1)
  expect(messages[0]?.role).toBe('user')
})

test('entries that are not messages, and malformed messages, never throw: skipped or emptied', () => {
  const messages = branchToMessages([
    { type: 'custom', customType: 'modes', data: { mode: 'plan' }, id: 'p', parentId: null, timestamp: '' },
    'garbage',
    null,
    entry('a1', { role: 'assistant', content: 'not an array' }),
    entry('u1', { role: 'user', content: [{ type: 'image', data: '…' }], timestamp: 1 }, 'not a date'),
    entry('x1', { role: 'somethingElse', content: '?' }),
  ])
  // A reply stored as a bare string renders as that text (the old reader emptied it — the
  // file says what it says, and a transcript shows it rather than hiding it); an image part
  // missing its bytes renders as a marker; an unknown role is skipped.
  expect(messages.map((message) => [message.role, message.parts])).toEqual([
    ['assistant', [{ type: 'text', content: 'not an array' }]],
    ['user', [{ type: 'text', content: '[image content]' }]],
  ])
  expect(messages[1]).not.toHaveProperty('createdAt')
  // …and the transcript itself keeps the unrendered message as `other` with its role in the
  // type, so the drawer's row says `message:somethingElse`, not merely that it was unknown.
  expect(transcriptOf([entry('x1', { role: 'somethingElse', content: '?' })])).toEqual([
    { kind: 'other', id: 'x1', at: '2026-09-08T12:00:00.000Z', type: 'message:somethingElse' },
  ])
})

// ── the interrupted tail (#109) ───────────────────────────────────────────────
// A branch that ends inside a turn is REPORTED, never repaired: the shapes a next prompt
// would paper over. A settled reply — even one cut short — is not one of them.
// Read off the ENTRIES since #220 — the fact is the transcript's, not the renderer's — so
// these cases run the file through the host's decoder and stop there.

const branchTail = (branch: readonly unknown[]): EnsoInterruptedTail | undefined =>
  interruptedTail(transcriptOf(branch))

const call = (id: string): BranchEntry =>
  entry(id, { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] })
const result = (id: string): BranchEntry =>
  entry(id, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] })

test('a branch ending on a user prompt is an unanswered prompt', () => {
  const branch = [
    entry('a0', { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] }),
    entry('u1', { role: 'user', content: 'next?', timestamp: 1 }),
  ]
  expect(branchTail(branch)).toBe('unanswered-prompt')
})

test('a branch ending on a tool call with no result is a call without its result', () => {
  expect(branchTail([call('a1')])).toBe('tool-call-without-result')
})

// PR #442 review: pi keeps the reply to the results only at its end, so a kill during that model
// call leaves the results with nothing after them. PR #438 review: a Stop never ends there — pi
// persists the aborted call's error reply after the results — so pi's aborted result is torn too.
test('⚠ a turn whose every call has its result and no reply is torn, whatever the results say; the reply settles it', () => {
  expect(branchTail([call('a1'), result('r1')])).toBe('tool-results-without-reply')
  // A result the guards refused is a real one: a kill after it is still torn.
  const refused = entry('r1', { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [], isError: true })
  expect(branchTail([call('a1'), refused])).toBe('tool-results-without-reply')
  // pi's `createErrorToolResult("Operation aborted")` with nothing after it: a kill that landed
  // between the aborted results and the error reply pi appends for a Stop.
  const aborted = entry('r1', {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'Operation aborted' }],
    isError: true,
  })
  expect(branchTail([call('a1'), aborted])).toBe('tool-results-without-reply')
  // A Stop's real shape, measured on the real host: pi's error reply after the results — no call.
  const stoppedReply = entry('a2', { role: 'assistant', content: [], stopReason: 'error' })
  expect(branchTail([call('a1'), aborted, stoppedReply])).toBeUndefined()
  // …and a reply to the results settles the turn.
  const reply = entry('a2', { role: 'assistant', content: [{ type: 'text', text: 'done' }] })
  expect(branchTail([call('a1'), result('r1'), reply])).toBeUndefined()
})

test('an empty branch, and one ending on an assistant reply, are settled', () => {
  expect(interruptedTail([])).toBeUndefined()
  const reply = entry('a1', { role: 'assistant', content: [{ type: 'text', text: 'done' }] })
  expect(branchTail([entry('u1', { role: 'user', content: 'hi', timestamp: 1 }), reply])).toBeUndefined()
})

// The last MESSAGE decides, not the last ENTRY: pi appends non-message entries of its own,
// and a model change logged after the prompt does not mean the prompt was answered.
test('a non-message entry logged after the last message does not hide the torn tail', () => {
  const modelChange = { type: 'model_change', id: 'm1', parentId: null, timestamp: '', provider: 'x', modelId: 'y' }
  expect(branchTail([entry('u1', { role: 'user', content: 'next?', timestamp: 1 }), modelChange])).toBe(
    'unanswered-prompt',
  )
  expect(branchTail([call('a1'), modelChange])).toBe('tool-call-without-result')
  // …and a result that arrives after one leaves a turn waiting on its reply.
  expect(branchTail([call('a1'), modelChange, result('r1')])).toBe('tool-results-without-reply')
})

// #381: pi keeps a refused attempt on the branch (`_omitRecoveryAttempt` keeps it in raw history)
// with `stopReason: "error"` and the provider's message, and its content is empty. Mapped as
// parts alone it mounted as an EMPTY assistant message — #340's silence again, for anyone who
// reloaded. The refusal rides the message's own metadata; the reply after it carries none.
// @pins resume/transcript-ours
test('a stored refused attempt, then the reply that got through: the refusal rides the attempt, not the reply (#381)', () => {
  const rateLimited = '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}'
  const messages = branchToMessages([
    entry('u1', { role: 'user', content: 'hi', timestamp: 1 }),
    entry('a1', {
      role: 'assistant',
      content: [],
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      stopReason: 'error',
      errorMessage: rateLimited,
    }),
    entry('a2', {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello after the retry' }],
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      stopReason: 'stop',
    }),
  ])
  expect(messages.map((message) => [message.id, message.metadata])).toEqual([
    ['u1', undefined],
    [
      'a1',
      {
        [ENSO_PROVIDER_REFUSAL_KEY]: {
          provider: 'anthropic',
          // Named from pi's built-in catalogue (#387) — a cold read has no session to ask.
          providerName: 'Anthropic',
          model: 'claude-sonnet-4-5',
          status: 429,
          message: rateLimited,
        },
      },
    ],
    ['a2', undefined],
  ])
  expect(messages[1]?.parts).toEqual([])
})

// A stop the user made is `aborted`, not a refusal — the same line the live event draws.
test('an aborted reply is not a refusal, and an error with no message still says one came (#381)', () => {
  const messages = branchToMessages([
    entry('a1', { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' }),
    entry('a2', { role: 'assistant', content: [], stopReason: 'error' }),
  ])
  expect(messages[0]?.metadata).toBeUndefined()
  expect(messages[1]?.metadata).toEqual({
    [ENSO_PROVIDER_REFUSAL_KEY]: { message: 'the provider returned an error without a message' },
  })
})

// ── #766: where the branch's runs were stopped ────────────────────────────────
// A stop is the host's `enso-run-stopped` entry after the run's last message; a reload puts its
// line after that message, so the anchor is the last MESSAGE before each entry, oldest first.

const stopEntry = (id: string): Record<string, unknown> => ({
  type: 'custom',
  id,
  parentId: null,
  timestamp: '',
  customType: ENSO_RUN_STOPPED_ENTRY,
  data: {},
})

test('each stop on the branch is anchored to the message before it, oldest first (#766)', () => {
  const branch = [
    entry('u1', { role: 'user', content: 'go', timestamp: 1 }),
    entry('a1', { role: 'assistant', content: [], stopReason: 'aborted' }),
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '', provider: 'x', modelId: 'y' },
    stopEntry('s1'),
    entry('u2', { role: 'user', content: 'again', timestamp: 2 }),
    call('a2'),
    result('r2'),
    stopEntry('s2'),
  ]
  expect(stoppedAfter(transcriptOf(branch))).toEqual(['a1', 'a2'])
})

test('a branch with no stop, or a stop entry that does not read, lists none (#766)', () => {
  const reply = entry('a1', { role: 'assistant', content: [{ type: 'text', text: 'done' }] })
  expect(stoppedAfter(transcriptOf([entry('u1', { role: 'user', content: 'hi', timestamp: 1 }), reply]))).toEqual([])
  const malformed = { ...stopEntry('s1'), data: { reason: 'x' } }
  expect(stoppedAfter(transcriptOf([reply, malformed]))).toEqual([])
})
