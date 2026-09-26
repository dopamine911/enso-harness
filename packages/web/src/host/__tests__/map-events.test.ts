import { expect, test } from 'bun:test'
import { truncateHead, truncateTail } from '@earendil-works/pi-coding-agent'
import { ENSO_TOOL_RESULT_KEY, type EnsoObservation } from '@enso/core'
import { Check } from 'typebox/value'
import { mapPiEvent, toolResultMetadata } from '../map-events.ts'
import { RuntimeEventSchema } from '../runtime-event.ts'

const kindOf = (event: Parameters<typeof mapPiEvent>[0]): EnsoObservation['kind'] => mapPiEvent(event).kind

// --- streaming deltas, and the usage that rides on every one
test('a text delta maps, carrying usage', () => {
  const observed = mapPiEvent({
    type: 'message_update',
    usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0004 } },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
  })
  expect(observed).toMatchObject({ kind: 'text-delta', delta: 'Hello ', contentIndex: 0 })
  // ⚠ #24's second deal-breaker: usage per message, not by polling.
  expect(observed).toMatchObject({ usage: { input: 100, output: 1, totalCost: 0.0004 } })
})

test('a thinking delta is distinguished from text', () =>
  expect(
    kindOf({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'hmm' },
    }),
  ).toBe('thinking-delta'))

test('a start/end marker is carried as unmapped, never dropped', () =>
  expect(kindOf({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })).toBe(
    'unmapped',
  ))

// --- tool lifecycle
// ⓘ Full-envelope `toEqual` wherever the whole shape is known (#53 S2): a `toMatchObject`
// on a subset let a renamed or extra field ride through unnoticed.
test('tool_execution_start becomes a tool call', () =>
  expect(
    mapPiEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
  ).toEqual({ kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }))

test('a partial result is incomplete and not an error', () => {
  const observed = mapPiEvent({
    type: 'tool_execution_update',
    toolCallId: 'c1',
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'partial…' }], details: { truncation: null } },
  })
  expect(observed).toEqual({
    kind: 'tool-result',
    toolCallId: 'c1',
    toolName: 'bash',
    text: 'partial…',
    complete: false,
    isError: false,
  })
})

test('a completed result is complete', () =>
  expect(
    mapPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'total 48' }] },
      isError: false,
    }),
  ).toEqual({
    kind: 'tool-result',
    toolCallId: 'c1',
    toolName: 'bash',
    text: 'total 48',
    complete: true,
    isError: false,
  }))

// ⚠ The only signal a refused call has. pi documents no distinct "blocked" event, so a
// guard's `{block:true}` shape on the wire is unverified — any error result must display.
test('an errored result is flagged so it cannot render as success', () =>
  expect(
    mapPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'blocked: outside the workspace' }] },
      isError: true,
    }),
  ).toMatchObject({ kind: 'tool-result', isError: true, text: 'blocked: outside the workspace' }))

test('non-text content parts are named, not silently dropped', () =>
  expect(
    mapPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'read',
      result: {
        content: [
          { type: 'image', data: '…' },
          { type: 'text', text: ' ok' },
        ],
      },
      isError: false,
    }),
  ).toMatchObject({ text: '[image content] ok' }))

// --- truncation becomes a descriptor, so it renders per surface (#18). `details` is built by pi's
// OWN truncation (#411: a hand-written shape pi never sends kept these green while no pi result
// ever had a descriptor).
const ended = (toolName: string, details: unknown): EnsoObservation | undefined =>
  mapPiEvent({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName,
    result: { content: '…', details },
    isError: false,
  })
const numbered = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

test("⚠ pi's line-limited truncation becomes a descriptor in lines", () =>
  expect(ended('bash', { truncation: truncateTail(numbered(4000)) })).toMatchObject({
    descriptor: { kind: 'pi.tool.bash', truncated: { shown: 2000, total: 4000, unit: 'lines' } },
  }))

// A read cut by the 50KB limit says pi's own words: lines 1-N of the file's lines.
test('⚠ a byte-limited cut that drops lines is still said in lines, as pi says it', () => {
  const truncation = truncateHead(numbered(1500).replaceAll('line', 'x'.repeat(60)))
  expect(truncation.truncatedBy).toBe('bytes')
  expect(ended('read', { truncation })).toMatchObject({
    descriptor: { truncated: { shown: truncation.outputLines, total: 1500, unit: 'lines' } },
  })
})

