import { PlusIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from './components/ui/button.tsx'

/**
 * The pane when a thread asked for is not on the server (#879): a rail row, a fork or a project's
 * thread the listing still named, whose session is gone. It says so with the id, and offers a new
 * thread, or the threads there are. It replaces the rail's "the server holds no session" line for
 * that case. Drawn over the panes, as a page beside the threads is (#869); any navigation ends it.
 */
export function ThreadNotFound({
  threadId,
  onNew,
  onSearch,
}: {
  threadId: string
  onNew: () => void
  /** Find a thread among the ones there are: the rail's search box (#875). */
  onSearch: () => void
}): React.ReactNode {
  // The screen answers a click elsewhere (a rail row): its heading takes focus, so it is read out.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [threadId])
  return (
    <section
      aria-labelledby="thread-not-found-title"
      className="absolute inset-0 grid place-items-center overflow-y-auto bg-background p-6"
    >
      {/* The prototype's `.not-found-card` (#417). */}
      <div className="flex w-full max-w-lg flex-col items-start gap-4 rounded-lg border bg-card p-8">
        <SearchXIcon aria-hidden="true" className="size-7 text-muted-foreground" />
        <h2 ref={heading} id="thread-not-found-title" tabIndex={-1} className="font-heading text-xl font-semibold">
          This thread isn’t on the server
        </h2>
        <p className="text-sm text-muted-foreground">
          Enso has no session under this id. It may have been deleted since the list was read.
        </p>
        <code className="w-full rounded-sm border bg-background px-3 py-2 font-mono text-xs break-all">{threadId}</code>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className={ACTION} onClick={onNew}>
            <PlusIcon />
            Start a new thread
          </Button>
          <Button
            type="button"
            variant="outline"
            className={`${ACTION} border-border-strong hover:border-primary hover:bg-accent`}
            onClick={onSearch}
          >
            Search threads
          </Button>
        </div>
      </div>
    </section>
  )
}

/** The prototype's `.button` (#417): 40px, the body size, bold. */
const ACTION = 'h-10 rounded-sm px-4 text-sm font-semibold'
