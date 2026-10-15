import {
  ENSO_UI_EVENTS,
  type EnsoContextUsage,
  type EnsoSessionIncidents,
  type EnsoSessionRiskChange,
  type EnsoSessionUsage,
  type EnsoThreadStatusKind,
  openIncidentOf,
  type ProviderRefusalClass,
  shellExitCodeOf,
  THREAD_STATUS_WORDS,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { useEffect, useLayoutEffect, useState } from 'react'
import { IN_FLIGHT_ESTIMATE_TITLE, outputCharsText, requestOutput } from './live-request.ts'
import { STATUS_BUTTON } from './menu-chrome.ts'
import { useThreadReadable } from './model-state.tsx'
import { PAGE_FAULT_WORDS, pageFault } from './page-health.ts'
import { reloadKeepingDrafts } from './page-reload.ts'
import {
  describeRunStatus,
  describeStep,
  formatElapsed,
  headlineOf,
  lostDetail,
  paneStopOf,
  revealQuestion,
  RUN_DOT,
  RUN_STATUS_TIMING,
  RUN_WORD_COLOUR,
  type RunHeadlineState,
  type RunStatus,
  stepLabel,
  stuckDetail,
  thinkingTail,
} from './run-status.ts'
import { useStore, useThreadStores } from './store.ts'
import { GitIndicator, type GitOutcome, settledToolResults, useThreadGit } from './thread-git.tsx'
import { type EnsoPendingDialog, type ThreadStores, updateThreadHeadline } from './thread-stores.ts'
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
 * ⚠ THE RUN'S STATUS AND THE COUNTS ARE DERIVED FROM STATE THE PAGE ALREADY HOLDS. The status
 * (#914, `run-status.ts`) from `chat.sessionGenerating` (the shared run flag — `isLoading` is
 * request-local and the follow adapter never raises it, #103 receipt), the shape of the last
 * message, and what the follow says of itself and the run; counts from the message list. Its
 * elapsed times are this page's clock, from when it saw the run open and the step begin: the host
 * stamps no events, and a page that joined a run mid-way counts from when it joined.
 *
 * ⚠ COST AND CONTEXT ARE PI'S, NOT SUMMED HERE (#45). The page used to add up each
 * `message-end` it saw, so a reload, a resume from the rail or a second tab started again at
 * `$0.0000` on a thread that had spent. The server now sends pi's session totals — in the
 * follow's snapshot, then as each `session-usage` — and the bar shows the latest, whole. The
 * context meter is pi's `getContextUsage()`: its estimate over its model's window, never a
 * percentage of ours.
 *
 * ⓘ No `role="status"`/live region, deliberately: this is a
 * persistent readout that changes on every delta, and a live region would interrupt a
 * screen reader continuously. The numbers stay poll-able, never announced; the send/stop
 * button already carries the in-flight state to assistive tech.
 */

export interface ThreadCounts {
  /** User messages — one per thing the human asked. */
  readonly prompts: number
  /** Tool calls across the whole transcript, paired or not. */
  readonly toolCalls: number
  /** Results something refused (#387, #523) — a guard, a permission rule, `auto`, the person: by decision, not by error. */
  readonly refused: number
  /** `bash` commands that ran and exited non-zero (#928): an error result to pi, the command answering to us. */
  readonly exited: number
  /** Results that came back as errors, not refusals nor non-zero exits: the tool ran, or tried to, and failed. */
  readonly failed: number
}

/** An error result that is a shell command's non-zero exit (#928), by the call's name and the result's text — a shell result is text. */
function exitedNonZero(toolName: string | undefined, content: unknown): boolean {
  if (toolName === undefined || typeof content !== 'string') return false
  return shellExitCodeOf({ toolName, isError: true, text: content }) !== undefined
}

type ToolResultPart = Extract<UIMessage['parts'][number], { type: 'tool-result' }>

/** What a result counts as on the bar; undefined for one that is not an error. */
function tallyOf(
  part: ToolResultPart,
  toolName: string | undefined,
  refusals: ReadonlyMap<string, unknown>,
): 'refused' | 'exited' | 'failed' | undefined {
  if (refusals.has(part.toolCallId)) return 'refused'
  if (part.state !== 'error') return undefined
  return exitedNonZero(toolName, part.content) ? 'exited' : 'failed'
}

/**
 * Count the transcript. Cheap enough to run per render; the list is what is on screen.
 * `refusals` is the thread's store of refused call ids — the one thing that tells a refusal
 * from a failure, since pi hands both over as an error result. A shell result's own text says a
 * non-zero exit (`shellExitCodeOf`), told by the call's name.
 */
export function countThread(
  messages: ReadonlyArray<UIMessage>,
  refusals: ReadonlyMap<string, unknown> = new Map(),
): ThreadCounts {
  const counts = { prompts: 0, toolCalls: 0, refused: 0, exited: 0, failed: 0 }
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'user') counts.prompts += 1
    for (const part of message.parts) {
      if (part.type === 'tool-call') {
        counts.toolCalls += 1
        toolNames.set(part.id, part.name)
      } else if (part.type === 'tool-result') {
        const tally = tallyOf(part, toolNames.get(part.toolCallId), refusals)
        if (tally !== undefined) counts[tally] += 1
      }
    }
  }
  return counts
}

