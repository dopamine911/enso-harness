import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { describeThrown, PAGE_FAULT_WORDS, pageFault, reportPageFault } from './page-health.ts'
import { reloadKeepingDrafts } from './page-reload.ts'
import { useStore } from './store.ts'

/**
 * What a page that may be out of date shows (#919): the one banner with Reload, and the error
 * boundary each pane draws inside — `page-health.ts` has the triggers.
 */

/**
 * The banner, over the main column: the page's words and Reload, which keeps every composer's draft
 * (`page-reload.ts`). Nothing while the page is believed. ⚠ The page never reloads by itself.
 */
export function PageFaultBanner(): React.ReactNode {
  const fault = useStore(pageFault)
  const [reloading, setReloading] = useState(false)
  if (fault === undefined) return null
  return (
    <div
      role="alert"
      data-page-fault={fault.trigger}
      className="flex shrink-0 items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">{fault.trigger === 'lost' ? PAGE_FAULT_WORDS.lost : PAGE_FAULT_WORDS.banner}</p>
      <Button
        size="sm"
        variant="destructive"
        disabled={reloading}
        onClick={(): void => {
          setReloading(true)
          void reloadKeepingDrafts()
        }}
      >
        <RotateCwIcon aria-hidden="true" />
        {PAGE_FAULT_WORDS.reload}
      </Button>
    </div>
  )
}

interface PaneBoundaryProps {
  /** The pane, as the record and the fallback name it: `transcript`, `views`, `rail`. */
  readonly pane: string
  /** The thread the pane shows; the rail shows none. */
  readonly threadId?: string | undefined
  /** Where the failure is drawn, when the pane's own box is not in the flow (the views, over the transcript). */
  readonly placement?: string
  readonly children: ReactNode
}

/**
 * One pane's error boundary (#919): a throw while rendering it replaces THAT pane with what failed,
 * and the rest of the page goes on — the composer, the other panes, the rail. Logged with the pane
 * and the thread, and the page's banner says the page may be out of date. Before this, a throw in
 * any pane unmounted the whole page, or nothing caught it at all.
 */
export class PaneBoundary extends Component<PaneBoundaryProps, { readonly failed: string | undefined }> {
  override state: { readonly failed: string | undefined } = { failed: undefined }

  static getDerivedStateFromError(thrown: unknown): { readonly failed: string } {
    return { failed: describeThrown(thrown).error }
  }

  override componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    const { error, stack } = describeThrown(thrown)
    reportPageFault({
      trigger: 'render',
      pane: this.props.pane,
      threadId: this.props.threadId,
      error,
      ...(stack === undefined ? {} : { stack: `${stack}${info.componentStack ?? ''}` }),
    })
  }

  override render(): ReactNode {
    if (this.state.failed === undefined) return this.props.children
    return (
      <Alert
        variant="destructive"
        className={cn('m-4 w-auto max-w-sm self-start', this.props.placement)}
        data-pane-failed={this.props.pane}
      >
        <TriangleAlertIcon />
        <AlertTitle>the {this.props.pane} failed to draw</AlertTitle>
        <AlertDescription className="whitespace-pre-wrap">
          {this.state.failed} — the rest of the page still works; Reload brings this back.
        </AlertDescription>
      </Alert>
    )
  }
}
