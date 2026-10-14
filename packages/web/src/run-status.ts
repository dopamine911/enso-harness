import { type EnsoSessionIncidents, openIncidentOf, summarizeToolInput, THREAD_STATUS_WORDS } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { automaticPartsForMessage, type ChatUISelectedToolPart, selectMessageUI } from '@tanstack/ai-client/ui'
import { toolResultState } from './EnsoToolResult.tsx'
import type { ComposingCall, LiveView, RunEnding, RunPulse } from './follow-connection.ts'
import type { PageFault } from './page-health.ts'
import type { EnsoPendingDialog, ProviderRefusalMark } from './thread-stores.ts'

/**
 * What the run and the page are doing, in one of five states (#914), each asking something
 * different of the person:
 *
 *   lost      the page is not receiving the thread's updates — reload;
 *   working   pi is at a named step, for so long — watch;
 *   waiting   pi waits on the person's answer — answer (over everything but a lost view);
 *   stuck     pi works and nothing has come from it for minutes — consider stopping;
 *   stopped   the run finished, was stopped, or failed, and how — read it; until the next prompt.
 *
 * Plus `idle` before anything ran here, and `behind` while the page says it may be out of date
 * (#919) — neither claims the run works or the page is live.
 *
 * ⚠ BUILT ON SIGNALS THE PAGE ALREADY HAS, NOT NEW DETECTORS: the follow's bytes and frames
 * (`FollowConnection.liveView`, `outputAt`, `pulse`), the page's fault (#919), the open question,
 * the provider's refusal and the session's incidents, and the transcript's tail. The status bar
 * reads them as it renders; the rail and the header read the headline it publishes.
 */

/**
 * The thresholds (#914). ⚠ Mutable only through {@link setRunStatusTimingForTest}: a mounted test
 * cannot wait three minutes.
 */
export const RUN_STATUS_TIMING = {
  /** No output event — keepalives do not count — for this long while working: possibly stuck. */
  stuckMs: 180_000,
  /** How often the bar's elapsed times move while a run is in flight. */
  tickMs: 1000,
}

const DEFAULT_RUN_STATUS_TIMING = { ...RUN_STATUS_TIMING }

/** Test seam: shorter thresholds; called with nothing, the defaults again. Never called from production code. */
export function setRunStatusTimingForTest(timing: Partial<typeof RUN_STATUS_TIMING> = DEFAULT_RUN_STATUS_TIMING): void {
  Object.assign(RUN_STATUS_TIMING, timing)
}

/** The step pi is at while it works (#914). */
export type RunStep =
  /** A model request is out and nothing has come back yet: before the first output, after tool results. */
  | { readonly kind: 'model' }
  /** The model is thinking; `text` is its thinking so far, whose last line the bar shows. */
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'writing' }
  /** The model is writing a tool call's arguments: `write src/x.ts`, 48 KB of them so far. */
  | { readonly kind: 'composing'; readonly tool: string; readonly subject: string | undefined; readonly size: number }
  /** pi runs the call; its result has not come back. */
  | { readonly kind: 'running'; readonly tool: string; readonly subject: string | undefined }

/** A step, with the identity its elapsed time is kept by: a new step starts the clock again. */
export interface StepReading {
  readonly step: RunStep
  readonly key: string
}

/** pi's tools name their subject by one of these; a composing call's arguments are cut mid-string. */
const PARTIAL_SUBJECT = /"(command|pattern|path|query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/g

/** The subject a call's arguments name so far — `src/x.ts`, `bun test` — as its transcript row would. */
function partialSubject(head: string): string | undefined {
  const fields: Record<string, string> = {}
  for (const [, key, raw] of head.matchAll(PARTIAL_SUBJECT)) {
    if (key === undefined || raw === undefined || key in fields) continue
    try {
      fields[key] = JSON.parse(`"${raw}"`) as string
    } catch {
      // An escape cut in half: the raw text reads well enough.
      fields[key] = raw
    }
  }
  return summarizeToolInput(fields)
}

