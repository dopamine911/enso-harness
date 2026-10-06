import { EnsoThreadPages } from '@enso/core'
import { CopyIcon, ExternalLinkIcon, EyeIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import {
  ANALYSIS_READING,
  type AnalysisOutcome,
  readThreadAnalysis,
  readThreadRoute,
  THREAD_READ_NONE,
  type ThreadReadOutcome,
} from './route-read.ts'
import { useThreadStores } from './store.ts'

/**
 * What a thread built, reachable from the page (#619). A thread runs in a tree of its own (#551),
 * so its work is not in the user's checkout. The status bar's "own tree" opens this: the tree's
 * path, to copy, and the HTML pages in it, each opened in a new tab through the server's preview
 * route (`server/thread-preview-route.ts`).
 *
 * ⚠ A NEW TAB, AND THE SERVER'S SANDBOX. The preview is agent-written; the server serves it under
 * a CSP sandbox that gives it an opaque origin, so it cannot use Enso's control plane. The tab is
 * opened `noopener noreferrer` so it holds no handle on this page either. A page's own `fetch()` of
 * its files fails under that sandbox, and the panel says so.
 */

/** The preview URL of one page of the thread's tree, each segment encoded. */
function previewUrl(threadId: string, page: string): string {
  return `/preview/threads/${encodeURIComponent(threadId)}/${page.split('/').map(encodeURIComponent).join('/')}`
}

/** What the last copy of the path came to: not tried yet, done, or refused by the clipboard. */
type CopyState = 'idle' | 'copied' | 'failed'

/** The panel's body: the path and its copy, then the pages. */
function ThreadTreePagesBody({
  threadId,
  outcome,
  onCopy,
  copy,
}: {
  readonly threadId: string
  readonly outcome: AnalysisOutcome<EnsoThreadPages>
  readonly onCopy: (path: string) => void
  readonly copy: CopyState
}): React.ReactNode {
  if (outcome.kind === 'reading') return <p className="text-sm text-muted-foreground">reading the tree…</p>
  if (outcome.kind === 'failed') {
    return <p className="text-sm text-muted-foreground">the tree could not be read: {outcome.problem}</p>
  }
  const { path, pages, truncated } = outcome.payload
  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-1.5">
        <span className="text-muted-foreground">Its files are here, not in your checkout:</span>
        <div className="flex items-start gap-2">
          <code className="flex-1 rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs wrap-anywhere">{path}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => onCopy(path)}>
            <CopyIcon />
            {copy === 'copied' ? 'Copied' : 'Copy path'}
          </Button>
        </div>
        {/* PR #635 review: a refused copy is said, never a button that silently did nothing. */}
        {copy === 'failed' ? (
          <span className="text-muted-foreground">The clipboard refused the copy: select the path to copy it.</span>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <span className="text-muted-foreground">Pages it can show:</span>
        {pages.length === 0 ? (
          <p>No HTML page at the top two levels of the tree.</p>
        ) : (
          <ul className="grid gap-1">
            {pages.map((page) => (
              <li key={page} className="flex items-center justify-between gap-3">
                <code className="font-mono text-xs wrap-anywhere">{page}</code>
                <Button asChild variant="outline" size="sm">
                  <a href={previewUrl(threadId, page)} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon />
                    Open preview
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {truncated ? <p className="text-muted-foreground">More pages than listed here; open others by path.</p> : null}
        <p className="text-xs text-muted-foreground">
          A preview opens in a new tab, sandboxed: it cannot reach Enso, and its own fetch() of its files is blocked.
        </p>
      </div>
    </div>
  )
}

/** `GET /api/threads/:id/tree`, as the bar holds it: nothing yet (or no session), the listing, or why not. */
const readThreadPages = (threadId: string, fetchImpl: FetchLike): Promise<ThreadReadOutcome<EnsoThreadPages>> =>
  readThreadRoute(threadId, 'tree', EnsoThreadPages, fetchImpl)
const readNoPages = (): Promise<ThreadReadOutcome<EnsoThreadPages>> => Promise.resolve(THREAD_READ_NONE)

/**
 * The bar's "own tree, not your checkout", as a button that opens the panel — and, once the tree
 * holds an HTML page, a **Preview** beside it that opens the same panel (#640).
 *
 * ⚠ NAMED FOR WHAT IT DOES. The first agent run after the preview shipped read the "own tree"
 * button and concluded Enso had no preview: the words say where the work is, not that it can be
 * opened. So the bar also says "Preview" while there is something to preview. It reads the tree's
 * pages as the git readout reads git (`thread-git.tsx`): once the thread has a session, and again
 * at every settled tool result, so a page built mid-run brings the control in without a reload.
 * The panel reads its own listing each time it opens: the tree moves under a run.
 */
export function ThreadTreeButton({
  moment,
  readable,
}: {
  /** When the tree may have moved: settled tool results and the run flag, as the git readout's. */
  readonly moment: string
  /** The thread has a live session or a stored branch — a tree the route can read. */
  readonly readable: boolean
}): React.ReactNode {
  const stores = useThreadStores()
  const listed = useReadOnUsage(readable ? readThreadPages : readNoPages, THREAD_READ_NONE, moment)
  const hasPages = listed.kind === 'read' && listed.payload.pages.length > 0
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<AnalysisOutcome<EnsoThreadPages>>(ANALYSIS_READING)
  const [copy, setCopy] = useState<CopyState>('idle')
  useEffect(() => {
    if (!open) return
    let current = true
    setOutcome(ANALYSIS_READING)
    setCopy('idle')
    void readThreadAnalysis(stores.threadId, 'tree', EnsoThreadPages, stores.fetch).then((read) => {
      if (current) setOutcome(read)
    })
    return () => {
      current = false
    }
  }, [open, stores])
  const copyPath = (path: string): void => {
    void navigator.clipboard.writeText(path).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    )
  }
  return (
    <>
      <button
        type="button"
        className="text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid"
        title="this thread reads and writes a tree of its own — open to see where, and to preview its pages"
        onClick={() => setOpen(true)}
      >
        own tree, not your checkout
      </button>
      {hasPages ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid"
          title="open a page this thread built, in a new tab"
          onClick={() => setOpen(true)}
        >
          <EyeIcon aria-hidden="true" className="size-3" />
          Preview
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>What this thread built</DialogTitle>
            <DialogDescription>Its edits are in a tree of its own until you bring them back.</DialogDescription>
          </DialogHeader>
          <ThreadTreePagesBody threadId={stores.threadId} outcome={outcome} onCopy={copyPath} copy={copy} />
        </DialogContent>
      </Dialog>
    </>
  )
}
