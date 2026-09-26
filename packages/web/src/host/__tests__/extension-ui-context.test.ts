import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { type EnsoQuestionnaireResult, QUESTIONNAIRE_COMPONENT_KEY } from '@enso/core'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import {
  type CustomComponentFactory,
  createEnsoExtensionUiContext,
  type EnsoExtensionUiContext,
} from '../extension-ui-context.ts'
import { PICC_PERMISSION_DIALOG_MODULE } from '../permission-dialog.ts'
import type { RuntimeEvent } from '../runtime-event.ts'

/**
 * The `ExtensionUIContext` the host binds (#69), driven directly: the blocking methods
 * become `extension_ui_request` records and resolve on an answer, a cancel, an abort
 * signal or a timeout; the fire-and-forget methods emit and return; the terminal-only
 * surface is inert — pi's rpc mode's behaviour, which extensions already tolerate.
 */

/** picc's `createFilePermissionDialogFactory(opts)` — the value it hands `ctx.ui.custom`. */
type PermissionFactoryBuilder = (options: Record<string, unknown>) => CustomComponentFactory<string | null>

let logs: LogRecorder
let createFilePermissionDialogFactory: PermissionFactoryBuilder
beforeAll(async () => {
  logs = await recordEnsoLogs()
  // Runtime import, as the host does it: picc's sources must not enter this package's type graph.
  const loaded = (await import(PICC_PERMISSION_DIALOG_MODULE)) as {
    createFilePermissionDialogFactory: PermissionFactoryBuilder
  }
  createFilePermissionDialogFactory = loaded.createFilePermissionDialogFactory
})
beforeEach(() => logs.clear())
afterAll(releaseEnsoLogs)

const THREAD = 't-ui'

function contextUnderTest(): EnsoExtensionUiContext & { events: RuntimeEvent[]; requests: RuntimeEvent[] } {
  /** Every record the host emits — requests, settles (#114), fire-and-forget. */
  const events: RuntimeEvent[] = []
  /** The blocking/notify requests alone, so a test can name "the second question" without counting settles. */
  const requests: RuntimeEvent[] = []
  const context = createEnsoExtensionUiContext({
    emit: (event: RuntimeEvent) => {
      events.push(event)
      if (event.type === 'extension_ui_request') requests.push(event)
    },
    threadId: THREAD,
  })
  return { ...context, events, requests }
}

const requestId = (event: RuntimeEvent | undefined): string => String(event?.id)
/** The settle records (#114), as `{ id, outcome }` — what the follow's `dialog-settled` observation carries. */
const settles = (events: RuntimeEvent[]): Array<{ id: unknown; outcome: unknown }> =>
  events.filter((event) => event.type === 'extension_ui_settled').map(({ id, outcome }) => ({ id, outcome }))

test('select emits a request and resolves to the answered value', async () => {
  const { uiContext, answerDialog, requests, pendingDialogCount } = contextUnderTest()
  const pending = uiContext.select('Mode?', ['ask', 'auto'])
  expect(requests[0]).toMatchObject({
    type: 'extension_ui_request',
    method: 'select',
    title: 'Mode?',
    options: ['ask', 'auto'],
  })
  expect(pendingDialogCount()).toBe(1)
  answerDialog({ id: requestId(requests[0]), value: 'auto' })
  expect(await pending).toBe('auto')
  expect(pendingDialogCount()).toBe(0)
})

