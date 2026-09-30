import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  KeybindingsManager,
  Theme as PiTheme,
} from '@earendil-works/pi-coding-agent'
import { Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import {
  type DialogAnswer,
  type EnsoDialogLink,
  type EnsoDialogOutcome,
  type EnsoOpenDialog,
  type EnsoQuestion,
  type EnsoQuestionnaireResult,
  ensoLogger,
  isEnsoDialogSpec,
} from '@enso/core'
import { liftQuestionnaire } from './questionnaire-dialog.ts'
import type { RuntimeEvent } from './runtime-event.ts'

/** The factory `ExtensionUIContext.custom` receives, named so the method can be written without `Parameters<>`. */
export type CustomComponentFactory<T> = (
  tui: TUI,
  theme: PiTheme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>

/**
 * The `ExtensionUIContext` the web server hands to an in-process `AgentSession` (#69).
 *
 * WHY THIS OBJECT EXISTS
 * Over the rpc subprocess, an extension's `ctx.ui.confirm(...)` became an
 * `extension_ui_request` line on stdout and the answer an `extension_ui_response` line on
 * stdin — pi's rpc mode owned the pending-dialog map. In-process there is no wire: the host
 * IS the UI, so it implements the interface pi's extensions call and turns each call into
 * the SAME rpc-shaped record the browser pipeline already consumes (`map-events.ts`
 * `extension_ui_request`, the #27 dialog park in `session.ts`). Replicated from pi 0.87.1
 * `dist/modes/rpc/rpc-mode.js` `createExtensionUIContext` (MIT), which is the reference
 * for "a UI with no terminal".
 *
 * ⚠ `ctx.hasUI` IS `true` THE MOMENT ANY OBJECT IS BOUND — pi's runner compares against its
 * no-op context, not against `mode`. That is load-bearing for the permission engine: with
 * no UI it denies every ask (the #20 failure). So this object
 * must be bound on every session, and the blocking methods must genuinely block until a
 * human answers or the request is cancelled — never resolve a default eagerly.
 *
 * WHAT IS REAL AND WHAT IS A NO-OP
 * `select`/`confirm`/`input`/`editor` block on a pending map keyed by request id; the
 * permission engine asks through `select` and `input` (#496). `custom` builds the extension's
 * component and, when it is one this surface knows (#12: the `ask_user` questionnaire), lifts
 * it to a blocking dialog; any other component resolves `undefined`, pi's rpc contract.
 * `notify`, `setStatus`, `setWidget`, `setTitle`,
 * `setEditorText` emit fire-and-forget records (the mapper forwards `notify` and drops the
 * terminal-addressed rest, as before). Everything else is a terminal concern with no
 * browser equivalent and returns its inert value.
 */

/**
 * The blocking dialogs: the four pi's rpc protocol names, and the one that is ours — the
 * questionnaire a lifted `ask_user` component asks (#12). `map-events.ts` agrees (its
 * `DIALOG_UI_METHODS`).
 */
type BlockingDialogRequest =
  | { method: 'select'; title: string; options: string[]; message?: string; timeout?: number }
  | { method: 'confirm'; title: string; message: string; timeout?: number }
  | {
      method: 'input'
      title: string
      placeholder?: string
      secret?: true
      message?: string
      link?: EnsoDialogLink
      timeout?: number
    }
  | { method: 'editor'; title: string; prefill?: string }
  | { method: 'questionnaire'; title: string; questions: EnsoQuestion[] }

/** A questionnaire's non-answer: a real decline, never `undefined` — which means "not shown" (#12). */
const QUESTIONNAIRE_DECLINED: EnsoQuestionnaireResult = { cancelled: true }

/**
 * What a component factory is handed in place of a terminal. A factory may read
 * `tui.terminal.rows` to size a panel; nothing on the web path touches the keybindings.
 * Typed as pi's parameter types because that
 * is what the factory declares — the casts are the one place the "no terminal" fact meets
 * a terminal-shaped signature.
 */
const INERT_TUI = { terminal: { rows: 24, columns: 80 } } as unknown as TUI
const INERT_KEYBINDINGS = {} as unknown as KeybindingsManager

interface PendingDialog {
  resolve: (response: DialogAnswer) => void
  /** Settle as the RUN's abort (#162 flows: "if the user says stop, it's stop"): the cancel value, outcome `aborted`. */
  abort: () => void
  /** What was asked — the `extension_ui_request` minus its id — so an answer can be checked against it (#112). */
  request: BlockingDialogRequest
}

export interface EnsoExtensionUiContextOptions {
  /** Where every record goes — the host's event emitter, so records interleave with session events in order. */
  emit: (event: RuntimeEvent) => void
  /** The thread this context serves — on every record it writes. */
  threadId: string
  /** How long an ASYNC component factory may take to produce its component. Defaults to `CUSTOM_COMPONENT_BUILD_TIMEOUT_MS`; injectable for tests. */
  componentBuildTimeoutMs?: number
}

/**
 * The budget an async `custom` factory gets to construct its component (#73, PR #107
 * review). Construction is meant to be immediate — the questionnaire's factory is synchronous — but a
 * factory may legitimately return a promise (to load something), and one that instead
 * waits on terminal interaction would hang the extension forever against a TUI that will
 * never answer. Past the budget the call falls back to pi's rpc contract (`undefined`).
 */
const CUSTOM_COMPONENT_BUILD_TIMEOUT_MS = 2000

/**
 * What `confirm` answers for every non-answer outcome — cancel, abort, timeout. pi's own
 * contract, and the one dialog method whose "no answer" value is not `undefined`; declared
 * as `boolean` because the extension's `await` may equally see `true`.
 */
const CONFIRM_DISMISSED: boolean = false

const hostLog = ensoLogger('host', 'ui')

export interface EnsoExtensionUiContext {
  readonly uiContext: ExtensionUIContext
  /**
   * A notice with its sender (#387): what an extension's tagged context calls in place of
   * `notify` (`notice-sender.ts`), and what the host's own lines say themselves with, as `Enso`.
   */
  readonly notifyFrom: (sender: string, message: string, type?: 'info' | 'warning' | 'error') => void
  /** Deliver an answer. Unknown ids are reported, not thrown — the extension is not waiting on them. */
  readonly answerDialog: (response: DialogAnswer) => void
  /** Every pending question, oldest first, as the follow's snapshot lists them (#114). Empty once settled. */
  readonly openDialogs: () => EnsoOpenDialog[]
  /** Cancel every pending dialog — session teardown. Each blocked extension call resolves to its cancel value. */
  readonly cancelAllDialogs: () => void
  /**
   * Settle every pending dialog as the RUN's abort: each blocked call resolves to its cancel
   * value with outcome `aborted` — the glossary's word for exactly this, produced by no code
   * until Stop was made to stop. The asking extension need not have passed a signal.
   */
  readonly abortAllDialogs: () => void
  /**
   * Refuse every question asked before `settled` settles: it resolves at once to its cancel
   * value, outcome `aborted`, and no card is shown. For the window while a stopped run winds
   * down — a tool that asks from its `execute` and ignores the abort signal (ask_user's
   * multi-select loop asks the next option) would otherwise open a question after the stop,
   * and the stop would wait on it (#376 review).
   */
  readonly refuseDialogsUntil: (settled: Promise<unknown>) => void
  /** How many dialogs are blocked right now — observable state for tests and for the idle-timeout logic. */
  readonly pendingDialogCount: () => number
  /**
   * The HOST's own questions, lifted to an `input` dialog: a credential (#338 slice 3: pi's
   * `AuthPrompt.type: 'secret'`, masked by the browser) and a login's code (#388: with what to
   * paste and a link to the login page). Not on `uiContext` — pi's interface has no such method,
   * and an extension must not be able to ask a masked question the transcript then fails to show,
   * or put a link on the card. Same wait, same settle record, same cancel value as `input`.
   */
  readonly askHostInput: (question: HostInputQuestion, signal: AbortSignal | undefined) => Promise<string | undefined>
}

/** One of the host's own `input` questions — see {@link EnsoExtensionUiContext.askHostInput}. */
export interface HostInputQuestion {
  readonly title: string
  readonly placeholder?: string
  readonly secret?: true
  readonly message?: string
  readonly link?: EnsoDialogLink
}

/**
 * A neutral 256-colour theme for the `theme` getter. The interface requires a `Theme`
 * instance and pi exports the class but not its singleton; no extension the harness loads
 * renders through it on the web surface (footers and headers do not
 * exist here), so the values only need to be complete — tsc enforces that — not pretty.
 */
const NEUTRAL_ANSI_256_FOREGROUND = 250
const NEUTRAL_ANSI_256_BACKGROUND = 236
function createNeutralTheme(): PiTheme {
  const fg = NEUTRAL_ANSI_256_FOREGROUND
  const bg = NEUTRAL_ANSI_256_BACKGROUND
  return new Theme(
    {
      accent: fg,
      border: fg,
      borderAccent: fg,
      borderMuted: fg,
      success: fg,
      error: fg,
      warning: fg,
      muted: fg,
      dim: fg,
      text: fg,
      thinkingText: fg,
      userMessageText: fg,
      customMessageText: fg,
      customMessageLabel: fg,
      toolTitle: fg,
      toolOutput: fg,
      mdHeading: fg,
      mdLink: fg,
      mdLinkUrl: fg,
      mdCode: fg,
      mdCodeBlock: fg,
      mdCodeBlockBorder: fg,
      mdQuote: fg,
      mdQuoteBorder: fg,
      mdHr: fg,
      mdListBullet: fg,
      toolDiffAdded: fg,
      toolDiffRemoved: fg,
      toolDiffContext: fg,
      syntaxComment: fg,
      syntaxKeyword: fg,
      syntaxFunction: fg,
      syntaxVariable: fg,
      syntaxString: fg,
      syntaxNumber: fg,
      syntaxType: fg,
      syntaxOperator: fg,
      syntaxPunctuation: fg,
      thinkingOff: fg,
      thinkingMinimal: fg,
      thinkingLow: fg,
      thinkingMedium: fg,
      thinkingHigh: fg,
      thinkingXhigh: fg,
      bashMode: fg,
    },
    {
      selectedBg: bg,
      userMessageBg: bg,
      customMessageBg: bg,
      toolPendingBg: bg,
      toolSuccessBg: bg,
      toolErrorBg: bg,
    },
    '256color',
    { name: 'enso-web-neutral' },
  )
}

export function createEnsoExtensionUiContext(options: EnsoExtensionUiContextOptions): EnsoExtensionUiContext {
  const { emit } = options
  const log = hostLog.with({ threadId: options.threadId })
  const componentBuildTimeoutMs = options.componentBuildTimeoutMs ?? CUSTOM_COMPONENT_BUILD_TIMEOUT_MS

  /**
   * Release a component without letting its `dispose` take the extension call down: the
   * build path was hardened so a factory failure is non-fatal, and a throwing `dispose`
   * is the same boundary (PR #107 review). Reported, never propagated.
   */
  function disposeQuietly(component: (Component & { dispose?(): void }) | undefined): void {
    try {
      component?.dispose?.()
    } catch (error) {
      log.warn("custom component's dispose() threw on the web surface: {error}", { error })
    }
  }

  /**
   * Build the extension's component against the inert terminal, within the budget.
   * Resolves `undefined` — never throws — when the factory throws, rejects, or does not
   * produce a component in time: pi's rpc mode never ran the factory at all, so any
   * factory that cannot survive a terminal-less build keeps the fallback it always had
   * (PR #107 review). The failure is reported, not swallowed. A component that arrives
   * AFTER the budget is disposed on arrival — nobody else will ever see it.
   */
  async function buildComponent<T>(
    factory: CustomComponentFactory<T>,
    done: (result: T) => void,
  ): Promise<(Component & { dispose?(): void }) | undefined> {
    try {
      const built = factory(INERT_TUI, uiContext.theme, INERT_KEYBINDINGS, done)
      if (!(built instanceof Promise)) return built
      const budget = Promise.withResolvers<never>()
      const timer = setTimeout(() => {
        budget.reject(new Error(`no component within ${componentBuildTimeoutMs} ms`))
        built.then(disposeQuietly, () => undefined)
      }, componentBuildTimeoutMs)
      try {
        return await Promise.race([built, budget.promise])
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      log.warn(
        "custom component could not be built on the web surface — resolving undefined, pi's rpc contract: {error}",
        {
          error,
        },
      )
      return undefined
    }
  }
  const pendingDialogs = new Map<string, PendingDialog>()
  /** Open stop windows (`refuseDialogsUntil`); a count because two may overlap. */
  let refusalWindows = 0
  let neutralTheme: PiTheme | undefined

  /**
   * Block on a dialog until an answer, a cancellation, the caller's own abort signal, or
   * the caller's timeout. `mapResponse` turns the wire answer into the method's return type.
   *
   * @flow dialog-ask-answer-settled A dialog: asked in the host, answered once, settled for every follower
   * An extension's `ctx.ui.select` / `confirm` / `input` / `editor` blocks its run until a human
   * answers. In-process there is no wire for that wait: the host IS the UI (this file's header),
   * so the question is parked in the host's pending map and rides to every follower as a blocking
   * `extension-ui-request` observation (#27, #112). The answer is one unary
   * `POST /api/threads/:id/dialog`, checked against the question it names. Every way the wait can
   * end crosses one `finish`, which emits `dialog-settled` with its outcome (how a tab that did
   * not answer learns the card is stale), and a follow opened under an open question finds it in
   * the snapshot's `openDialogs` (#114).
   * @contract packages/core/src/dialog.ts#validateDialogAnswer
   * @see docs/seams/dialog.md the vocabulary and both schemas, the host's wait, the route, the browser
   * @see docs/glossary.md the words: parked, dialog, answer, outcome (Thread states, Control)
   *
   * @invariant dialog-ask-answer-settled/parked-in-host The question is parked in the host, and nowhere else.
   * This mints the id, keeps `{ resolve, request }` in a `Map` keyed by it, and emits the request
   * on the same emitter as the session's events, so request and settle sit in stream order.
   * Nothing parks server-side; the run keeps going on the follow (`server/follow.ts` header). The
   * thread is busy (`glossary.md`: parked).
   *
   * @invariant dialog-ask-answer-settled/one-finish Every path that stops the wait goes through `finish`.
   * Answer, browser cancel, `dispose`'s `cancelAllDialogs`, the extension's own `timeout`, the
   * extension's own `signal`: each deletes the pending entry first (so a second path is a no-op),
   * emits `extension_ui_settled` with its outcome (#114), and THEN resolves the extension. pi has
   * no event for a question ending, and a follower that did not answer it has no other way to
   * learn the card is stale. One exception: a `signal` already aborted when asked resolves the
   * cancel value with no request and no settle.
   *
   * @invariant dialog-ask-answer-settled/cancel-value A non-answer resolves the runtime's own cancel value, never a wrong type.
   * `cancelValue` is what the extension sees for every non-answer outcome, pi's own contract:
   * `select`, `input` and `editor` see `undefined`; `confirm` sees `false` (`CONFIRM_DISMISSED`).
   * `mapResponse` degrades a wrong-shaped answer to that value. An answer naming no pending id is
   * a logged warning (`answerDialog`), never a throw.
   */
  function awaitDialog<T>(
    request: BlockingDialogRequest,
    dialogOptions: { signal?: AbortSignal; timeout?: number } | undefined,
    cancelValue: T,
    mapResponse: (response: DialogAnswer) => T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = crypto.randomUUID()
      if (refusalWindows > 0) {
        // Asked while a stopped run winds down: refused like a pre-aborted signal below — no
        // request was shown, so there is no card to settle.
        hostLog.info('a question asked while the run stops is refused: {title}', { title: request.title })
        resolve(cancelValue)
        return
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const finish = (value: T, outcome: EnsoDialogOutcome): void => {
        if (!pendingDialogs.delete(id)) return // already settled by another path
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        dialogOptions?.signal?.removeEventListener('abort', onAbort)
        emit({ type: 'extension_ui_settled', id, outcome })
        resolve(value)
      }
      const onAbort = (): void => finish(cancelValue, 'aborted')
      if (dialogOptions?.signal?.aborted) {
        resolve(cancelValue)
        return
      }
      dialogOptions?.signal?.addEventListener('abort', onAbort)
      if (dialogOptions?.timeout !== undefined) {
        timeoutHandle = setTimeout(() => finish(cancelValue, 'timeout'), dialogOptions.timeout)
      }
      pendingDialogs.set(id, {
        resolve: (response: DialogAnswer) =>
          response.cancelled === true ? finish(cancelValue, 'cancelled') : finish(mapResponse(response), 'answered'),
        abort: () => finish(cancelValue, 'aborted'),
        request,
      })
      emit({ type: 'extension_ui_request', id, ...request })
    })
  }

  function notifyFrom(sender: string, message: string, type?: 'info' | 'warning' | 'error'): void {
    emit({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'notify', message, notifyType: type, sender })
  }

  // `notifyFrom` rides on the context itself so pi's wrapper (`runner.js` `wrapUIPromptContext`,
  // which spreads it) keeps it, and an extension's tagged context can reach it.
  const uiContext: ExtensionUIContext & { notifyFrom: typeof notifyFrom } = {
    notifyFrom,
    select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
      return awaitDialog(
        {
          method: 'select',
          title,
          options,
          ...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout }),
        },
        dialogOptions,
        undefined,
        (response: DialogAnswer) => response.value,
      )
    },
    confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
      return awaitDialog(
        {
          method: 'confirm',
          title,
          message,
          ...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout }),
        },
        dialogOptions,
        CONFIRM_DISMISSED,
        (response: DialogAnswer) => response.confirmed ?? false,
      )
    },
    input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
      return awaitDialog(
        {
          method: 'input',
          title,
          ...(placeholder === undefined ? {} : { placeholder }),
          ...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout }),
        },
        dialogOptions,
        undefined,
        (response: DialogAnswer) => response.value,
      )
    },
    editor(title: string, prefill?: string): Promise<string | undefined> {
      return awaitDialog(
        { method: 'editor', title, ...(prefill === undefined ? {} : { prefill }) },
        undefined,
        undefined,
        (response: DialogAnswer) => response.value,
      )
    },
    notify(message: string, type?: 'info' | 'warning' | 'error'): void {
      emit({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'notify', message, notifyType: type })
    },
    setStatus(key: string, text: string | undefined): void {
      emit({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setStatus',
        statusKey: key,
        statusText: text,
      })
    },
    setWidget(
      key: string,
      content: string[] | ((tui: TUI, theme: PiTheme) => Component & { dispose?(): void }) | undefined,
      widgetOptions?: ExtensionWidgetOptions,
    ): void {
      // A component factory has no serialisable form; only string lines cross (pi's rule too).
      if (typeof content === 'function') return
      emit({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setWidget',
        widgetKey: key,
        widgetLines: content,
        widgetPlacement: widgetOptions?.placement,
      })
    },
    setTitle(title: string): void {
      emit({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setTitle', title })
    },
    setEditorText(text: string): void {
      emit({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_editor_text', text })
    },
    // ── Terminal-only surface: inert on the web, exactly as in pi's rpc mode ──────────
    onTerminalInput: () => () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    /**
     * Build the component the extension asked for and lift it if it is one this surface
     * knows (#12). `done` is the callback the component would call on a keypress; here the
     * lifted dialog's answer is what calls it. An unknown component resolves `undefined` at
     * once, exactly as pi's rpc mode does.
     */
    async custom<T>(factory: CustomComponentFactory<T>): Promise<T> {
      const { promise, resolve } = Promise.withResolvers<T>()
      const component = await buildComponent(factory, resolve)
      const questionnaire = liftQuestionnaire(component)
      if (questionnaire !== undefined) {
        disposeQuietly(component)
        const result = await awaitDialog<EnsoQuestionnaireResult>(
          questionnaire,
          undefined,
          QUESTIONNAIRE_DECLINED,
          (response) => (response.answers === undefined ? QUESTIONNAIRE_DECLINED : { answers: response.answers }),
        )
        // `T` for the asking tool is `EnsoQuestionnaireResult` — what its component's `done` takes.
        resolve(result as T)
        return promise
      }
      disposeQuietly(component)
      // pi's rpc contract, stated in TypeScript: an unknown component is "no component".
      resolve(undefined as T)
      return promise
    },
    pasteToEditor: () => undefined,
    getEditorText: () => '',
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    get theme(): PiTheme {
      neutralTheme ??= createNeutralTheme()
      return neutralTheme
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching is not available on the web surface' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  }

  return {
    uiContext,
    notifyFrom,
    answerDialog(response: DialogAnswer): void {
      const pending = pendingDialogs.get(response.id)
      if (pending === undefined) {
        log.warn('dialog answer for unknown request id {dialogId} — already answered, cancelled, or never asked', {
          dialogId: response.id,
        })
        return
      }
      pending.resolve(response)
    },
    askHostInput(question: HostInputQuestion, signal: AbortSignal | undefined): Promise<string | undefined> {
      return awaitDialog(
        { method: 'input', ...question },
        signal === undefined ? undefined : { signal },
        undefined,
        (response: DialogAnswer) => response.value,
      )
    },
    /**
     * @invariant dialog-ask-answer-settled/settle-per-id The settle is for one id, on every follower; the snapshot's list is complete.
     * The browser drops the card only when `dialog-settled` names the id it shows
     * (`custom-event-router.ts`, its `dialog-settled` case). This walks the pending map in
     * insertion order, oldest first, checking each request with `isEnsoDialogSpec` rather than
     * casting; the snapshot carries that list whole, so a reconnect renders the card and an empty
     * list clears one.
     */
    openDialogs(): EnsoOpenDialog[] {
      const open: EnsoOpenDialog[] = []
      for (const [dialogId, { request }] of pendingDialogs) {
        // The request IS a dialog spec structurally (the mapper builds the browser's spec
        // from the same fields); checked rather than cast, so a request shape the spec
        // does not admit (a select with no options) is not listed as a question here either.
        if (isEnsoDialogSpec(request)) open.push({ id: dialogId, dialog: request })
      }
      return open
    },
    cancelAllDialogs(): void {
      for (const [dialogId, pending] of pendingDialogs) {
        pending.resolve({ id: dialogId, cancelled: true })
      }
    },
    abortAllDialogs(): void {
      for (const pending of pendingDialogs.values()) pending.abort()
    },
    refuseDialogsUntil(settled: Promise<unknown>): void {
      refusalWindows += 1
      const close = (): void => {
        refusalWindows -= 1
      }
      // Closed either way: a stop whose runtime rejects still ends its window.
      settled.then(close, close)
    },
    pendingDialogCount(): number {
      return pendingDialogs.size
    },
  }
}
