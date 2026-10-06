import { EnsoThreadPages } from '@enso/core'
import { CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
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

/** The panel's body: the path and its copy, then the pages. */
function ThreadTreePagesBody({
  threadId,
  outcome,
  onCopy,
  copied,
}: {
  readonly threadId: string
  readonly outcome: AnalysisOutcome<EnsoThreadPages>
  readonly onCopy: (path: string) => void
  readonly copied: boolean
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
            {copied ? 'Copied' : 'Copy path'}
          </Button>
        </div>
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

/**
 * The bar's "own tree, not your checkout", as a button that opens the panel. Read each time it
 * opens: the tree moves under a run, and nothing here is cached.
 */
export function ThreadTreeButton(): React.ReactNode {
  const stores = useThreadStores()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<AnalysisOutcome<EnsoThreadPages>>(ANALYSIS_READING)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!open) return
    let current = true
    setOutcome(ANALYSIS_READING)
    setCopied(false)
    void readThreadAnalysis(stores.threadId, 'tree', EnsoThreadPages, stores.fetch).then((read) => {
      if (current) setOutcome(read)
    })
    return () => {
      current = false
    }
  }, [open, stores])
  const copy = (path: string): void => {
    void navigator.clipboard.writeText(path).then(
      () => setCopied(true),
      () => setCopied(false),
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>What this thread built</DialogTitle>
            <DialogDescription>Its edits are in a tree of its own until you bring them back.</DialogDescription>
          </DialogHeader>
          <ThreadTreePagesBody threadId={stores.threadId} outcome={outcome} onCopy={copy} copied={copied} />
        </DialogContent>
      </Dialog>
    </>
  )
}