test('a cut inside one line is said in bytes', () => {
  const truncation = truncateTail('y'.repeat(60_000))
  expect(ended('bash', { truncation })).toMatchObject({
    descriptor: { truncated: { shown: truncation.outputBytes, total: 60_000, unit: 'bytes' } },
  })
})

test('an untruncated, absent, or null truncation yields no descriptor', () => {
  expect(ended('bash', { truncation: truncateTail(numbered(3)) })).not.toHaveProperty('descriptor')
  expect(ended('bash', { truncation: null })).not.toHaveProperty('descriptor')
  expect(ended('bash', undefined)).not.toHaveProperty('descriptor')
})

test('the descriptor is wrapped under the namespaced metadata key', () => {
  const descriptor = { kind: 'pi.tool.bash', props: {} }
  expect(toolResultMetadata(descriptor)).toEqual({ [ENSO_TOOL_RESULT_KEY]: descriptor })
  expect(toolResultMetadata(undefined)).toBeUndefined()
})

// --- extension UI requests: the notify payload (#29)
// The envelope always crossed; these pin that the MESSAGE now crosses with it — the gap
// that made a mode change complete silently.
test('a notify carries its message and a declared notifyType', () =>
  expect(
    mapPiEvent({
      type: 'extension_ui_request',
      id: 'n1',
      method: 'notify',
      message: 'Mode set to Plan Mode',
      notifyType: 'info',
    }),
  ).toEqual({
    kind: 'extension-ui-request',
    id: 'n1',
    method: 'notify',
    blocking: false,
    origin: 'run',
    message: 'Mode set to Plan Mode',
    notifyType: 'info',
  }))

// #387: who said it crosses with the notify, as the host tagged it; an empty or non-string sender
// is no sender, and a dialog carries none.
test('a notify carries the sender the host tagged it with; a malformed one is dropped', () => {
  const notify = (sender: unknown): unknown =>
    mapPiEvent({ type: 'extension_ui_request', id: 'n', method: 'notify', message: 'm', sender })
  expect(notify('pi-multi-account')).toMatchObject({ sender: 'pi-multi-account' })
  expect(notify('')).not.toHaveProperty('sender')
  expect(notify(7)).not.toHaveProperty('sender')
  expect(
    mapPiEvent({ type: 'extension_ui_request', id: 'c', method: 'confirm', title: 't', message: 'm', sender: 'x' }),
  ).not.toHaveProperty('sender')
})

test('an unrecognised notifyType degrades to an untyped notification, not a failure', () => {
  const observed = mapPiEvent({
    type: 'extension_ui_request',
    id: 'n2',
    method: 'notify',
    message: 'odd',
    notifyType: 'sparkle',
  })
  expect(observed).toMatchObject({ kind: 'extension-ui-request', message: 'odd' })
  expect((observed as { notifyType?: unknown }).notifyType).toBeUndefined()
})

test('a notify with no message maps to an empty string, never undefined', () =>
  expect(mapPiEvent({ type: 'extension_ui_request', id: 'n3', method: 'notify' })).toMatchObject({
    kind: 'extension-ui-request',
    method: 'notify',
    message: '',
  }))

// ⚠ A dialog's `message` is part of the QUESTION and travels inside `dialog` — it must not
// gain a second home on the observation root, or the two copies drift.
test("a confirm dialog's message stays inside dialog and off the observation root", () => {
  const observed = mapPiEvent({
    type: 'extension_ui_request',
    id: 'd1',
    method: 'confirm',
    title: 'Proceed?',
    message: 'Really?',
  })
  expect(observed).toMatchObject({
    kind: 'extension-ui-request',
    blocking: true,
    dialog: { method: 'confirm', title: 'Proceed?', message: 'Really?' },
  })
  expect((observed as { message?: unknown }).message).toBeUndefined()
})

// --- errors and lifecycle
test('extension_error surfaces with its origin', () =>
  expect(
    mapPiEvent({ type: 'extension_error', extensionPath: '/x/guards.ts', event: 'tool_call', error: 'boom' }),
  ).toEqual({ kind: 'extension-error', extensionPath: '/x/guards.ts', event: 'tool_call', error: 'boom' }))