test("openDialogs lists the pending questions as the browser's dialog specs, oldest first, and nothing once settled (#112, #114)", async () => {
  const { uiContext, answerDialog, openDialogs, requests, events } = contextUnderTest()
  const first = uiContext.select('Mode?', ['ask', 'auto'], { timeout: 50_000 })
  const second = uiContext.confirm('Sure?', 'm')
  const [firstId, secondId] = [requestId(requests[0]), requestId(requests[1])]
  expect(openDialogs()).toEqual([
    { id: firstId, dialog: { method: 'select', title: 'Mode?', options: ['ask', 'auto'], timeout: 50_000 } },
    { id: secondId, dialog: { method: 'confirm', title: 'Sure?', message: 'm' } },
  ])
  answerDialog({ id: firstId, value: 'auto' })
  await first
  expect(openDialogs()).toEqual([{ id: secondId, dialog: { method: 'confirm', title: 'Sure?', message: 'm' } }])
  // The settle is a record on the same stream as the request, in order (#114): a second
  // follower learns the question is gone the same way it learned it was asked.
  expect(settles(events)).toEqual([{ id: firstId, outcome: 'answered' }])
  answerDialog({ id: secondId, cancelled: true })
  await second
  expect(openDialogs()).toEqual([])
  expect(settles(events)).toEqual([
    { id: firstId, outcome: 'answered' },
    { id: secondId, outcome: 'cancelled' },
  ])
})

test("confirm resolves true/false on the answer, and false on cancel — pi's cancel value", async () => {
  const { uiContext, answerDialog, requests } = contextUnderTest()
  const yes = uiContext.confirm('Apply?', 'It is reversible')
  answerDialog({ id: requestId(requests[0]), confirmed: true })
  expect(await yes).toBe(true)
  const cancelled = uiContext.confirm('Again?', 'm')
  answerDialog({ id: requestId(requests[1]), cancelled: true })
  expect(await cancelled).toBe(false)
})

test('input and editor resolve to the value, or undefined on cancel', async () => {
  const { uiContext, answerDialog, requests } = contextUnderTest()
  const typed = uiContext.input('Name?', 'placeholder')
  expect(requests[0]).toMatchObject({ method: 'input', title: 'Name?', placeholder: 'placeholder' })
  answerDialog({ id: requestId(requests[0]), value: 'enso' })
  expect(await typed).toBe('enso')
  const edited = uiContext.editor('Edit', 'prefill')
  expect(requests[1]).toMatchObject({ method: 'editor', title: 'Edit', prefill: 'prefill' })
  answerDialog({ id: requestId(requests[1]), cancelled: true })
  expect(await edited).toBeUndefined()
})

test('a wrong-shaped answer degrades to the cancel value rather than a wrong type', async () => {
  const { uiContext, answerDialog, requests } = contextUnderTest()
  const pending = uiContext.select('Pick', ['a'])
  // a `confirmed` answer to a select carries no value
  answerDialog({ id: requestId(requests[0]), confirmed: true })
  expect(await pending).toBeUndefined()
})

test("the caller's abort signal and timeout both resolve to the cancel value, each settled with its own reason (#114)", async () => {
  const { uiContext, requests, events, pendingDialogCount } = contextUnderTest()
  const controller = new AbortController()
  const aborted = uiContext.select('Pick', ['a'], { signal: controller.signal })
  controller.abort()
  expect(await aborted).toBeUndefined()
  const timedOut = uiContext.confirm('Slow?', 'm', { timeout: 5 })
  expect(requests[1]).toMatchObject({ method: 'confirm', timeout: 5 })
  expect(await timedOut).toBe(false)
  // an already-aborted signal short-circuits without even registering
  const preAborted = new AbortController()
  preAborted.abort()
  expect(await uiContext.input('x', undefined, { signal: preAborted.signal })).toBeUndefined()
  expect(pendingDialogCount()).toBe(0)
  // A question never asked is never settled: two settles, for the two requests, by reason.
  expect(settles(events)).toEqual([
    { id: requestId(requests[0]), outcome: 'aborted' },
    { id: requestId(requests[1]), outcome: 'timeout' },
  ])
})

test('cancelAllDialogs settles every pending dialog as cancelled; a second answer is reported, not applied', async () => {
  const { uiContext, answerDialog, cancelAllDialogs, requests, events } = contextUnderTest()
  const a = uiContext.select('A', ['x'])
  const b = uiContext.input('B')
  cancelAllDialogs()
  expect(await a).toBeUndefined()
  expect(await b).toBeUndefined()
  expect(settles(events).map((settle) => settle.outcome)).toEqual(['cancelled', 'cancelled'])
  answerDialog({ id: requestId(requests[0]), value: 'x' })
  expect(logs.records).toHaveLength(1)
  logs.assertLogged({
    level: 'warning',
    rawMessage: /^dialog answer for unknown request id/,
    properties: { threadId: THREAD, dialogId: requestId(requests[0]) },
  })
})