/**
 * The step in progress (#914): a tool call the model is writing, else read off the transcript's
 * tail.
 *
 * The last AUTOMATIC part of the last message (TanStack's own selection, matched results folded
 * into their calls) is the step in progress: a call with no result yet is a tool running; a call
 * WITH its result means the model has the output and its next request is out — `model`, not
 * `running`, because the tool is done. Thinking and text are what they say. Anything else — no
 * assistant message yet, a user message as the tail, an image — is `model`: in flight, nothing
 * back yet.
 *
 * "The last message" skips assistant messages with NO parts at the tail (#418). Joining a run that
 * is already going (a reload) opens a new assistant message for what streams next, after the stored
 * one holding the step in progress; until something streams into it, that step is still the one in
 * progress. The skip stops at the first message with a part, or at a user message.
 *
 * ⓘ The catch-all DIVERGES from `selected-message-part.tsx` on purpose. The transcript renders
 * every part kind it has no handler for visibly; this is a one-line summary, and `model` is TRUE of
 * an image, a document, or an unmatched result at the tail — the run is in flight. The part itself
 * is still on screen in the transcript.
 *
 * ⚠ `selectMessageUI` HERE, `selectChatUI` in `transcript-selection.ts` (#282) — deliberately. The
 * transcript renders EVERY message, so a call in an earlier message whose result the server stamped
 * onto a later one must pair there. This reads only the LAST message, where that shape cannot arise:
 * a result is normalised into the message holding its call, and a result whose call is absent is
 * unmatched under both selections. What it buys: the whole-transcript selection allocated a selected
 * part per part plus two Maps and a Set on every streamed token to use one element — 76.4 µs per
 * delta at 600 messages, against 0.32 µs here (#282's measurement). `thread-status.test.tsx` pins
 * the cross-message shapes.
 */
export function describeStep(messages: ReadonlyArray<UIMessage>, composing: ComposingCall | undefined): StepReading {
  if (composing !== undefined) {
    return {
      step: {
        kind: 'composing',
        tool: composing.toolName,
        subject: partialSubject(composing.head),
        size: composing.size,
      },
      key: `composing:${composing.toolCallId}`,
    }
  }
  const message = messages.findLast((candidate) => candidate.role !== 'assistant' || candidate.parts.length > 0)
  const last = message === undefined ? undefined : selectMessageUI(message, {})
  if (last === undefined || last.message.role !== 'assistant') {
    return { step: { kind: 'model' }, key: `model:${message?.id ?? ''}` }
  }
  const parts = automaticPartsForMessage(last)
  const tail = parts.at(-1)
  const at = `${last.message.id}:${parts.length}`
  if (tail?.key === 'toolCall') return callStep(tail, at)
  if (tail?.key === 'thinking' && tail.part.type === 'thinking') {
    return { step: { kind: 'thinking', text: tail.part.content }, key: `thinking:${at}` }
  }
  if (tail?.key === 'text') return { step: { kind: 'writing' }, key: `writing:${at}` }
  return { step: { kind: 'model' }, key: `model:${at}` }
}

/** A tool call at the tail: running while its result is pending, else the model has the next request. */
function callStep(tail: ChatUISelectedToolPart, at: string): StepReading {
  // In flight, so the tail's run is open: no result is pending, never aborted.
  if (toolResultState(tail.result, true).status !== 'pending') return { step: { kind: 'model' }, key: `model:${at}` }
  let input = tail.input
  if (input === undefined) {
    try {
      input = JSON.parse(tail.part.arguments) as unknown
    } catch {
      input = undefined
    }
  }
  return {
    step: { kind: 'running', tool: tail.part.name, subject: summarizeToolInput(input) },
    key: `running:${tail.part.id}`,
  }
}

/** What the run and the page are doing (#914) — see the module header. */
export type RunStatus =
  | { readonly kind: 'idle' }
  /** Not receiving the thread's updates since `since`; `reload` once the page knows a reload is the way back. */
  | { readonly kind: 'lost'; readonly since: number | undefined; readonly reload: boolean }
  | { readonly kind: 'behind' }
  | { readonly kind: 'waiting'; readonly dialogId: string; readonly question: string }
  | {
      readonly kind: 'working'
      readonly step: RunStep
      readonly stepSince: number
      readonly runSince: number | undefined
    }
  | { readonly kind: 'stuck'; readonly step: RunStep; readonly stepSince: number; readonly quietSince: number }
  | {
      readonly kind: 'stopped'
      readonly ending: 'finished' | 'stopped' | 'failed'
      readonly reason: string | undefined
    }

/** Everything the status is read from, as of one render. */
export interface RunStatusInputs {
  readonly generating: boolean
  /** The step in progress (`describeStep`); read only while generating. */
  readonly step: StepReading
  /** When this page first saw that step. */
  readonly stepSince: number
  readonly liveView: LiveView
  /** The thread's follow ended (#119, `follow-ended`). */
  readonly disconnected: boolean
  /** The page's fault (#919): it may be out of date. */
  readonly fault: PageFault | undefined
  readonly dialog: EnsoPendingDialog | undefined
  readonly pulse: RunPulse
  readonly outputAt: number | undefined
  /** The provider's last refusal, while no reply has got through since (#340). */
  readonly refusal: ProviderRefusalMark | undefined
  readonly incidents: EnsoSessionIncidents
  readonly now: number
}

