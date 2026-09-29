import { expect, test } from 'bun:test'
import { EventType } from '@ag-ui/core'
import { ENSO_TOOL_RESULT_KEY, type EnsoObservation, isEnsoToolResultDescriptor } from '@enso/core'
import { observationKindsDeclaredByTheUnion } from '@enso/core/observation-kinds'
import type { StreamChunk } from '@tanstack/ai'
import { type AguiIdentifiers, observationToAguiEvents } from '../to-agui.ts'

const ids: AguiIdentifiers = { messageId: 'm1', runId: 'r1', threadId: 't1' }
const toAgui = (observation: EnsoObservation): StreamChunk[] => observationToAguiEvents(observation, ids)
const types = (observation: EnsoObservation): StreamChunk['type'][] => toAgui(observation).map((event) => event.type)

test('a text delta becomes TEXT_MESSAGE_CONTENT carrying the message id', () => {
  const [event] = toAgui({ kind: 'text-delta', contentIndex: 0, delta: 'Hello ' })
  expect(event).toMatchObject({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'm1',
    delta: 'Hello ',
  })
})

// REASONING_*, because @ag-ui/core 1.0.0 removed THINKING_* from `EventType`.
test('a thinking delta uses REASONING_MESSAGE_CONTENT, not the removed THINKING_*', () =>
  expect(types({ kind: 'thinking-delta', contentIndex: 0, delta: 'hmm' })).toEqual([
    EventType.REASONING_MESSAGE_CONTENT,
  ]))

// ⚠ One observation, two events — which is why the mapper returns an array.
test('a tool call becomes TOOL_CALL_START followed by TOOL_CALL_ARGS', () => {
  const events = toAgui({ kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } })
  expect(events.map((event) => event.type)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS])
  expect(events[0]).toMatchObject({ toolCallId: 'c1', toolCallName: 'bash' })
  // args are serialised, because AG-UI streams them as a string delta
  expect(events[1]).toMatchObject({ delta: '{"command":"ls"}' })
})

test('absent args serialise to an empty object rather than undefined', () =>
  expect(toAgui({ kind: 'tool-call', toolCallId: 'c1', toolName: 'ls', args: undefined })[1]).toMatchObject({
    delta: '{}',
  }))

// ⚠⚠ The documented loss: AG-UI has no partial-result event, so accumulated output before
// completion has nowhere to go. Emitting a result per update would say "finished" repeatedly.
test('an INCOMPLETE tool result maps to nothing, deliberately', () =>
  expect(
    toAgui({
      kind: 'tool-result',
      toolCallId: 'c1',
      toolName: 'bash',
      text: 'partial…',
      complete: false,
      isError: false,
    }),
  ).toEqual([]))

test('a completed tool result becomes TOOL_CALL_RESULT with its text', () => {
  const [event] = toAgui({
    kind: 'tool-result',
    toolCallId: 'c1',
    toolName: 'bash',
    text: 'total 48',
    complete: true,
    isError: false,
  })
  expect(event).toMatchObject({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: 'c1',
    content: 'total 48',
    role: 'tool',
  })
})

// ⚠ `isError` has no AG-UI field on a tool result and is the only signal a REFUSED or ABORTED
// call has. The field that matters is the one TanStack's processor READS — `state:
// "output-error"` (activities/chat/stream/processor.js, `handleToolCallResultEvent`). The
// earlier `ensoIsError` was read by nothing, and this test passed while a denial rendered as
// success (#130). The mounted pane pins the observable half: the step row reads `error`.
test('an errored result carries the state TanStack reads, so a denial cannot render as success', () => {
  const [errored] = toAgui({
    kind: 'tool-result',
    toolCallId: 'c1',
    toolName: 'write',
    text: 'blocked',
    complete: true,
    isError: true,
  })
  expect(errored).toMatchObject({ state: 'output-error', content: 'blocked' })
  const [fine] = toAgui({
    kind: 'tool-result',
    toolCallId: 'c1',
    toolName: 'read',
    text: 'ok',
    complete: true,
    isError: false,
  })
  expect(fine).not.toHaveProperty('state')
})

// ⚠ NOT RUN_FINISHED — `agent_end` may be followed by an automatic retry.
test('a run ending is STEP_FINISHED, never RUN_FINISHED', () => {
  expect(types({ kind: 'run-ended', willRetry: false })).toEqual([EventType.STEP_FINISHED])
  expect(types({ kind: 'run-ended', willRetry: true })).toEqual([EventType.STEP_FINISHED])
  // and the retry is visible in the step name rather than lost
  expect(toAgui({ kind: 'run-ended', willRetry: true })[0]).toMatchObject({
    stepName: 'agent-run-will-retry',
  })
})