export interface ThreadStatusViewProps {
  /** What the run and the page are doing (#914). */
  readonly status: RunStatus
  /** The moment the elapsed times are read at (`Date.now()`), so a static render is deterministic. */
  readonly now: number
  /** Brings the open question's card into view (#914); the question is words alone when absent. */
  readonly onRevealQuestion?: ((dialogId: string) => void) | undefined
  /** Stops the run — the composer's Stop (#914); "possibly stuck" offers it. Words alone when absent. */
  readonly onStop?: (() => void) | undefined
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
  /**
   * A pane side by side with others (#938): the strip is a pane's width, so the counts and the
   * branch's state go — the run's state, the tree and the cost stay.
   */
  readonly narrow?: boolean | undefined
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
      className={`${STATUS_BUTTON} ${tone} underline decoration-dotted underline-offset-2 hover:decoration-solid`}
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
      title="an incident is open — halting is off (Settings › Security), so nothing is suspended; its card is in the Chat view"
    >
      incident open
    </span>
  )
}

/**
 * "a question is waiting", said to a screen reader while pi waits on an answer (#362) — the bar's
 * run word says `waiting on you` and the question for the eye (#914).
 *
 * ⚠ THE LIVE REGION IS ALWAYS MOUNTED (#371): a screen reader announces a change inside a region
 * that exists, not a region that appears already filled. Only its words change, and `sr-only` is
 * absolutely placed, so while empty the region takes no item or gap in the bar's row.
 */
function QuestionWaiting({ waiting }: { waiting: boolean }): React.ReactNode {
  return (
    <span role="status" className="sr-only">
      {waiting ? THREAD_STATUS_WORDS.questionWaiting : ''}
    </span>
  )
}

/** What each state's word means, on hover. */
const RUN_TITLE: Readonly<Record<RunHeadlineState, string>> = {
  idle: 'nothing has run on this page yet',
  working: 'what pi is doing now, and for how long: this step, then the whole run',
  waiting: 'pi is waiting for your answer — the question is in the Chat view',
  stuck: 'pi is working, and nothing has come from it for a while — an observation, not a verdict; Stop ends the run',
  finished: 'the last run finished on its own',
  stopped: 'a Stop ended the last run',
  failed: 'the last run ended on an error',
  lost: "this page is not receiving the thread's updates: what it shows is as of then",
  behind: 'this page has fallen behind the server or part of it failed — Reload to catch up',
}

/** A line of detail that may be long: cut with an ellipsis, whole on hover. */
const DETAIL = 'min-w-0 max-w-md truncate'

/** A control in the run's detail: a word that acts, underlined like the risk word. */
const DETAIL_BUTTON = `${STATUS_BUTTON} underline decoration-dotted underline-offset-2 hover:decoration-solid`

/**
 * What pi is doing and for how long (#914): the step, its elapsed time, the run's, and the request's
 * output so far (`~18K chars`, #913); while it thinks, the last line of its thinking, live — which
 * opens to the thinking's latest stretch.
 */