/**
 * The one status (#914), first that holds:
 *
 *   1. lost — the follow is silent or gone. Before anything else, a question included: a page that
 *      is not receiving the thread cannot vouch that the question is still open;
 *   2. behind — the page says it may be out of date (#919): nothing is claimed working or live;
 *   3. waiting — a question is open;
 *   4. stuck — in flight, and no frame, nor the run's start, nor a new step for `stuckMs`;
 *   5. working — in flight;
 *   6. stopped — how the last run here ended: a Stop, its error, the provider's refusal, a guard's
 *      halt (an open incident that suspended tools), or finished;
 *   7. idle — nothing has ended here yet.
 */
export function describeRunStatus(inputs: RunStatusInputs): RunStatus {
  const { liveView, fault, dialog, pulse } = inputs
  if (liveView.state !== 'live' || inputs.disconnected) {
    return { kind: 'lost', since: liveView.state === 'live' ? undefined : liveView.since, reload: fault !== undefined }
  }
  if (fault !== undefined) return { kind: 'behind' }
  if (dialog !== undefined) return { kind: 'waiting', dialogId: dialog.id, question: dialog.dialog.title }
  if (inputs.generating) {
    const { step } = inputs.step
    const { stepSince } = inputs
    const quietSince = Math.max(inputs.outputAt ?? 0, pulse.runStartedAt ?? 0, stepSince)
    if (inputs.now - quietSince >= RUN_STATUS_TIMING.stuckMs) return { kind: 'stuck', step, stepSince, quietSince }
    return { kind: 'working', step, stepSince, runSince: pulse.runStartedAt }
  }
  return pulse.ended === undefined ? { kind: 'idle' } : endingOf(pulse.ended, inputs)
}

/** How a run that ended says it: a Stop, its error, the provider's refusal, a guard's halt, or finished. */
function endingOf(ended: RunEnding, inputs: RunStatusInputs): RunStatus {
  if (ended.aborted) return { kind: 'stopped', ending: 'stopped', reason: undefined }
  if (ended.error !== undefined) return { kind: 'stopped', ending: 'failed', reason: ended.error }
  const { refusal } = inputs
  if (refusal !== undefined) {
    return {
      kind: 'stopped',
      ending: 'failed',
      reason: `${refusal.provider ?? 'the provider'}: ${refusal.refusalClass}`,
    }
  }
  if (openIncidentOf(inputs.incidents)?.opened.halted === true) {
    return { kind: 'stopped', ending: 'failed', reason: 'a guard halted it — an incident is open' }
  }
  return { kind: 'stopped', ending: 'finished', reason: undefined }
}

/** `42s`, `3m 12s`, `1h 4m`: an elapsed time at the bar's resolution. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** `812 B`, `4.2 KB`, `48 KB` — how much of a call's arguments the model has written. */
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  return size < 10_240 ? `${(size / 1024).toFixed(1)} KB` : `${Math.round(size / 1024)} KB`
}

/** The step in words: `composing write src/arcade.html · 48 KB`, `running bash bun test`. */
export function stepLabel(step: RunStep): string {
  switch (step.kind) {
    case 'model':
      return "waiting for the model's first output"
    case 'thinking':
      return 'thinking'
    case 'writing':
      return 'writing a reply'
    case 'composing':
      return `composing ${callNamed(step)} · ${formatSize(step.size)}`
    case 'running':
      return `running ${callNamed(step)}`
  }
}

/** A call as the bar names it: the tool, then its subject when it has one — `write site/index.html`. */
function callNamed(call: { readonly tool: string; readonly subject: string | undefined }): string {
  return call.subject === undefined ? call.tool : `${call.tool} ${call.subject}`
}

/** What has been open while nothing came: `model request open`, `running bash`. */
function quietStepLabel(step: RunStep): string {
  if (step.kind === 'model') return 'model request open'
  if (step.kind === 'composing' || step.kind === 'running') return `${step.kind} ${step.tool}`
  return stepLabel(step)
}

/** A moment as the clock on the wall reads it: `13:34`. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** `no output for 3 min (model request open since 13:34)` — an observation, never a verdict. */
export function stuckDetail(status: Extract<RunStatus, { kind: 'stuck' }>, now: number): string {
  const minutes = Math.floor((now - status.quietSince) / 60_000)
  const quiet = minutes < 1 ? formatElapsed(now - status.quietSince) : `${minutes} min`
  return `no output for ${quiet} (${quietStepLabel(status.step)} since ${clockTime(status.stepSince)})`
}

/** The last line of the thinking so far, cut at its start when long: the bar's live tail. */
export function thinkingTail(text: string): string {
  const line =
    text
      .trimEnd()
      .split('\n')
      .findLast((candidate) => candidate.trim().length > 0)
      ?.trim() ?? ''
  return line.length > THINKING_TAIL_CHARS ? `…${line.slice(-THINKING_TAIL_CHARS)}` : line
}

const THINKING_TAIL_CHARS = 120

/** The words a lost live view says: still trying, or the way back. */
export function lostDetail(reload: boolean): string {
  return reload ? 'Reload to catch up' : 'not receiving updates — reconnecting…'
}

