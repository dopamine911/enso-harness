import { EventType } from '@ag-ui/core'
import {
  type DialogAnswer,
  ENSO_IMAGE_MIME_TYPES,
  EnsoAbortReceipt,
  EnsoConfigurationRefusal,
  type EnsoFollowFrame,
  EnsoFollowFrame as EnsoFollowFrameSchema,
  EnsoForkReceipt,
  type EnsoIncidentResolution,
  type EnsoHostCommandRun,
  ensoLogger,
  type EnsoObservation,
  type EnsoPromptBody,
  type EnsoPromptImage,
  type EnsoPromptRejected,
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
import { pageLeaving } from './page-leaving.ts'
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
  /**
   * A turn started on the thread — pi's `turn_start`, the evidence a run is really going (PR #440
   * review). A lease alone (a mode change, `/model`, a refused Continue) raises `busy` but never
   * starts a turn, so what must key on "a run answered this thread" keys on this, not on `busy`.
   */
  readonly onTurnStart?: () => void
  /**
   * Whether the page is going away (#664; `page-leaving.ts` by default): a stream the browser cuts
   * as the page leaves is not a failed follow. Test seam.
   */
  readonly leaving?: () => boolean
}

/** One run this adapter has open: its AG-UI ids and, once the receipt is in, the acquisition it took or queued behind. */
interface OpenRun {
  readonly runId: string
  /**
   * The assistant message the view is streaming into. Rotates when pi claims a queued prompt (#75),
   * and when pi starts a new attempt after a refused one (#382).
   */
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
  /**
   * A provider refused this run's current attempt (#382). pi's retry then begins a new assistant
   * message, and the view gives it a new bubble: the refused attempt keeps its own, and the lines
   * said about it (`refused: …`, `retrying in …`) read between the two, not after the reply.
   */
  refused: boolean
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

/**
 * `data:` lines of an SSE body, one parsed frame at a time; comments (keepalives) are skipped.
 *
 * ⚠ `signal` ends a read that is WAITING, not only the next one (#915): the reader is cancelled the
 * moment it aborts. A loop that only checked it between reads sat in `reader.read()` for as long as
 * the server kept the stream open (all of a run, keepalives every 5 s), so a subscription that had
 * to stop could not, whatever the `fetch` underneath did with the same signal.
 */
async function* readSseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const cancel = (): void => {
    // A body the fetch already failed rejects the cancel too: the read it ends is what matters.
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
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
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/**
 * What the server did with a dialog answer (#112):
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
   * and said once, the way a refused mode change is. The store moves on the
   * feed's `model` observation, never on the answer.
   */
  readonly runHostCommand: (run: EnsoHostCommandRun) => Promise<HostCommandOutcome>
  /**
   * Apply a new session's model, effort and mode together (#391): `POST …/configure`, the
   * launch panel's Start (#877). The server applies them in order under one lease; a refusal
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
   * Resolve the thread's incident (#466): `POST …/incidents/:incidentId/resolve`, the human's
   * classification and outcome. The resolution arrives on the follow as its `custom-entry`; the
   * answer only says whether the server took it — and, when not, why, because the card that asked
   * shows the reason where the person is looking (as `configure` does for its dialog).
   */
  readonly resolveIncident: (incidentId: string, resolution: EnsoIncidentResolution) => Promise<IncidentResolveOutcome>
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
  /**
   * The assistant message of the chunk TanStack is processing now, in STREAM order (#382) — the
   * last `TEXT_MESSAGE_START` this adapter has handed over, which a run opens and a rotation moves.
   * Undefined until the first. A line the router adds while processing a chunk follows this
   * message: React's committed transcript lags the stream, and a line placed by it would land in
   * the bubble before a rotation the same batch made.
   */
  readonly streamMessageId: () => string | undefined
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
 * to be one. Not said on the transcript: the dialog is where the person is
 * looking, and a second copy there would be a duplicate.
 */
export type ConfigureOutcome =
  | { readonly outcome: 'told' }
  | { readonly outcome: 'refused'; readonly step: EnsoConfigurationRefusal['step']; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly status: number }
  | { readonly outcome: 'unreachable' }
/**
 * What `resolveIncident` reports (#466): recorded (204), or why not — the thread running (409), the
 * resolution refused (422, `incidentResolutionRefusal`'s reason), or any other answer with its
 * text — or the request never answered.
 */
export type IncidentResolveOutcome =
  | { readonly outcome: 'told' }
  | { readonly outcome: 'busy' | 'refused'; readonly reason: string }
  | { readonly outcome: 'unreachable' }

export function createFollowConnection(options: FollowConnectionOptions): FollowConnection {
  const { threadId } = options
  const leaving = options.leaving ?? pageLeaving
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
   * A frame that fails the wire schema has been reported on this connection.
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
  /**
   * Receipt ids of prompts this tab queued behind a run (#75).
   *
   * @invariant abort-clear-restore/queued-rejection-said A later rejection of a queued prompt is said, not matched to a run.
   * A `prompt-rejected` naming one of these is reported where the human looks and opens no run
   * error. `settled` forgets the ids: nothing behind a settled run can be refused any more; the
   * runtime claimed it, or a stop cleared it.
   */
  const queuedPrompts = new Set<string>()

  function push(...chunks: StreamChunk[]): void {
    queue.push(...chunks)
    wake?.()
    wake = undefined
  }

  function openRun(runId: string, promptMessageId: string | undefined, generation: number | undefined): OpenRun {
    const run: OpenRun = {
      runId,
      messageId: crypto.randomUUID(),
      promptMessageId,
      generation,
      assistantMessages: 0,
      refused: false,
    }
    runs.set(runId, run)
    current = run
    push(
      { type: EventType.RUN_STARTED, threadId, runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: run.messageId, role: 'assistant' },
    )
    return run
  }

  /**
   * End a run: its closing chunk, once. A run no longer open says nothing — closed already, or
   * forgotten when the client stopped taking chunks (`consumerStopped`): TanStack reset it, and a
   * late receipt's chunk would be yielded ahead of the next subscription's snapshot.
   */
  function closeRun(run: OpenRun, chunk: StreamChunk): void {
    if (!runs.delete(run.runId)) return
    if (current === run) current = undefined
    push(chunk)
  }

  /** End the run's assistant bubble and open a new one after it: everything that follows lands there. */
  function rotateMessage(run: OpenRun): void {
    const ended = run.messageId
    run.messageId = crypto.randomUUID()
    run.refused = false
    push(
      { type: EventType.TEXT_MESSAGE_END, messageId: ended },
      { type: EventType.TEXT_MESSAGE_START, messageId: run.messageId, role: 'assistant' },
    )
  }

  /**
   * A message boundary inside the run. Two of them rotate the assistant bubble:
   * - a USER message after an assistant message has begun: pi claimed a queued prompt (#75), so
   *   the reply lands after its question rather than inside the previous answer. The run's own
   *   prompt arrives before any assistant message and rotates nothing;
   * - an ASSISTANT message after a refused attempt: pi's retry (#382). Without it the refused
   *   attempt and the reply that got through share one bubble, and a line said between them has
   *   nowhere to go but after both.
   */
  function observeMessageStart(role: string): void {
    if (current === undefined) return
    if (role === 'assistant') {
      // Whatever began before the refusal — the attempt's own message, or none when the provider
      // refused before pi started one — stays in the bubble the refusal's lines follow.
      if (current.refused) rotateMessage(current)
      current.assistantMessages += 1
      return
    }
    if (role !== 'user' || current.assistantMessages === 0) return
    rotateMessage(current)
    current.assistantMessages = 0
  }

  function idsOf(run: OpenRun | undefined): AguiIdentifiers {
    return { threadId, runId: run?.runId ?? `external-${threadId}`, messageId: run?.messageId ?? threadId }
  }

  /** The server's latest word on the thread, from the last snapshot or status frame. */
  let serverGeneration = 0
  let serverBusy = false

  /** The assistant message of the chunk TanStack is processing — see {@link FollowConnection.streamMessageId}. */
  let streamMessageId: string | undefined

  /**
   * Close every run the server has moved past: `RUN_FINISHED` for each, so TanStack's
   * loading state resolves.
   *
   * @invariant prompt-run-settle/generation-fence A run closes only once the server has moved past its generation.
   * A run whose generation is still unknown (its receipt has not come back) or newer than the
   * server's is NOT closed: the frames ending an EARLIER run can arrive after this tab has
   * already opened the next one, and closing that one here would end it before it started.
   */
  function finishRunsThrough(generation: number): void {
    for (const run of runs.values()) {
      if (run.generation === undefined || run.generation > generation) continue
      closeRun(run, { type: EventType.RUN_FINISHED, threadId, runId: run.runId })
    }
  }

  /**
   * The thread's status. Busy under a generation this adapter did not send is a run another
   * client started.
   *
   * @invariant prompt-run-settle/two-endings Acceptance and completion are separate signals, so a run ends on either.
   * `onAccepted` is the runtime's preflight: taken, not finished (the `ThreadRuntime` contract).
   * One exception is deliberate: an extension command's acceptance IS its completion, so a slash
   * prompt releases on acceptance and never `settled`s. So a released status (`busy: false`) is
   * the server's statement that the run is over, as much as `settled` is.
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

  /**
   * A prompt pi refused at preflight: a prompt this tab queued, the prompt of an open run, or one
   * whose receipt has not landed yet. Each is said here, so nothing crosses to TanStack.
   */
  function observePromptRejected(observation: EnsoPromptRejected): void {
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
  }

  /** What an observation does to this adapter's own state before its chunks cross. */
  function observeBeforeCrossing(observation: EnsoObservation): void {
    if (observation.kind === 'message-start') observeMessageStart(observation.role)
    if (observation.kind === 'provider-refused' && current !== undefined) current.refused = true
    if (observation.kind === 'extension-ui-request' && observation.blocking && observation.dialog === undefined) {
      if (observation.id.length > 0) void declineUnreadable(observation.id)
    }
    if (observation.kind === 'tool-result' && observation.complete && observation.descriptor !== undefined) {
      options.onToolResultDescriptor?.(observation.toolCallId, observation.descriptor)
    }
    if (observation.kind === 'turn-start') options.onTurnStart?.()
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
    if (observation.kind === 'prompt-rejected') {
      observePromptRejected(observation)
      return
    }
    observeBeforeCrossing(observation)
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
    // Leaving, the refusal is the browser's cancel, not the server's (#664): no failure to log —
    // but the follow is still ended, as the pump says it (a restored page must know).
    if (!leaving()) problem('the follow could not be opened: {detail}', { detail })
    yield { type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId } }
  }

  /**
   * What the open produced: a live response, this page's own release, or a refusal with the
   * detail to report. Separate from `subscribe` so the three answers are one `switch` there
   * instead of three interleaved with the pump's own control flow.
   */
  type FollowOpening =
    // The BODY, not the response: `openFollow` has already established there is one, and a
    // `Response` here would make `subscribe` re-check a null it cannot receive.
    | { readonly kind: 'opened'; readonly body: ReadableStream<Uint8Array> }
    | { readonly kind: 'released' }
    | { readonly kind: 'refused'; readonly detail: string; readonly failure: Error }

  async function openFollow(abort: AbortSignal): Promise<FollowOpening> {
    let response: Response
    try {
      response = await fetchImpl(`${base}/follow`, { signal: abort })
    } catch (error) {
      // ⚠ Released while the socket was still OPENING. `close()` is silent by
      // contract — the page letting a thread go is not an error the page should be shown — but
      // the abort lands on this fetch, whose rejection had nowhere to go but out of the
      // generator, at whoever is iterating it. Our own release ends the iteration instead.
      if (released.signal.aborted) return { kind: 'released' }
      const failure = error instanceof Error ? error : new Error(String(error))
      return { kind: 'refused', detail: String(error), failure }
    }
    if (response.ok && response.body !== null) return { kind: 'opened', body: response.body }
    // ⚠ The status is the fact; the body is colour. Reading it can itself
    // reject — a truncated or aborted body — and that rejection would have thrown past the
    // arming in `subscribe`, leaving the page saying "live" for a follow the server just
    // refused, which is the state #274 exists to end. The read cannot decide whether the
    // contract is armed.
    const body = await response.text().catch((error: unknown) => `(body unreadable: ${String(error)})`)
    const detail = `${response.status} ${body}`
    return { kind: 'refused', detail, failure: new Error(`follow ${threadId}: ${detail}`) }
  }

  /**
   * A follow that closed, whoever closed it. Its open runs end as errors, or the client would wait
   * on them forever — unless the client is the one that stopped (`consumerGone`): nothing will take
   * a chunk any more, so they are forgotten instead of queued for nobody.
   *
   * The follow ended under this page (#103 receipt, step 8) — not this page releasing it, nor this
   * subscription stopping itself (`follow`). Said as a chunk so the page can show it and the debug
   * pane refetches: with no run open nothing else would mention it, and the pane would keep
   * presenting its last fetch of a session that may no longer exist as current.
   * ⚠ Said even while the page is leaving (#664): the follow HAS ended, and a page the
   * back/forward cache restores must know it — a live-looking page over a dead follow is what #274
   * ended. Only the "failed" log line was false; that one is gated.
   */
  function followClosed(follow: AbortSignal, consumerGone: boolean): void {
    if (consumerGone) {
      runs.clear()
      current = undefined
    }
    for (const run of runs.values()) {
      closeRun(run, {
        type: EventType.RUN_ERROR,
        runId: run.runId,
        message: 'the follow closed before the run settled',
      })
    }
    if (!follow.aborted) push({ type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId } })
    wake?.()
    wake = undefined
  }

