import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { ChevronLeftIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from './components/ui/button.tsx'
import { EnsoSmile } from './enso-mark.tsx'
import type { ListingState } from './listing-store.ts'
import { RailToggle } from './page-header.tsx'
import { usePermissionPolicy } from './permissions-settings.tsx'
import { SettingsPage } from './settings-page.tsx'
import { type PageRoute, type PageUrl, SETTINGS_ROUTE } from './thread-url.ts'

/**
 * The pages beside the threads (#869): what the URL's `?page=` names (`thread-url.ts`), drawn in
 * the box a thread's pane fills, with the header and status strip a page has in place of a
 * thread's. The thread stays mounted behind the page, off screen as any other pane is, so a run
 * goes on and leaving the page shows it as it was. A page Enso doesn't have, or a section its
 * page doesn't, is said as not found with a way back — never a blank page.
 */

/** Where a page's breadcrumb goes back to. */
interface PageBack {
  readonly label: string
  readonly to: PageRoute
}

/** What a page's header and status strip say it is. */
interface PageHeading {
  readonly title: string
  readonly subtitle?: string
  readonly back?: PageBack
  /** The status strip's name for it. */
  readonly status: string
}

/** Each page's heading, the one place a page's name is written. */
function headingOf(page: PageUrl): PageHeading {
  if (page.kind === 'settings') {
    return {
      title: 'Settings',
      subtitle: 'Appearance stays in this browser. Permissions and storage live on the server.',
      status: 'Settings',
    }
  }
  if (page.within === 'settings') {
    return { title: 'Section not found', back: { label: 'Settings', to: SETTINGS_ROUTE }, status: 'Settings' }
  }
  return { title: 'Page not found', status: 'Page not found' }
}

/** The breadcrumb back: where the page sits, one click up. */
function BackLink({ back, onOpen }: { back: PageBack; onOpen: (route: PageRoute) => void }): React.ReactNode {
  return (
    <button
      type="button"
      onClick={() => onOpen(back.to)}
      className="flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3"
    >
      <ChevronLeftIcon />
      {back.label}
    </button>
  )
}

/**
 * A page's header: the threads button (narrow screens), the mark, the breadcrumb back where the page
 * has one, its title and what it is. Arriving on a page moves focus to its title, so a keyboard or
 * a screen reader starts where the page does; moving within it (a section) leaves focus on the link
 * that moved it.
 */
export function PageHeader({
  page,
  rail,
  onOpen,
}: {
  page: PageUrl
  rail: { open: boolean; toggle: () => void }
  onOpen: (route: PageRoute) => void
}): React.ReactNode {
  const heading = headingOf(page)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    title.current?.focus()
  }, [heading.title])
  return (
    <header className="flex min-h-14 items-center gap-3 border-b bg-sidebar px-3 py-2">
      <RailToggle open={rail.open} onToggle={rail.toggle} />
      <EnsoSmile className="size-7.5" />
      <div className="grid min-w-0 flex-1 justify-items-start">
        {heading.back === undefined ? null : <BackLink back={heading.back} onOpen={onOpen} />}
        <h1
          ref={title}
          id="page-heading"
          tabIndex={-1}
          className="truncate font-heading text-base font-semibold focus:outline-none"
        >
          {heading.title}
        </h1>
        {heading.subtitle === undefined ? null : (
          <p className="max-w-full truncate text-xs text-muted-foreground">{heading.subtitle}</p>
        )}
      </div>
    </header>
  )
}

/** A page or section Enso doesn't have: what was asked, and the way back. */
function NotFound({
  page,
  onOpen,
  onLeave,
}: {
  page: Extract<PageUrl, { kind: 'not-found' }>
  onOpen: (route: PageRoute) => void
  onLeave: () => void
}): React.ReactNode {
  // Within Settings, Settings is the way back; a page Enso doesn't have at all goes back to the thread.
  const [where, wayBack, back] =
    page.within === 'settings'
      ? ['Settings has no section called', 'Open Settings', (): void => onOpen(SETTINGS_ROUTE)]
      : ['Enso has no page called', 'Back to the thread', onLeave]
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="flex w-full max-w-lg flex-col items-start gap-4 rounded-lg border bg-card p-8">
        <SearchXIcon aria-hidden="true" className="size-7 text-muted-foreground" />
        <p className="text-sm">
          {where} <code className="font-mono break-all">“{page.asked}”</code>.
        </p>
        <Button type="button" onClick={back}>
          {wayBack}
        </Button>
      </div>
    </div>
  )
}

/** The page's counts, under every page: projects and the threads the server holds, or why not. */
function PageStatus({
  heading,
  projects,
  stored,
}: {
  heading: PageHeading
  projects: ListingState<EnsoProject>
  stored: ListingState<EnsoStoredThread>
}): React.ReactNode {
  const projectCount = projects.rows.length
  const threadCount = stored.rows.length
  return (
    <footer
      aria-label="page status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-5 py-2 font-mono text-xs text-muted-foreground"
    >
      <span className="flex items-center gap-2 font-semibold text-foreground">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-muted-foreground" />
        {heading.status}
      </span>
      <span title="the projects this server serves">
        {projects.error === undefined
          ? `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`
          : 'projects not listed'}
      </span>
      <span title="the threads the server holds, in every project">
        {stored.error === undefined
          ? `${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}`
          : 'threads not listed'}
      </span>
    </footer>
  )
}

export interface RoutedPageProps {
  /** The page on screen, or undefined: a thread is, and this draws nothing. */
  readonly page: PageUrl | undefined
  readonly onOpen: (route: PageRoute) => void
  /** Leave the page for the thread behind it — not-found's way back when there is no page to go to. */
  readonly onLeave: () => void
  /** The thread behind the page: Settings' "Try a command" asks it. */
  readonly threadId: string | undefined
  readonly projects: ListingState<EnsoProject>
  readonly stored: ListingState<EnsoStoredThread>
  /** A thread deleted from a page (Settings' Storage): the page leaves it, as the header's Delete does. */
  readonly onDeleted: (threadId: string) => void
}

/**
 * The page on screen, in the pane's box, over the threads kept there. Mounted with or without a
 * page, so what a page holds unsaved outlives a visit: Settings' Permissions draft is held here,
 * and leaving Settings keeps it, as closing the dialog it was did.
 */
export function RoutedPage({
  page,
  onOpen,
  onLeave,
  threadId,
  projects,
  stored,
  onDeleted,
}: RoutedPageProps): React.ReactNode {
  const permissions = usePermissionPolicy(page?.kind === 'settings', undefined)
  if (page === undefined) return null
  return (
    <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background">
      <div role="region" aria-labelledby="page-heading" className="min-h-0 flex-1 overflow-y-auto">
        {page.kind === 'settings' ? (
          <SettingsPage
            section={page.section}
            onSection={(section) => onOpen({ kind: 'settings', section })}
            permissions={permissions}
            threadId={threadId}
            projects={projects.rows}
            stored={stored.rows}
            onDeleted={onDeleted}
          />
        ) : (
          <NotFound page={page} onOpen={onOpen} onLeave={onLeave} />
        )}
      </div>
      <PageStatus heading={headingOf(page)} projects={projects} stored={stored} />
    </div>
  )
}