// ⚠ #24 acceptance: agent_end with willRetry must not present as completion.
test('agent_end is a run ending, not a settle — and carries willRetry', () => {
  expect(mapPiEvent({ type: 'agent_end', willRetry: true })).toEqual({ kind: 'run-ended', willRetry: true })
  expect(mapPiEvent({ type: 'agent_end', willRetry: false })).toEqual({ kind: 'run-ended', willRetry: false })
  expect(mapPiEvent({ type: 'agent_end' })).toEqual({ kind: 'run-ended', willRetry: false })
})

test('agent_settled is the only completion', () =>
  expect(mapPiEvent({ type: 'agent_settled' })).toEqual({ kind: 'settled' }))

// --- #29's remaining half: custom session entries are promoted, other entries are not
test('a custom entry maps with its type and data', () =>
  expect(
    mapPiEvent({
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'modes', data: { mode: 'acceptEdits' } },
    }),
  ).toEqual({ kind: 'custom-entry', customType: 'modes', data: { mode: 'acceptEdits' } }))

test('a custom entry with no data still maps — the shape belongs to its extension', () =>
  expect(mapPiEvent({ type: 'entry_appended', entry: { type: 'custom', customType: 'modes' } })).toEqual({
    kind: 'custom-entry',
    customType: 'modes',
    data: undefined,
  }))

// --- L3 (#162 workstream 4): the host's own mode event, so no surface reads a vendor entry
test("the host's permission_mode event maps to the permission-mode observation, state intact", () =>
  expect(mapPiEvent({ type: 'permission_mode', mode: 'plan', available: ['default', 'plan'] })).toEqual({
    kind: 'permission-mode',
    mode: 'plan',
    available: ['default', 'plan'],
  }))

test('a permission_mode event without a well-formed state is carried as unmapped, never dropped', () => {
  expect(kindOf({ type: 'permission_mode', mode: 'plan' })).toBe('unmapped')
  expect(kindOf({ type: 'permission_mode', mode: 7, available: [] })).toBe('unmapped')
})

// #45: a usage the host could not read whole (a negative cost, a missing context) is carried for
// the debug pane, never applied as the thread's total.
test('a session_usage event without a well-formed usage is carried as unmapped, never dropped', () => {
  const usage = { cost: 0.5, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, context: null }
  expect(kindOf({ type: 'session_usage', ...usage })).toBe('session-usage')
  expect(kindOf({ type: 'session_usage', ...usage, cost: -1 })).toBe('unmapped')
  const { context: _context, ...withoutContext } = usage
  expect(kindOf({ type: 'session_usage', ...withoutContext })).toBe('unmapped')
})

// ⚠ Non-custom entries duplicate first-class observations (messages stream as
// message_update), so they stay unmapped exactly as before this case existed.
test('a non-custom entry stays unmapped', () =>
  expect(kindOf({ type: 'entry_appended', entry: { type: 'message', message: { role: 'user' } } })).toBe('unmapped'))

test('an entry_appended with no readable entry stays unmapped', () =>
  expect(kindOf({ type: 'entry_appended' })).toBe('unmapped'))

// --- #45: one completed request's accounting, off message_end
test('an assistant message_end becomes a message-end with its role and usage', () =>
  expect(
    mapPiEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: { input: 1200, output: 40, cacheRead: 300, cacheWrite: 50, cost: { total: 0.0132 } },
      },
    }),
  ).toEqual({
    kind: 'message-end',
    role: 'assistant',
    usage: { input: 1200, output: 40, cacheRead: 300, cacheWrite: 50, totalCost: 0.0132 },
  }))

// pi's attribution rule: a toolResult carries usage only when a model summarized the output.
test('a toolResult message_end WITH usage is counted spend', () =>
  expect(
    mapPiEvent({
      type: 'message_end',
      message: { role: 'toolResult', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
    }),
  ).toEqual({
    kind: 'message-end',
    role: 'toolResult',
    usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
  }))

test('a toolResult message_end WITHOUT usage is a boundary with no spend to count', () =>
  expect(mapPiEvent({ type: 'message_end', message: { role: 'toolResult' } })).toEqual({
    kind: 'message-end',
    role: 'toolResult',
  }))

// ⚠ The role gate is load-bearing: without it, any future message shape carrying a
// usage-like object would inflate the cost sum outside pi's own attribution rule.
test('a message_end with usage but an unattributable role is a boundary WITHOUT that usage', () =>
  expect(
    mapPiEvent({
      type: 'message_end',
      message: { role: 'user', usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 } },
    }),
  ).toEqual({ kind: 'message-end', role: 'user' }))

