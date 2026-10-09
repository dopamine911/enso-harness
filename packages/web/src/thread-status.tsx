import {
  ENSO_UI_EVENTS,
  type EnsoContextUsage,
  type EnsoSessionIncidents,
  type EnsoSessionRiskChange,
  type EnsoSessionUsage,
  type EnsoThreadStatusKind,
  openIncidentOf,
  type ProviderRefusalClass,
  THREAD_STATUS_WORDS,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { automaticPartsForMessage, selectMessageUI } from '@tanstack/ai-client/ui'
import { useEffect } from 'react'
import { toolResultState } from './EnsoToolResult.tsx'
import { useThreadReadable } from './model-state.tsx'
import { useStore, useThreadStores } from './store.ts'
import { GitIndicator, type GitOutcome, settledToolResults, useThreadGit } from './thread-git.tsx'
import { type EnsoPendingDialog } from './thread-stores.ts'
import { ThreadTreeButton } from './thread-tree-pages.tsx'
import { announceUiEvent } from './ui-events.ts'

/**
 * The status bar (#90 PR 1): the always-on line that says what this session is doing and
 * what it has cost, so the answer to "is anything happening?" is a glance, not a prompt.
 *
 * deepseek-harness's footer is the reference: `97 turns · 111 steps · LLM 23m5s · …` — the bar
 * is WHERE YOU LOOK, so it is always there.
 *
 * ⚠ ALWAYS VISIBLE, ZEROS INCLUDED. The original bar (#45, `SessionStatsBar`, since removed) hid until the first counted
 * request so an all-zero line would not read as a broken meter. That was the wrong call for
 * a bar whose job is to be the place you look: a fresh session reading `idle · 0 prompts ·
 * $0.0000` is the honest state, the same reasoning that put `default` in the mode dropdown
 * before the first prompt (#84 round 2). A bar that appears only after the first request is
 * a bar you never learn to look at.
 *
 * ⚠ ACTIVITY AND COUNTS ARE DERIVED FROM STATE THE PAGE ALREADY HOLDS. Activity from
 * `chat.sessionGenerating` (the shared run flag — `isLoading` is request-local and the follow
 * adapter never raises it, #103 receipt) and the shape of the last message; counts from the
 * message list. Timing — LLM time, TTFT, tok/s — is NOT on the wire and is not invented here;
 * the host would have to stamp events. That is a later slice of #90, named there.
 *
 * ⚠ COST AND CONTEXT ARE PI'S, NOT SUMMED HERE (#45). The page used to add up each
 * `message-end` it saw, so a reload, a resume from the rail or a second tab started again at
 * `$0.0000` on a thread that had spent. The server now sends pi's session totals — in the
 * follow's snapshot, then as each `session-usage` — and the bar shows the latest, whole. The
 * context meter is pi's `getContextUsage()`: its estimate over its model's window, never a
 * percentage of ours.
 *
 * ⓘ No `role="status"`/live region, deliberately (PR #51 review, nit 3): this is a
 * persistent readout that changes on every delta, and a live region would interrupt a
 * screen reader continuously. The numbers stay poll-able, never announced; the send/stop
 * button already carries the in-flight state to assistive tech.
 */

/** What the run is doing right now, as far as the page can tell from the transcript. */
export type Activity =
  | { readonly kind: 'idle' }
  /** A run is in flight but nothing has streamed yet, or the model is between steps. */
  | { readonly kind: 'working' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'running'; readonly tool: string }
  | { readonly kind: 'responding' }
  /**
   * The follow ended under this page (#119): whatever the run flag holds is as of that
   * moment, so it is not reported — a run that was in flight may have finished, been
   * aborted, or died with the server, and the page cannot tell which.
   */
  | { readonly kind: 'disconnected' }

/**
 * Read the activity off the transcript's tail.
 *
 * The last AUTOMATIC part of the last message (TanStack's own selection, matched results folded
 * into their calls) is the step in progress: a call with no result yet is a tool running; a
 * call WITH its result means the model has the output and is composing — `working`, not
 * `running`, because the tool is done. Thinking and text are what they say. Anything else — no
 * assistant message yet, a user message as the tail, an image — is `working`: in flight,
 * nothing more specific known.
 *
 * "The last message" skips assistant messages with NO parts at the tail (#418). Joining a run that
 * is already going (a reload) opens a new assistant message for what streams next, after the stored
 * one holding the step in progress; until something streams into it, that step is still the one in
 * progress. The skip stops at the first message with a part, or at a user message.
 *
 * ⓘ The catch-all DIVERGES from `selected-message-part.tsx` on purpose (PR #92 review).
 * The transcript renders every part kind it has no handler for visibly, because there a
 * silently skipped part is indistinguishable from one never sent. This is a one-word
 * summary with no room for per-kind detail, and `working` is TRUE of an image, a document,
 * or an unmatched result at the tail — the run is in flight. The part itself is still on
 * screen in the transcript; nothing is hidden by summarising it.
 *
 * ⚠ `selectMessageUI` HERE, `selectChatUI` in `transcript-selection.ts` (#282) — the opposite of
 * that module's choice, and deliberately. The transcript renderer needs the whole-list
 * selection because it renders EVERY message, so a call in an earlier message whose result
 * the server stamped onto a later one must still pair or it reads `running…` for ever
 * (`message-row.tsx#ChatMessageRow` says so). This function reads only the LAST
 * message, where that shape cannot arise: a result is normalised into the message holding
 * its call, and a result whose call is absent from the transcript is unmatched under BOTH
 * selections. The pairing this loses is pairing across messages, which the tail read never
 * consults. What it buys: the whole-transcript selection allocated a selected part per part
 * plus two Maps and a Set on every streamed token to use one element — 76.4 µs per delta at
 * 600 messages and rising for the life of the thread, against 0.32 µs here (#282's
 * measurement, reproduced). `thread-status.test.tsx` pins the cross-message shapes.
 */
export function describeActivity(
  messages: ReadonlyArray<UIMessage>,
  generating: boolean,
  disconnected = false,
): Activity {
  if (disconnected) return { kind: 'disconnected' }
  if (!generating) return { kind: 'idle' }
  const message = messages.findLast((candidate) => candidate.role !== 'assistant' || candidate.parts.length > 0)
  const last = message === undefined ? undefined : selectMessageUI(message, {})
  if (last === undefined || last.message.role !== 'assistant') return { kind: 'working' }
  const tail = automaticPartsForMessage(last).at(-1)
  if (tail === undefined) return { kind: 'working' }
  if (tail.key === 'toolCall') {
    // `generating` is true here, so the tail's run is open: no result is pending, never aborted.
    const pending = toolResultState(tail.result, true).status === 'pending'
    return pending ? { kind: 'running', tool: tail.part.name } : { kind: 'working' }
  }
  if (tail.key === 'thinking') return { kind: 'thinking' }
  if (tail.key === 'text') return { kind: 'responding' }
  return { kind: 'working' }
}

export interface ThreadCounts {
  /** User messages — one per thing the human asked. */
  readonly prompts: number
  /** Tool calls across the whole transcript, paired or not. */
  readonly toolCalls: number
  /** Results something refused (#387, #523) — a guard, a permission rule, `auto`, the person: by decision, not by error. */
  readonly refused: number
  /** Results that came back as errors and were not refusals: the tool ran, or tried to, and failed. */
  readonly failed: number
}

/**
 * Count the transcript. Cheap enough to run per render; the list is what is on screen.
 * `refusals` is the thread's store of refused call ids — the one thing that tells a refusal
 * from a failure, since pi hands both over as an error result.
 */
export function countThread(
  messages: ReadonlyArray<UIMessage>,
  refusals: ReadonlyMap<string, unknown> = new Map(),
): ThreadCounts {
  let prompts = 0
  let toolCalls = 0
  let refused = 0
  let failed = 0
  for (const message of messages) {
    if (message.role === 'user') prompts += 1
    for (const part of message.parts) {
      if (part.type === 'tool-call') toolCalls += 1
      if (part.type !== 'tool-result') continue
      if (refusals.has(part.toolCallId)) refused += 1
      else if (part.state === 'error') failed += 1
    }
  }
  return { prompts, toolCalls, refused, failed }
}

/**
 * `running read` — the tool named as pi names it, so it matches the transcript's step row. The
 * resting words are core's (#648): the arena's attention wait reads them back off the page.
 */
function activityLabel(activity: Activity): string {
  if (activity.kind === 'idle') return THREAD_STATUS_WORDS.idle
  if (activity.kind === 'disconnected') return THREAD_STATUS_WORDS.disconnected
  return activity.kind === 'running' ? `running ${activity.tool}` : activity.kind
}

export interface ThreadStatusViewProps {
  readonly activity: Activity
  readonly counts: ThreadCounts
  /** pi's session totals and context (#45); undefined until the follow's first snapshot. */
  readonly usage?: EnsoSessionUsage | undefined
  /** The tree pi runs this thread in (#44); undefined until the follow's first snapshot. */
  readonly cwd?: string | undefined
  /** The thread's project's title, when the page lists it — the bar's name for where the thread runs (#551). */
  readonly projectTitle?: string | undefined
  /** Whether the thread runs on a tree of its own (#551), not the checkout — the follow snapshot's `tree`. */
  readonly onTree?: boolean | undefined
  /** What stands for "own tree" on the bar: the wired bar's button that opens the tree's panel (#619); the words alone when absent. */
  readonly treeControl?: React.ReactNode
  /** A question from pi is open for this thread — said here too, since only the transcript shows it. */
  readonly questionWaiting?: boolean
  /** The provider's last refusal while no reply has got through since (#340) — its class word. */
  readonly refusal?: ProviderRefusalClass | undefined
  /** Who refused (#387): `Anthropic: rate-limited`, never a bare word that reads as Enso's policy. */
  readonly refusalSource?: string | undefined
  /** git in the thread's cwd (#453): branch, ahead/behind the last push, the tree's changes. */
  readonly git?: GitOutcome | undefined
  /** The session's risk (#464): said only once it is above `low`. */
  readonly risk?: EnsoSessionRiskChange | undefined
  /** Opens the Stats view at the risk's signals (#727); the risk is words alone when absent (a static render). */
  readonly onRiskSignals?: (() => void) | undefined
  /** The session's incidents (#466): said while one is open, or once a resolution ended the thread. */
  readonly incidents?: EnsoSessionIncidents | undefined
}

const COMPACT_TOKENS = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** `34% · 68.4K / 200K` — pi's estimate over its window; `? / 200K` after a compaction, until the next response says. */
function ContextMeter({ context }: { readonly context: EnsoContextUsage }): React.ReactNode {
  const window = COMPACT_TOKENS.format(context.window)
  if (context.tokens === null || context.percent === null) {
    return (
      <span title="context in use is unknown after a compaction until the model's next response reports it">
        context ? / {window}
      </span>
    )
  }
  const percent = Math.round(context.percent)
  return (
    <span
      className="flex items-center gap-1.5"
      title={`${context.tokens.toLocaleString('en-US')} of ${context.window.toLocaleString('en-US')} tokens in the model's context window — pi's estimate: the latest request's usage plus what was added since`}
    >
      context
      <meter
        aria-label="context window used"
        min={0}
        max={100}
        value={Math.min(percent, 100)}
        className="h-1.5 w-16 appearance-none overflow-hidden rounded-full bg-muted-foreground/25 [&::-moz-meter-bar]:bg-foreground/60 [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-transparent [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-foreground/60 [&::-webkit-meter-optimum-value]:bg-none"
      />
      {/* pi's meter: the provider's count for the last response plus pi's estimate since — an estimate, so ≈ (#407). */}
      {percent}% · ≈{COMPACT_TOKENS.format(context.tokens)} / {window}
    </span>
  )
}

/** The project as a reader names it: the directory's own name; the full path rides in the tooltip. */
function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? cwd
}