// The run's abort (Daniel, 2026-09-16: if the user says stop, it's stop): the same settle as
// teardown's, under the glossary's word for it. A dialog whose extension passed its own
// aborted signal is already gone by then and is not settled twice.
test('abortAllDialogs settles every pending dialog as aborted, each blocked call resolving to its cancel value, once', async () => {
  const { uiContext, abortAllDialogs, requests, events } = contextUnderTest()
  const a = uiContext.confirm('A?', 'm')
  const b = uiContext.select('B', ['x', 'y'])
  // picc's permission prompt, exactly as it asks it — lifted to a select on the same pending map (#73)
  const permission = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT), { overlay: true })
  await untilEmitted(requests, 3)
  abortAllDialogs()
  expect(await a).toBe(false)
  expect(await b).toBeUndefined()
  // picc reads `choice === "Yes"`; the cancel value is not "Yes", so the tool is denied
  expect(await permission).toBeUndefined()
  expect(settles(events).map((settle) => settle.outcome)).toEqual(['aborted', 'aborted', 'aborted'])
  abortAllDialogs()
  expect(settles(events)).toHaveLength(3)
})

// The stop's window (#376 review): a question asked while a stopped run winds down resolves to its
// cancel value at once and shows nothing — a tool that ignores the abort and asks again must not
// open a card the stop then waits on. The window closes when the stop settles, rejected or not.
test('refuseDialogsUntil refuses questions until the stop settles — cancel value, no request, no settle — then asks again', async () => {
  const { uiContext, refuseDialogsUntil, events, requests, pendingDialogCount } = contextUnderTest()
  const stopping = Promise.withResolvers<void>()
  refuseDialogsUntil(stopping.promise)
  expect(await uiContext.confirm('Include lint?', '')).toBe(false)
  expect(await uiContext.select('Pick', ['a', 'b'])).toBeUndefined()
  expect(events).toEqual([])
  expect(pendingDialogCount()).toBe(0)

  stopping.reject(new Error('the runtime would not stop'))
  await Promise.resolve()
  void uiContext.confirm('Next run?', '')
  await untilEmitted(requests, 1)
  expect(requests).toHaveLength(1)
  expect(pendingDialogCount()).toBe(1)
})

// A dialog whose extension passed its OWN signal, already fired, is settled by that signal
// (`aborted`, once) and is not on the pending map when the run's abort sweeps — never twice.
test('a dialog already settled by its own abort signal is skipped by abortAllDialogs, not settled again', async () => {
  const { uiContext, abortAllDialogs, requests, events, pendingDialogCount } = contextUnderTest()
  const own = new AbortController()
  const withSignal = uiContext.input('Name?', undefined, { signal: own.signal })
  const without = uiContext.input('Other?')
  await untilEmitted(requests, 2)
  own.abort()
  expect(await withSignal).toBeUndefined()
  expect(pendingDialogCount()).toBe(1)
  abortAllDialogs()
  expect(await without).toBeUndefined()
  expect(settles(events).map((settle) => [settle.id, settle.outcome])).toEqual([
    [requestId(requests[0]), 'aborted'],
    [requestId(requests[1]), 'aborted'],
  ])
})

test('fire-and-forget methods emit the rpc-shaped record and return immediately', () => {
  const { uiContext, events } = contextUnderTest()
  uiContext.notify('hello', 'warning')
  uiContext.setStatus('quota', '50%')
  uiContext.setWidget('w', ['line 1', 'line 2'], { placement: 'belowEditor' })
  // a component FACTORY has no serialisable form — pi's rule too — so it emits nothing
  uiContext.setWidget('ignored', () => ({ render: () => [], invalidate: () => undefined }))
  uiContext.setTitle('enso')
  uiContext.setEditorText('draft')
  expect(events.map((event) => event.method)).toEqual([
    'notify',
    'setStatus',
    'setWidget',
    'setTitle',
    'set_editor_text',
  ])
  expect(events[0]).toMatchObject({ message: 'hello', notifyType: 'warning' })
  expect(events[2]).toMatchObject({
    widgetKey: 'w',
    widgetLines: ['line 1', 'line 2'],
    widgetPlacement: 'belowEditor',
  })
  expect(events[4]).toMatchObject({ text: 'draft' })
})

