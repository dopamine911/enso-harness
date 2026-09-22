import type { FetchLike } from '../browser-logging.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { readThreadUrl } from '../thread-url.ts'
import { LogTailScreen } from './log-tail-screen.tsx'
import { ThreadTimelineScreen } from './thread-timeline-screen.tsx'

/**
 * The debug page, by its URL (#144 slice 3): `debug.html` is the day's tail, and
 * `debug.html?thread=<id>` is that thread's timeline. ONE page with two views rather than two
 * pages, because they are the same surface — observation — and a thread id on the tail leads
 * into the timeline without leaving it.
 *
 * THE URL IS READ BY `thread-url.ts`, the file the chat page reads it with, so `?thread=` means
 * one thing on both pages and a link from either to the other carries the same id. And a
 * `?thread=` that CANNOT be a thread id is said, above the tail it fell back to — a page that
 * silently showed the whole day for a mistyped id would be answering a question nobody asked.
 */
export interface DebugScreenProps {
  /** `window.location.search` — passed in, so the entry is the one module that touches the DOM. */
  readonly search: string
  /** Test seam (#118's convention) — the browser's own otherwise. */
  readonly fetch?: FetchLike
}

export function DebugScreen({ search, fetch: pageFetch }: DebugScreenProps): React.ReactNode {
  const named = readThreadUrl(search)
  const seam = pageFetch === undefined ? {} : { fetch: pageFetch }
  if (named.kind === 'resume') return <ThreadTimelineScreen threadId={named.threadId} {...seam} />
  if (named.notice === undefined) return <LogTailScreen {...seam} />
  // The tail sizes itself to the viewport; in a flex column it shrinks under the notice
  // (it is `overflow-hidden`, so its minimum height is 0) rather than pushing the page to scroll.
  return (
    <div className="flex h-dvh flex-col">
      <div className="px-4 pt-2">
        <Alert variant="destructive">
          <AlertTitle>the thread in the URL</AlertTitle>
          <AlertDescription>{named.notice}</AlertDescription>
        </Alert>
      </div>
      <LogTailScreen {...seam} />
    </div>
  )
}