const DOT_DISCONNECTED = 'size-2 shrink-0 rotate-45 rounded-xs bg-refuse'
const DOT_IDLE = 'size-2 shrink-0 rounded-full border border-muted-foreground'
// ⚠ Static, not pulsing (#739): any CSS animation here, even a stepped or `motion-safe:` one, keeps
// the compositor ticking for as long as pi works — 40–55% of a GPU process in the live run. The
// colour and the word beside the dot already say the thread is in flight.
const DOT_IN_FLIGHT = 'size-2 shrink-0 rounded-full bg-evidence signal:shadow-glow-evidence'

/** The dot beside the word: solid in the running colour while in flight, hollow when idle, a refusal-coloured diamond once the follow ended (#119). */
function activityDotClass(activity: Activity): typeof DOT_DISCONNECTED | typeof DOT_IDLE | typeof DOT_IN_FLIGHT {
  if (activity.kind === 'disconnected') return DOT_DISCONNECTED
  if (activity.kind === 'idle') return DOT_IDLE
  return DOT_IN_FLIGHT
}

/**
 * Where the thread runs (#44): nothing before the first snapshot, and the server's `''` said as what
 * it means. Named by its project's title when the page knows it — since #551 the cwd is usually the
 * thread's own tree, whose directory name is a thread id, not a name a reader knows the project by.
 * ⚠ A thread on its own tree says so on the bar, never only on hover (#576 review): with trees on
 * by default, its edits are not in the user's checkout, and nothing else on the page says where
 * they went. Its title names no path — until the next snapshot a new thread's cwd still names the
 * project.
 */