test("the terminal-only surface is inert, exactly as in pi's rpc mode", async () => {
  const { uiContext, events } = contextUnderTest()
  expect(uiContext.onTerminalInput(() => undefined)()).toBeUndefined()
  uiContext.setWorkingMessage('x')
  uiContext.setWorkingVisible(true)
  uiContext.setWorkingIndicator()
  uiContext.setHiddenThinkingLabel('x')
  uiContext.setFooter(undefined)
  uiContext.setHeader(undefined)
  uiContext.pasteToEditor('x')
  uiContext.addAutocompleteProvider((current) => current)
  uiContext.setEditorComponent(undefined)
  uiContext.setToolsExpanded(true)
  expect(await uiContext.custom(() => ({ render: () => [], invalidate: () => undefined }))).toBeUndefined()
  expect(uiContext.getEditorText()).toBe('')
  expect(uiContext.getEditorComponent()).toBeUndefined()
  expect(uiContext.getAllThemes()).toEqual([])
  expect(uiContext.getTheme('any')).toBeUndefined()
  expect(uiContext.setTheme('any').success).toBe(false)
  expect(uiContext.getToolsExpanded()).toBe(false)
  // the theme getter returns a real Theme, built once
  expect(uiContext.theme.getColorMode()).toBe('256color')
  expect(uiContext.theme).toBe(uiContext.theme)
  // none of that emitted anything
  expect(events).toEqual([])
})

// ── picc's permission prompt, through `custom` (#73) ─────────────────────────

/** Drain microtasks until `count` records exist — the lift awaits a cached module promise, so depth is not one tick. */
async function untilEmitted(events: RuntimeEvent[], count: number): Promise<void> {
  for (let drained = 0; drained < 100 && events.length < count; drained += 1) await Promise.resolve()
}

const WRITE_PROMPT = {
  options: ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No'],
  title: 'Create file',
  subtitle: 'receipt-73.txt',
  question: 'Do you want to create this file: receipt-73.txt?',
  previewLines: ['ok'],
  showPanel: true,
}

test("⚠⚠ picc's permission prompt reaches the browser as a select with its options and detail, and the answer is the option string", async () => {
  const { uiContext, answerDialog, requests, pendingDialogCount } = contextUnderTest()
  // Exactly picc's call: `ctx.ui.custom<FilePermissionChoice>(createFilePermissionDialogFactory(opts), {overlay…})`.
  const pending = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT), { overlay: true })
  await untilEmitted(requests, 1) // the factory and the lift are awaited before the request is emitted
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    type: 'extension_ui_request',
    method: 'select',
    title: 'Create file',
    options: WRITE_PROMPT.options,
  })
  expect(String(requests[0]?.message)).toContain('Do you want to create this file: receipt-73.txt?')
  expect(String(requests[0]?.message)).toContain('ok')
  expect(pendingDialogCount()).toBe(1)
  answerDialog({ id: requestId(requests[0]), value: 'Yes' })
  // picc's own check is `choice === "Yes"` — the string it offered, back verbatim.
  expect(await pending).toBe('Yes')
  expect(pendingDialogCount()).toBe(0)
})

test("cancelling the lifted prompt resolves picc's 'dismissed' value; a non-picc component still resolves undefined at once", async () => {
  const { uiContext, answerDialog, cancelAllDialogs, requests } = contextUnderTest()
  const dismissed = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT))
  await untilEmitted(requests, 1)
  answerDialog({ id: requestId(requests[0]), cancelled: true })
  expect(await dismissed).toBeUndefined()
  // teardown while a prompt is open: the extension is released, not left hanging
  const torn = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT))
  await untilEmitted(requests, 2)
  cancelAllDialogs()
  expect(await torn).toBeUndefined()
  // and pi's rpc contract for anything else is untouched: no request, undefined
  const before = requests.length
  expect(await uiContext.custom(() => ({ render: () => [], invalidate: () => undefined }))).toBeUndefined()
  expect(requests).toHaveLength(before)
})

