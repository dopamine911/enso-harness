import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ZenDialogSpec } from '@zen/core'
import { routeZenCustomEvent } from '../custom-event-router.ts'
import {
  ZEN_CUSTOM_EVENT_DIALOG,
  ZEN_CUSTOM_EVENT_DIALOG_SETTLED,
  ZEN_CUSTOM_EVENT_ENTRY,
  ZEN_CUSTOM_EVENT_FOLLOW_ENDED,
  ZEN_CUSTOM_EVENT_MODE,
  ZEN_CUSTOM_EVENT_NOTIFY,
  ZEN_CUSTOM_EVENT_OPEN_DIALOGS,
  ZEN_CUSTOM_EVENT_QUEUE,
  ZEN_CUSTOM_EVENT_RUN,
  ZEN_CUSTOM_EVENT_UNMAPPED,
  ZEN_CUSTOM_EVENT_USAGE,
} from '../rpc/custom-event-names.ts'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'

/**
 * #53 S1.3: the CUSTOM-chunk router was an inline closure no test reached — renaming
 * `zen.entry`, dropping the notify-type allowlist, or swapping the two `apply*` calls all
 * left the suite green. These drive the extracted function with a fresh thread's stores
 * (#90 PR 3) and read them back.
 */

let stores: ThreadStores
beforeEach(() => {
  stores = mintThread()
})
afterEach(() => clearThreadsForTest())

const route = (eventType: string, data: unknown): void => routeZenCustomEvent(stores, eventType, data)
const notificationMessages = (): string[] => stores.notifications.get().map((notification) => notification.message)