function ProjectIndicator({
  cwd,
  projectTitle,
  onTree,
  treeControl,
}: {
  readonly cwd: string | undefined
  readonly projectTitle: string | undefined
  readonly onTree: boolean | undefined
  readonly treeControl: React.ReactNode
}): React.ReactNode {
  if (cwd === undefined) return null
  if (cwd === '') {
    // A new thread whose project was removed (#395): it will be built nowhere.
    return (
      <span title="this thread's project is no longer registered — its first prompt will be refused">
        project removed
      </span>
    )
  }
  return (
    <>
      <span title={`the tree pi reads and writes for this thread: ${cwd}`}>
        project {projectTitle ?? projectName(cwd)}
      </span>
      {onTree !== true
        ? null
        : (treeControl ?? (
            <span
              className="text-foreground"
              title="this thread reads and writes a tree of its own — its edits are not in your checkout until you bring them back"
            >
              own tree, not your checkout
            </span>
          ))}
    </>
  )
}

/** The provider's refusal (#340), named for who refused (#387): `Anthropic: rate-limited`; nothing without one. */
function RefusalWord({
  refusal,
  source,
}: {
  readonly refusal: ProviderRefusalClass | undefined
  readonly source: string | undefined
}): React.ReactNode {
  if (refusal === undefined) return null
  return (
    <span
      className="text-refuse"
      title={`${source ?? 'the provider'} refused the last request — the transcript says why`}
    >
      {source === undefined ? refusal : `${source}: ${refusal}`}
    </span>
  )
}