  /**
   * The client stopped taking chunks while the follow was live (#915): said, and what it never took
   * is dropped.
   *
   * ⚠ TanStack's loop leaves a subscription for two reasons only: its own abort (which is
   * `abort`, and silent) or a THROW from handling the chunk it was just handed — its stream
   * processor, a callback of ours, a React update. That throw lands in TanStack's `for await`, and
   * this adapter only sees the loop return. Before this, the return waited on a follow the server
   * keeps open for the whole run: the loop never finished, TanStack never reached the `catch` that
   * reports it, and the page stopped applying the thread without a word while frames kept
   * arriving — #915, a tab frozen at a `write` for 20 minutes and 23 tool calls, nothing logged.
   * The chunk is named; the exception is TanStack's to hand on (`chat.error`, `thread-pane.tsx`).
   */
  function consumerStopped(state: Following, abort: AbortSignal): void {
    if (state.handing === undefined || abort.aborted) return
    state.consumerGone = true
    queue.length = 0
    const name = state.handing.type === EventType.CUSTOM ? state.handing.name : state.handing.type
    problem(
      "this page stopped applying the thread's updates: handling a {chunk} chunk failed. What it shows is as of then, and the thread may have moved on — reload the page to catch up",
      { chunk: name },
    )
  }

  /** One subscription's state the pump and the yielding loop share. */
  interface Following {
    /** The pump has stopped: nothing more will be queued. */
    ended: boolean
    /** The client stopped taking chunks (`consumerStopped`). */
    consumerGone: boolean
    /** The chunk handed over and not yet taken back: the one being handled if the client stops. */
    handing: StreamChunk | undefined
  }