/** The state the rail and the header show: the status's kind, with a stopped run's ending said apart. */
export type RunHeadlineState =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'stuck'
  | 'finished'
  | 'stopped'
  | 'failed'
  | 'lost'
  | 'behind'

/**
 * The status as the rail row and the header say it (#914): its word and one detail — no clock, so
 * it changes when the state or the step does, not every second. Published by the thread's status bar.
 */
export interface RunHeadline {
  readonly state: RunHeadlineState
  readonly word: string
  readonly detail: string | undefined
}

/** The headline of a status. */
export function headlineOf(status: RunStatus): RunHeadline {
  switch (status.kind) {
    case 'idle':
      return { state: 'idle', word: THREAD_STATUS_WORDS.idle, detail: undefined }
    case 'lost':
      return { state: 'lost', word: THREAD_STATUS_WORDS.lost, detail: lostDetail(status.reload) }
    case 'behind':
      return { state: 'behind', word: THREAD_STATUS_WORDS.behind, detail: undefined }
    case 'waiting':
      return { state: 'waiting', word: THREAD_STATUS_WORDS.waiting, detail: status.question }
    case 'working':
      return { state: 'working', word: THREAD_STATUS_WORDS.working, detail: stepLabel(status.step) }
    case 'stuck':
      return { state: 'stuck', word: THREAD_STATUS_WORDS.stuck, detail: quietStepLabel(status.step) }
    case 'stopped':
      return {
        state: status.ending,
        word: THREAD_STATUS_WORDS[status.ending],
        detail: status.reason,
      }
  }
}

/**
 * Each state's dot, shared by the bar, the header and the rail row: solid in the running colour
 * while pi works, violet while it waits on you, a refusal-coloured ring when it may be stuck, a
 * refusal-coloured dot when the run failed, a refusal-coloured diamond when the page is not live
 * (#119) or out of date (#919), the ok colour once a run finished, a hollow square once a Stop ended
 * it, a hollow ring at rest. ⚠ Static, never pulsing (#739): any CSS animation, even a stepped or
 * `motion-safe:` one, keeps the compositor ticking for as long as pi works — 40–55% of a GPU process
 * in the live run. The colour and the word beside the dot already say it.
 */
export const RUN_DOT: Readonly<Record<RunHeadlineState, string>> = {
  idle: 'size-2 shrink-0 rounded-full border-dot border-muted-foreground',
  working: 'size-2 shrink-0 rounded-full bg-evidence signal:shadow-glow-evidence',
  waiting: 'size-2 shrink-0 rounded-full bg-human signal:shadow-glow-human',
  stuck: 'size-2 shrink-0 rounded-full border-dot border-refuse',
  finished: 'size-2 shrink-0 rounded-full bg-ok',
  stopped: 'size-2 shrink-0 rounded-xs border-dot border-muted-foreground',
  failed: 'size-2 shrink-0 rounded-full bg-refuse',
  lost: 'size-2 shrink-0 rotate-45 rounded-xs bg-refuse',
  behind: 'size-2 shrink-0 rotate-45 rounded-xs bg-refuse',
}

/** Each state's word colour: the running colour, the human colour, the refusal colour, or plain. */
export const RUN_WORD_COLOUR: Readonly<Record<RunHeadlineState, string>> = {
  idle: 'text-foreground',
  working: 'text-evidence',
  waiting: 'text-human',
  stuck: 'text-refuse',
  finished: 'text-foreground',
  stopped: 'text-foreground',
  failed: 'text-refuse',
  lost: 'text-refuse',
  behind: 'text-refuse',
}

/**
 * Bring the open question's card into view and put focus in it (#914): the status's jump to the
 * card. The caller shows the Chat view first; this runs once it is laid out.
 */
export function revealQuestion(dialogId: string): void {
  const card = document.getElementById(`enso-dialog-title-${dialogId}`)?.closest<HTMLElement>('[role="group"]')
  if (card === null || card === undefined) return
  card.scrollIntoView({ block: 'center', behavior: 'smooth' })
  card.querySelector<HTMLElement>('button, input, textarea')?.focus({ preventScroll: true })
}

/** The Stop each thread's composer offers (#914): the status bar's Stop beside "possibly stuck" is the same. */
const paneStops = new WeakMap<object, () => void>()

/** Offer the composer's Stop to the status bar; the cleanup withdraws it. */
export function offerPaneStop(stores: object, stop: () => void): () => void {
  paneStops.set(stores, stop)
  return (): void => {
    if (paneStops.get(stores) === stop) paneStops.delete(stores)
  }
}

/** The Stop the thread's composer offers — undefined while no composer holds the thread. */
export function paneStopOf(stores: object): (() => void) | undefined {
  return paneStops.get(stores)
}
