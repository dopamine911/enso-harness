import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  ENSO_PROVIDER_REFUSAL_KEY,
  type EnsoDialogSpec,
  type EnsoFollowSnapshot,
  type EnsoFollowStatus,
  type EnsoModelState,
  type EnsoObservation,
  type EnsoSessionUsage,
} from '@enso/core'
import { FOLLOW_ENDED_CUSTOM_EVENT, routeEnsoCustomEvent } from '../custom-event-router.ts'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'

/**
 * #53 S1.3: the CUSTOM-chunk router was an inline closure no test reached — renaming a
 * chunk, dropping the notify-type allowlist, or swapping the two `apply*` calls all left
 * the suite green. These drive the extracted function with a fresh thread's stores
 * (#90 PR 3) and read them back.
 *
 * One vocabulary (#162 workstream 5): a chunk is named by `EnsoObservation.kind` or
 * `EnsoFollowFrame.type` and carries the whole thing, so every case here routes an
 * observation or a frame as the adapter would push it — never a re-shaped value.
 */

let stores: ThreadStores
beforeEach(() => {
  stores = mintThread()
})
afterEach(() => clearThreadsForTest())

const route = (eventType: string, data: unknown): void => routeEnsoCustomEvent(stores, eventType, data)
const observe = (observation: EnsoObservation): void => route(observation.kind, observation)
const notificationMessages = (): string[] => stores.notifications.get().map((notification) => notification.message)
/** A snapshot always writes its mode line; tests about anything else read past it. */
const noticesBesideModeLines = (): string[] => notificationMessages().filter((message) => !message.startsWith('Mode: '))

const CONFIRM: EnsoDialogSpec = { method: 'confirm', title: 'Apply?', message: 'm' }
const SELECT: EnsoDialogSpec = { method: 'select', title: 'Pick', options: ['a', 'b'] }

const NO_USAGE: EnsoSessionUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null }
const SPENT: EnsoSessionUsage = {
  cost: 0.5,
  input: 100,
  output: 10,
  cacheRead: 20,
  cacheWrite: 5,
  context: { tokens: 135, window: 200_000, percent: 0.0675 },
}
const snapshot = (overrides: Partial<EnsoFollowSnapshot> = {}): EnsoFollowSnapshot => ({
  type: 'snapshot',
  threadId: 't1',
  asOfSeq: 0,
  live: true,
  busy: false,
  generation: 1,
  permissionMode: { mode: 'default', available: ['default'] },
  model: null,
  cwd: '/work/project',
  messages: [],
  usage: NO_USAGE,
  openDialogs: [],
  ...overrides,
})
const status = (generation: number): EnsoFollowStatus => ({ type: 'status', live: true, busy: false, generation })