  /**
   * Frames off the follow, observed into the queue, on their own loop so `send` can interleave
   * chunks. Ends when the server closes the follow, the wire fails, or `follow` aborts.
   */
  async function pumpFrames(frames: AsyncGenerator<unknown>, follow: AbortSignal, state: Following): Promise<void> {
    try {
      for await (const raw of frames) {
        if (follow.aborted) break
        if (admitted(raw)) observe(raw)
      }
      // The server closed it: `followClosed` says so on the page; this is the record of why.
      if (!follow.aborted && !leaving()) log.warn('the follow ended: the server closed it')
    } catch (error) {
      // ⚠ #664: a stream the browser cut because the page is leaving is not a failure — every
      // reload logged "the follow failed: TypeError: network error" for each followed thread.
      if (!follow.aborted && !leaving()) problem('the follow failed: {error}', { error: String(error) })
    } finally {
      state.ended = true
      followClosed(follow, state.consumerGone)
    }
  }

  /**
   * The next queued chunk, or undefined when none is. Its message is read here, at the hand-over,
   * not where the chunk was queued: TanStack processes one chunk to the end — custom events
   * included — before it asks for the next, so this is the message of the chunk being processed,
   * whatever the pump has queued behind it.
   */
  function takeQueued(): StreamChunk | undefined {
    const next = queue.shift()
    if (next?.type === EventType.TEXT_MESSAGE_START) streamMessageId = next.messageId
    return next
  }