test('a message_end with no readable message is a boundary of unknown role', () =>
  expect(mapPiEvent({ type: 'message_end' })).toEqual({ kind: 'message-end', role: 'unknown' }))

// --- #112: the boundaries and counters AG-UI supplied and the vocabulary lacked
test('a user message_start carries its text; an assistant one is a bare boundary', () => {
  expect(mapPiEvent({ type: 'message_start', message: { role: 'user', content: 'fix it' } })).toEqual({
    kind: 'message-start',
    role: 'user',
    text: 'fix it',
  })
  expect(mapPiEvent({ type: 'message_start', message: { role: 'assistant', content: [] } })).toEqual({
    kind: 'message-start',
    role: 'assistant',
  })
})

test("pi's turn boundaries cross with the tool-result count, not the results", () => {
  expect(mapPiEvent({ type: 'turn_start' })).toEqual({ kind: 'turn-start' })
  expect(mapPiEvent({ type: 'turn_end', message: {}, toolResults: [{}, {}] })).toEqual({
    kind: 'turn-end',
    toolResults: 2,
  })
  expect(mapPiEvent({ type: 'turn_end' })).toEqual({ kind: 'turn-end', toolResults: 0 })
})

test('queue_update crosses with the texts, in order; a non-string entry is dropped, an absent list is empty (#75)', () => {
  expect(mapPiEvent({ type: 'queue_update', steering: ['a'], followUp: ['b', 'c'] })).toEqual({
    kind: 'queue',
    interrupting: ['a'],
    enqueued: ['b', 'c'],
  })
  expect(mapPiEvent({ type: 'queue_update', steering: [1, 'x'], followUp: undefined })).toEqual({
    kind: 'queue',
    interrupting: ['x'],
    enqueued: [],
  })
})

// --- #114: the host's settle record ---------------------------------------------------
test("the host's extension_ui_settled maps to dialog-settled; an outcome the union does not name stays unmapped", () => {
  expect(mapPiEvent({ type: 'extension_ui_settled', id: 'd1', outcome: 'timeout' })).toEqual({
    kind: 'dialog-settled',
    id: 'd1',
    outcome: 'timeout',
  })
  // Host/mapper drift is shown in the debug pane, not carried as a settle the browser would act on.
  expect(mapPiEvent({ type: 'extension_ui_settled', id: 'd1', outcome: 'vanished' })).toMatchObject({
    kind: 'unmapped',
  })
  // A settle must name a question: an empty id is the same drift (`EnsoDialogSettled.id` is minLength 1).
  expect(mapPiEvent({ type: 'extension_ui_settled', id: '', outcome: 'answered' })).toMatchObject({ kind: 'unmapped' })
})

// ⚠ The design rule: there is no skip case.
test('an unmodelled event is carried through with its payload intact', () => {
  const observed = mapPiEvent({ type: 'some_future_event', detail: 42 })
  expect(observed).toEqual({ kind: 'unmapped', event: { type: 'some_future_event', detail: 42 } })
})

// --- usage: zero versus absent (#53 S2, adjacent to #45)
// `usage: {}` is a real shape pi can emit (an errored request); absent means "this delta
// carries no accounting". They must not collapse into one another: the browser's stats
// treat an all-zero usage as a failed request and an absent one as nothing to fold.
test('a delta with usage {} carries an all-zero usage; a delta without usage carries none', () => {
  const withEmptyUsage = mapPiEvent({
    type: 'message_update',
    usage: {},
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' },
  })
  expect(withEmptyUsage).toEqual({
    kind: 'text-delta',
    contentIndex: 0,
    delta: 'x',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  const withoutUsage = mapPiEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' },
  })
  expect(withoutUsage).toEqual({ kind: 'text-delta', contentIndex: 0, delta: 'x' })
})

