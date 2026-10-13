import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_PERMISSION_DENIAL_ENTRY,
  ENSO_NOTICE_SOURCE,
  ENSO_RUN_STOPPED_ENTRY,
  ENSO_SESSION_RISK_ENTRY,
  type EnsoDialogSpec,
  type EnsoFollowSnapshot,
  type EnsoIncidentOpened,
  type EnsoIncidentResolved,
  type EnsoFollowStatus,
  type EnsoModelState,
  type EnsoObservation,
  type EnsoThreadHistory,
  type EnsoSessionUsage,
  NO_SESSION_INCIDENTS,
} from '@enso/core'
import { FOLLOW_ENDED_CUSTOM_EVENT, RUN_STOPPED_NOTICE, routeEnsoCustomEvent } from '../custom-event-router.ts'
import type { EnsoNotification } from '../notifications.tsx'
import { adoptThread, clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'

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
  sessionRisk: { level: 'low', signals: 0 },
  incidents: NO_SESSION_INCIDENTS,
  model: null,
  systemPrompt: null,
  cwd: '/work/project',
  tree: false,
  messageCount: 0,
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

test("a cold snapshot's recordedModel rides beside the live store, never in it; a live snapshot without one clears it (#434)", () => {
  const recorded = { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'medium' }
  route('snapshot', snapshot({ model: null, recordedModel: recorded }))
  expect(stores.model.get()).toBeNull()
  expect(stores.model.recorded.get()).toEqual(recorded)
  route('snapshot', snapshot({ model: LIVE_MODEL }))
  expect(stores.model.get()).toEqual(LIVE_MODEL)
  expect(stores.model.recorded.get()).toBeNull()
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

// #551, PR #561 review: the page offers a restore only on a thread with a tree to restore — the
// snapshot says which, and a later one replaces it.
test("the snapshot's tree says whether the thread has files to restore, replaced by every later snapshot", () => {
  expect(stores.tree.get()).toBe(false)
  route('snapshot', snapshot({ tree: true }))
  expect(stores.tree.get()).toBe(true)
  route('snapshot', snapshot({ tree: false }))
  expect(stores.tree.get()).toBe(false)
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

// #387, live: a refusal's entry is the one thing that says a call was refused rather than
// failed. The guard's and the engine's (#523) both land in the thread's refusals by call id, as
// who refused; an entry that is another extension's, malformed, or an engine refusal naming no
// call (a mode probe's) marks nothing.
// @pins guarded-tool-call/denial-entry
test('a refusal custom-entry marks its call refused, naming who; any other entry marks nothing (#387, #523)', () => {
  observe({
    kind: 'custom-entry',
    customType: ENSO_GUARD_DENIAL_ENTRY,
    data: { toolCallId: 'c1', rule: 'network-egress' },
  })
  observe({ kind: 'custom-entry', customType: 'modes', data: { toolCallId: 'c2', rule: 'network-egress' } })
  observe({ kind: 'custom-entry', customType: ENSO_GUARD_DENIAL_ENTRY, data: { toolCallId: 'c3', rule: 'curl' } })
  const engine = { requestId: 'r', surface: 'bash', value: 'rm -rf x' }
  observe({
    kind: 'custom-entry',
    customType: ENSO_PERMISSION_DENIAL_ENTRY,
    data: { ...engine, toolCallId: 'c4', resolution: 'user_denied' },
  })
  observe({
    kind: 'custom-entry',
    customType: ENSO_PERMISSION_DENIAL_ENTRY,
    data: { ...engine, toolCallId: 'c5', resolution: 'policy_deny' },
  })
  observe({
    kind: 'custom-entry',
    customType: ENSO_PERMISSION_DENIAL_ENTRY,
    data: { ...engine, toolCallId: 'c6', resolution: 'authorizer_denied' },
  })
  observe({
    kind: 'custom-entry',
    customType: ENSO_PERMISSION_DENIAL_ENTRY,
    data: { ...engine, resolution: 'user_denied' },
  })
  expect([...stores.refusals.get()]).toEqual([
    ['c1', { by: 'guard', rule: 'network-egress' }],
    ['c4', { by: 'operator' }],
    ['c5', { by: 'rule' }],
    ['c6', { by: 'auto' }],
  ])
  expect(notificationMessages()).toEqual([])
})

// #766: a stopped run settled exactly like a finished one. The host's `enso-run-stopped` entry is
// what says it, live: one Enso line where the run stopped. A finished run's settle says nothing.
const STOPPED_ENTRY: EnsoObservation = { kind: 'custom-entry', customType: ENSO_RUN_STOPPED_ENTRY, data: {} }
const stopLines = (on: ThreadStores = stores): EnsoNotification[] =>
  on.notifications.get().filter((notification) => notification.message === RUN_STOPPED_NOTICE)

test('a stopped run’s entry is one Enso line; a finished run’s settle is none (#766)', () => {
  observe({ kind: 'settled', aborted: false })
  expect(stopLines()).toEqual([])
  observe(STOPPED_ENTRY)
  expect(stopLines()).toEqual([
    expect.objectContaining({ message: 'Stopped.', notifyType: 'info', origin: 'run', source: ENSO_NOTICE_SOURCE }),
  ])
  // A reconnect's snapshot lists the same stop off the branch: it is not said twice.
  route('snapshot', snapshot({ stoppedAfter: ['a1'] }))
  expect(stopLines()).toHaveLength(1)
})

const STOPPED_HISTORY: EnsoThreadHistory = {
  threadId: 'stopped-thread',
  projectId: 'p1',
  messages: [
    { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'go' }] },
    { id: 'a1', role: 'assistant', parts: [] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', content: 'again' }] },
    { id: 'a2', role: 'assistant', parts: [{ type: 'text', content: 'done' }] },
  ],
  permissionMode: { mode: 'default', available: ['default'] },
  sessionRisk: { level: 'low', signals: 0 },
  incidents: NO_SESSION_INCIDENTS,
  stoppedAfter: ['a1'],
}

// #766, reloaded: the server reads each stop off the branch as the message it follows. The adopted
// thread says it after that message, as the live line did; the follow's first snapshot lists the
// same stop and says nothing more, and a stop made while the page was away is said once.
test('a reloaded thread says each stop after its message, once, whatever the snapshots repeat (#766)', () => {
  const adopted = adoptThread(STOPPED_HISTORY)
  expect(stopLines(adopted).map((line) => [line.after, line.source])).toEqual([['a1', ENSO_NOTICE_SOURCE]])
  routeEnsoCustomEvent(adopted, 'snapshot', snapshot({ threadId: 'stopped-thread', stoppedAfter: ['a1'] }))
  expect(stopLines(adopted)).toHaveLength(1)
  routeEnsoCustomEvent(adopted, 'snapshot', snapshot({ threadId: 'stopped-thread', stoppedAfter: ['a1', 'a2'] }))
  expect(stopLines(adopted).map((line) => line.after)).toEqual(['a1', 'a2'])
})

// #464: the session's risk, seeded by the snapshot (the server's replay) and raised live by the
// guard's entry — the one store the status bar reads.
test("the snapshot seeds the session's risk and the guard's risk entry raises it; a malformed one moves nothing", () => {
  route('snapshot', snapshot({ sessionRisk: { level: 'medium', signals: 1 } }))
  expect(stores.sessionRisk.get()).toEqual({ level: 'medium', signals: 1 })
  observe({ kind: 'custom-entry', customType: ENSO_SESSION_RISK_ENTRY, data: { level: 'high', signals: 3 } })
  expect(stores.sessionRisk.get()).toEqual({ level: 'high', signals: 3 })
  observe({ kind: 'custom-entry', customType: ENSO_SESSION_RISK_ENTRY, data: { level: 'severe', signals: 9 } })
  expect(stores.sessionRisk.get()).toEqual({ level: 'high', signals: 3 })
  expect(notificationMessages().filter((message) => !message.startsWith('Mode: '))).toEqual([])
})

// #466: the incidents, folded live by the same step the server runs — an opening, then a human's
// resolution — and resynced whole by every snapshot.
const OPENED: EnsoIncidentOpened = {
  incidentId: 'inc-1',
  signals: [{ signal: 'denial-retry', toolCallId: 'c4', detail: 'retried a refused command', after: ['c2'] }],
  halted: true,
  suspended: ['execute', 'network', 'write'],
}

test("the guard's opening folds into the thread's incidents live, and a resolution keeps only what it restricts and starts the risk over", () => {
  observe({ kind: 'custom-entry', customType: ENSO_SESSION_RISK_ENTRY, data: { level: 'incident', signals: 4 } })
  observe({ kind: 'custom-entry', customType: ENSO_INCIDENT_OPENED_ENTRY, data: OPENED })
  expect(stores.incidents.get()).toEqual({
    incidents: [{ opened: OPENED, resolutions: [] }],
    suspended: ['execute', 'network', 'write'],
    ended: false,
  })
  const resolved: EnsoIncidentResolved = {
    incidentId: 'inc-1',
    classification: 'agent-error',
    outcome: 'resume-with-restrictions',
    suspended: ['network'],
  }
  observe({ kind: 'custom-entry', customType: ENSO_INCIDENT_RESOLVED_ENTRY, data: resolved })
  expect(stores.incidents.get()).toEqual({
    incidents: [{ opened: OPENED, resolutions: [resolved] }],
    suspended: ['network'],
    ended: false,
  })
  expect(stores.sessionRisk.get()).toEqual({ level: 'low', signals: 0 })
})

test("the snapshot's incidents replace the live fold — a resolution recorded while the page was away lands too", () => {
  const open = { incidents: [{ opened: OPENED, resolutions: [] }], suspended: OPENED.suspended, ended: false }
  route('snapshot', snapshot({ incidents: open }))
  expect(stores.incidents.get()).toEqual(open)
  const ended = {
    incidents: [
      {
        opened: OPENED,
        resolutions: [
          {
            incidentId: 'inc-1',
            classification: 'confirmed-bypass' as const,
            outcome: 'end-thread' as const,
            suspended: OPENED.suspended,
          },
        ],
      },
    ],
    suspended: OPENED.suspended,
    ended: true,
  }
  route('snapshot', snapshot({ incidents: ended }))
  expect(stores.incidents.get()).toEqual(ended)
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

// @pins dialog-ask-answer-settled/settle-per-id
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

// #387: every line says who acted. An extension's notice carries the sender the host tagged it
// with; the page's own lines — the connection, a busy thread — say Enso; a notice nobody tagged
// says nothing rather than a guess.
test('a notice carries its sender as the line’s source; Enso’s own lines say Enso; an untagged one says none (#387)', () => {
  observe({
    kind: 'extension-ui-request',
    id: '',
    method: 'notify',
    blocking: false,
    origin: 'run',
    message: 'no recoverable account is available',
    notifyType: 'warning',
    sender: 'probe-extension',
  })
  observe({ kind: 'extension-ui-request', id: '', method: 'notify', blocking: false, origin: 'run', message: 'x' })
  route(FOLLOW_ENDED_CUSTOM_EVENT, { threadId: 't1' })
  expect(stores.notifications.get().map((line) => line.source)).toEqual(['probe-extension', undefined, 'Enso'])
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

// @pins follow-snapshot-frames/snapshot-lists-complete
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
  providerName: 'Anthropic',
  model: 'claude-sonnet-4-5',
  ...(status === undefined ? {} : { status }),
  message,
})

// The acceptance's three: a 429, a 401 and a 400 must read as three different things — what to do
// about each differs (wait, log in, change the model), so a person must be able to tell them apart.
test('a 429, a 401 and a 400 are three distinct transcript lines and status words, each with the provider’s sentence', () => {
  const seen: Array<{ source: string | undefined; line: string | undefined; word: string | undefined }> = []
  for (const [status, message] of [
    [429, '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}'],
    [401, '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
    [
      400,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.259 does not support this model"}}',
    ],
  ] as const) {
    observe(refusal(status, message))
    seen.push({
      source: stores.notifications.get().at(-1)?.source,
      line: notificationMessages().at(-1),
      word: stores.refusal.get()?.refusalClass,
    })
  }
  // Who refused leads each line (#387) — the provider's display name, so the class word is never
  // read as an Enso policy.
  expect(seen).toEqual([
    {
      source: 'Anthropic',
      line: 'claude-sonnet-4-5 refused: rate-limited (429) — rate limit exceeded',
      word: 'rate-limited',
    },
    {
      source: 'Anthropic',
      line: 'claude-sonnet-4-5 refused: not logged in (401) — invalid x-api-key',
      word: 'not logged in',
    },
    {
      source: 'Anthropic',
      line: 'claude-sonnet-4-5 refused: model refused (400) — Claude Code 2.1.259 does not support this model',
      word: 'model refused',
    },
  ])
  expect(stores.notifications.get().at(-1)).toMatchObject({ notifyType: 'error', origin: 'run' })
})

// pi retries the request the provider just refused, so the retry line names that provider (#387) —
// the retry itself carries none.
test('pi’s retry is its own line: when, which attempt of how many, and the provider it retries', () => {
  observe(refusal(429, '429 rate limited'))
  observe({ kind: 'provider-retry', attempt: 2, maxAttempts: 4, delayMs: 4000 })
  observe({ kind: 'provider-retry', attempt: 1, maxAttempts: 3, delayMs: 500 })
  const retries = stores.notifications.get().slice(1)
  expect(retries.map((line) => line.message)).toEqual([
    'retrying in 4 s — attempt 2 of 4',
    'retrying in 500 ms — attempt 1 of 3',
  ])
  expect(retries.map((line) => line.source)).toEqual(['Anthropic', 'Anthropic'])
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
  expect(stores.refusal.get()).toEqual({
    refusalClass: 'rate-limited',
    provider: 'Anthropic',
    outputAtRefusal: SPENT.output,
  })
  observe({ kind: 'session-usage', ...SPENT, output: SPENT.output + 12 })
  expect(stores.refusal.get()).toBeUndefined()
})

// #384: a refusal MID-STREAM comes after the model wrote some — 178 tokens in the live case — and the
// turn's usage, said after the refusal, counts them. That growth is the refused attempt's own, not a
// reply getting through: the word must stay until output grows past the attempt too.
test('⚠ a refusal after streamed text keeps its word through the turn’s usage, which counts the refused attempt’s own output', () => {
  observe({ kind: 'session-usage', ...SPENT })
  observe({
    kind: 'provider-refused',
    provider: 'anthropic',
    model: 'claude-opus-5',
    providerStopReason: 'refusal',
    output: 178,
    message:
      'This request triggered restrictions on violative cyber content and was blocked under Anthropic’s Usage Policy.',
  })
  expect(notificationMessages().at(-1)).toBe(
    'claude-opus-5 refused: provider policy — This request triggered restrictions on violative cyber content and was blocked under Anthropic’s Usage Policy.',
  )
  // A refusal pi names no display name for still says who refused — by its id.
  expect(stores.notifications.get().at(-1)?.source).toBe('anthropic')
  observe({ kind: 'session-usage', ...SPENT, output: SPENT.output + 178 })
  expect(stores.refusal.get()?.refusalClass).toBe('provider policy')
  observe({ kind: 'session-usage', ...SPENT, output: SPENT.output + 178 + 5 })
  expect(stores.refusal.get()).toBeUndefined()
})

// #381: the word lived only in the page's stores, so a reload lost it and the status bar read
// `idle · $0.0000` again. The snapshot says the refusal the branch's last reply is — the server read
// it off pi's stored attempt (#739: the snapshot no longer carries the branch) — and that is the
// resync. A refusal a reply came after is history, not state: the server sends none then.
const REFUSED = { provider: 'anthropic', status: 401, message: '401 invalid x-api-key' }

// @pins resume/transcript-ours
test('a snapshot whose last reply is a refused attempt shows the word; one with a reply after it clears it (#381)', () => {
  route('snapshot', snapshot({ usage: SPENT, messageCount: 3, trailingRefusal: REFUSED }))
  expect(stores.refusal.get()).toEqual({
    refusalClass: 'not logged in',
    provider: 'anthropic',
    outputAtRefusal: SPENT.output,
  })
  // the mark is the snapshot's output: a later reply's usage clears it as a live one would
  observe({ kind: 'session-usage', ...SPENT, output: SPENT.output + 1 })
  expect(stores.refusal.get()).toBeUndefined()

  route('snapshot', snapshot({ messageCount: 1, trailingRefusal: REFUSED }))
  route('snapshot', snapshot({ messageCount: 3 }))
  expect(stores.refusal.get()).toBeUndefined()
  // and the snapshot adds no transcript line: the attempt's own bubble says it
  expect(noticesBesideModeLines()).toEqual([])
})