// ⚠ The catch that exists so a picc module that fails to load can never silently reopen #73:
// the extension is released with "dismissed", the operator is told why, no request is emitted.
test("⚠ a lift that rejects (picc's module did not load) fails closed: undefined to the extension, an error logged, no request", async () => {
  const events: RuntimeEvent[] = []
  const { uiContext } = createEnsoExtensionUiContext({
    emit: (event: RuntimeEvent) => events.push(event),
    threadId: THREAD,
    liftDialog: () => Promise.reject(new Error('Cannot find module filePermissionDialog.ts')),
  })
  const answer = await uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT))
  expect(answer).toBeUndefined()
  expect(events).toEqual([])
  expect(logs.records).toHaveLength(1)
  logs.assertLogged({
    level: 'error',
    rawMessage: /#73/,
    properties: (properties: Readonly<Record<string, unknown>>) =>
      properties.threadId === THREAD && String(properties.error).includes('Cannot find module'),
  })
})

test('a factory that resolves no component degrades to undefined instead of throwing on dispose', async () => {
  const { uiContext, events } = contextUnderTest()
  // Outside the declared type on purpose: a buggy extension, not a typed caller.
  const noComponent = (() => undefined) as unknown as CustomComponentFactory<unknown>
  expect(await uiContext.custom(noComponent)).toBeUndefined()
  expect(events).toEqual([])
})

// ⚠ pi's rpc mode never ran the factory, so every non-picc factory used to get `undefined` at
// once. Building against the inert terminal must not take that away (Codex, PR #107): a factory
// that throws, rejects, or never produces a component falls back the same way, with a report.
test('⚠ a factory that throws or rejects against the inert terminal falls back to undefined, reported, no request', async () => {
  const { uiContext, events } = contextUnderTest()
  const throwing = (() => {
    throw new Error('tui.requestRender is not a function')
  }) as unknown as CustomComponentFactory<unknown>
  expect(await uiContext.custom(throwing)).toBeUndefined()
  const rejecting = (() => Promise.reject(new Error('no terminal'))) as unknown as CustomComponentFactory<unknown>
  expect(await uiContext.custom(rejecting)).toBeUndefined()
  expect(events).toEqual([])
  expect(
    logs.filter({ level: 'warning', rawMessage: /resolving undefined/, properties: { threadId: THREAD } }),
  ).toHaveLength(2)
  expect(logs.records).toHaveLength(2)
})

test('⚠ an async factory that never produces a component is cut off at the build budget, not awaited forever', async () => {
  const events: RuntimeEvent[] = []
  const { uiContext } = createEnsoExtensionUiContext({
    emit: (event: RuntimeEvent) => events.push(event),
    threadId: THREAD,
    // The code's own timer with a tiny budget — the test awaits the promise it exposes, not a sleep.
    componentBuildTimeoutMs: 1,
  })
  const waitingOnATerminal = (() => new Promise(() => undefined)) as unknown as CustomComponentFactory<unknown>
  expect(await uiContext.custom(waitingOnATerminal)).toBeUndefined()
  expect(events).toEqual([])
  logs.assertLogged({
    level: 'warning',
    properties: (properties: Readonly<Record<string, unknown>>) =>
      String(properties.error).includes('no component within 1 ms'),
  })
})

test('a component whose dispose() throws is reported, not propagated — the call still resolves undefined', async () => {
  const { uiContext } = contextUnderTest()
  const component = {
    render: () => [],
    invalidate: () => undefined,
    dispose: () => {
      throw new Error('dispose exploded')
    },
  }
  expect(await uiContext.custom(() => component)).toBeUndefined()
  logs.assertLogged({
    level: 'warning',
    rawMessage: /dispose\(\) threw/,
    properties: (properties: Readonly<Record<string, unknown>>) =>
      properties.threadId === THREAD && String(properties.error).includes('dispose exploded'),
  })
})