  async function* subscribe(signal?: AbortSignal): AsyncIterable<StreamChunk> {
    // The page's own end (#272) rides with TanStack's: either one closes the socket, and a
    // connection already released never opens one.
    if (released.signal.aborted) return
    const abort = signal === undefined ? released.signal : AbortSignal.any([signal, released.signal])
    // This subscription's own end (#915): when the loop below is done, for any reason, the socket
    // closes and the pump ends with it — nothing waits on a stream the server keeps open.
    const stop = new AbortController()
    const follow = AbortSignal.any([abort, stop.signal])
    const opening = await openFollow(follow)
    if (opening.kind === 'released') return
    if (opening.kind === 'refused') {
      // A throwing fetch is the same fact as a refusing one (#274) — unless the CALLER is the
      // one leaving, in which case there is nothing to report and the cancel is theirs to see.
      if (!abort.aborted) yield* followNeverOpened(opening.detail)
      throw opening.failure
    }
    // The pump fills the queue; this loop hands it over, waiting when nothing is queued.
    const state: Following = { ended: false, consumerGone: false, handing: undefined }
    const pump = pumpFrames(readSseFrames(opening.body, follow), follow, state)
    try {
      while (!abort.aborted) {
        const next = takeQueued()
        if (next === undefined) {
          if (state.ended) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          continue
        }
        state.handing = next
        yield next
        state.handing = undefined
      }
    } finally {
      consumerStopped(state, abort)
      stop.abort()
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

  async function resolveIncident(
    incidentId: string,
    resolution: EnsoIncidentResolution,
  ): Promise<IncidentResolveOutcome> {
    const response = await post(`incidents/${encodeURIComponent(incidentId)}/resolve`, `resolve ${incidentId}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolution),
    })
    if (response === undefined) return { outcome: 'unreachable' }
    if (response.status === 204) return { outcome: 'told' }
    const reason = await response.text()
    log.warn('incident {incidentId} not resolved: {status} {reason}', { incidentId, status: response.status, reason })
    return { outcome: response.status === 409 ? 'busy' : 'refused', reason: reason || `${response.status}` }
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
    resolveIncident,
    close,
    streamMessageId: () => streamMessageId,
  }
}