test('cacheWrite and cost.total are read from usage, not defaulted', () =>
  expect(
    mapPiEvent({
      type: 'message_update',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'x' },
    }),
  ).toEqual({
    kind: 'text-delta',
    contentIndex: 2,
    delta: 'x',
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalCost: 0.5 },
  }))

// ⚠ All four dialog methods block pi (#53 S3): `input` and `editor` were never tested as
// blocking, so dropping either from the dialog set would have let pi hang silently.
test('input and editor dialogs are blocking, with their question read into dialog', () => {
  expect(
    mapPiEvent({ type: 'extension_ui_request', id: 'i1', method: 'input', title: 'Name?', placeholder: 'x' }),
  ).toEqual({
    kind: 'extension-ui-request',
    id: 'i1',
    method: 'input',
    blocking: true,
    origin: 'run',
    dialog: { method: 'input', title: 'Name?', placeholder: 'x' },
  })
  expect(
    mapPiEvent({ type: 'extension_ui_request', id: 'e1', method: 'editor', title: 'Edit', prefill: 'draft' }),
  ).toEqual({
    kind: 'extension-ui-request',
    id: 'e1',
    method: 'editor',
    blocking: true,
    origin: 'run',
    dialog: { method: 'editor', title: 'Edit', prefill: 'draft' },
  })
})

// #96: the origin is the host's DELIVERY, never the event's position. A replayed request —
// emitted during the session's own start — is `session-start`; live is `run`, and live is the
// default because every caller but the pump maps a run's stream.
test("⚠ a ui request's origin comes from how the host delivered it: replayed is session-start, live is run", () => {
  const notify = { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'loaded', notifyType: 'info' }
  expect(mapPiEvent(notify, 'replayed')).toMatchObject({ kind: 'extension-ui-request', origin: 'session-start' })
  expect(mapPiEvent(notify, 'live')).toMatchObject({ kind: 'extension-ui-request', origin: 'run' })
  expect(mapPiEvent(notify)).toMatchObject({ kind: 'extension-ui-request', origin: 'run' })
  // Every ui request is tagged, not only notifies: a dialog replayed from startup says so too.
  expect(
    mapPiEvent({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Pick', options: ['a'] }, 'replayed'),
  ).toMatchObject({ kind: 'extension-ui-request', blocking: true, origin: 'session-start' })
})

// ⚠ The event schema is OPEN on purpose — an unmodelled field must not fail validation, or a
// new pi event becomes "the host is broken" instead of "we don't render this yet". Host-internal
// since L2: nothing above the host sees an event, so this is the mapper's own contract now.
test('extra fields are accepted, so a newer pi does not break the host', () => {
  expect(Check(RuntimeEventSchema, { type: 'some_future_event', brandNew: { nested: true } })).toBe(true)
  expect(Check(RuntimeEventSchema, { type: '' })).toBe(false)
  expect(Check(RuntimeEventSchema, { delta: 'x' })).toBe(false)
})

// #340: the host's `provider_refused` is checked like every host event — a malformed one is carried
// as unmapped, never dropped — and pi's retry keeps exactly its three fields, not the error again.
test('a provider refusal maps whole; a malformed one is unmapped; a retry carries only attempt, maximum and delay', () => {
  const refused = { type: 'provider_refused', provider: 'anthropic', status: 429, message: '429 {}' }
  expect(mapPiEvent(refused)).toEqual({
    kind: 'provider-refused',
    provider: 'anthropic',
    status: 429,
    message: '429 {}',
  })
  const malformed = { type: 'provider_refused', status: 999, message: 'x' }
  expect(mapPiEvent(malformed)).toEqual({ kind: 'unmapped', event: malformed })
  expect(
    mapPiEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: '429 {}' }),
  ).toEqual({ kind: 'provider-retry', attempt: 2, maxAttempts: 3, delayMs: 4000 })
  // #380 review: the end, picked too — a success carries no error, running out does.
  expect(mapPiEvent({ type: 'auto_retry_end', success: true, attempt: 1 })).toEqual({
    kind: 'provider-retry-ended',
    success: true,
    attempt: 1,
  })
  expect(mapPiEvent({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '429 {}' })).toEqual({
    kind: 'provider-retry-ended',
    success: false,
    attempt: 3,
    finalError: '429 {}',
  })
})