test('only a settle becomes RUN_FINISHED', () =>
  expect(toAgui({ kind: 'settled' })[0]).toMatchObject({
    type: EventType.RUN_FINISHED,
    threadId: 't1',
    runId: 'r1',
  }))

test('an extension error becomes RUN_ERROR naming the extension and the hook', () => {
  const [event] = toAgui({
    kind: 'extension-error',
    extensionPath: '/x/guards.ts',
    event: 'tool_call',
    error: 'boom',
  })
  // The whole envelope, exactly: two `toContain`s used to pass with `${event}` and
  // `${error}` swapped in the template (#53 S2, the 1f436dc class).
  expect(event).toEqual({
    type: EventType.RUN_ERROR,
    runId: 'r1',
    message: '/x/guards.ts failed on tool_call: boom',
  })
})

// ⚠ ONE VOCABULARY (#162 workstream 5). Whatever AG-UI has no word for rides CUSTOM named by
// `EnsoObservation.kind` and carrying the observation WHOLE — so #29's "the notify payload must
// survive the last hop" and #45's "the session's usage intact" are the same fact: the value IS the
// observation, and the router reads it by the kind the mapper gave it. The first hop
// (runtime event → observation) is pinned in host/__tests__/map-events.test.ts; the two
// meet on `EnsoObservation`, which the mapper sweep validates.
test('every CUSTOM chunk is named by its kind and carries the observation whole — nothing re-shaped, nothing forged', () => {
  const custom: EnsoObservation[] = [
    {
      kind: 'extension-ui-request',
      id: 'n1',
      method: 'notify',
      blocking: false,
      origin: 'run',
      message: 'Mode set to Plan Mode',
      notifyType: 'warning',
    },
    {
      kind: 'extension-ui-request',
      id: 'd1',
      method: 'select',
      blocking: true,
      origin: 'run',
      dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] },
    },
    { kind: 'dialog-settled', id: 'd1', outcome: 'answered' },
    { kind: 'permission-mode', mode: 'plan', available: ['default', 'plan'] },
    // L3 step C: crosses as itself; the ROUTER composes the warning. Before this the adapter
    // forged a notify observation here — a second shape for one fact.
    { kind: 'permission-mode-rejected', mode: 'plan', reason: 'the command refused' },
    { kind: 'custom-entry', customType: 'modes', data: { mode: 'acceptEdits' } },
    {
      kind: 'session-usage',
      cost: 0.0132,
      input: 1200,
      output: 40,
      cacheRead: 300,
      cacheWrite: 50,
      context: { tokens: 1590, window: 200_000, percent: 0.795 },
    },
    { kind: 'queue', interrupting: ['stop'], enqueued: ['then'] },
    // ⚠ CUSTOM, not RAW. @ag-ui/core defines RAW and it looks made for this, but TanStack
    // NARROWS AGUIEvent and RAW is not in the narrowed union — found only by removing a cast.
    { kind: 'unmapped', event: { type: 'some_future_event', detail: 1 } },
  ]
  for (const observation of custom) {
    expect(toAgui(observation)).toEqual([{ type: EventType.CUSTOM, name: observation.kind, value: observation }])
  }
})