// ⚠ ONE RECEIPT, TWO VIEWS (#84, L3). The `zen.mode` receipt — at run start and on every
// mid-run change — is both state (the current-mode store) and history (the transcript
// line). Dropping either `apply*` call from the branch leaves the other view green, so both
// are read here.
test('zen.mode reaches BOTH the current-mode store and the mode-lines store', () => {
  route(ZEN_CUSTOM_EVENT_MODE, { mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
  expect(stores.permissionMode.get()).toEqual({ mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
  expect(notificationMessages()).toEqual(['Mode: acceptEdits'])
  // and it did NOT land in the stats store (the swap-the-two-apply-calls mutation)
  expect(stores.stats.get().totalCost).toBe(0)
})

// ⚠ THE BROWSER NO LONGER READS A VENDOR ENTRY (L3). A persisted `modes` entry still crosses
// as `zen.entry` (recorded, counted) but moves nothing: the mode arrives as `zen.mode`, said
// by the host. If this ever renders a line, a reader has learned the vendor's shape again.
test('zen.entry is recorded but renders nothing and moves no store', () => {
  route(ZEN_CUSTOM_EVENT_ENTRY, { kind: 'custom-entry', customType: 'modes', data: { mode: 'acceptEdits' } })
  expect(notificationMessages()).toEqual([])
  expect(stores.permissionMode.get().mode).toBeUndefined()
  expect(stores.recentChunks.get().map((chunk) => chunk.name)).toContain(ZEN_CUSTOM_EVENT_ENTRY)
})

test("zen.run sets the thread's run generation; a malformed value leaves the last one standing (#109)", () => {
  expect(stores.generation.get()).toBeUndefined()
  route(ZEN_CUSTOM_EVENT_RUN, { generation: 3 })
  expect(stores.generation.get()).toBe(3)
  route(ZEN_CUSTOM_EVENT_RUN, { generation: -1 })
  route(ZEN_CUSTOM_EVENT_RUN, { generation: '4' })
  route(ZEN_CUSTOM_EVENT_RUN, null)
  expect(stores.generation.get()).toBe(3)
  expect(notificationMessages()).toEqual([])
})

test("zen.dialog opens the thread's question; a malformed one opens nothing and says so (#112)", () => {
  route(ZEN_CUSTOM_EVENT_DIALOG, { id: 'd1', dialog: { method: 'confirm', title: 'Apply?', message: 'm' } })
  expect(stores.dialog.get()).toEqual({ id: 'd1', dialog: { method: 'confirm', title: 'Apply?', message: 'm' } })
  route(ZEN_CUSTOM_EVENT_DIALOG, { id: '', dialog: { method: 'select' } })
  expect(stores.dialog.get()?.id).toBe('d1')
  expect(notificationMessages()).toEqual([expect.stringContaining('could not read')])
})

const CONFIRM: ZenDialogSpec = { method: 'confirm', title: 'Apply?', message: 'm' }

test('zen.dialog-settled drops the card for ITS id and no other (#114)', () => {
  route(ZEN_CUSTOM_EVENT_DIALOG, { id: 'd1', dialog: CONFIRM })
  route(ZEN_CUSTOM_EVENT_DIALOG_SETTLED, { id: 'd0', outcome: 'answered' })
  expect(stores.dialog.get()?.id).toBe('d1')
  route(ZEN_CUSTOM_EVENT_DIALOG_SETTLED, { id: 'd1', outcome: 'timeout' })
  expect(stores.dialog.get()).toBeUndefined()
  // nothing shown: a settle for anything is nothing to do
  route(ZEN_CUSTOM_EVENT_DIALOG_SETTLED, { id: 'd1', outcome: 'answered' })
  expect(stores.dialog.get()).toBeUndefined()
  expect(notificationMessages()).toEqual([])
})

test('two questions open: a settle for the one NOT shown leaves the card; the snapshot then lists the survivor first (#114, PR #115 review)', () => {
  const SELECT: ZenDialogSpec = { method: 'select', title: 'Pick', options: ['a', 'b'] }
  route(ZEN_CUSTOM_EVENT_OPEN_DIALOGS, {
    open: [
      { id: 'first', dialog: CONFIRM },
      { id: 'second', dialog: SELECT },
    ],
  })
  expect(stores.dialog.get()?.id).toBe('first')
  // The second question settles elsewhere while the first is what this page shows.
  route(ZEN_CUSTOM_EVENT_DIALOG_SETTLED, { id: 'second', outcome: 'answered' })
  expect(stores.dialog.get()?.id).toBe('first')
  // The shown one settles: the slot clears; the next question is whatever the next snapshot lists.
  route(ZEN_CUSTOM_EVENT_DIALOG_SETTLED, { id: 'first', outcome: 'cancelled' })
  expect(stores.dialog.get()).toBeUndefined()
  route(ZEN_CUSTOM_EVENT_OPEN_DIALOGS, { open: [{ id: 'third', dialog: SELECT }] })
  expect(stores.dialog.get()).toEqual({ id: 'third', dialog: SELECT })
  expect(notificationMessages()).toEqual([])
})

test('zen.follow-ended is said where the human looks, as an error of this run (#103 receipt)', () => {
  route(ZEN_CUSTOM_EVENT_FOLLOW_ENDED, { threadId: 't1' })
  expect(notificationMessages()).toEqual([expect.stringContaining('the connection to the server ended')])
  expect(stores.notifications.get().at(-1)).toMatchObject({ notifyType: 'error', origin: 'run' })
})

// #119: the notice scrolls away; the status bar's own state must say it too. Only a live
// follow delivers a status frame, so `zen.run` is the honest "connected again".
test('zen.follow-ended marks the thread disconnected; the next zen.run clears it (#119)', () => {
  expect(stores.disconnected.get()).toBe(false)
  route(ZEN_CUSTOM_EVENT_FOLLOW_ENDED, { threadId: 't1' })
  expect(stores.disconnected.get()).toBe(true)
  // A malformed status frame is still a frame from a live follow.
  route(ZEN_CUSTOM_EVENT_RUN, { generation: 'x' })
  expect(stores.disconnected.get()).toBe(false)
})

test("zen.open-dialogs is the snapshot's complete list: it replaces the card, an empty list clears it, a malformed one is ignored (#114)", () => {
  route(ZEN_CUSTOM_EVENT_DIALOG, { id: 'stale', dialog: CONFIRM })
  route(ZEN_CUSTOM_EVENT_OPEN_DIALOGS, { open: [{ id: 'd2', dialog: CONFIRM }] })
  expect(stores.dialog.get()).toEqual({ id: 'd2', dialog: CONFIRM })
  route(ZEN_CUSTOM_EVENT_OPEN_DIALOGS, { open: 'nope' })
  expect(stores.dialog.get()?.id).toBe('d2')
  route(ZEN_CUSTOM_EVENT_OPEN_DIALOGS, { open: [] })
  expect(stores.dialog.get()).toBeUndefined()
  expect(notificationMessages()).toEqual([])
})

test("zen.queue is pi's whole queue, steering first; a malformed frame leaves the last list standing (#75)", () => {
  expect(stores.queue.get()).toEqual([])
  route(ZEN_CUSTOM_EVENT_QUEUE, {
    kind: 'queue',
    steering: ['stop at the tests'],
    followUp: ['then this', 'and this'],
  })
  expect(stores.queue.get()).toEqual(['stop at the tests', 'then this', 'and this'])
  route(ZEN_CUSTOM_EVENT_QUEUE, { kind: 'queue', steering: 'not a list' })
  expect(stores.queue.get()).toEqual(['stop at the tests', 'then this', 'and this'])
  route(ZEN_CUSTOM_EVENT_QUEUE, { kind: 'queue', steering: [], followUp: [] })
  expect(stores.queue.get()).toEqual([])
})

test('zen.usage reaches the thread-stats store and nothing else', () => {
  route(ZEN_CUSTOM_EVENT_USAGE, {
    kind: 'message-end',
    role: 'assistant',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
  })
  expect(stores.stats.get().totalCost).toBe(0.5)
  expect(notificationMessages()).toEqual([])
})

test('zen.notify pushes the message with each declared notify type', () => {
  for (const notifyType of ['info', 'warning', 'error'] as const) {
    route(ZEN_CUSTOM_EVENT_NOTIFY, { message: `m-${notifyType}`, notifyType })
  }
  expect(stores.notifications.get().map((notification) => notification.notifyType)).toEqual([
    'info',
    'warning',
    'error',
  ])
})

// #96: the origin is the host's tag, carried as-is; when it cannot be read the notice is
// shown OPEN (`run`), because the safe failure of a grouping rule is "not grouped".
test('zen.notify carries the origin into the store; an unreadable origin degrades to run, never to hidden', () => {
  route(ZEN_CUSTOM_EVENT_NOTIFY, { message: 'startup', notifyType: 'info', origin: 'session-start' })
  route(ZEN_CUSTOM_EVENT_NOTIFY, { message: 'during', notifyType: 'info', origin: 'run' })
  route(ZEN_CUSTOM_EVENT_NOTIFY, { message: 'untagged', notifyType: 'info' })
  route(ZEN_CUSTOM_EVENT_NOTIFY, { message: 'mistagged', notifyType: 'info', origin: 'elsewhere' })
  expect(stores.notifications.get().map((notification) => [notification.message, notification.origin])).toEqual([
    ['startup', 'session-start'],
    ['during', 'run'],
    ['untagged', 'run'],
    ['mistagged', 'run'],
  ])
})

test('an unrecognised notify type degrades to an untyped notification, never a drop', () => {
  route(ZEN_CUSTOM_EVENT_NOTIFY, { message: 'hello', notifyType: 'loud' })
  route(ZEN_CUSTOM_EVENT_NOTIFY, { message: 'plain' })
  expect(stores.notifications.get().map((notification) => [notification.message, notification.notifyType])).toEqual([
    ['hello', undefined],
    ['plain', undefined],
  ])
})

test('a chunk name this surface does not render falls through untouched', () => {
  route(ZEN_CUSTOM_EVENT_UNMAPPED, { type: 'some_future_event' })
  route('zen.entry-renamed', { customType: 'modes', data: { mode: 'plan' } })
  route('', { message: 'x' })
  expect(notificationMessages()).toEqual([])
  expect(stores.stats.get().totalCost).toBe(0)
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
  ]
  for (const eventType of [ZEN_CUSTOM_EVENT_NOTIFY, ZEN_CUSTOM_EVENT_ENTRY, ZEN_CUSTOM_EVENT_USAGE]) {
    for (const value of malformed) {
      expect(() => route(eventType, value)).not.toThrow()
    }
  }
  expect(notificationMessages()).toEqual([])
  expect(stores.stats.get().totalCost).toBe(0)
})

// ⚠ THE REASON THE ROUTER TAKES ITS STORES. TanStack hands `onCustomEvent` no thread id;
// each pane's factory closes over its own stores, so a chunk routed through one thread's
// callback must land in that thread and no other.
test("⚠ a chunk routed to one thread never touches another thread's stores", () => {
  const other = mintThread()
  route(ZEN_CUSTOM_EVENT_USAGE, {
    kind: 'message-end',
    role: 'assistant',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
  })
  route(ZEN_CUSTOM_EVENT_MODE, { mode: 'plan', available: ['plan'] })
  expect(stores.stats.get().totalCost).toBe(0.5)
  expect(other.stats.get().totalCost).toBe(0)
  expect(other.permissionMode.get().mode).toBeUndefined()
  expect(other.recentChunks.get()).toEqual([])
})