// ⚠ ONE RECEIPT, TWO VIEWS (#84, L3). The mode — off the snapshot at run start, and as a
// `permission-mode` observation on every mid-run change — is both state (the current-mode
// store) and history (the transcript line). Dropping either `apply*` call leaves the other
// view green, so both are read here, for both carriers.
test('a permission-mode observation reaches BOTH the current-mode store and the mode-lines store', () => {
  observe({ kind: 'permission-mode', mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
  expect(stores.permissionMode.get()).toEqual({ mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
  expect(notificationMessages()).toEqual(['Mode: acceptEdits'])
  // and it did NOT land in the usage store (the swap-the-two-apply-calls mutation)
  expect(stores.usage.get()).toBeUndefined()
})

test("the snapshot's permissionMode is the run-start receipt, folded by the same two stores", () => {
  route('snapshot', snapshot({ permissionMode: { mode: 'plan', available: ['default', 'plan'] } }))
  expect(stores.permissionMode.get()).toEqual({ mode: 'plan', available: ['default', 'plan'] })
  expect(notificationMessages()).toEqual(['Mode: plan'])
})

// #338 slice 2: the model store has ONE source, the follow — the snapshot's `model` and the
// `model` observation the host emits after a `/model` or `/thinking` run. `null` is a fact the
// snapshot states (not live), not an absence to skip over.
const LIVE_MODEL: EnsoModelState = {
  model: { provider: 'fake', id: 'one', name: 'Fake One' },
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'low', 'medium', 'high'],
}

test("the snapshot's model seeds the model store; a null snapshot leaves it null (#338 slice 2)", () => {
  expect(stores.model.get()).toBeNull()
  route('snapshot', snapshot())
  expect(stores.model.get()).toBeNull()
  route('snapshot', snapshot({ model: LIVE_MODEL }))
  expect(stores.model.get()).toEqual(LIVE_MODEL)
})

// #44: the project the status bar names is whatever the latest snapshot says — a reconnect's
// snapshot is the resync, so a later one replaces an earlier one rather than being ignored.
test("the snapshot's cwd is the thread's project, replaced by every later snapshot", () => {
  expect(stores.cwd.get()).toBeUndefined()
  route('snapshot', snapshot())
  expect(stores.cwd.get()).toBe('/work/project')
  route('snapshot', snapshot({ cwd: '/work/other' }))
  expect(stores.cwd.get()).toBe('/work/other')
})

// #45: the thread's spend is pi's session total, whole — the snapshot seeds it (so a resumed or
// reloaded thread shows what it spent), and each `session-usage` REPLACES it: applied twice, the
// same observation is the same total, never double.
test("the snapshot's usage seeds the usage store; a session-usage replaces it whole, never adds", () => {
  expect(stores.usage.get()).toBeUndefined()
  route('snapshot', snapshot({ usage: { ...NO_USAGE, cost: 0.25, input: 40 } }))
  expect(stores.usage.get()).toEqual({ ...NO_USAGE, cost: 0.25, input: 40 })
  observe({ kind: 'session-usage', ...SPENT })
  observe({ kind: 'session-usage', ...SPENT })
  expect(stores.usage.get()).toEqual(SPENT)
})

test('a model observation replaces the model store with the state the host says (#338 slice 2)', () => {
  route('snapshot', snapshot({ model: LIVE_MODEL }))
  observe({ kind: 'model', ...LIVE_MODEL, thinkingLevel: 'high' })
  expect(stores.model.get()).toEqual({ ...LIVE_MODEL, thinkingLevel: 'high' })
  observe({ kind: 'model', model: null, thinkingLevel: 'off', availableThinkingLevels: [] })
  expect(stores.model.get()).toEqual({ model: null, thinkingLevel: 'off', availableThinkingLevels: [] })
})

// ⚠ THE BROWSER NO LONGER READS A VENDOR ENTRY (L3). A persisted `modes` entry still crosses
// as `custom-entry` (recorded, counted) but moves nothing: the mode arrives as
// `permission-mode`, said by the host. If this ever renders a line, a reader has learned
// the vendor's shape again.
test('a custom-entry is recorded but renders nothing and moves no store', () => {
  observe({ kind: 'custom-entry', customType: 'modes', data: { mode: 'acceptEdits' } })
  expect(notificationMessages()).toEqual([])
  expect(stores.permissionMode.get().mode).toBeUndefined()
  expect(stores.recentChunks.get().map((chunk) => chunk.name)).toEqual(['custom-entry'])
})

test("a status frame sets the thread's run generation; a malformed one leaves the last standing (#109)", () => {
  expect(stores.generation.get()).toBeUndefined()
  route('status', status(3))
  expect(stores.generation.get()).toBe(3)
  route('status', { type: 'status', live: true, busy: false, generation: -1 })
  route('status', { type: 'status', generation: '4' })
  route('status', null)
  expect(stores.generation.get()).toBe(3)
  // a snapshot carries the generation too
  route('snapshot', snapshot({ generation: 7 }))
  expect(stores.generation.get()).toBe(7)
  expect(noticesBesideModeLines()).toEqual([])
})

test("a blocking extension-ui-request opens the thread's question; one without a readable dialog opens nothing and says so (#112)", () => {
  observe({ kind: 'extension-ui-request', id: 'd1', method: 'confirm', blocking: true, origin: 'run', dialog: CONFIRM })
  expect(stores.dialog.get()).toEqual({ id: 'd1', dialog: CONFIRM })
  observe({ kind: 'extension-ui-request', id: '', method: 'select', blocking: true, origin: 'run' })
  expect(stores.dialog.get()?.id).toBe('d1')
  expect(notificationMessages()).toEqual([expect.stringContaining('could not read')])
})

test('dialog-settled drops the card for ITS id and no other (#114)', () => {
  observe({ kind: 'extension-ui-request', id: 'd1', method: 'confirm', blocking: true, origin: 'run', dialog: CONFIRM })
  observe({ kind: 'dialog-settled', id: 'd0', outcome: 'answered' })
  expect(stores.dialog.get()?.id).toBe('d1')
  observe({ kind: 'dialog-settled', id: 'd1', outcome: 'timeout' })
  expect(stores.dialog.get()).toBeUndefined()
  // nothing shown: a settle for anything is nothing to do
  observe({ kind: 'dialog-settled', id: 'd1', outcome: 'answered' })
  expect(stores.dialog.get()).toBeUndefined()
  expect(notificationMessages()).toEqual([])
})

// ⚠ THE OLDEST QUESTION HOLDS THE SLOT (#271). Two LIVE asks — what the host actually does
// (`host/extension-ui-context.ts` holds several at once, oldest first) and the case the
// snapshot test below cannot observe, since a snapshot arrives once, when the follow opens.
// Newest-wins made the question being read vanish mid-read and left the page blank once the
// newer one was answered, with pi still parked on the older one.
test('a second live question never displaces the one on screen — the oldest holds the slot (#271)', () => {
  const ask = (id: string, dialog: EnsoDialogSpec): void =>
    observe({ kind: 'extension-ui-request', id, method: dialog.method, blocking: true, origin: 'run', dialog })
  ask('first', CONFIRM)
  ask('second', SELECT)
  expect(stores.dialog.get()).toEqual({ id: 'first', dialog: CONFIRM })
  // The held question is still the server's: settling the shown one empties the slot, and the
  // next snapshot — the only wholesale write — is what surfaces `second`.
  observe({ kind: 'dialog-settled', id: 'first', outcome: 'answered' })
  expect(stores.dialog.get()).toBeUndefined()
  route('snapshot', snapshot({ openDialogs: [{ id: 'second', dialog: SELECT }] }))
  expect(stores.dialog.get()).toEqual({ id: 'second', dialog: SELECT })
  expect(noticesBesideModeLines()).toEqual([])
})

test('two questions open: a settle for the one NOT shown leaves the card; the snapshot then lists the survivor first (#114, PR #115 review)', () => {
  route(
    'snapshot',
    snapshot({
      openDialogs: [
        { id: 'first', dialog: CONFIRM },
        { id: 'second', dialog: SELECT },
      ],
    }),
  )
  expect(stores.dialog.get()?.id).toBe('first')
  // The second question settles elsewhere while the first is what this page shows.
  observe({ kind: 'dialog-settled', id: 'second', outcome: 'answered' })
  expect(stores.dialog.get()?.id).toBe('first')
  // The shown one settles: the slot clears; the next question is whatever the next snapshot lists.
  observe({ kind: 'dialog-settled', id: 'first', outcome: 'cancelled' })
  expect(stores.dialog.get()).toBeUndefined()
  route('snapshot', snapshot({ openDialogs: [{ id: 'third', dialog: SELECT }] }))
  expect(stores.dialog.get()).toEqual({ id: 'third', dialog: SELECT })
  expect(noticesBesideModeLines()).toEqual([])
})

test('follow-ended is said where the human looks, as an error of this run (#103 receipt)', () => {
  route(FOLLOW_ENDED_CUSTOM_EVENT, { threadId: 't1' })
  expect(notificationMessages()).toEqual([expect.stringContaining('the connection to the server ended')])
  expect(stores.notifications.get().at(-1)).toMatchObject({ notifyType: 'error', origin: 'run' })
})

// #119: the notice scrolls away; the status bar's own state must say it too. Only a live
// follow delivers a status frame, so the next one is the honest "connected again".
test('follow-ended marks the thread disconnected; the next status frame clears it (#119)', () => {
  expect(stores.disconnected.get()).toBe(false)
  route(FOLLOW_ENDED_CUSTOM_EVENT, { threadId: 't1' })
  expect(stores.disconnected.get()).toBe(true)
  route('status', status(2))
  expect(stores.disconnected.get()).toBe(false)
})

test("the snapshot's openDialogs is the complete list: it replaces the card, an empty list clears it, a malformed snapshot moves nothing (#114)", () => {
  observe({
    kind: 'extension-ui-request',
    id: 'stale',
    method: 'confirm',
    blocking: true,
    origin: 'run',
    dialog: CONFIRM,
  })
  route('snapshot', snapshot({ openDialogs: [{ id: 'd2', dialog: CONFIRM }] }))
  expect(stores.dialog.get()).toEqual({ id: 'd2', dialog: CONFIRM })
  route('snapshot', { ...snapshot(), openDialogs: 'nope' })
  expect(stores.dialog.get()?.id).toBe('d2')
  route('snapshot', snapshot({ openDialogs: [] }))
  expect(stores.dialog.get()).toBeUndefined()
  expect(noticesBesideModeLines()).toEqual([])
})

test('a queue observation is the whole queue, interrupting first; a malformed one leaves the last list standing (#75)', () => {
  expect(stores.queue.get()).toEqual([])
  observe({ kind: 'queue', interrupting: ['stop at the tests'], enqueued: ['then this', 'and this'] })
  expect(stores.queue.get()).toEqual(['stop at the tests', 'then this', 'and this'])
  route('queue', { kind: 'queue', interrupting: 'not a list' })
  expect(stores.queue.get()).toEqual(['stop at the tests', 'then this', 'and this'])
  observe({ kind: 'queue', interrupting: [], enqueued: [] })
  expect(stores.queue.get()).toEqual([])
})

test('a notify pushes the message with each declared notify type', () => {
  for (const notifyType of ['info', 'warning', 'error'] as const) {
    observe({
      kind: 'extension-ui-request',
      id: '',
      method: 'notify',
      blocking: false,
      origin: 'run',
      message: `m-${notifyType}`,
      notifyType,
    })
  }
  expect(stores.notifications.get().map((notification) => notification.notifyType)).toEqual([
    'info',
    'warning',
    'error',
  ])
})

// #96: the origin is the host's tag, carried as-is into the store.
test('a notify carries the origin into the store; one without a message has nothing for a human', () => {
  observe({
    kind: 'extension-ui-request',
    id: '',
    method: 'notify',
    blocking: false,
    origin: 'session-start',
    message: 'startup',
    notifyType: 'info',
  })
  observe({ kind: 'extension-ui-request', id: '', method: 'notify', blocking: false, origin: 'run', message: 'during' })
  observe({ kind: 'extension-ui-request', id: '', method: 'notify', blocking: false, origin: 'run' })
  expect(
    stores.notifications
      .get()
      .map((notification) => [notification.message, notification.origin, notification.notifyType]),
  ).toEqual([
    ['startup', 'session-start', 'info'],
    ['during', 'run', undefined],
  ])
})

// L3 step C: the rejection crosses as itself; the router composes the warning where notices
// are rendered, so no notify observation is forged upstream.
test('a permission-mode-rejected is a WARNING notice — the click did nothing and the user is told', () => {
  observe({ kind: 'permission-mode-rejected', mode: 'plan', reason: 'the command refused' })
  expect(stores.notifications.get()).toEqual([
    expect.objectContaining({
      message: 'mode change to plan rejected: the command refused',
      notifyType: 'warning',
      origin: 'run',
    }),
  ])
  expect(stores.permissionMode.get().mode).toBeUndefined()
})

// ⚠ THE VALUE IS VALIDATED WHOLE, AS THE OBSERVATION IT CLAIMS TO BE. A value that is not a
// `EnsoObservation` — or is one of a different kind than its chunk name — moves nothing. The
// wire already refused it (`follow-connection.ts`'s frame check); this is the second lock.
test('a value that is not the observation its name claims moves no store', () => {
  route('extension-ui-request', { message: 'no kind, no method' })
  route('session-usage', { kind: 'queue', interrupting: [], enqueued: [] })
  route('session-usage', { ...SPENT, kind: 'session-usage', cost: -1 })
  route('extension-ui-request', {
    kind: 'extension-ui-request',
    id: '',
    method: 'notify',
    blocking: false,
    origin: 'elsewhere',
    message: 'mistagged',
  })
  route('extension-ui-request', {
    kind: 'extension-ui-request',
    id: '',
    method: 'notify',
    blocking: false,
    origin: 'run',
    message: 'loud',
    notifyType: 'loud',
  })
  expect(notificationMessages()).toEqual([])
  expect(stores.queue.get()).toEqual([])
  expect(stores.usage.get()).toBeUndefined()
})

test('a chunk this surface does not render is recorded and falls through untouched', () => {
  observe({ kind: 'unmapped', event: { type: 'some_future_event' } })
  route('not-a-kind', { customType: 'modes', data: { mode: 'plan' } })
  route('', { message: 'x' })
  expect(notificationMessages()).toEqual([])
  expect(stores.usage.get()).toBeUndefined()
  expect(stores.recentChunks.get().map((chunk) => chunk.name)).toEqual(['unmapped', 'not-a-kind', ''])
})

// ⚠ A throw here would end TanStack's stream loop — every malformed value must render as nothing.
test('malformed payloads never throw and never render', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    42,
    'text',
    [],
    {},
    { message: 7 },
    { message: null, notifyType: 'info' },
    { kind: 'extension-ui-request' },
    { type: 'snapshot' },
  ]
  for (const eventType of [
    'extension-ui-request',
    'custom-entry',
    'session-usage',
    'snapshot',
    'status',
    FOLLOW_ENDED_CUSTOM_EVENT,
  ]) {
    for (const value of malformed) {
      expect(() => route(eventType, value)).not.toThrow()
    }
  }
  expect(stores.usage.get()).toBeUndefined()
  expect(stores.dialog.get()).toBeUndefined()
  // the one chunk whose value is not read: follow-ended says its piece whatever it carries
  expect(notificationMessages().every((message) => message.includes('the connection to the server ended'))).toBe(true)
})

// ⚠ THE REASON THE ROUTER TAKES ITS STORES. TanStack hands `onCustomEvent` no thread id;
// each pane's factory closes over its own stores, so a chunk routed through one thread's
// callback must land in that thread and no other.
test("⚠ a chunk routed to one thread never touches another thread's stores", () => {
  const other = mintThread()
  observe({ kind: 'session-usage', ...SPENT })
  observe({ kind: 'permission-mode', mode: 'plan', available: ['plan'] })
  expect(stores.usage.get()).toEqual(SPENT)
  expect(other.usage.get()).toBeUndefined()
  expect(other.permissionMode.get().mode).toBeUndefined()
  expect(other.recentChunks.get()).toEqual([])
})

// ── a provider's refusal (#340) ──────────────────────────────────────────────

const refusal = (status: number | undefined, message: string): EnsoObservation => ({
  kind: 'provider-refused',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  ...(status === undefined ? {} : { status }),
  message,
})

// The acceptance's three: a 429, a 401 and a 400 must read as three different things — what to do
// about each differs (wait, log in, change the model), so a person must be able to tell them apart.
test('a 429, a 401 and a 400 are three distinct transcript lines and status words, each with the provider’s sentence', () => {
  const seen: Array<{ line: string | undefined; word: string | undefined }> = []
  for (const [status, message] of [
    [429, '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}'],
    [401, '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
    [
      400,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.259 does not support this model"}}',
    ],
  ] as const) {
    observe(refusal(status, message))
    seen.push({ line: notificationMessages().at(-1), word: stores.refusal.get()?.refusalClass })
  }
  expect(seen).toEqual([
    { line: 'anthropic/claude-sonnet-4-5 refused: rate-limited (429) — rate limit exceeded', word: 'rate-limited' },
    { line: 'anthropic/claude-sonnet-4-5 refused: not logged in (401) — invalid x-api-key', word: 'not logged in' },
    {
      line: 'anthropic/claude-sonnet-4-5 refused: model refused (400) — Claude Code 2.1.259 does not support this model',
      word: 'model refused',
    },
  ])
  expect(stores.notifications.get().at(-1)).toMatchObject({ notifyType: 'error', origin: 'run' })
})

test('pi’s retry is its own line: when, and which attempt of how many', () => {
  observe({ kind: 'provider-retry', attempt: 2, maxAttempts: 4, delayMs: 4000 })
  observe({ kind: 'provider-retry', attempt: 1, maxAttempts: 3, delayMs: 500 })
  expect(notificationMessages()).toEqual(['retrying in 4 s — attempt 2 of 4', 'retrying in 500 ms — attempt 1 of 3'])
})

// #380 review: without an end line, a thread that ran out of retries ends on `retrying in …`, as
// if one were still coming — the two-hour case ends exactly there. A retry that got through adds
// nothing: the reply is the evidence.
test('pi giving up is said, with its last error; a retry that got through adds no line', () => {
  observe({ kind: 'provider-retry-ended', success: true, attempt: 1 })
  observe({
    kind: 'provider-retry-ended',
    success: false,
    attempt: 4,
    finalError: '429 {"error":{"message":"slow down"}}',
  })
  observe({ kind: 'provider-retry-ended', success: false, attempt: 1, finalError: 'Retry cancelled' })
  expect(notificationMessages()).toEqual([
    'no reply after 4 retries — slow down',
    'no reply after 1 retry — Retry cancelled',
  ])
  expect(stores.notifications.get().map((line) => line.notifyType)).toEqual(['error', 'error'])
})

// "Nothing ran" must not read as "free" (`$0.0000` beside `idle`) — so the word stays through
// usage that does not grow (a failed turn still announces usage), and goes once a reply's output
// has, which is pi's own accounting saying something got through.
test('the status word stays while nothing got through, and clears once output grows past the refusal', () => {
  observe({ kind: 'session-usage', ...SPENT })
  observe(refusal(429, '429 rate limited'))
  observe({ kind: 'session-usage', ...SPENT })
  expect(stores.refusal.get()).toEqual({ refusalClass: 'rate-limited', outputAtRefusal: SPENT.output })
  observe({ kind: 'session-usage', ...SPENT, output: SPENT.output + 12 })
  expect(stores.refusal.get()).toBeUndefined()
})

// #381: the word lived only in the page's stores, so a reload lost it and the status bar read
// `idle · $0.0000` again. The snapshot carries the branch, whose last reply is the refused
// attempt pi stored — that is the resync. A refusal a reply came after is history, not state.
const refusedAttempt = (id: string): unknown => ({
  id,
  role: 'assistant',
  parts: [],
  metadata: { [ENSO_PROVIDER_REFUSAL_KEY]: { provider: 'anthropic', status: 401, message: '401 invalid x-api-key' } },
})
const reply = (id: string): unknown => ({ id, role: 'assistant', parts: [{ type: 'text', content: 'hello' }] })
const prompt = (id: string): unknown => ({ id, role: 'user', parts: [{ type: 'text', content: 'hi' }] })

test('a snapshot whose last reply is a refused attempt shows the word; one with a reply after it clears it (#381)', () => {
  route('snapshot', snapshot({ usage: SPENT, messages: [prompt('u1'), refusedAttempt('a1'), prompt('u2')] }))
  expect(stores.refusal.get()).toEqual({ refusalClass: 'not logged in', outputAtRefusal: SPENT.output })
  // the mark is the snapshot's output: a later reply's usage clears it as a live one would
  observe({ kind: 'session-usage', ...SPENT, output: SPENT.output + 1 })
  expect(stores.refusal.get()).toBeUndefined()

  route('snapshot', snapshot({ messages: [refusedAttempt('a1')] }))
  route('snapshot', snapshot({ messages: [prompt('u1'), refusedAttempt('a1'), reply('a2')] }))
  expect(stores.refusal.get()).toBeUndefined()
  // and the snapshot adds no transcript line: the attempt's own bubble says it
  expect(noticesBesideModeLines()).toEqual([])
})
