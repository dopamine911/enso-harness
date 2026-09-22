import type { FetchLike } from '../browser-logging.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { readThreadUrl } from '../thread-url.ts'
import { DayStatsScreen } from './day-stats-screen.tsx'
import { LogTailScreen } from './log-tail-screen.tsx'
import { ThreadTimelineScreen } from './thread-timeline-screen.tsx'

/**
 * The debug page, by its URL (#144 slices 3–4): `debug.html` is the day's tail,
 * `debug.html?thread=<id>` is that thread's timeline, and `debug.html?stats` is the day's stats
 * and processes view. ONE page with three views rather than three pages, because they are the
 * same surface — observation — and a thread id on the tail or in a stats row leads into the
 * timeline without leaving it.
 *
 * THE URL IS READ BY `thread-url.ts`, the file the chat page reads it with, so `?thread=` means
 * one thing on both pages and a link from either to the other carries the same id. A thread
 * WINS over `stats`: a link into a timeline that carries a stale `?stats` along still names one
 * thread, and the narrower question is the one being asked. And a `?thread=` that CANNOT be a
 * thread id is said, above the tail it fell back to — a page that silently showed the whole day
 * for a mistyped id would be answering a question nobody asked.
 */

/** `?stats` — a flag, not a value: the day is the only one this page can sum. */
const STATS_QUERY_FLAG = 'stats'

export interface DebugScreenProps {
  /** `window.location.search` — passed in, so the entry is the one module that touches the DOM. */
  readonly search: string
  /** Test seam (#118's convention) — the browser's own otherwise. */
  readonly fetch?: FetchLike
}

export function DebugScreen({ search, fetch: pageFetch }: DebugScreenProps): React.ReactNode {
  const stats = new URLSearchParams(search).has(STATS_QUERY_FLAG)
  // The notice says what THIS page fell back to — never "opened a new thread", which is the
  // chat page's fallback and something an observation surface cannot do (PR #336 review).
  const named = readThreadUrl(search, stats ? "showing the day's stats instead" : "showing the day's log instead")
  const seam = pageFetch === undefined ? {} : { fetch: pageFetch }
  if (named.kind === 'resume') return <ThreadTimelineScreen threadId={named.threadId} {...seam} />
  const screen = stats ? <DayStatsScreen {...seam} /> : <LogTailScreen {...seam} />
  // A malformed id is said on EVERY fallback, the stats view included: the path where a reader
  // typed something wrong is exactly the one that must not swallow it (PR #336 review).
  if (named.notice === undefined) return screen
  // The screens size themselves to the viewport; in a flex column each shrinks under the notice
  // (they are `overflow-hidden`, so their minimum height is 0) rather than pushing the page to scroll.
  return (
    <div className="flex h-dvh flex-col">
      <div className="px-4 pt-2">
        <Alert variant="destructive">
          <AlertTitle>the thread in the URL</AlertTitle>
          <AlertDescription>{named.notice}</AlertDescription>
        </Alert>
      </div>
      {screen}
    </div>
  )
}
