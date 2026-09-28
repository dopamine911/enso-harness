import { EventType } from '@ag-ui/core'
import {
  type DialogAnswer,
  ENSO_IMAGE_MIME_TYPES,
  EnsoAbortReceipt,
  EnsoConfigurationRefusal,
  type EnsoFollowFrame,
  EnsoFollowFrame as EnsoFollowFrameSchema,
  EnsoForkReceipt,
  type EnsoHostCommandRun,
  ensoLogger,
  type EnsoPromptBody,
  type EnsoPromptImage,
  EnsoPromptReceipt,
  type EnsoSessionConfiguration,
  type EnsoToolResultDescriptor,
  isEnsoImageMimeType,
} from '@enso/core'
import type { MessagePart, StreamChunk } from '@tanstack/ai'
import type { RunAgentInputContext, SubscribeConnectionAdapter } from '@tanstack/ai-client'
import type { ModelMessage, UIMessage } from '@tanstack/ai/client'
import { Compile } from 'typebox/compile'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { FOLLOW_ENDED_CUSTOM_EVENT } from './custom-event-router.ts'
import { type AguiIdentifiers, observationToAguiEvents } from './to-agui.ts'

/**
 * The browser's connection to a thread (#112): TanStack's `SubscribeConnectionAdapter` over
 * the prompt/follow split.
 *
 *   subscribe()  opens `GET /api/threads/:id/follow` once and turns its frames into AG-UI
 *                chunks for as long as the view is attached. A follow that never opens —
 *                refused, or a fetch that throws — arms `disconnected` before it rethrows
 *                (#274), so the page says so instead of waiting on a stream that will
 *                never arrive.
 *   send()       POSTs `/api/threads/:id/prompt` and answers at admission; the run's events
 *                arrive on the subscription, not on the POST.
 *   close()      releases that subscription's socket when the page lets the thread go (#272);
 *                the page's live threads are bounded, so a follow has to be able to end.
 *
 * ⚠ AG-UI IS MADE HERE AND ONLY HERE. The wire carries `EnsoObservation` (`docs/architecture.md`,
 * decided constraints); this adapter derives the chunk vocabulary TanStack's client consumes,
 * in memory, per view. Nothing is stored in it and nothing else reads it.
 *
 * RUNS. TanStack minted the `runId` (`runContext.runId`) before calling `send`, and it
 * resolves its own loading state on `RUN_FINISHED`/`RUN_ERROR` for that id. So `send` emits
 * `RUN_STARTED` for the client's id at once — admission, in TanStack's own terms — and the
 * thread's `settled` observation closes every run this adapter has open. A run another client
 * started shows up as `status { busy }` with a generation this adapter did not send: it is
 * synthesised as `external-<generation>` so a second tab renders the transcript it is
 * watching (dsh: `followup()` is admission; a run is the interval to the next idle).
 *
 * MESSAGES. One assistant message per run, opened at `RUN_STARTED` — the same shape the run
 * path produced, so the renderers see nothing new. Per-message boundaries are on the wire
 * (`message-start`/`message-end`) for a later fold that wants them.
 *
 * DIALOGS. A blocking question is an `extension-ui-request` CUSTOM chunk (`to-agui.ts`) into the thread's
 * dialog store; the answer is `answerDialog` below — a unary POST. No interrupt: the run keeps
 * going on the follow and nothing on the server parks. An unreadable blocking request is
 * declined here on pi's behalf, and the run error `to-agui.ts` emits tells the user.
 */

const followLog = ensoLogger('browser', 'follow')

/**
 * The wire validator, compiled once at module load — the `@enso/core` convention
 * (`config.ts:47`, `dialog.ts:83-84`, `thread-runtime.ts:60`, `tool-result.ts:94`).
 *
 * `Compile` rather than `Check` because this runs on EVERY frame off the follow — once per
 * streamed token — against a union whose snapshot arm is the whole transcript. Measured
 * (#281): 13.16 µs interpreted against 0.035 µs compiled for a `text-delta` frame, and
 * 41.5 µs against 0.57 µs for a 50-message snapshot. The receipt checks below stay
 * interpreted on purpose: one per prompt and one per abort is not a hot path, and compiling
 * them would imply otherwise.
 */
const followFrameValidator = Compile(EnsoFollowFrameSchema)

