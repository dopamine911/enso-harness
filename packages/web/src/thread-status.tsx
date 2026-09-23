import type { EnsoContextUsage, EnsoSessionUsage } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { automaticPartsForMessage, selectMessageUI } from '@tanstack/ai-client/ui'
import { toolResultState } from './EnsoToolResult.tsx'
import { useStore, useThreadStores } from './store.ts'

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
 * ⓘ The catch-all DIVERGES from `selected-message-part.tsx` on purpose (PR #92 review).
 * The transcript renders every part kind it has no handler for visibly, because there a
 * silently skipped part is indistinguishable from one never sent. This is a one-word
 * summary with no room for per-kind detail, and `working` is TRUE of an image, a document,
 * or an unmatched result at the tail — the run is in flight. The part itself is still on
 * screen in the transcript; nothing is hidden by summarising it.
 *
 * ⚠ `selectMessageUI` HERE, `selectChatUI` in `chat-screen.tsx` (#282) — the opposite of
 * that module's choice, and deliberately. The transcript renderer needs the whole-list
 * selection because it renders EVERY message, so a call in an earlier message whose result
 * the server stamped onto a later one must still pair or it reads `running…` for ever
 * (`chat-screen.tsx`'s `message` component says so). This function reads only the LAST
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
  const message = messages.at(-1)
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
}

/** Count the transcript. Cheap enough to run per render; the list is what is on screen. */
export function countThread(messages: ReadonlyArray<UIMessage>): ThreadCounts {
  let prompts = 0
  let toolCalls = 0
  for (const message of messages) {
    if (message.role === 'user') prompts += 1
    for (const part of message.parts) if (part.type === 'tool-call') toolCalls += 1
  }
  return { prompts, toolCalls }
}

/** `running read` — the tool named as pi names it, so it matches the transcript's step row. */
function activityLabel(activity: Activity): string {
  return activity.kind === 'running' ? `running ${activity.tool}` : activity.kind
}

export interface ThreadStatusViewProps {
  readonly activity: Activity
  readonly counts: ThreadCounts
  /** pi's session totals and context (#45); undefined until the follow's first snapshot. */
  readonly usage?: EnsoSessionUsage | undefined
  /** The tree pi runs this thread in (#44); undefined until the follow's first snapshot. */
  readonly cwd?: string | undefined
  /** Whether the thread's stats drawer is open (#45 phase 2) — the toggle's pressed state. */
  readonly statsOpen?: boolean
  /** Opens or closes the stats drawer; no toggle is drawn without it (a static render, a test). */
  readonly onToggleStats?: (() => void) | undefined
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
        className="h-1.5 w-16 appearance-none overflow-hidden rounded-full bg-muted-foreground/25 [&::-moz-meter-bar]:bg-foreground/60 [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-bar]:bg-transparent [&::-webkit-meter-optimum-value]:bg-foreground/60 [&::-webkit-meter-optimum-value]:bg-none"
      />
      {percent}% · {COMPACT_TOKENS.format(context.tokens)} / {window}
    </span>
  )
}

/** The project as a reader names it: the directory's own name; the full path rides in the tooltip. */
function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? cwd
}

const DOT_DISCONNECTED = 'size-2 rounded-full bg-destructive'
const DOT_IDLE = 'size-2 rounded-full bg-muted-foreground/40'
const DOT_IN_FLIGHT = 'size-2 animate-pulse rounded-full bg-foreground'

/** The dot beside the word: pulsing while in flight, still when idle, red once the follow ended (#119). */
function activityDotClass(activity: Activity): typeof DOT_DISCONNECTED | typeof DOT_IDLE | typeof DOT_IN_FLIGHT {
  if (activity.kind === 'disconnected') return DOT_DISCONNECTED
  if (activity.kind === 'idle') return DOT_IDLE
  return DOT_IN_FLIGHT
}

/** Pure view — everything it shows arrives as props, so a static render pins the wording. */
export function ThreadStatusView({
  activity,
  counts,
  usage,
  cwd,
  statsOpen = false,
  onToggleStats,
}: ThreadStatusViewProps): React.ReactNode {
  const dotClass = activityDotClass(activity)
  const context = usage?.context ?? null
  return (
    <footer
      id="thread-status"
      className="flex items-center gap-3 border-t px-4 py-1 font-mono text-muted-foreground text-xs"
    >
      <span
        className="flex items-center gap-1.5"
        title={
          activity.kind === 'disconnected'
            ? 'the connection to the server ended — reload and resume from the rail'
            : "what the run is doing right now, read off the transcript's tail"
        }
      >
        <span aria-hidden="true" className={dotClass} />
        {activityLabel(activity)}
      </span>
      <span title="user messages in this transcript">
        {counts.prompts} {counts.prompts === 1 ? 'prompt' : 'prompts'}
      </span>
      <span title="tool calls across this transcript, finished or not">
        {counts.toolCalls} {counts.toolCalls === 1 ? 'tool call' : 'tool calls'}
      </span>
      {cwd === undefined ? null : (
        <span title={`the tree pi reads and writes for this thread: ${cwd}`}>project {projectName(cwd)}</span>
      )}
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
      {onToggleStats === undefined ? null : (
        <button
          type="button"
          className="text-foreground underline-offset-2 hover:underline"
          aria-expanded={statsOpen}
          aria-controls="thread-stats-pane"
          title="per prompt, turn and tool: what this thread spent, and on what"
          onClick={onToggleStats}
        >
          {statsOpen ? 'hide stats' : 'stats'}
        </button>
      )}
    </footer>
  )
}

export interface ThreadStatusBarProps {
  readonly messages: ReadonlyArray<UIMessage>
  readonly generating: boolean
  readonly statsOpen?: boolean
  readonly onToggleStats?: () => void
}

/**
 * The bar wired to its thread: the chat's messages and in-flight flag come in as props
 * (the chat hook is bound inside chat-screen.tsx, and this module stays free of it), the
 * thread's usage store and its disconnected flag (#119) are read from context.
 */
export function ThreadStatusBar({
  messages,
  generating,
  statsOpen,
  onToggleStats,
}: ThreadStatusBarProps): React.ReactNode {
  const stores = useThreadStores()
  const usage = useStore(stores.usage)
  const disconnected = useStore(stores.disconnected)
  const cwd = useStore(stores.cwd)
  return (
    <ThreadStatusView
      activity={describeActivity(messages, generating, disconnected)}
      counts={countThread(messages)}
      usage={usage}
      cwd={cwd}
      statsOpen={statsOpen ?? false}
      onToggleStats={onToggleStats}
    />
  )
}