const RISK_TITLE =
  'security signals observed in this session: what the agent did after a refusal. Evidence, not a verdict — the level blocks nothing; reaching incident opens an incident.'

/**
 * The session's risk (#464), once it is above `low`: `risk high · 3 signals`. Observed evidence,
 * labelled as such — the level itself blocks nothing; reaching `incident` opens an incident, which
 * suspends tools only with halting on (#466). Its thresholds are uncalibrated (#468).
 *
 * ⚠ A BUTTON TO THE SIGNALS, NOT A TOOLTIP (#727). An arena agent clicked `risk high · 2 signals`
 * and nothing opened; the tooltip it never got sent it to a Stats tab that only counted them, and
 * its guess at the cause was wrong. It opens Stats at the session eval's list of each signal.
 */
function RiskWord({
  risk,
  onShow,
}: {
  readonly risk: EnsoSessionRiskChange | undefined
  readonly onShow: (() => void) | undefined
}): React.ReactNode {
  if (risk === undefined || risk.level === 'low') return null
  const tone = risk.level === 'high' || risk.level === 'incident' ? 'text-refuse' : 'text-foreground'
  const words = `risk ${risk.level} · ${risk.signals} ${risk.signals === 1 ? 'signal' : 'signals'}`
  if (onShow === undefined) {
    return (
      <span className={tone} title={RISK_TITLE}>
        {words}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`${tone} underline decoration-dotted underline-offset-2 hover:decoration-solid`}
      aria-label={`${words}: show them on the Stats tab`}
      title={`${RISK_TITLE} Open the Stats tab to read each one.`}
      onClick={onShow}
    >
      {words}
    </button>
  )
}

/**
 * The session's incident (#466), tersely: `intervention required` while an open
 * incident holds tool families suspended — only a human's resolution lifts it, on the incident's
 * card; `incident open` when it opened with halting off (an alert, nothing suspended); `thread
 * ended by incident resolution` once a resolution ended it. Nothing otherwise — a resumed thread's
 * restrictions are the card's to list.
 */
