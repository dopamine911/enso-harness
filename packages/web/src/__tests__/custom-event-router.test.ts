import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ZenDialogSpec, ZenFollowSnapshot, ZenFollowStatus, ZenObservation } from '@zen/core'
import { FOLLOW_ENDED_CUSTOM_EVENT, routeZenCustomEvent } from '../custom-event-router.ts'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'

/**
 * #53 S1.3: the CUSTOM-chunk router was an inline closure no test reached — renaming a
 * chunk, dropping the notify-type allowlist, or swapping the two `apply*` calls all left
 * the suite green. These drive the extracted function with a fresh thread's stores
 * (#90 PR 3) and read them back.
 *
 * One vocabulary (#162 workstream 5): a chunk is named by `ZenObservation.kind` or
 * `ZenFollowFrame.type` and carries the whole thing, so every case here routes an
 * observation or a frame as the adapter would push it — never a re-shaped value.
 */

let stores: ThreadStores
beforeEach(() => {
  stores = mintThread()
})
afterEach(() => clearThreadsForTest())

const route = (eventType: string, data: unknown): void => routeZenCustomEvent(stores, eventType, data)
const observe = (observation: ZenObservation): void => route(observation.kind, observation)
const notificationMessages = (): string[] => stores.notifications.get().map((notification) => notification.message)
/** A snapshot always writes its mode line; tests about anything else read past it. */
const noticesBesideModeLines = (): string[] => notificationMessages().filter((message) => !message.startsWith('Mode: '))

const CONFIRM: ZenDialogSpec = { method: 'confirm', title: 'Apply?', message: 'm' }
const SELECT: ZenDialogSpec = { method: 'select', title: 'Pick', options: ['a', 'b'] }

const snapshot = (overrides: Partial<ZenFollowSnapshot> = {}): ZenFollowSnapshot => ({
  type: 'snapshot',
  threadId: 't1',
  asOfSeq: 0,
  live: true,
  busy: false,
  generation: 1,
  permissionMode: { mode: 'default', available: ['default'] },
  messages: [],
  openDialogs: [],
  ...overrides,
})
const status = (generation: number): ZenFollowStatus => ({ type: 'status', live: true, busy: false, generation })

// ⚠ ONE RECEIPT, TWO VIEWS (#84, L3). The mode — off the snapshot at run start, and as a
// `permission-mode` observation on every mid-run change — is both state (the current-mode
// store) and history (the transcript line). Dropping either `apply*` call leaves the other
// view green, so both are read here, for both carriers.
test('a permission-mode observation reaches BOTH the current-mode store and the mode-lines store', () => {
  observe({ kind: 'permission-mode', mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
  expect(stores.permissionMode.get()).toEqual({ mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
  expect(notificationMessages()).toEqual(['Mode: acceptEdits'])
  // and it did NOT land in the stats store (the swap-the-two-apply-calls mutation)
  expect(stores.stats.get().totalCost).toBe(0)
})

test("the snapshot's permissionMode is the run-start receipt, folded by the same two stores", () => {
  route('snapshot', snapshot({ permissionMode: { mode: 'plan', available: ['default', 'plan'] } }))
  expect(stores.permissionMode.get()).toEqual({ mode: 'plan', available: ['default', 'plan'] })
  expect(notificationMessages()).toEqual(['Mode: plan'])
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
  const ask = (id: string, dialog: ZenDialogSpec): void =>
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

test('a message-end with usage reaches the thread-stats store and nothing else', () => {
  observe({
    kind: 'message-end',
    role: 'assistant',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
  })
  expect(stores.stats.get().totalCost).toBe(0.5)
  expect(notificationMessages()).toEqual([])
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
// `ZenObservation` — or is one of a different kind than its chunk name — moves nothing. The
// wire already refused it (`follow-connection.ts`'s frame check); this is the second lock.
test('a value that is not the observation its name claims moves no store', () => {
  route('extension-ui-request', { message: 'no kind, no method' })
  route('message-end', { kind: 'queue', interrupting: [], enqueued: [] })
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
  expect(stores.stats.get().totalCost).toBe(0)
})

test('a chunk this surface does not render is recorded and falls through untouched', () => {
  observe({ kind: 'unmapped', event: { type: 'some_future_event' } })
  route('not-a-kind', { customType: 'modes', data: { mode: 'plan' } })
  route('', { message: 'x' })
  expect(notificationMessages()).toEqual([])
  expect(stores.stats.get().totalCost).toBe(0)
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
    'message-end',
    'snapshot',
    'status',
    FOLLOW_ENDED_CUSTOM_EVENT,
  ]) {
    for (const value of malformed) {
      expect(() => route(eventType, value)).not.toThrow()
    }
  }
  expect(stores.stats.get().totalCost).toBe(0)
  expect(stores.dialog.get()).toBeUndefined()
  // the one chunk whose value is not read: follow-ended says its piece whatever it carries
  expect(notificationMessages().every((message) => message.includes('the connection to the server ended'))).toBe(true)
})

// ⚠ THE REASON THE ROUTER TAKES ITS STORES. TanStack hands `onCustomEvent` no thread id;
// each pane's factory closes over its own stores, so a chunk routed through one thread's
// callback must land in that thread and no other.
test("⚠ a chunk routed to one thread never touches another thread's stores", () => {
  const other = mintThread()
  observe({
    kind: 'message-end',
    role: 'assistant',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
  })
  observe({ kind: 'permission-mode', mode: 'plan', available: ['plan'] })
  expect(stores.stats.get().totalCost).toBe(0.5)
  expect(other.stats.get().totalCost).toBe(0)
  expect(other.permissionMode.get().mode).toBeUndefined()
  expect(other.recentChunks.get()).toEqual([])
})
