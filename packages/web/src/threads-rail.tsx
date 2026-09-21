import type { ZenStoredThread } from '@zen/core'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { pageClock } from './page-clock.ts'
import { useStore } from './store.ts'
import type { ThreadSummary } from './thread-stores.ts'

/**
 * The threads rail (#90 PR 3): which conversation am I in, what else is live on this
 * page, how do I start over. deepseek-harness's left rail is the reference — a title, a
 * relative age, a New Thread button.
 *
 * Two lists, each labelled for what it is. "Active Threads": the threads this page has open
 * — they die with the page. "Previous Threads" (#95): pi's session files for this
 * workspace that this page has not got open; a click resumes one, with its history and
 * its mode, under the same id — the thread id IS pi's session id. A thread another page
 * is RUNNING right now (a run in flight, a dialog parked) is shown but not clickable:
 * two pages must not drive one pi session at once. Idle is resumable, even when this
 * server still holds it — a reload must get its own thread back (PR #104 review).
 *
 * Presentational: the lists, the active id, and the callbacks arrive as props, so a static
 * render pins the wording and the active marker without any chat. The clock is the one
 * input that is NOT a prop (#278): an age that only moves when the page happens to
 * re-render is a stale reading that looks live, so each age subscribes to `pageClock` —
 * which a static render does not, leaving the markup as fixed as the props are.
 */

/** `now`, `12s`, `3m`, `2h`, `6d` — deepseek's form, one unit, no "ago". */
export function relativeAge(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One row's age, live (#278). Its own component because the clock's tick re-renders
 * whatever read the clock: this label moves every five seconds and the rail, the panes and
 * the transcript above it do not re-render at all. Under a static render nothing subscribes
 * and the age is computed once, against the clock's load time.
 */
function Age({ from }: { from: Date }): React.ReactNode {
  const now = useStore(pageClock)
  return <>{relativeAge(from, now)}</>
}

/** What an untitled thread reads as — a thread that has not been asked anything yet. */
export const UNTITLED_THREAD = 'new thread'

export interface ThreadsRailProps {
  readonly threads: readonly ThreadSummary[]
  /** Undefined while a URL-named thread is still being adopted (#142): nothing is highlighted. */
  readonly activeThreadId: string | undefined
  /** Stored threads not open on this page, newest first — already filtered by the caller. */
  readonly earlier: readonly ZenStoredThread[]
  /** Why the earlier list could not be fetched, or undefined. Shown where the rows would be. */
  readonly earlierError: string | undefined
  readonly onSelect: (threadId: string) => void
  readonly onResume: (threadId: string) => void
  readonly onNew: () => void
}

/**
 * One stored thread's row: title, age, and — when it is running — a pulse. Running is
 * shown, not locked (#114): under the follow transport (#112) a resume MOUNTS the thread
 * and follows it, so a page that reloaded under pi's open question comes back to the card
 * from here. Before #113 a run belonged to the tab's HTTP response and a second page could
 * not join it, which is what the old `disabled` protected.
 */
function EarlierThreadRow({
  thread,
  onResume,
}: {
  thread: ZenStoredThread
  onResume: (threadId: string) => void
}): React.ReactNode {
  const at = new Date(thread.lastActivityAt)
  return (
    <li>
      <button
        type="button"
        title={thread.busy ? 'running — resume to follow it' : at.toLocaleString()}
        onClick={() => onResume(thread.threadId)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground text-xs hover:bg-muted"
      >
        {thread.busy ? (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground">
            <span className="sr-only">running</span>
          </span>
        ) : null}
        <span className={cn('min-w-0 flex-1 truncate', thread.title === undefined ? 'italic' : '')}>
          {thread.title ?? UNTITLED_THREAD}
        </span>
        <span className="shrink-0 tabular-nums">
          <Age from={at} />
        </span>
      </button>
    </li>
  )
}

export function ThreadsRail({
  threads,
  activeThreadId,
  earlier,
  earlierError,
  onSelect,
  onResume,
  onNew,
}: ThreadsRailProps): React.ReactNode {
  return (
    <nav aria-label="threads" className="flex w-56 shrink-0 flex-col gap-2 border-r p-2">
      <Button type="button" size="sm" variant="outline" onClick={onNew}>
        New Thread
      </Button>
      <h2 className="px-1 pt-1 font-medium text-muted-foreground text-xs">Active Threads</h2>
      <ol aria-label="Active Threads" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {threads.map((thread) => {
          const active = thread.threadId === activeThreadId
          return (
            <li key={thread.threadId}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(thread.threadId)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted',
                  active ? 'bg-muted text-foreground' : 'text-muted-foreground',
                )}
              >
                {/* The busy dot is the status bar's, at rail size: a run is in flight there. */}
                {thread.busy ? (
                  <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground">
                    <span className="sr-only">running</span>
                  </span>
                ) : null}
                <span className={cn('min-w-0 flex-1 truncate', thread.title === undefined ? 'italic' : '')}>
                  {thread.title ?? UNTITLED_THREAD}
                </span>
                <span className="shrink-0 tabular-nums" title={thread.lastActivityAt.toLocaleString()}>
                  <Age from={thread.lastActivityAt} />
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <h2 className="px-1 pt-1 font-medium text-muted-foreground text-xs">Previous Threads</h2>
      {earlierError !== undefined ? (
        <div role="alert" className="px-2 text-destructive text-xs">
          could not list previous threads: {earlierError}
        </div>
      ) : null}
      <ol aria-label="Previous Threads" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {earlier.length === 0 && earlierError === undefined ? (
          <li className="px-2 py-1.5 text-muted-foreground text-xs italic">none yet</li>
        ) : null}
        {earlier.map((thread) => (
          <EarlierThreadRow key={thread.threadId} thread={thread} onResume={onResume} />
        ))}
      </ol>
    </nav>
  )
}