/** The template with its values in, as a notice reads it: `dialog {id} {outcome}` → `dialog d1 refused`. */
function sentence(template: string, properties: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
    const value = properties[name]
    if (value === undefined) return placeholder
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

export interface FollowConnectionOptions {
  readonly threadId: string
  /** Test seam: the page's `fetch`. */
  readonly fetch?: FetchLike
  /** Notified for anything the adapter could not deliver. Never silent. */
  readonly onProblem?: (problem: unknown) => void
  /**
   * A finished tool result's #18 descriptor (#411). It rides the AG-UI result as an extra key, and
   * TanStack's processor keeps none (`updateToolResultPart` takes no metadata), so the page would
   * never see it live; this hands it over before the result is pushed, so it is known when the
   * result renders.
   */
  readonly onToolResultDescriptor?: (toolCallId: string, descriptor: EnsoToolResultDescriptor) => void
}

/** One run this adapter has open: its AG-UI ids and, once the receipt is in, the acquisition it took or queued behind. */
interface OpenRun {
  readonly runId: string
  /** The assistant message the view is streaming into. Rotates when pi claims a queued prompt (#75). */
  messageId: string
  /** The receipt's `messageId` — how a `prompt-rejected` names this run. Undefined for a run another client started. */
  promptMessageId: string | undefined
  generation: number | undefined
  /**
   * Assistant messages pi has begun in this run. A USER `message-start` after the first of
   * them is a queued prompt being CLAIMED (#75), not the prompt that opened the run — the
   * view then ends the current assistant bubble and starts a new one, so the reply lands
   * after its question rather than inside the previous answer.
   */
  assistantMessages: number
}
/** The parts of the last user message, whichever shape TanStack hands over — `UIMessage.parts` or `ModelMessage.content`. */
function latestUserParts(messages: Array<UIMessage> | Array<ModelMessage>): readonly MessagePart[] {
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const message: UIMessage | ModelMessage | undefined = messages[position]
    if (message === undefined || message.role !== 'user') continue
    if ('parts' in message) return message.parts
    if (typeof message.content === 'string') return [{ type: 'text', content: message.content }]
    return message.content ?? []
  }
  return []
}

/** The text of a user message's parts — what `send` prompts with. */
function textOf(parts: readonly MessagePart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.content : '')).join('')
}

/** The `data:<mime>;base64,<data>` URL the composer submits, split. Anything else is not an inline image. */
const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/

/**
 * The user's image parts as the wire takes them (#68): inline bytes only. `EnsoPromptImage`
 * has no `url` — a server-side fetch would be egress the guards do not cover — so a part
 * whose source is a URL that is not a `data:` URL is REFUSED here, by name, before anything
 * is posted; the server never learns of it. A `data:` URL is bytes already, so it crosses.
 * The mime type is the part's own; the server holds the allowlist and says which is refused.
 */
function imagesOf(parts: readonly MessagePart[]): { images: EnsoPromptImage[]; refused: string[] } {
  const images: EnsoPromptImage[] = []
  const refused: string[] = []
  for (const part of parts) {
    if (part.type !== 'image') continue
    // Bytes and a kind, from either source shape; a kind the wire does not take is refused
    // by name here rather than sent for the server to refuse (the server still would).
    const inline: [string, string] | undefined =
      part.source.type === 'data' ? [part.source.mimeType, part.source.value] : dataUrlOf(part.source.value)
    if (inline === undefined) {
      refused.push(`${part.source.value.slice(0, 80)}: an image by URL is not sent — attach the file itself`)
      continue
    }
    const [mimeType, data] = inline
    if (!isEnsoImageMimeType(mimeType)) {
      refused.push(`${mimeType}: not a kind this wire takes (${ENSO_IMAGE_MIME_TYPES.join(', ')})`)
      continue
    }
    images.push({ mimeType, data })
  }
  return { images, refused }
}

/** `data:<mime>;base64,<data>` → `[mime, data]`; anything else — an http(s) URL, a blob URL — is not inline bytes. */
function dataUrlOf(value: string): [string, string] | undefined {
  const match = DATA_URL.exec(value)
  return match?.[1] !== undefined && match[2] !== undefined ? [match[1], match[2]] : undefined
}