test('a component that arrives after the build budget is disposed on arrival, since nobody will ever see it', async () => {
  const late = Promise.withResolvers<{ render: () => string[]; invalidate: () => void; dispose: () => void }>()
  let disposed = 0
  const { uiContext } = createEnsoExtensionUiContext({
    emit: () => undefined,
    threadId: THREAD,
    componentBuildTimeoutMs: 1,
  })
  expect(await uiContext.custom(() => late.promise)).toBeUndefined()
  late.resolve({
    render: () => [],
    invalidate: () => undefined,
    dispose: () => {
      disposed += 1
    },
  })
  await late.promise // the disposal is chained on this same promise, so it has run once this settles
  await Promise.resolve()
  expect(disposed).toBe(1)
})

// ── the ask_user questionnaire, lifted (#12) ─────────────────────────────────

/** A component as `ask_user` builds it: the questionnaire under the registered key, and whatever else it carries. */
function questionnaireComponent(carried: unknown): () => unknown {
  return () => ({
    [QUESTIONNAIRE_COMPONENT_KEY]: carried,
    render: (): string[] => [],
    invalidate: (): void => undefined,
  })
}

const ONE_QUESTION = {
  header: 'Database',
  question: 'Which database?',
  options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }],
  multiSelect: false,
}

// What the component carries rides to every follower as the question, so the lift takes the
// schema's fields and nothing else — at every level — and answers the tool with the answers.
test('a questionnaire component is asked as one questionnaire dialog of exactly its schema fields, and answered with the answers', async () => {
  const { uiContext, answerDialog, requests } = contextUnderTest()
  const carried = {
    title: 'Which database?',
    questions: [
      {
        ...ONE_QUESTION,
        stray: 'dropped',
        options: [{ label: 'Postgres', description: 'relational', stray: 1 }, { label: 'SQLite' }],
      },
    ],
    stray: 'dropped too',
  }
  const pending = uiContext.custom<EnsoQuestionnaireResult>(questionnaireComponent(carried) as never)
  await untilEmitted(requests, 1)
  const request = requests[0]
  if (request === undefined) throw new Error('no questionnaire was asked')
  const { id, type: _type, ...asked } = request
  expect(asked).toEqual({ method: 'questionnaire', title: 'Which database?', questions: [ONE_QUESTION] })
  answerDialog({ id: String(id), answers: [{ selected: ['SQLite'] }] })
  expect(await pending).toEqual({ answers: [{ selected: ['SQLite'] }] })
})

// `undefined` is the tool's signal that this host could not show the card — so a decline must be
// the explicit `{ cancelled: true }`, and a malformed questionnaire must be no dialog at all.
test('a declined questionnaire resolves { cancelled: true }; a malformed one, or one repeating a label, is never asked and resolves undefined', async () => {
  const { uiContext, answerDialog, requests } = contextUnderTest()
  const declined = uiContext.custom<EnsoQuestionnaireResult>(
    questionnaireComponent({ title: 'Q', questions: [ONE_QUESTION] }) as never,
  )
  await untilEmitted(requests, 1)
  answerDialog({ id: String(requests[0]?.id), cancelled: true })
  expect(await declined).toEqual({ cancelled: true })

  const malformed = uiContext.custom<EnsoQuestionnaireResult>(
    questionnaireComponent({ title: 'Q', questions: [] }) as never,
  )
  expect(await malformed).toBeUndefined()
  // A label listed twice is refused too: two rows sharing one value would render as one choice.
  const repeated = { ...ONE_QUESTION, options: [...ONE_QUESTION.options, { label: 'SQLite' }] }
  const twice = uiContext.custom<EnsoQuestionnaireResult>(
    questionnaireComponent({ title: 'Q', questions: [repeated] }) as never,
  )
  expect(await twice).toBeUndefined()
  expect(requests).toHaveLength(1)
})
