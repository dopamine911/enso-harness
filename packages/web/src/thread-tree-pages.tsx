import { EnsoThreadPages } from '@enso/core'
import { CopyIcon, ExternalLinkIcon, EyeIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx'
import { STATUS_BUTTON } from './menu-chrome.ts'
import { TREE_READ_INTERVAL_MS, useReadOnUsage } from './read-on-usage.ts'
import {
  ANALYSIS_READING,
  type AnalysisOutcome,
  readThreadAnalysis,
  readThreadRoute,
  THREAD_READ_NONE,
  type ThreadReadOutcome,
} from './route-read.ts'
import { useThreadStores } from './store.ts'
import { TreeSetupReport } from './tree-setup-report.tsx'

/**
 * What a thread built, reachable from the page (#619). A thread runs in a tree of its own (#551),
 * so its work is not in the user's checkout. The status bar's "own tree" opens this: the tree's
 * path, to copy, what preparing it did (its setup, #754), and the HTML pages in it, each opened in a
 * new tab on the thread's preview origin (`server/thread-preview-route.ts`).
 *
 * ⚠ A NEW TAB, ON AN ORIGIN OF ITS OWN (#713). The preview is agent-written; it is served from the
 * thread's own loopback port, the tree at `/`, so it runs as it would anywhere — its storage, its
 * root paths — and Enso trusts no request from it (#717). The tab is opened `noopener noreferrer`
 * so it holds no handle on this page either.
 */

/** The preview URL of one page of the thread's tree, on the thread's preview origin, each segment encoded. */
function previewUrl(previewOrigin: string, page: string): string {
  return `${previewOrigin}/${page.split('/').map(encodeURIComponent).join('/')}`
}

/** What the last copy of the path came to: not tried yet, done, or refused by the clipboard. */
type CopyState = 'idle' | 'copied' | 'failed'

/** The panel's body: the path and its copy, then the pages. */
function ThreadTreePagesBody({
  outcome,
  onCopy,
  copy,
  onOpened,
}: {
  readonly outcome: AnalysisOutcome<EnsoThreadPages>
  readonly onCopy: (path: string) => void
  readonly copy: CopyState
  /** A preview opened in its tab: the panel's work is done (#714). */
  readonly onOpened: () => void
}): React.ReactNode {
  if (outcome.kind === 'reading') return <p className="text-sm text-muted-foreground">reading the tree…</p>
  if (outcome.kind === 'failed') {
    return <p className="text-sm text-muted-foreground">the tree could not be read: {outcome.problem}</p>
  }
  const { path, pages, truncated, previewOrigin, setup } = outcome.payload
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
        {/* A refused copy is said, never a button that silently did nothing. */}
        {copy === 'failed' ? (
          <span className="text-muted-foreground">The clipboard refused the copy: select the path to copy it.</span>
        ) : null}
      </div>
      {/* #754: what preparing the tree did — a failed setup is said here, with the file to fix. */}
      {setup === undefined ? null : <TreeSetupReport setup={setup} />}
      <div className="grid gap-1.5">
        <span className="text-muted-foreground">Pages it can show:</span>
        {pages.length === 0 || previewOrigin === undefined ? (
          <p>No HTML page at the top two levels of the tree.</p>
        ) : (
          <ul className="grid gap-1">
            {pages.map((page) => (
              <li key={page} className="flex items-center justify-between gap-3">
                <code className="font-mono text-xs wrap-anywhere">{page}</code>
                {/* #729: each link's name says which page ("Open preview of debug.html"), not N identical ones. */}
                <Button asChild variant="outline" size="sm">
                  <a
                    href={previewUrl(previewOrigin, page)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={onOpened}
                  >
                    <ExternalLinkIcon />
                    Open preview
                    <span className="sr-only"> of {page}</span>
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {truncated ? <p className="text-muted-foreground">More pages than listed here; open others by path.</p> : null}
        <p className="text-xs text-muted-foreground">
          A preview opens in a new tab, on an origin of its own: it runs as it would anywhere, and it can't reach Enso.
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
 * Focus the composer of the thread layout `inside` sits in (#714): the chat screen marks its
 * layout `data-thread-layout`, and the composer is its `PromptInputTextarea` (`name="message"`).
 * Without either (the markup changed), focus goes to `inside`, the bar's own button, close to where
 * Radix would have returned it: never to nowhere, which is the page's body.
 */
function focusComposerNear(inside: HTMLElement | null): void {
  const composer = inside
    ?.closest('[data-thread-layout]')
    ?.querySelector<HTMLTextAreaElement>('textarea[name="message"]')
  ;(composer ?? inside)?.focus()
}

/**
 * The bar's "own tree, not your checkout", as a button that opens the panel — and, once the tree
 * holds an HTML page, a **Preview** beside it that opens the same panel (#640).
 *
 * ⚠ OPEN PREVIEW CLOSES THE PANEL, AND FOCUS GOES TO THE COMPOSER (#714). Found by an arena run: the
 * panel stayed open over the chat once its preview tab opened, so coming back to Enso to say what
 * playing found met a blocked chat, and the natural Enter — focus still on Open preview — opened a
 * second preview tab. What follows a preview is the next prompt.
 *
 * ⚠ NAMED FOR WHAT IT DOES. The first agent run after the preview shipped read the "own tree"
 * button and concluded Enso had no preview: the words say where the work is, not that it can be
 * opened. So the bar also says "Preview" while there is something to preview. It reads the tree's
 * pages as the git readout reads git (`thread-git.tsx`): once the thread has a session, and again
 * at settled tool results, paced as git's (#739), so a page built mid-run brings the control in
 * without a reload.
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
  // The bar's own button: where this thread's layout, and so its composer, is found from (#714).
  const trigger = useRef<HTMLButtonElement | null>(null)
  const listed = useReadOnUsage(
    readable ? readThreadPages : readNoPages,
    THREAD_READ_NONE,
    moment,
    TREE_READ_INTERVAL_MS,
  )
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
        ref={trigger}
        type="button"
        className={`${STATUS_BUTTON} text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid`}
        title="this thread reads and writes a tree of its own — open to see where, and to preview its pages"
        onClick={() => setOpen(true)}
      >
        own tree, not your checkout
      </button>
      {hasPages ? (
        <button
          type="button"
          className={`${STATUS_BUTTON} text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid`}
          title="open a page this thread built, in a new tab"
          onClick={() => setOpen(true)}
        >
          <EyeIcon aria-hidden="true" className="size-3" />
          Preview
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="rounded-lg p-6 shadow-pop ring-0 sm:max-w-lg"
          onCloseAutoFocus={(event: Event): void => {
            event.preventDefault()
            focusComposerNear(trigger.current)
          }}
        >
          <DialogHeader>
            <DialogTitle>What this thread built</DialogTitle>
            <DialogDescription>Its edits are in a tree of its own until you bring them back.</DialogDescription>
          </DialogHeader>
          <ThreadTreePagesBody outcome={outcome} onCopy={copyPath} copy={copy} onOpened={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}