function IncidentWord({ incidents }: { readonly incidents: EnsoSessionIncidents | undefined }): React.ReactNode {
  if (incidents === undefined) return null
  if (incidents.ended) {
    return (
      <span className="text-refuse" title="a resolution ended this thread: it is read-only, and can still be forked">
        thread ended by incident resolution
      </span>
    )
  }
  if (openIncidentOf(incidents) === undefined) return null
  return incidents.suspended.length > 0 ? (
    <span
      className="font-medium text-refuse"
      title={`an incident suspended ${incidents.suspended.join(', ')} tools — resolve it on its card in the Chat view`}
    >
      intervention required
    </span>
  ) : (
    <span
      className="text-refuse"
      title="an incident is open — halting is off (security.incidents.halt), so nothing is suspended; its card is in the Chat view"
    >
      incident open
    </span>
  )
}

/**
 * "a question is waiting", said in the bar while pi waits on an answer (#362).
 *
 * ⚠ THE LIVE REGION IS ALWAYS MOUNTED (#371): a screen reader announces a change inside a region
 * that exists, not a region that appears already filled. Only its words change; the visible line
 * is `aria-hidden` so they are read once, and `sr-only` is absolutely placed, so while empty the
 * region takes no item or gap in the bar's row.
 */
function QuestionWaiting({ waiting }: { waiting: boolean | undefined }): React.ReactNode {
  return (
    <>
      <span role="status" className="sr-only">
        {waiting ? THREAD_STATUS_WORDS.questionWaiting : ''}
      </span>
      {waiting ? (
        <span
          aria-hidden="true"
          className="flex items-center gap-2 font-medium text-human"
          title="pi is waiting for your answer — it is in the Chat view"
        >
          <span className="size-2 shrink-0 rounded-full bg-human signal:shadow-glow-human" />
          {THREAD_STATUS_WORDS.questionWaiting}
        </span>
      ) : null}
    </>
  )
}

/** Pure view — everything it shows arrives as props, so a static render pins the wording. */
export function ThreadStatusView({
  activity,
  counts,
  usage,
  cwd,
  projectTitle,
  onTree,
  treeControl,
  questionWaiting,
  refusal,
  refusalSource,
  git,
  risk,
  onRiskSignals,
  incidents,
}: ThreadStatusViewProps): React.ReactNode {
  const dotClass = activityDotClass(activity)
  const context = usage?.context ?? null
  return (
    <footer
      id="thread-status"
      aria-label={THREAD_STATUS_WORDS.region}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-5 py-2 font-mono text-xs text-muted-foreground"
    >
      <span
        className="flex items-center gap-2 font-medium text-foreground"
        title={
          activity.kind === 'disconnected'
            ? 'the connection to the server ended — reload and resume from the rail'
            : "what the run is doing right now, read off the transcript's tail"
        }
      >
        <span aria-hidden="true" className={dotClass} />
        {activityLabel(activity)}
      </span>
      {/* Seen from every view: the question itself is in the transcript (#362 review). */}
      <QuestionWaiting waiting={questionWaiting} />
      {/* #340: `$0.0000` beside `idle` means "nothing ran" here, not "free" — the line in the
			    transcript says who refused and why. */}
      <RefusalWord refusal={refusal} source={refusalSource} />
      <IncidentWord incidents={incidents} />
      <RiskWord risk={risk} onShow={onRiskSignals} />
      <span title="user messages in this transcript">
        {counts.prompts} {counts.prompts === 1 ? 'prompt' : 'prompts'}
      </span>
      <span title="tool calls across this transcript, finished or not">
        {counts.toolCalls} {counts.toolCalls === 1 ? 'tool call' : 'tool calls'}
      </span>
      {/* Said apart (#407): a refusal is policy doing its job, a failure is something to fix. */}
      {counts.refused === 0 ? null : (
        <span className="text-refuse" title="tool calls an Enso guard refused — by policy, not by error">
          {counts.refused} refused
        </span>
      )}
      {counts.failed === 0 ? null : (
        <span title="tool calls that came back as errors: the tool ran, or tried to, and failed">
          {counts.failed} failed
        </span>
      )}
      <ProjectIndicator cwd={cwd} projectTitle={projectTitle} onTree={onTree} treeControl={treeControl} />
      {git === undefined ? null : <GitIndicator outcome={git} />}
      {context === null ? null : (
        <span className="ml-auto">
          <ContextMeter context={context} />
        </span>
      )}
      <span
        className={context === null ? 'ml-auto' : undefined}
        title="what this thread's session has spent — pi's own total, every model call on every branch, compactions included"
      >
        {usage === undefined ? '$—' : `$${usage.cost.toFixed(4)}`}
      </span>
    </footer>
  )
}