function WorkingDetail({
  status,
  now,
}: {
  readonly status: Extract<RunStatus, { kind: 'working' }>
  readonly now: number
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const { step } = status
  const thinking = step.kind === 'thinking' ? step.text : undefined
  const tail = thinking === undefined ? '' : thinkingTail(thinking)
  return (
    <>
      <span className={`${DETAIL} text-foreground`} title={stepLabel(step)}>
        {stepLabel(step)}
      </span>
      <span title="how long this step has run">{formatElapsed(now - status.stepSince)}</span>
      {status.runSince === undefined ? null : (
        <span title="how long the run has run, since this page saw it start">
          run {formatElapsed(now - status.runSince)}
        </span>
      )}
      {status.request === undefined || requestOutput(status.request) === 0 ? null : (
        <span title={`this model request's output so far — ${IN_FLIGHT_ESTIMATE_TITLE}`}>
          {outputCharsText(requestOutput(status.request))}
        </span>
      )}
      {tail.length === 0 ? null : (
        <button
          type="button"
          aria-expanded={open}
          title={open ? 'hide the thinking' : 'show more of the thinking'}
          className={`${STATUS_BUTTON} ${DETAIL} italic`}
          onClick={(): void => setOpen(!open)}
        >
          {tail}
        </button>
      )}
      {open && thinking !== undefined ? (
        <span
          data-thinking-tail=""
          className="max-h-32 basis-full overflow-y-auto font-sans whitespace-pre-wrap text-muted-foreground italic"
        >
          {thinking.length > THINKING_OPEN_CHARS ? `…${thinking.slice(-THINKING_OPEN_CHARS)}` : thinking}
        </span>
      ) : null}
    </>
  )
}

/** How much of the thinking the opened tail shows: its latest stretch, not the whole. */
const THINKING_OPEN_CHARS = 1500

/** The detail after the run's word: what it is doing, what it waits on, why it ended, how to get back. */
function RunDetail({
  status,
  now,
  onRevealQuestion,
  onStop,
}: Pick<ThreadStatusViewProps, 'status' | 'now' | 'onRevealQuestion' | 'onStop'>): React.ReactNode {
  switch (status.kind) {
    case 'lost':
      return (
        <>
          <span className="text-foreground">{lostDetail(status.reload)}</span>
          {status.reload ? (
            <button
              type="button"
              className={`${DETAIL_BUTTON} text-refuse`}
              onClick={(): void => void reloadKeepingDrafts()}
            >
              {PAGE_FAULT_WORDS.reload}
            </button>
          ) : null}
        </>
      )
    case 'waiting':
      return onRevealQuestion === undefined ? (
        <span className={`${DETAIL} text-foreground`}>{status.question}</span>
      ) : (
        <button
          type="button"
          title={`go to the question: ${status.question}`}
          className={`${DETAIL_BUTTON} ${DETAIL} text-foreground`}
          onClick={(): void => onRevealQuestion(status.dialogId)}
        >
          {status.question}
        </button>
      )
    case 'working':
      return <WorkingDetail status={status} now={now} />
    case 'stuck':
      return (
        <>
          <span className={`${DETAIL} text-foreground`}>{stuckDetail(status, now)}</span>
          {onStop === undefined ? null : (
            <button type="button" className={`${DETAIL_BUTTON} text-refuse`} onClick={onStop}>
              Stop
            </button>
          )}
        </>
      )
    case 'stopped':
      return status.reason === undefined ? null : (
        <span className={`${DETAIL} text-refuse`} title={status.reason}>
          {status.reason}
        </span>
      )
    default:
      return null
  }
}

/** The run's dot and word, first in the bar — bold, in its state's colour — then its detail. */
function RunWords(
  props: Pick<ThreadStatusViewProps, 'status' | 'now' | 'onRevealQuestion' | 'onStop'>,
): React.ReactNode {
  const { state, word } = headlineOf(props.status)
  return (
    <>
      <span
        className={`flex shrink-0 items-center gap-2 font-semibold ${RUN_WORD_COLOUR[state]}`}
        title={RUN_TITLE[state]}
      >
        <span aria-hidden="true" className={RUN_DOT[state]} />
        {word}
      </span>
      <RunDetail {...props} />
    </>
  )
}

/** The transcript's tallies: prompts and tool calls always, refused, exited non-zero and failed only when any. */
function CountWords({ counts }: { readonly counts: ThreadStatusViewProps['counts'] }): React.ReactNode {
  return (
    <>
      <span title="user messages in this transcript">
        {counts.prompts} {counts.prompts === 1 ? 'prompt' : 'prompts'}
      </span>
      <span title="tool calls across this transcript, finished or not">
        {counts.toolCalls} {counts.toolCalls === 1 ? 'tool call' : 'tool calls'}
      </span>
      {/* Said apart (#407): a refusal is policy doing its job, a failure is something to fix. */}
      {counts.refused === 0 ? null : (
        <span
          className="text-refuse"
          title="tool calls something refused — a guard, your rule, auto, or you — by decision, not by error"
        >
          {counts.refused} refused
        </span>
      )}
      {counts.exited === 0 ? null : (
        <span title="commands that ran and exited non-zero — the command answered, the tool did not fail">
          {counts.exited} exited non-zero
        </span>
      )}
      {counts.failed === 0 ? null : (
        <span title="tool calls that came back as errors: the tool ran, or tried to, and failed">
          {counts.failed} failed
        </span>
      )}
    </>
  )
}

/** The bar's right end: the context meter when known, then the session's spend. */
function SpendWords({ usage }: { readonly usage: ThreadStatusViewProps['usage'] }): React.ReactNode {
  const context = usage?.context ?? null
  return (
    <>
      {context === null ? null : <ContextMeter context={context} />}
      <span
        className="text-foreground"
        title="what this thread's session has spent — pi's own total, every model call on every branch, compactions included"
      >
        {usage === undefined ? '$—' : `$${usage.cost.toFixed(4)}`}
      </span>
    </>
  )
}

/** The strip's tallies, at a full width only (#938): a pane side by side with others drops them. */
function TallyWords({
  counts,
  narrow,
}: {
  readonly counts: ThreadStatusViewProps['counts']
  readonly narrow: boolean | undefined
}): React.ReactNode {
  return narrow === true ? null : <CountWords counts={counts} />
}

/** The branch's state against its push, at a full width only (#938), and once it has been read. */
function BranchWord({
  git,
  narrow,
}: {
  readonly git: GitOutcome | undefined
  readonly narrow: boolean | undefined
}): React.ReactNode {
  return git === undefined || narrow === true ? null : <GitIndicator outcome={git} />
}

/** Pure view — everything it shows arrives as props, so a static render pins the wording. */
export function ThreadStatusView({
  status,
  now,
  onRevealQuestion,
  onStop,
  counts,
  usage,
  cwd,
  projectTitle,
  onTree,
  treeControl,
  refusal,
  refusalSource,
  git,
  risk,
  onRiskSignals,
  incidents,
  narrow,
}: ThreadStatusViewProps): React.ReactNode {
  return (
    // One line, the prototype's (#417), when it fits — and a second when it doesn't: a cut would hide
    // what the bar must say (the tree's "own tree, not your checkout", #576 review; a refusal; a
    // question waiting). The meter and the cost keep their place at the bar's right end. A pane's
    // width (#938) takes the narrow screen's gutters.
    <footer
      id="thread-status"
      aria-label={THREAD_STATUS_WORDS.region}
      data-narrow={narrow === true ? '' : undefined}
      className="flex min-h-8 shrink-0 items-center gap-4 border-t px-6 font-mono text-xs whitespace-nowrap text-muted-foreground data-narrow:gap-3 data-narrow:px-4 max-md:gap-3 max-md:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5 py-0.5 max-md:gap-x-3">
        <RunWords status={status} now={now} onRevealQuestion={onRevealQuestion} onStop={onStop} />
        {/* Heard from every view: the question itself is in the transcript (#362 review). */}
        <QuestionWaiting waiting={status.kind === 'waiting'} />
        {/* #340: `$0.0000` beside `idle` means "nothing ran" here, not "free" — the line in the
			    transcript says who refused and why. */}
        <RefusalWord refusal={refusal} source={refusalSource} />
        <IncidentWord incidents={incidents} />
        <RiskWord risk={risk} onShow={onRiskSignals} />
        <TallyWords counts={counts} narrow={narrow} />
        <ProjectIndicator cwd={cwd} projectTitle={projectTitle} onTree={onTree} treeControl={treeControl} />
        <BranchWord git={git} narrow={narrow} />
      </div>
      <div className="flex shrink-0 items-center gap-4 max-md:gap-3">
        <SpendWords usage={usage} />
      </div>
    </footer>
  )
}

export interface ThreadStatusBarProps {
  readonly messages: ReadonlyArray<UIMessage>
  readonly generating: boolean
  /** The thread's project's title as the page lists it (#551); the bar falls back to the cwd's name. */
  readonly projectTitle?: string | undefined
  /** Asks the page for a view (#361) — the risk word asks for Stats (#727), the question's line for the Chat (#914). */
  readonly openView: (view: 'stats' | 'chat') => void
  /** Whether this bar's pane is on screen (#737, #938): every mounted pane keeps its bar (#472). */
  readonly shown: boolean
  /** Its pane is side by side with others (#938): `ThreadStatusViewProps.narrow`. */
  readonly narrow?: boolean | undefined
}

/**
 * What the bar says to a listener (#737, core's `EnsoThreadStatusKind`), from what it shows: the
 * live view lost or the page fallen behind (#919: a listener must not wait on a page that is not
 * applying the thread), else a question waiting, else pi working (possibly stuck included) or not —
 * a stopped run, however it ended, is at rest to something that waits on it.
 */
function threadStatusKind(status: RunStatus): EnsoThreadStatusKind {
  if (status.kind === 'lost' || status.kind === 'behind') return 'disconnected'
  if (status.kind === 'waiting') return 'question'
  return status.kind === 'working' || status.kind === 'stuck' ? 'running' : 'idle'
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
 * The page's clock while a run is in flight (#914), every `tickMs`: the elapsed times and "possibly
 * stuck" move with it, not with events — the moment nothing arrives is the moment that matters. No
 * timer at rest.
 */
export function useRunClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const tick = (): void => setNow(Date.now())
    tick()
    const timer = setInterval(tick, RUN_STATUS_TIMING.tickMs)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/**
 * When this page first saw the step in progress (#914): kept per step, so a delta into the same
 * thinking keeps its clock and a new step starts one. The moment is read in a layout effect, before
 * the new step is painted; the render that first meets it reads `now` in its place.
 */
function useStepSince(key: string, now: number): number {
  const [step, setStep] = useState(() => ({ key, since: now }))
  useLayoutEffect(() => {
    setStep((seen) => (seen.key === key ? seen : { key, since: Date.now() }))
  }, [key])
  return step.key === key ? step.since : now
}

/**
 * Publish the headline (#914) for the rail's row and the header — `updateThreadHeadline` drops one
 * that says nothing new, so a tick that moves nothing they show re-renders neither.
 */
function usePublishedHeadline(threadId: string, status: RunStatus): void {
  const { state, word, detail } = headlineOf(status)
  useEffect(() => updateThreadHeadline(threadId, { state, word, detail }), [threadId, state, word, detail])
}

/**
 * The thread's run status as of now (#914), from its stores, its follow and the transcript —
 * announced to listeners (#737) and published for the rail and the header. `now` is the clock the
 * bar's elapsed times are read at.
 */
function useRunStatus(
  stores: ThreadStores,
  messages: ReadonlyArray<UIMessage>,
  generating: boolean,
  shown: boolean,
): { readonly status: RunStatus; readonly now: number } {
  const { connection } = stores
  const disconnected = useStore(stores.disconnected)
  const liveView = useStore(connection.liveView)
  const dialog = useStore(stores.dialog)
  const refusal = useStore(stores.refusal)
  const incidents = useStore(stores.incidents)
  // While the page says it may be out of date (#919), the bar claims nothing is working.
  const fault = useStore(pageFault)
  const pulse = connection.pulse()
  const step = describeStep(messages, pulse.composing)
  const clock = useRunClock(generating)
  const stepSince = useStepSince(step.key, clock)
  const now = Math.max(clock, stepSince)
  const status = describeRunStatus({
    generating,
    step,
    stepSince,
    liveView,
    disconnected,
    fault,
    dialog,
    pulse,
    outputAt: connection.outputAt(),
    refusal,
    incidents,
    now,
  })
  useThreadStatusAnnouncement(stores.threadId, shown, threadStatusKind(status), dialog)
  usePublishedHeadline(stores.threadId, status)
  return { status, now }
}

/**
 * The bar wired to its thread: the chat's messages and in-flight flag come in as props
 * (the chat hook is bound inside thread-pane.tsx, and this module stays free of it), the
 * thread's stores and its follow's word on itself and the run (#914) are read from context. It
 * announces what it shows (`useThreadStatusAnnouncement`, #737) and publishes its headline.
 */
export function ThreadStatusBar({
  messages,
  generating,
  projectTitle,
  openView,
  shown,
  narrow,
}: ThreadStatusBarProps): React.ReactNode {
  const stores = useThreadStores()
  const usage = useStore(stores.usage)
  const cwd = useStore(stores.cwd)
  const onTree = useStore(stores.tree)
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
  const { status, now } = useRunStatus(stores, messages, generating, shown)
  return (
    <ThreadStatusView
      status={status}
      now={now}
      onRevealQuestion={(dialogId): void => {
        openView('chat')
        requestAnimationFrame(() => revealQuestion(dialogId))
      }}
      onStop={(): void => paneStopOf(stores)?.()}
      counts={countThread(messages, refusals)}
      usage={usage}
      cwd={cwd}
      projectTitle={projectTitle}
      onTree={onTree}
      treeControl={<ThreadTreeButton moment={moment} readable={readable} />}
      refusal={refusal?.refusalClass}
      refusalSource={refusal?.provider}
      git={git}
      risk={risk}
      onRiskSignals={(): void => {
        stores.landOnRiskSignals.set(true)
        openView('stats')
      }}
      incidents={incidents}
      narrow={narrow}
    />
  )
}