/** `data:` lines of an SSE body, one parsed frame at a time; comments (keepalives) are skipped. */
async function* readSseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) yield JSON.parse(line.slice('data: '.length)) as unknown
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * What the server did with a dialog answer (#112, PR #113 review):
 * `answered` taken (204) — the question is spent.
 *
 * `gone` no such open question (404) — answered from another tab, or expired. Spent too.
 * `refused` the answer did not fit the question (422: an unoffered value). The question is
 * STILL OPEN on the server and must stay on screen. `unreachable` the request never got an
 * answer (network). Nothing changed; still open.
 */
export type DialogAnswerOutcome = 'answered' | 'gone' | 'refused' | 'unreachable'

/**
 * What the server did with an abort (#116):
 * `aborted` pi was told (204).
 *
 * The run ends ON THE FOLLOW — `settled`, then `status` — so nothing here closes it; the same
 * frames close it for every follower. `idle` nothing was in flight (409) — the run ended
 * between the click and the request. `gone` the thread is not live on the server (404).
 * `unreachable` the request never got an answer (network). The run is still in flight.
 */
export type AbortOutcome = 'aborted' | 'idle' | 'gone' | 'unreachable'

/** What `abort()` returns: the outcome, and the prompts pi had waiting — handed back to the composer (#75). Empty unless `aborted`. */
export interface AbortResult {
  readonly outcome: AbortOutcome
  readonly restored: readonly string[]
}

/**
 * What the server did with a prompt sent DURING a run (#75):
 * `queued` pi holds it behind the run in flight (202, `queued: true`) — the follow's
 * `queue` lists it for every follower; pi claims it when the run's turn ends.
 *
 * `taken` the run had ended by the time it arrived, so it started a run of its own (202,
 * `queued: false`); the follow opens that run as it would another tab's. `refused` pi would not
 * take it (a `prompt-rejected` on the follow, or a non-202). `unreachable` the request never
 * got an answer (network). Nothing changed.
 */
export type PromptOutcome = 'queued' | 'taken' | 'refused' | 'unreachable'

export interface FollowConnection extends SubscribeConnectionAdapter {
  /** Answer the thread's open question. A non-`answered` outcome is also reported with the server's reason. */
  readonly answerDialog: (answer: DialogAnswer) => Promise<DialogAnswerOutcome>
  /**
   * Stop the run in flight (#116). ⚠ Not TanStack's `stop()`: that aborts this client's
   * in-flight POST, which returned at admission long ago, and touches nothing on the server.
   * The answer carries what was queued behind the run, for the composer (#75).
   */
  readonly abort: () => Promise<AbortResult>
  /**
   * Send a prompt while a run is in flight (#75). ⚠ Not `chat.sendMessage`: TanStack holds a
   * send in its own queue while the run it started is open, and delivers it at settle — the
   * browser's queue, invisible to other tabs and lost on reload. This POSTs now with
   * `admission: enqueue`, so the runtime queues it and every follower sees it.
   */
  readonly prompt: (text: string, images?: readonly EnsoPromptImage[]) => Promise<PromptOutcome>
  /**
   * Switch the permission mode (L3 step C): `POST …/mode`, a control route, never a prompt —
   * the browser says a mode and no command. The change arrives on the follow as `permission-mode`,
   * said by the host once its extension has persisted it; a refusal is reported with the
   * server's reason and moves nothing.
   */
  readonly changeMode: (mode: string) => Promise<ModeChangeOutcome>
  /**
   * Run a `host` command (#338 slice 2): `POST …/command`, `/model` with an `options[].id` or
   * `/thinking` with a level — the same control shape as `changeMode`, and the same failure
   * path: `busy` (409) and `refused` (422, the host's reason) are recorded through `problem`
   * and said once, the way a refused mode change is (PR #344 review). The store moves on the
   * feed's `model` observation, never on the answer.
   */
  readonly runHostCommand: (run: EnsoHostCommandRun) => Promise<HostCommandOutcome>
  /**
   * Apply a new session's model, effort and mode together (#391): `POST …/configure`, the
   * Start-a-session dialog's Start. The server applies them in order under one lease; a refusal
   * comes back with its step and reason for the dialog to show.
   */
  readonly configure: (configuration: EnsoSessionConfiguration) => Promise<ConfigureOutcome>
  /**
   * Fork the thread at one of its user messages (#433): `POST …/fork` with the message's pi entry
   * id. The receipt names the new thread and the words to prefill it with; a refusal — the thread
   * running (409), an entry it does not have (404), one that is no user message (400) — is
   * recorded through `problem` and said once, as a refused control is, and answers `undefined`.
   */
  readonly fork: (entryId: string) => Promise<EnsoForkReceipt | undefined>
  /**
   * Continue the thread's torn tail from its stored state (#436): `POST …/continue`, no prompt and
   * no new user message. The run arrives on the follow as a run another tab started would; a refusal
   * — the thread running (409), nothing to continue (422) — is recorded through `problem` and said
   * once, as a refused control is.
   */
  readonly continueRun: () => Promise<ContinueOutcome>
  /**
   * Release the thread's follow (#272): the socket closes and nothing else opens one on
   * this connection. The page calls it when a thread leaves its live list — a thread whose
   * pane is gone must not keep a stream the browser counts against its six-per-origin
   * budget. Idempotent, and LATCHING: a later `subscribe` ends at once rather than
   * reconnecting a thread the page has let go.
   *
   * ⚠ Not the server going away: a close from this side emits no `follow-ended` and no
   * problem. `disconnected` states a server that dropped the page, which this is not.
   */
  readonly close: () => void
}

export type ModeChangeOutcome = 'told' | 'busy' | 'refused' | 'unreachable'
/** What `runHostCommand` reports — the same four words as a mode change, for the same route shape. */
export type HostCommandOutcome = ModeChangeOutcome
/** What `continueRun` reports — the control words, `told` meaning the run was accepted (#436). */
export type ContinueOutcome = ModeChangeOutcome
/**
 * What `configure` reports (#391): applied, or why not — WITH the reason, because the asking
 * dialog shows it. `refused` is the server's 422, naming the step; `failed` is any other answer
 * (a fault's 500, a body the server would not read), which is not a refusal and does not pretend
 * to be one (PR #393 review). Not said on the transcript: the dialog is where the person is
 * looking, and a second copy there would be a duplicate.
 */
export type ConfigureOutcome =
  | { readonly outcome: 'told' }
  | { readonly outcome: 'refused'; readonly step: EnsoConfigurationRefusal['step']; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly status: number }
  | { readonly outcome: 'unreachable' }

export function createFollowConnection(options: FollowConnectionOptions): FollowConnection {
  const { threadId } = options
  // The global is looked up per call, not captured: a thread minted at module load (the
  // page's first) must still see a `fetch` a test installs afterwards (#118).
  const fetchImpl: (input: string, init?: RequestInit) => Promise<Response> =
    options.fetch ?? ((input: string, init?: RequestInit): Promise<Response> => fetch(input, init))
  const base = `/api/threads/${encodeURIComponent(threadId)}`
  const log = followLog.with({ threadId })
  /** This connection's own end (#272), aborted by `close()` — see the interface for what it is not. */
  const released = new AbortController()
  /**
   * A problem is a RECORD (#132) — the event with its properties, to the ring and the
   * server — and, through `onProblem`, a NOTICE the page shows: the same template rendered
   * as one sentence. One site per problem, so the two can never disagree.
   */
  const problem = (template: string, properties: Record<string, unknown> = {}): void => {
    log.warn(template, properties)
    options.onProblem?.(`thread ${threadId}: ${sentence(template, properties)}`)
  }

  /** Chunks waiting for the subscription loop to take them — pushed by frames and by `send`. */
  const queue: StreamChunk[] = []
  let wake: (() => void) | undefined
  const runs = new Map<string, OpenRun>()
  /**
   * A frame that fails the wire schema has been reported on this connection (PR #355 review).
   * Once, not per frame: the usual cause is a version mismatch — a tab from an earlier bundle
   * against a newer server, or the reverse under HMR — and then EVERY frame of the changed kind
   * fails; a token stream of them would bury the transcript under one sentence.
   */
  let reportedWireMismatch = false

  /**
   * Whether a frame off the wire is one this page can read. ⚠ A failure is almost always a
   * VERSION mismatch, not corruption: the schemas are closed (`additionalProperties: false`), so
   * a field either side added fails the other's check — a dropped snapshot applies nothing (no
   * messages, mode, model, dialog), and the page would look connected while stale. The notice
   * says what fixes it; the frame rides in the record's properties, never in the sentence.
   */
  function admitted(raw: unknown): raw is EnsoFollowFrame {
    if (followFrameValidator.Check(raw)) return true
    if (!reportedWireMismatch) {
      reportedWireMismatch = true
      problem(
        'a frame from the server does not match this page — the page and the server are from different versions; reload the page',
        { frame: raw },
      )
    }
    return false
  }
  /** The run observation chunks attach to: the most recently opened. */
  let current: OpenRun | undefined
  /** `prompt-rejected` reasons that arrived before the receipt naming their run, by the receipt's `messageId`. */
  const rejectedBeforeReceipt = new Map<string, string>()
  /** Receipt ids of prompts this tab queued behind a run (#75) — a later `prompt-rejected` for one is said, not matched to a run. */
  const queuedPrompts = new Set<string>()

  function push(...chunks: StreamChunk[]): void {
    queue.push(...chunks)
    wake?.()
    wake = undefined
  }

  function openRun(runId: string, promptMessageId: string | undefined, generation: number | undefined): OpenRun {
    const run: OpenRun = { runId, messageId: crypto.randomUUID(), promptMessageId, generation, assistantMessages: 0 }
    runs.set(runId, run)
    current = run
    push(
      { type: EventType.RUN_STARTED, threadId, runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: run.messageId, role: 'assistant' },
    )
    return run
  }

  function closeRun(run: OpenRun, chunk: StreamChunk): void {
    runs.delete(run.runId)
    if (current === run) current = undefined
    push(chunk)
  }

  /**
   * A message boundary inside the run (#75). Assistant: count it. User, after an assistant
   * message has begun: pi claimed a queued prompt — end the current assistant bubble and
   * open a new one after it. The run's own prompt arrives before any assistant message and
   * rotates nothing.
   */
  function observeMessageStart(role: string): void {
    if (current === undefined) return
    if (role === 'assistant') {
      current.assistantMessages += 1
      return
    }
    if (role !== 'user' || current.assistantMessages === 0) return
    const ended = current.messageId
    current.messageId = crypto.randomUUID()
    current.assistantMessages = 0
    push(
      { type: EventType.TEXT_MESSAGE_END, messageId: ended },
      { type: EventType.TEXT_MESSAGE_START, messageId: current.messageId, role: 'assistant' },
    )
  }

  function idsOf(run: OpenRun | undefined): AguiIdentifiers {
    return { threadId, runId: run?.runId ?? `external-${threadId}`, messageId: run?.messageId ?? threadId }
  }

  /** The server's latest word on the thread, from the last snapshot or status frame. */
  let serverGeneration = 0
  let serverBusy = false

  /**
   * Close every run the server has moved past: `RUN_FINISHED` for each, so TanStack's
   * loading state resolves. ⚠ A run whose generation is still unknown (its receipt has
   * not come back) or newer than the server's is NOT closed — the frames ending an
   * EARLIER run can arrive after this tab has already opened the next one, and closing
   * that one here would end it before it started.
   */
  function finishRunsThrough(generation: number): void {
    for (const run of runs.values()) {
      if (run.generation === undefined || run.generation > generation) continue
      closeRun(run, { type: EventType.RUN_FINISHED, threadId, runId: run.runId })
    }
  }

  /**
   * The thread's status. Released (`busy: false`) is the server's statement that the run
   * is over — the way a slash command ends, which never `settled`s (its completion is its
   * acceptance). Busy under a generation this adapter did not send is a run another
   * client started.
   */
  function observeStatus(busy: boolean, generation: number): void {
    serverGeneration = generation
    serverBusy = busy
    if (!busy) {
      finishRunsThrough(generation)
      return
    }
    for (const run of runs.values()) {
      if (run.generation === generation || run.generation === undefined) return
    }
    openRun(`external-${generation}`, undefined, generation)
  }

  async function declineUnreadable(id: string): Promise<void> {
    // `gone` is fine — someone else settled it; only a refusal of a cancel is a problem.
    if ((await answerDialog({ id, cancelled: true })) === 'refused') {
      problem('could not decline unreadable dialog {dialogId}', { dialogId: id })
    }
  }

  function observe(frame: EnsoFollowFrame): void {
    if (frame.type === 'snapshot' || frame.type === 'status') {
      // The frame crosses to the router WHOLE, named by its type (#162 workstream 5): the
      // run-start receipts — mode, the complete open-question list, the generation — are
      // read off it there, not re-shaped here into a second vocabulary of names.
      push({ type: EventType.CUSTOM, name: frame.type, value: frame })
      observeStatus(frame.busy, frame.generation)
      return
    }
    const { observation } = frame
    if (observation.kind === 'settled') {
      // Nothing queued behind a settled run can be refused any more: pi claimed it (it ran
      // inside this run) or a stop cleared it (the receipt said so). Forget the ids.
      queuedPrompts.clear()
      finishRunsThrough(serverGeneration)
      return
    }
    if (observation.kind === 'message-start') observeMessageStart(observation.role)
    if (observation.kind === 'prompt-rejected') {
      // A prompt this tab queued behind the run (#75): pi would not take it. Said where the
      // human looks; the composer got its text back when `prompt` reported `refused`.
      if (queuedPrompts.has(observation.messageId)) {
        queuedPrompts.delete(observation.messageId)
        problem('queued prompt refused: {reason}', { messageId: observation.messageId, reason: observation.reason })
        return
      }
      const run = [...runs.values()].find((open) => open.promptMessageId === observation.messageId)
      if (run === undefined) {
        // ⚠ The rejection can beat the receipt that names the run (the queued-prompt
        // path rejects the instant `session.prompt` runs, before the 202 body is even
        // written). Keep it; `send` looks here when its receipt lands.
        rejectedBeforeReceipt.set(observation.messageId, observation.reason)
        return
      }
      closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: observation.reason })
      return
    }
    if (observation.kind === 'extension-ui-request' && observation.blocking && observation.dialog === undefined) {
      if (observation.id.length > 0) void declineUnreadable(observation.id)
    }
    if (observation.kind === 'tool-result' && observation.complete && observation.descriptor !== undefined) {
      options.onToolResultDescriptor?.(observation.toolCallId, observation.descriptor)
    }
    push(...observationToAguiEvents(observation, idsOf(current)))
  }

  /**
   * A follow that NEVER OPENED, said the same way a follow that ended says it (#274).
   *
   * ⚠ Yielded, never `push`ed: `push` only enqueues, and the subscription loop that drains
   * the queue is BELOW the open — a chunk pushed here and then thrown past is a chunk the
   * router never sees. Measured before this existed: a 500 on `…/follow` moved no store, so
   * `disconnected` stayed false and every reading on the page said the thread was live —
   * the composer took prompts, the stop button was offered for a run nothing could observe,
   * and the status bar said idle. The only signal was the client's own "the run failed"
   * alert, which names the wrong thing.
   */
  function* followNeverOpened(detail: string): Generator<StreamChunk> {
    problem('the follow could not be opened: {detail}', { detail })
    yield { type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId } }
  }

  /**
   * What the open produced: a live response, this page's own release, or a refusal with the
   * detail to report. Separate from `subscribe` so the three answers are one `switch` there
   * instead of three interleaved with the pump's own control flow.
   */
  type FollowOpening =
    // The BODY, not the response: `openFollow` has already established there is one, and a
    // `Response` here would make `subscribe` re-check a null it cannot receive (PR #305 review).
    | { readonly kind: 'opened'; readonly body: ReadableStream<Uint8Array> }
    | { readonly kind: 'released' }
    | { readonly kind: 'refused'; readonly detail: string; readonly failure: Error }

  async function openFollow(abort: AbortSignal): Promise<FollowOpening> {
    let response: Response
    try {
      response = await fetchImpl(`${base}/follow`, { signal: abort })
    } catch (error) {
      // ⚠ Released while the socket was still OPENING (PR #301 review). `close()` is silent by
      // contract — the page letting a thread go is not an error the page should be shown — but
      // the abort lands on this fetch, whose rejection had nowhere to go but out of the
      // generator, at whoever is iterating it. Our own release ends the iteration instead.
      if (released.signal.aborted) return { kind: 'released' }
      const failure = error instanceof Error ? error : new Error(String(error))
      return { kind: 'refused', detail: String(error), failure }
    }
    if (response.ok && response.body !== null) return { kind: 'opened', body: response.body }
    // ⚠ The status is the fact; the body is colour (PR #305 review). Reading it can itself
    // reject — a truncated or aborted body — and that rejection would have thrown past the
    // arming in `subscribe`, leaving the page saying "live" for a follow the server just
    // refused, which is the state #274 exists to end. The read cannot decide whether the
    // contract is armed.
    const body = await response.text().catch((error: unknown) => `(body unreadable: ${String(error)})`)
    const detail = `${response.status} ${body}`
    return { kind: 'refused', detail, failure: new Error(`follow ${threadId}: ${detail}`) }
  }

  async function* subscribe(signal?: AbortSignal): AsyncIterable<StreamChunk> {
    // The page's own end (#272) rides with TanStack's: either one closes the socket, and a
    // connection already released never opens one.
    if (released.signal.aborted) return
    const abort = signal === undefined ? released.signal : AbortSignal.any([signal, released.signal])
    const opening = await openFollow(abort)
    if (opening.kind === 'released') return
    if (opening.kind === 'refused') {
      // A throwing fetch is the same fact as a refusing one (#274) — unless the CALLER is the
      // one leaving, in which case there is nothing to report and the cancel is theirs to see.
      if (!abort.aborted) yield* followNeverOpened(opening.detail)
      throw opening.failure
    }
    const frames = readSseFrames(opening.body, abort)
    // Frames are consumed on their own loop so `send` can interleave chunks; this loop
    // yields whatever is queued, waiting when nothing is.
    let ended = false
    const pump = (async () => {
      try {
        for await (const raw of frames) {
          if (admitted(raw)) observe(raw)
        }
      } catch (error) {
        if (!abort.aborted) problem('the follow failed: {error}', { error: String(error) })
      } finally {
        ended = true
        // The follow closed under open runs: the client would otherwise wait forever.
        for (const run of runs.values()) {
          closeRun(run, {
            type: EventType.RUN_ERROR,
            runId: run.runId,
            message: 'the follow closed before the run settled',
          })
        }
        // The server went away under this page (#103 receipt, step 8) — not this page
        // leaving. Said as a chunk so the page can show it and the debug pane refetches:
        // with no run open nothing else would mention it, and the pane would keep
        // presenting its last fetch of a session that may no longer exist as current.
        if (!abort.aborted) {
          push({ type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId } })
        }
        wake?.()
        wake = undefined
      }
    })()
    try {
      while (!abort.aborted) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (ended) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      await pump
    }
  }

  async function send(
    messages: Array<UIMessage> | Array<ModelMessage>,
    _data?: Record<string, unknown>,
    signal?: AbortSignal,
    runContext?: RunAgentInputContext,
  ): Promise<void> {
    const run = openRun(runContext?.runId ?? crypto.randomUUID(), undefined, undefined)
    const parts = latestUserParts(messages)
    const message = textOf(parts)
    const { images, refused } = imagesOf(parts)
    if (refused.length > 0) {
      // Refused on this side, by name: the server would only ever have seen bytes.
      const reason = `image not sent: ${refused.join('; ')}`
      log.warn('prompt refused: {reason}', { runId: run.runId, reason })
      closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: reason })
      return
    }
    const body: EnsoPromptBody = { message, ...(images.length === 0 ? {} : { images }) }
    let response: Response
    try {
      response = await fetchImpl(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // The transcript shows the run's error; the record says what the page could not do.
      log.warn('prompt could not be sent: {error}', { runId: run.runId, error: String(error) })
      closeRun(run, {
        type: EventType.RUN_ERROR,
        runId: run.runId,
        message: `prompt could not be sent: ${String(error)}`,
      })
      return
    }
    if (response.status !== 202) {
      const body = await response.text()
      log.warn('prompt refused: {status} {body}', { runId: run.runId, status: response.status, body })
      closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: body })
      return
    }
    const receipt: unknown = await response.json()
    if (!Check(EnsoPromptReceipt, receipt)) {
      log.warn('the prompt receipt did not match its schema', { runId: run.runId })
      closeRun(run, {
        type: EventType.RUN_ERROR,
        runId: run.runId,
        message: 'the prompt receipt did not match its schema',
      })
      return
    }
    run.promptMessageId = receipt.messageId
    run.generation = receipt.generation
    // The spine from this side: the admission, with the ids that join it to the server's line.
    log.info('prompt {messageId} {admission} on run {generation}', {
      runId: run.runId,
      messageId: receipt.messageId,
      generation: receipt.generation,
      admission: receipt.queued ? 'queued' : 'opened',
    })
    // The rejection may already have crossed on the follow, before this receipt named the run.
    const rejection = rejectedBeforeReceipt.get(receipt.messageId)
    if (rejection !== undefined) {
      rejectedBeforeReceipt.delete(receipt.messageId)
      closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: rejection })
      return
    }
    // A run so quick the server released it before its receipt came back (a slash
    // command that answered in the same tick): the status that ended it has already
    // passed through, so nothing later will close this run. Close it now.
    if (!serverBusy && serverGeneration >= receipt.generation) {
      closeRun(run, { type: EventType.RUN_FINISHED, threadId, runId: run.runId })
    }
  }

  /**
   * One unary POST, or `undefined` when it never got an answer. Reported here, once, so the
   * callers' fire-and-forget (`void connection.abort()`) can never leak an unhandled rejection.
   */
  async function post(route: string, what: string, init?: RequestInit): Promise<Response | undefined> {
    try {
      return await fetchImpl(`${base}/${route}`, { ...init, method: 'POST' })
    } catch (error) {
      problem('{what} unreachable: {error}', { what, error: String(error) })
      return undefined
    }
  }

  async function answerDialog(answer: DialogAnswer): Promise<DialogAnswerOutcome> {
    const response = await post('dialog', `dialog ${answer.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answer),
    })
    if (response === undefined) return 'unreachable'
    if (response.status === 204) return 'answered'
    const outcome: DialogAnswerOutcome = response.status === 404 ? 'gone' : 'refused'
    problem('dialog {dialogId} {outcome}: {status} {body}', {
      dialogId: answer.id,
      outcome,
      status: response.status,
      body: await response.text(),
    })
    return outcome
  }

  async function abort(): Promise<AbortResult> {
    const response = await post('abort', 'abort')
    if (response === undefined) return { outcome: 'unreachable', restored: [] }
    if (response.status === 200) {
      const receipt: unknown = await response.json()
      if (Check(EnsoAbortReceipt, receipt)) return { outcome: 'aborted', restored: receipt.restored }
      problem('the abort receipt did not match its schema — anything queued is lost')
      return { outcome: 'aborted', restored: [] }
    }
    const outcome: AbortOutcome = response.status === 409 ? 'idle' : 'gone'
    problem('abort {outcome}: {status} {body}', { outcome, status: response.status, body: await response.text() })
    return { outcome, restored: [] }
  }

  async function changeMode(mode: string): Promise<ModeChangeOutcome> {
    const response = await post('mode', `mode ${mode}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    if (response === undefined) return 'unreachable'
    if (response.status === 204) return 'told'
    const outcome: ModeChangeOutcome = response.status === 409 ? 'busy' : 'refused'
    problem('mode change {outcome}: {status} {body}', { outcome, status: response.status, body: await response.text() })
    return outcome
  }

  async function runHostCommand(run: EnsoHostCommandRun): Promise<HostCommandOutcome> {
    const response = await post('command', `/${run.name}${run.value === undefined ? '' : ` ${run.value}`}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(run),
    })
    if (response === undefined) return 'unreachable'
    // 204: applied (`/model`, `/thinking`). 202: STARTED (`/login`, `/logout`, #338 slice 3) — the
    // flow's questions and progress arrive on the feed; told is what this route can say.
    if (response.status === 204 || response.status === 202) return 'told'
    const outcome: HostCommandOutcome = response.status === 409 ? 'busy' : 'refused'
    problem('/{name} {outcome}: {status} {body}', {
      name: run.name,
      outcome,
      status: response.status,
      body: await response.text(),
    })
    return outcome
  }

  async function prompt(text: string, images: readonly EnsoPromptImage[] = []): Promise<PromptOutcome> {
    const body: EnsoPromptBody = {
      message: text,
      admission: 'enqueue',
      ...(images.length === 0 ? {} : { images: [...images] }),
    }
    const response = await post('prompt', 'queued prompt', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response === undefined) return 'unreachable'
    if (response.status !== 202) {
      problem('queued prompt refused: {status} {body}', { status: response.status, body: await response.text() })
      return 'refused'
    }
    const receipt: unknown = await response.json()
    if (!Check(EnsoPromptReceipt, receipt)) {
      problem('the prompt receipt did not match its schema')
      return 'refused'
    }
    // The rejection may already have crossed on the follow, before this receipt named it.
    const rejection = rejectedBeforeReceipt.get(receipt.messageId)
    if (rejection !== undefined) {
      rejectedBeforeReceipt.delete(receipt.messageId)
      problem('queued prompt refused: {reason}', { reason: rejection })
      return 'refused'
    }
    if (!receipt.queued) return 'taken'
    queuedPrompts.add(receipt.messageId)
    return 'queued'
  }

  function close(): void {
    if (released.signal.aborted) return
    log.info('follow released')
    released.abort()
  }

  async function configure(configuration: EnsoSessionConfiguration): Promise<ConfigureOutcome> {
    const response = await post('configure', 'configure', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configuration),
    })
    if (response === undefined) return { outcome: 'unreachable' }
    if (response.status === 204) return { outcome: 'told' }
    const body = await response.text()
    log.warn('configure not applied: {status} {body}', { status: response.status, body })
    if (response.status === 409) return { outcome: 'busy', reason: body }
    let refusal: unknown
    try {
      refusal = response.status === 422 ? JSON.parse(body) : undefined
    } catch {
      refusal = undefined
    }
    return Check(EnsoConfigurationRefusal, refusal)
      ? { outcome: 'refused', step: refusal.step, reason: refusal.reason }
      : { outcome: 'failed', status: response.status }
  }

  async function fork(entryId: string): Promise<EnsoForkReceipt | undefined> {
    const response = await post('fork', 'fork', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId }),
    })
    if (response === undefined) return undefined
    if (response.status !== 200) {
      problem('fork refused: {status} {body}', { status: response.status, body: await response.text() })
      return undefined
    }
    const receipt: unknown = await response.json()
    if (Check(EnsoForkReceipt, receipt)) return receipt
    problem('the fork receipt did not match its schema')
    return undefined
  }

  async function continueRun(): Promise<ContinueOutcome> {
    const response = await post('continue', 'continue')
    if (response === undefined) return 'unreachable'
    if (response.status === 202) return 'told'
    const outcome: ContinueOutcome = response.status === 409 ? 'busy' : 'refused'
    problem('continue {outcome}: {status} {body}', { outcome, status: response.status, body: await response.text() })
    return outcome
  }

  return {
    subscribe,
    send,
    answerDialog,
    abort,
    prompt,
    changeMode,
    runHostCommand,
    configure,
    fork,
    continueRun,
    close,
  }
}