export interface ThreadStatusBarProps {
  readonly messages: ReadonlyArray<UIMessage>
  readonly generating: boolean
  /** The thread's project's title as the page lists it (#551); the bar falls back to the cwd's name. */
  readonly projectTitle?: string | undefined
  /** Asks the page for a view (#361) — the risk word asks for Stats (#727). */
  readonly openView: (view: 'stats') => void
  /** Whether this bar's pane is the one on screen (#737): every mounted pane keeps its bar (#472). */
  readonly shown: boolean
}

/**
 * What the bar says to a listener (#737, core's `EnsoThreadStatusKind`), from what it shows: the
 * follow ended, else a question waiting, else at rest or not. The bar's finer activity words
 * (working, thinking, running a tool, responding) are all `running` to something that waits on it.
 */
function threadStatusKind(activity: Activity, questionWaiting: boolean): EnsoThreadStatusKind {
  if (activity.kind === 'disconnected') return 'disconnected'
  if (questionWaiting) return 'question'
  return activity.kind === 'idle' ? 'idle' : 'running'
}

/**
 * Announce the bar's status as `enso:thread-status` (#737): on mount, and whenever the status, the
 * open question or `shown` changes — after the commit, so a listener that reads the page on the
 * event finds the bar saying what the event says. The question's fields are the dependencies, not
 * the dialog object: a re-render with the same question announces nothing.
 */
function useThreadStatusAnnouncement(
  threadId: string,
  shown: boolean,
  status: EnsoThreadStatusKind,
  dialog: EnsoPendingDialog | undefined,
): void {
  const questionId = status === 'question' ? dialog?.id : undefined
  const questionTitle = status === 'question' ? dialog?.dialog.title : undefined
  useEffect(() => {
    announceUiEvent(ENSO_UI_EVENTS.threadStatus, {
      threadId,
      shown,
      status,
      ...(questionId === undefined || questionTitle === undefined
        ? {}
        : { question: { id: questionId, title: questionTitle } }),
    })
  }, [threadId, shown, status, questionId, questionTitle])
}

/**
 * The bar wired to its thread: the chat's messages and in-flight flag come in as props
 * (the chat hook is bound inside thread-pane.tsx, and this module stays free of it), the
 * thread's usage store and its disconnected flag (#119) are read from context. It announces
 * what it shows (`useThreadStatusAnnouncement`, #737).
 */
export function ThreadStatusBar({
  messages,
  generating,
  projectTitle,
  openView,
  shown,
}: ThreadStatusBarProps): React.ReactNode {
  const stores = useThreadStores()
  const usage = useStore(stores.usage)
  const disconnected = useStore(stores.disconnected)
  const cwd = useStore(stores.cwd)
  const onTree = useStore(stores.tree)
  const dialog = useStore(stores.dialog)
  const questionWaiting = dialog !== undefined
  const refusal = useStore(stores.refusal)
  const refusals = useStore(stores.refusals)
  const risk = useStore(stores.sessionRisk)
  const incidents = useStore(stores.incidents)
  // A live session, or a thread the server has seen messages in (#620, #659). ⚠ Not the transcript's
  // own length (#682): a first prompt is in it the moment it is sent, a second before the server has
  // built the session, and `/git` and `/tree` each answered that read with a 404.
  const readable = useThreadReadable()
  // When the tree may have moved: a settled tool result, the run starting or ending.
  const moment = `${settledToolResults(messages)}:${generating}`
  const git = useThreadGit(moment, readable)
  const activity = describeActivity(messages, generating, disconnected)
  useThreadStatusAnnouncement(stores.threadId, shown, threadStatusKind(activity, questionWaiting), dialog)
  return (
    <ThreadStatusView
      activity={activity}
      counts={countThread(messages, refusals)}
      usage={usage}
      cwd={cwd}
      projectTitle={projectTitle}
      onTree={onTree}
      treeControl={<ThreadTreeButton moment={moment} readable={readable} />}
      questionWaiting={questionWaiting}
      refusal={refusal?.refusalClass}
      refusalSource={refusal?.provider}
      git={git}
      risk={risk}
      onRiskSignals={(): void => {
        stores.landOnRiskSignals.set(true)
        openView('stats')
      }}
      incidents={incidents}
    />
  )
}