test('nothing is silently dropped: every kind except an in-flight result and a bare message boundary yields an event', () => {
  const observations: EnsoObservation[] = [
    { kind: 'text-delta', contentIndex: 0, delta: 'a' },
    { kind: 'thinking-delta', contentIndex: 0, delta: 'b' },
    { kind: 'tool-call', toolCallId: 'c', toolName: 'bash', args: {} },
    { kind: 'tool-result', toolCallId: 'c', toolName: 'bash', text: 'x', complete: true, isError: false },
    { kind: 'extension-error', extensionPath: '/x', event: 'e', error: 'err' },
    // The notify variant: the one ui-request shape that crosses (fire-and-forget ones are
    // addressed to a terminal and are dropped by design — see the mapper).
    {
      kind: 'extension-ui-request',
      id: 'u1',
      method: 'notify',
      blocking: false,
      origin: 'run',
      message: 'Mode: acceptEdits',
    },
    { kind: 'custom-entry', customType: 'modes', data: { mode: 'acceptEdits' } },
    { kind: 'permission-mode', mode: 'acceptEdits', available: ['default', 'acceptEdits'] },
    { kind: 'permission-mode-rejected', mode: 'plan', reason: 'the command refused' },
    {
      kind: 'model',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      thinkingLevel: 'medium',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
    { kind: 'session-usage', cost: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, context: null },
    { kind: 'branch-compacted', reason: 'manual' },
    { kind: 'turn-start' },
    { kind: 'turn-end', toolResults: 1 },
    { kind: 'queue', interrupting: [], enqueued: ['later'] },
    { kind: 'prompt-rejected', messageId: 'm', reason: 'Agent is already processing' },
    { kind: 'provider-refused', provider: 'anthropic', status: 429, message: '429 rate limited' },
    { kind: 'provider-retry', attempt: 1, maxAttempts: 3, delayMs: 2000 },
    { kind: 'provider-retry-ended', success: false, attempt: 3, finalError: '429 rate limited' },
    { kind: 'dialog-settled', id: 'd1', outcome: 'answered' },
    { kind: 'run-ended', willRetry: false },
    { kind: 'settled' },
    { kind: 'unmapped', event: { type: 'z' } },
  ]
  for (const observation of observations) {
    expect(toAgui(observation).length).toBeGreaterThan(0)
  }
  // The AG-UI view opens one message per run, so a per-message boundary has no event in
  // it (#112) — the follow carries boundaries; this view's loss is stated, not silent. A
  // message's accounting goes with it: the page reads the thread's total as `session-usage`
  // (#45), and the per-message unit is the log's.
  const bareBoundaries: EnsoObservation[] = [
    { kind: 'message-start', role: 'user', text: 'hi' },
    { kind: 'message-end', role: 'user' },
    { kind: 'message-end', role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  ]
  for (const boundary of bareBoundaries) {
    expect(toAgui(boundary)).toEqual([])
  }
  observations.push(...bareBoundaries)
  // every member covered — the oracle is the union itself, never a hard-coded count (the
  // count here and in the mapper sweep drifted apart once; a set diff names the missing kind)
  const coveredKinds: string[] = [...new Set(observations.map((observation) => observation.kind))]
  expect(coveredKinds.sort()).toEqual(observationKindsDeclaredByTheUnion())
})

// ⚠⚠ #18's descriptor must survive the LAST hop: EnsoObservation → AG-UI StreamChunk, and
// still be readable. The first hop (the runtime's `details` bag → descriptor) is the host's
// and is pinned in host/__tests__/map-events.test.ts; `EnsoToolResult.descriptor` is the type
// the two hops meet on.
test('the tool-result descriptor survives observation → AG-UI intact', () => {
  const [event] = observationToAguiEvents(
    {
      kind: 'tool-result',
      toolCallId: 'c1',
      toolName: 'bash',
      text: 'trimmed output',
      complete: true,
      isError: false,
      descriptor: { kind: 'pi.tool.bash', props: {}, truncated: { shown: 500, total: 4000, unit: 'lines' } },
    },
    ids,
  )
  const carried = (event as Record<string, unknown>)[ENSO_TOOL_RESULT_KEY]
  expect(isEnsoToolResultDescriptor(carried)).toBe(true)
  expect(carried).toMatchObject({
    kind: 'pi.tool.bash',
    truncated: { shown: 500, total: 4000, unit: 'lines' },
  })
  // and the mandatory textual form rode alongside it, which is what makes an
  // unrecognised descriptor render visibly rather than blank
  expect(event).toMatchObject({ content: 'trimmed output' })
})

test('a result with no descriptor carries no descriptor key at all', () => {
  const observation: EnsoObservation = {
    kind: 'tool-result',
    toolCallId: 'c1',
    toolName: 'bash',
    text: 'plain',
    complete: true,
    isError: false,
  }
  expect(observationToAguiEvents(observation, ids)[0]).not.toHaveProperty(ENSO_TOOL_RESULT_KEY)
})

// ⚠ The deliberate drop (#53 S3): terminal-addressed fire-and-forget requests produce NO
// event — measured at 40 of 43 events for a one-word prompt when they were forwarded.
test('setStatus, setWidget, setTitle and set_editor_text produce no AG-UI event', () => {
  for (const method of ['setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
    expect(
      toAgui({ kind: 'extension-ui-request', id: '', method, blocking: false, origin: 'run', message: '' }),
    ).toEqual([])
  }
})
