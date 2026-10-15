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
  type EnsoMessageStart,
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
import { PAGE_HEALTH_TIMING, reportPageFault } from './page-health.ts'
import { pageLeaving } from './page-leaving.ts'
import { createStore, type Store } from './store.ts'
import { type AguiIdentifiers, extensionErrorMessage, observationToAguiEvents } from './to-agui.ts'

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

/** The `runId` prefix of a run another client started, synthesised from its generation. */
const EXTERNAL_RUN = 'external-'

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
   * The assistant message the view is streaming into. Rotates on every assistant message after the
   * run's first (#921); when pi delivers a prompt — a queued one it claims (#75), one steered in
   * right after the opening prompt, or the opening prompt of a run another client started (#917),
   * but not the opening prompt of a run this page sent (`awaitingOwnOpeningPrompt`); and when pi
   * starts a new attempt after a refused one (#382).
   */
  messageId: string
  /** The receipt's `messageId` — how a `prompt-rejected` names this run. Undefined for a run another client started. */
  promptMessageId: string | undefined
  generation: number | undefined
  /**
   * A run THIS page sent, whose opening prompt pi has not yet delivered: TanStack already drew
   * that one, so its `message-start` adds nothing. Every other USER `message-start` is a prompt
   * pi delivers — queued behind the run, steered in right after its opening prompt, or the
   * opening prompt of a run another client started — and is drawn (#917). Cleared also by the
   * first assistant message: past it, the opening prompt is behind the run.
   */
  awaitingOwnOpeningPrompt: boolean
  /**
   * Assistant messages pi has begun in this run since the last prompt it delivered. Every one
   * after the first is a new model turn and gets its own bubble (#921), as the stored history
   * draws it.
   */
  assistantMessages: number
  /**
   * A provider refused this run's current attempt (#382). pi's retry then begins a new assistant
   * message, and the view gives it a new bubble: the refused attempt keeps its own, and the lines
   * said about it (`refused: …`, `retrying in …`) read between the two, not after the reply.
   */
  refused: boolean
  /** When this page opened it (`Date.now()`): the run's elapsed time on the status bar (#914). */
  readonly startedAt: number
  /** pi's settle said a Stop ended it (#766) — set as the settle closes it. */
  aborted: boolean
  /** What failed in it while it ran (#914): an extension's error. The run's ending carries it. */
  error: string | undefined
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

/** How many times per `stallMs` the hand-over watchdog looks: a stall is said within a quarter window of its threshold. */
const STALL_SAMPLES_PER_WINDOW = 4
/** The watchdog's shortest tick, for the tests' shortened `stallMs`: never a busy loop. */
const MIN_WATCHDOG_TICK_MS = 10

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
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  heard: () => void,
): AsyncGenerator<unknown> {
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
      // Any byte is the server heard from (#914) — a keepalive comment as much as a frame.
      heard()
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

/**
 * Whether this page is receiving the thread's updates (#914), from the follow's BYTES — the
 * server's `: keepalive` every 5 s included — not from the events they carry, which a quiet run
 * may go minutes without.
 *
 *   live    the follow is open and the server is heard from;
 *   silent  the follow is open and not one byte has arrived for `silentMs` (the 5 s keepalive
 *           missed twice): a dead connection the browser has not noticed, or a server that hung;
 *   ended   the follow closed, failed, never opened, or was abandoned after going silent.
 *
 * `since` is when the page last heard from the server. A silent follow that is heard from again is
 * live again, and missed nothing: the bytes were held, not lost. An ended one stays ended — the
 * follow has no cursor to resume from (`server/follow.ts`, `resume/cold-then-live`), so what the
 * thread did meanwhile reaches this page only through a reload (`live-view-check.ts`).
 */
export type LiveView = { readonly state: 'live' } | { readonly state: 'silent' | 'ended'; readonly since: number }

/** A tool call the model is writing now (#914): pi's `toolcall_start` until its `toolcall_end`. */
export interface ComposingCall {
  readonly toolCallId: string
  readonly toolName: string
  /**
   * The arguments as they have streamed so far (#913): cut mid-JSON. The same text the call's
   * transcript row shows once it lands whole — a `write` being composed is drawn from it, labelled
   * as not applied.
   */
  readonly args: string
}

/**
 * The model request in flight (#913): from pi's `turn_start` (or the assistant message's start)
 * until the assistant message ends, when the provider's count replaces every figure here. The
 * output is counted in CHARACTERS as it streams — an estimate, said as one wherever it is shown.
 */
export interface RequestPulse {
  /** When this page saw the request open (`Date.now()`). */
  readonly startedAt: number
  /** Characters of thinking streamed so far. */
  readonly thinking: number
  /** Characters of reply text streamed so far. */
  readonly text: number
  /** Characters of tool-call arguments streamed so far. */
  readonly tool: number
}

/** How the last run on this page ended (#914). */
export interface RunEnding {
  /** A Stop ended it: pi's settle said `aborted` (#766). */
  readonly aborted: boolean
  /** It ended on an error — a refused prompt, an extension's failure — with the error's words. */
  readonly error: string | undefined
}

/**
 * What the follow says of the run (#914, #913), read on each render by the status bar and by the
 * Context, Stats and Diff views (`ThreadViewOverlay`).
 */
export interface RunPulse {
  /** When the oldest run open on this page opened (`Date.now()`); undefined while none is. */
  readonly runStartedAt: number | undefined
  /** The tool call the model is writing now; undefined while it writes none. */
  readonly composing: ComposingCall | undefined
  /** The model request in flight (#913); undefined between requests and at rest. */
  readonly request: RequestPulse | undefined
  /** How the last run ended; undefined before one has, and once the next opens. */
  readonly ended: RunEnding | undefined
}

/**
 * Whether a frame is the run's output (#914) — what "possibly stuck" waits on. Not a snapshot or a
 * status (the run's lifecycle, not its work), and not an extension's fire-and-forget UI request: the
 * harness's status line and widgets are re-sent every minute or so whatever the model does — measured
 * live, one a minute through a model request that never answered, which kept the page from ever
 * calling it stuck.
 */
function carriesOutput(frame: EnsoFollowFrame): boolean {
  if (frame.type !== 'observation') return false
  const { observation } = frame
  return observation.kind !== 'extension-ui-request' || observation.blocking
}

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
  /**
   * When this page last applied the follow (#919), `Date.now()`: the client took back the last
   * chunk handed to it, or a frame that passed the wire check and queued none was observed with
   * nothing waiting. Undefined while no follow is open, and from the moment the server closes one —
   * nothing is being applied, and a dropped follow is said otherwise.
   * What the page's server check compares the server's listing against (`page-behind-check.ts`).
   */
  readonly appliedAt: () => number | undefined
  /** Whether this page is receiving the thread's updates (#914) — see {@link LiveView}. */
  readonly liveView: Store<LiveView>
  /**
   * When the follow last carried the run's output (#914), `Date.now()`: an observation, never a
   * keepalive, a snapshot or a status, nor an extension's fire-and-forget UI request (`carriesOutput`).
   * Undefined before the first. What "no output for 3 min" is measured from.
   */
  readonly outputAt: () => number | undefined
  /** What the follow says of the run now (#914) — see {@link RunPulse}. */
  readonly pulse: () => RunPulse
  /**
   * Give up on a SILENT follow (#914): its socket closes and it ends as one the server closed
   * would — the run's error, `follow-ended`, `disconnected`. The page's live-view check calls it
   * once it knows a reload is the way back. Nothing while the follow is live or already ended.
   */
  readonly abandon: () => void
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
  /** `appliedAt`'s answer: set while a follow is open, undefined otherwise. */
  let appliedAt: number | undefined
  let wake: (() => void) | undefined
  const runs = new Map<string, OpenRun>()
  /** `liveView`'s value: live until the follow goes silent or ends (#914). */
  const liveView = createStore<LiveView>({ state: 'live' })
  /** `outputAt`'s answer: when the follow last carried a frame. */
  let outputAt: number | undefined
  /** The tool call the model is writing now — mutated per delta, copied out by `pulse` (#914). */
  let composing: { toolCallId: string; toolName: string; args: string } | undefined
  /** The model request in flight — mutated per delta, copied out by `pulse` (#913). */
  let request: { startedAt: number; thinking: number; text: number; tool: number } | undefined
  /** How the last run on this page ended; cleared when the next opens (#914). */
  let lastEnding: RunEnding | undefined
  /** Ends the open follow as the server closing it would (`abandon`); undefined while none is open. */
  let cutFollow: (() => void) | undefined
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

  function openRun(
    runId: string,
    promptMessageId: string | undefined,
    generation: number | undefined,
    origin: 'this-page' | 'another-client',
  ): OpenRun {
    const run: OpenRun = {
      runId,
      messageId: crypto.randomUUID(),
      promptMessageId,
      generation,
      awaitingOwnOpeningPrompt: origin === 'this-page',
      assistantMessages: 0,
      refused: false,
      startedAt: Date.now(),
      aborted: false,
      error: undefined,
    }
    runs.set(runId, run)
    current = run
    // The status bar says how the last run ended until the next prompt (#914): this is the next.
    lastEnding = undefined
    push(
      { type: EventType.RUN_STARTED, threadId, runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: run.messageId, role: 'assistant' },
    )
    return run
  }

  /**
   * The run is over for the client: its closing chunk, once. `known` is false when this page cannot
   * tell HOW it ended — the follow closed under it — so no ending is recorded, and the bar says the
   * live view is lost instead. A run no longer open says nothing — closed already, or forgotten when
   * the client stopped taking chunks (`consumerStopped`): TanStack reset it, and a late receipt's
   * chunk would be yielded ahead of the next subscription's snapshot.
   */
  function closeRun(run: OpenRun, chunk: StreamChunk, known = true): void {
    if (!runs.delete(run.runId)) return
    if (current === run) current = undefined
    if (runs.size === 0) {
      composing = undefined
      request = undefined
    }
    if (known) {
      const error = chunk.type === EventType.RUN_ERROR ? chunk.message : run.error
      lastEnding = { aborted: run.aborted, error }
    }
    push(chunk)
  }

  /**
   * A tool call the model is writing (#914), off pi's own `message_update` events, which cross as
   * `unmapped` (`host/map-events.ts`): `toolcall_start` names the tool, each `toolcall_delta` adds to
   * its arguments, `toolcall_end` ends it. The arguments are kept whole (#913): the Diff view draws a
   * `write` being composed from them — the same text the call's row holds once it lands.
   */
  function observeComposing(event: unknown): void {
    if (typeof event !== 'object' || event === null) return
    const { type, assistantMessageEvent: update } = event as {
      type?: unknown
      assistantMessageEvent?: { type?: unknown; id?: unknown; toolName?: unknown; delta?: unknown }
    }
    if (type !== 'message_update' || update === undefined) return
    if (update.type === 'toolcall_start') {
      composing = {
        toolCallId: typeof update.id === 'string' ? update.id : '',
        toolName: typeof update.toolName === 'string' ? update.toolName : 'a tool call',
        args: '',
      }
      return
    }
    if (update.type === 'toolcall_delta' && typeof update.delta === 'string') {
      observeToolArguments(update.delta)
      return
    }
    if (update.type === 'toolcall_end') composing = undefined
  }

  /** A piece of a call's arguments: the call's text grows, and so does the request's output (#913). */
  function observeToolArguments(delta: string): void {
    if (current !== undefined) request ??= { startedAt: Date.now(), thinking: 0, text: 0, tool: 0 }
    if (request !== undefined) request.tool += delta.length
    if (composing !== undefined) composing.args += delta
  }

  /**
   * The request in flight (#913): opened by `turn-start` — or, for a page that joined mid-request,
   * the assistant message's start or its first delta, timed from when this page saw it — grown by
   * each delta, ended by the assistant message's end, whose usage is the provider's count.
   */
  function observeRequest(observation: EnsoObservation): void {
    if (observation.kind === 'turn-start') {
      request = { startedAt: Date.now(), thinking: 0, text: 0, tool: 0 }
      return
    }
    if (observation.kind === 'message-end') {
      if (observation.role === 'assistant') request = undefined
      return
    }
    const opens =
      (observation.kind === 'message-start' && observation.role === 'assistant') ||
      observation.kind === 'thinking-delta' ||
      observation.kind === 'text-delta'
    if (!opens || current === undefined) return
    request ??= { startedAt: Date.now(), thinking: 0, text: 0, tool: 0 }
    if (observation.kind === 'thinking-delta') request.thinking += observation.delta.length
    else if (observation.kind === 'text-delta') request.text += observation.delta.length
  }

  function pulse(): RunPulse {
    let runStartedAt: number | undefined
    for (const run of runs.values()) {
      if (runStartedAt === undefined || run.startedAt < runStartedAt) runStartedAt = run.startedAt
    }
    return {
      runStartedAt,
      composing: composing === undefined ? undefined : { ...composing },
      request: request === undefined ? undefined : { ...request },
      ended: lastEnding,
    }
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
   * The prompt pi has just DELIVERED, as a user bubble between the assistant bubble that ends and
   * the one that opens (#917). A prompt typed during a run is not in the transcript while pi holds
   * it — only in the queue above the composer — so this is where it lands, on every page following
   * the thread, when pi actually sends it. Text only: pi's `message-start` carries the words, not
   * the images a queued prompt was sent with; a reload draws those from the stored branch.
   */
  function deliverPrompt(run: OpenRun, text: string): void {
    const ended = run.messageId
    const prompt = crypto.randomUUID()
    run.messageId = crypto.randomUUID()
    run.refused = false
    push(
      { type: EventType.TEXT_MESSAGE_END, messageId: ended },
      { type: EventType.TEXT_MESSAGE_START, messageId: prompt, role: 'user' },
      ...(text.length === 0 ? [] : [{ type: EventType.TEXT_MESSAGE_CONTENT as const, messageId: prompt, delta: text }]),
      { type: EventType.TEXT_MESSAGE_END, messageId: prompt },
      { type: EventType.TEXT_MESSAGE_START, messageId: run.messageId, role: 'assistant' },
    )
  }

  /**
   * A message boundary inside the run. Three of them rotate the assistant bubble:
   * - an ASSISTANT message after another one: a new model turn (#921). Thinking and text are
   *   keyed by the bubble's id, so in one bubble each turn's thinking appended to the run's first
   *   thinking part, above every later tool row. One bubble per assistant message is what the
   *   stored history draws, so the live view and a reload read the same;
   * - a USER message pi delivers: a queued prompt pi claimed (#75), one it steered in right after
   *   the run's opening prompt (pi polls its queue as the loop begins; in `"all"` mode it sends
   *   every waiting prompt back to back), or the opening prompt of a run another page started.
   *   Its bubble goes in there (#917), and the reply lands after its question rather than inside
   *   the previous answer. Only the opening prompt of a run THIS page sent adds nothing: TanStack
   *   already put it there (`awaitingOwnOpeningPrompt`);
   * - an ASSISTANT message after a refused attempt: pi's retry (#382). Without it the refused
   *   attempt and the reply that got through share one bubble, and a line said between them has
   *   nowhere to go but after both.
   */
  function observeMessageStart(observation: EnsoMessageStart): void {
    if (current === undefined) return
    if (observation.role === 'assistant') {
      // Any assistant message after one already begun is a new model turn, with its own bubble
      // (#921). After a refusal, so is the retry even when this view saw no message begin before
      // it (a page that joined mid-attempt): the refused attempt keeps the bubble the refusal's
      // lines follow. Both at once rotate once.
      if (current.refused || current.assistantMessages > 0) rotateMessage(current)
      current.assistantMessages += 1
      current.awaitingOwnOpeningPrompt = false
      return
    }
    if (observation.role !== 'user') return
    if (current.awaitingOwnOpeningPrompt) {
      current.awaitingOwnOpeningPrompt = false
      return
    }
    deliverPrompt(current, observation.text ?? '')
    current.assistantMessages = 0
  }

  function idsOf(run: OpenRun | undefined): AguiIdentifiers {
    return { threadId, runId: run?.runId ?? `${EXTERNAL_RUN}${threadId}`, messageId: run?.messageId ?? threadId }
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
   * `aborted`: pi's settle said a Stop ended them (#766), which their ending carries (#914).
   */
  function finishRunsThrough(generation: number, aborted = false): void {
    for (const run of runs.values()) {
      if (run.generation === undefined || run.generation > generation) continue
      run.aborted = aborted
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
    openRun(`${EXTERNAL_RUN}${generation}`, undefined, generation, 'another-client')
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
    if (observation.kind === 'message-start') observeMessageStart(observation)
    if (observation.kind === 'provider-refused' && current !== undefined) current.refused = true
    if (observation.kind === 'extension-ui-request' && observation.blocking && observation.dialog === undefined) {
      if (observation.id.length > 0) void declineUnreadable(observation.id)
    }
    if (observation.kind === 'tool-result' && observation.complete && observation.descriptor !== undefined) {
      options.onToolResultDescriptor?.(observation.toolCallId, observation.descriptor)
    }
    if (observation.kind === 'turn-start') options.onTurnStart?.()
    observeRun(observation)
  }

  /**
   * What the follow says of the run (#914): the request in flight (`observeRequest`, #913), a call
   * the model is writing — ended once pi runs it, and a new message starts none — and an
   * extension's failure, which ends the client's run now (`to-agui.ts`); pi's run settles later,
   * and its ending says it too. Read through `pulse()` by the status bar and the views.
   */
  function observeRun(observation: EnsoObservation): void {
    observeRequest(observation)
    if (observation.kind === 'unmapped') observeComposing(observation.event)
    if (observation.kind === 'tool-call' || observation.kind === 'message-start') composing = undefined
    if (observation.kind !== 'extension-error') return
    const error = extensionErrorMessage(observation)
    if (current !== undefined) current.error = error
    lastEnding = { aborted: false, error }
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
      finishRunsThrough(serverGeneration, observation.aborted)
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
      closeRun(
        run,
        { type: EventType.RUN_ERROR, runId: run.runId, message: 'the follow closed before the run settled' },
        false,
      )
    }
    if (!follow.aborted) {
      followLost()
      push({ type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId } })
    }
    wake?.()
    wake = undefined
  }

  /** The follow is gone (#914): the live view ends as of when the server was last heard from. */
  function followLost(heardAt = Date.now()): void {
    const view = liveView.get()
    if (view.state === 'ended') return
    liveView.set({ state: 'ended', since: view.state === 'silent' ? view.since : heardAt })
  }

  /**
   * The watchdog on hearing from the server (#914): no byte for `silentMs` — the 5 s keepalive
   * missed twice, read every second — and the live view is silent until one arrives. Not a fault by itself: the
   * page's live-view check decides whether to wait or to ask for a reload (`live-view-check.ts`).
   */
  function watchSilence(state: Following): () => void {
    const { silentMs } = PAGE_HEALTH_TIMING
    const timer = setInterval(
      () => {
        if (state.ended || liveView.get().state !== 'live' || Date.now() - state.heardAt < silentMs) return
        const seconds = Math.round((Date.now() - state.heardAt) / 1000)
        log.warn('the follow has been silent for {seconds}s: no event and no keepalive', { seconds })
        liveView.set({ state: 'silent', since: state.heardAt })
      },
      Math.min(Math.max(silentMs / 4, 10), 1000),
    )
    return () => clearInterval(timer)
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
    reportPageFault({
      trigger: 'stalled',
      threadId,
      error: `the chat client stopped taking chunks while handling a ${name} chunk`,
    })
  }

  /**
   * The watchdog on applying (#919): a chunk handed to the client and not taken back for
   * `stallMs` is a stall, said once per subscription. ⚠ TanStack handles a chunk synchronously
   * and asks for the next (`consumeSubscription`); a hand-over that lasts seconds is a client that
   * will not come back — #915's shape when the throw does not even reach its loop. One timer per
   * subscription, not one per chunk: deltas are handed thousands at a time.
   */
  function watchHandOver(state: Following): () => void {
    const { stallMs } = PAGE_HEALTH_TIMING
    const tickMs = Math.max(stallMs / STALL_SAMPLES_PER_WINDOW, MIN_WATCHDOG_TICK_MS)
    const timer = setInterval(() => {
      if (state.stalled || state.handing === undefined || Date.now() - state.handedAt < stallMs) return
      state.stalled = true
      const name = state.handing.type === EventType.CUSTOM ? state.handing.name : state.handing.type
      const seconds = Math.round((Date.now() - state.handedAt) / 1000)
      problem(
        "this page has not applied the thread's updates for {seconds}s: a {chunk} chunk is still being handled. What it shows may be out of date — reload the page to catch up",
        { seconds, chunk: name },
      )
      reportPageFault({
        trigger: 'stalled',
        threadId,
        error: `a ${name} chunk handed to the chat client ${seconds}s ago was never taken back`,
      })
    }, tickMs)
    return () => clearInterval(timer)
  }

  /** One subscription's state the pump and the yielding loop share. */
  interface Following {
    /** The pump has stopped: nothing more will be queued. */
    ended: boolean
    /** The client stopped taking chunks (`consumerStopped`). */
    consumerGone: boolean
    /** The chunk handed over and not yet taken back: the one being handled if the client stops. */
    handing: StreamChunk | undefined
    /** When `handing` was handed over (`Date.now()`). */
    handedAt: number
    /** The watchdog has said this subscription stalled (`watchHandOver`). */
    stalled: boolean
    /** When the follow last carried a byte, a keepalive included (`watchSilence`, #914). */
    heardAt: number
  }

  /** One frame off the follow: observed if this page can read it, then the applied mark when nothing waits. */
  function takeFrame(raw: unknown, state: Following): void {
    // One that fails `admitted` applied nothing: the page is as stale as before it came.
    if (!admitted(raw)) return
    if (carriesOutput(raw)) outputAt = Date.now()
    observe(raw)
    // A frame that queued nothing for the client is applied once it is observed.
    if (queue.length === 0 && state.handing === undefined) appliedAt = Date.now()
  }

  /**
   * Frames off the follow, observed into the queue, on their own loop so `send` can interleave
   * chunks. Ends when the server closes the follow, the wire fails, or `follow` aborts.
   */
  async function pumpFrames(
    frames: AsyncGenerator<unknown>,
    follow: AbortSignal,
    state: Following,
    cut: AbortSignal,
  ): Promise<void> {
    try {
      for await (const raw of frames) {
        if (follow.aborted) break
        takeFrame(raw, state)
      }
      // The server closed it, or this page gave up on it in silence (`abandon`): `followClosed`
      // says so on the page; this is the record of why.
      const why = cut.aborted ? 'abandoned after it went silent' : 'the server closed it'
      if (!follow.aborted && !leaving()) log.warn('the follow ended: {why}', { why })
    } catch (error) {
      // ⚠ #664: a stream the browser cut because the page is leaving is not a failure — every
      // reload logged "the follow failed: TypeError: network error" for each followed thread.
      if (!follow.aborted && !leaving()) problem('the follow failed: {error}', { error: String(error) })
    } finally {
      state.ended = true
      appliedAt = undefined
      cutFollow = undefined
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
      if (!abort.aborted) {
        followLost()
        yield* followNeverOpened(opening.detail)
      }
      throw opening.failure
    }
    // The pump fills the queue; this loop hands it over, waiting when nothing is queued.
    const state: Following = {
      ended: false,
      consumerGone: false,
      handing: undefined,
      handedAt: 0,
      stalled: false,
      heardAt: Date.now(),
    }
    appliedAt = Date.now()
    if (liveView.get().state !== 'live') liveView.set({ state: 'live' })
    // `abandon`'s cut ends the read the way the server closing the stream would: not `follow`, which
    // is this page's own end and says nothing.
    const cut = new AbortController()
    cutFollow = (): void => cut.abort()
    const heard = (): void => {
      state.heardAt = Date.now()
      if (liveView.get().state !== 'silent') return
      log.info('the follow is heard from again')
      liveView.set({ state: 'live' })
    }
    const pump = pumpFrames(
      readSseFrames(opening.body, AbortSignal.any([follow, cut.signal]), heard),
      follow,
      state,
      cut.signal,
    )
    const unwatch = watchHandOver(state)
    const unwatchSilence = watchSilence(state)
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
        state.handedAt = Date.now()
        yield next
        state.handing = undefined
        // Once the pump has ended, nothing yielded applies a follow: the follow is gone.
        if (!state.ended) appliedAt = Date.now()
      }
    } finally {
      unwatch()
      unwatchSilence()
      appliedAt = undefined
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
    const run = openRun(runContext?.runId ?? crypto.randomUUID(), undefined, undefined, 'this-page')
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

  /** A {@link post} carrying `body` as JSON: every route but `abort` and `continue` takes one. */
  function postJson(route: string, what: string, body: unknown): Promise<Response | undefined> {
    return post(route, what, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  async function answerDialog(answer: DialogAnswer): Promise<DialogAnswerOutcome> {
    const response = await postJson('dialog', `dialog ${answer.id}`, answer)
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
    const response = await postJson('mode', `mode ${mode}`, { mode })
    if (response === undefined) return 'unreachable'
    if (response.status === 204) return 'told'
    const outcome: ModeChangeOutcome = response.status === 409 ? 'busy' : 'refused'
    problem('mode change {outcome}: {status} {body}', { outcome, status: response.status, body: await response.text() })
    return outcome
  }

  async function runHostCommand(run: EnsoHostCommandRun): Promise<HostCommandOutcome> {
    const response = await postJson('command', `/${run.name}${run.value === undefined ? '' : ` ${run.value}`}`, run)
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
    const response = await postJson('prompt', 'queued prompt', body)
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

  function abandon(): void {
    if (liveView.get().state !== 'silent') return
    log.warn('abandoning the silent follow: a reload is the way back')
    cutFollow?.()
  }

  function close(): void {
    if (released.signal.aborted) return
    log.info('follow released')
    released.abort()
  }

  async function configure(configuration: EnsoSessionConfiguration): Promise<ConfigureOutcome> {
    const response = await postJson('configure', 'configure', configuration)
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
    const response = await postJson('fork', 'fork', { entryId })
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
    const response = await postJson(
      `incidents/${encodeURIComponent(incidentId)}/resolve`,
      `resolve ${incidentId}`,
      resolution,
    )
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
    appliedAt: () => appliedAt,
    liveView,
    outputAt: () => outputAt,
    pulse,
    abandon,
  }
}
