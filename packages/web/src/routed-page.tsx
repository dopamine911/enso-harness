import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { ChevronLeftIcon, PlusIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { AddProjectPage } from './add-project.tsx'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import type { ListingState } from './listing-store.ts'
import { HEADER, RailToggle } from './page-header.tsx'
import { type PolicyEditor, usePermissionPolicy } from './permissions-settings.tsx'
import { projectOf } from './project-list.ts'
import { ProjectPage, type ProjectPageActions } from './project-page.tsx'
import { type ProjectCardActions, ProjectsPage } from './projects-page.tsx'
import { SettingsPage } from './settings-page.tsx'
import type { ThreadSummary } from './thread-stores.ts'
import {
  ADD_PROJECT_ROUTE,
  type PageRoute,
  type PageUrl,
  PROJECTS_ROUTE,
  projectRoute,
  SETTINGS_ROUTE,
} from './thread-url.ts'

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
  /** The subtitle is a path, set in the code face as the prototype's project header sets it (#417). */
  readonly subtitleIsPath?: boolean
  readonly back?: PageBack
  /** The status strip's name for it. */
  readonly status: string
}

/** Each page as its sections' not-found goes back to it: its name, and where its link opens it. A project's page, and Add project, are among the Projects. */
const PAGE_HOMES: Readonly<Record<PageRoute['kind'], PageBack>> = {
  settings: { label: 'Settings', to: SETTINGS_ROUTE },
  projects: { label: 'Projects', to: PROJECTS_ROUTE },
  project: { label: 'Projects', to: PROJECTS_ROUTE },
  'add-project': { label: 'Projects', to: PROJECTS_ROUTE },
}

/** What a page's not-found says it lacks: Settings' sections, a project page's tabs (#871); Projects and Add project (#872) have none. */
const MISSING_PART: Readonly<Record<PageRoute['kind'], string>> = {
  settings: 'Settings has no section called',
  projects: 'Projects has no section called',
  project: 'A project’s page has no tab called',
  'add-project': 'Add project has no section called',
}

/** A project's page is headed by the project the listing names; one it does not name is not found. */
function projectHeading(project: EnsoProject | undefined): PageHeading {
  const back = PAGE_HOMES.project
  if (project === undefined) return { title: 'Project not found', back, status: back.label }
  return { title: project.title, subtitle: project.path, subtitleIsPath: true, back, status: project.title }
}

/** Each page's heading, the one place a page's name is written. */
function headingOf(page: PageUrl, projects: readonly EnsoProject[]): PageHeading {
  if (page.kind === 'settings') {
    return {
      title: 'Settings',
      subtitle: 'Appearance stays in this browser. Permissions, web tools and storage live on the server.',
      status: 'Settings',
    }
  }
  if (page.kind === 'projects') {
    return { title: 'Projects', subtitle: 'Folders on this machine that pi can work in', status: 'Projects' }
  }
  if (page.kind === 'project') {
    return projectHeading(projects.find((project) => project.projectId === page.projectId))
  }
  if (page.kind === 'add-project')
    return { title: 'Add a project', back: PAGE_HOMES['add-project'], status: 'Adding a project' }
  if (page.within !== undefined) {
    const home = PAGE_HOMES[page.within]
    return { title: 'Section not found', back: home, status: home.label }
  }
  return { title: 'Page not found', status: 'Page not found' }
}

/** The breadcrumb back: where the page sits, one click up. */
function BackLink({ back, onOpen }: { back: PageBack; onOpen: (route: PageRoute) => void }): React.ReactNode {
  return (
    <button
      type="button"
      onClick={() => onOpen(back.to)}
      className="-ml-1 flex min-h-6 items-center gap-1 justify-self-start rounded-xs px-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5"
    >
      <ChevronLeftIcon />
      {back.label}
    </button>
  )
}

/** The page's own action at the header's end: Projects' Add project, a project's New thread, or none. */
function PageAction({
  page,
  projects,
  onOpen,
  onNewThread,
}: {
  page: PageUrl
  projects: readonly EnsoProject[]
  onOpen: (route: PageRoute) => void
  onNewThread: (projectId: string) => void
}): React.ReactNode {
  const className = 'h-10 rounded-sm px-4 text-sm font-semibold'
  if (page.kind === 'projects') {
    return (
      <Button type="button" className={className} onClick={() => onOpen(ADD_PROJECT_ROUTE)}>
        <PlusIcon />
        Add project
      </Button>
    )
  }
  if (page.kind !== 'project') return null
  const project = projects.find((row) => row.projectId === page.projectId)
  if (project === undefined) return null
  // A folder that is gone can start nothing — the launch panel would only say so (`launch-panel.tsx`).
  const blocked = project.status === 'missing-dir'
  return (
    <Button
      type="button"
      className={className}
      disabled={blocked}
      title={blocked ? 'No new thread can start in this project' : undefined}
      onClick={() => onNewThread(project.projectId)}
    >
      <PlusIcon />
      New thread
    </Button>
  )
}

/**
 * A page's header: the threads button (narrow screens), the breadcrumb back where the page has
 * one, its title and what it is, and the page's own action (`PageAction`) — Projects' **Add
 * project** (#870), which opens the Add project page (#872), or a project's **New thread** (#417),
 * started in that project. The thread header's box (`HEADER`), so moving between a thread and a
 * page doesn't jump (#417).
 * Arriving on a page moves focus to its title, so a keyboard or a screen reader starts where the
 * page does; moving within it (a section) leaves focus on the link that moved it.
 */
export function PageHeader({
  page,
  projects,
  rail,
  onOpen,
  onNewThread,
}: {
  page: PageUrl
  /** The listed projects: a project's page is headed by its title and path (#871). */
  projects: readonly EnsoProject[]
  rail: { open: boolean; toggle: () => void }
  onOpen: (route: PageRoute) => void
  /** Start a thread in the project, as the rail's `+` does. */
  onNewThread: (projectId: string) => void
}): React.ReactNode {
  const heading = headingOf(page, projects)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    title.current?.focus()
  }, [heading.title])
  return (
    <header className={HEADER}>
      <RailToggle open={rail.open} onToggle={rail.toggle} />
      <div className="grid min-w-0 flex-1 justify-items-start">
        {heading.back === undefined ? null : <BackLink back={heading.back} onOpen={onOpen} />}
        <h1
          ref={title}
          id="page-heading"
          tabIndex={-1}
          className="truncate font-heading text-base leading-snug font-semibold focus:outline-none"
        >
          {heading.title}
        </h1>
        {heading.subtitle === undefined ? null : (
          <p
            className={cn(
              'max-w-full truncate text-xs text-muted-foreground',
              heading.subtitleIsPath === true && 'font-mono',
            )}
            title={heading.subtitleIsPath === true ? heading.subtitle : undefined}
          >
            {heading.subtitle}
          </p>
        )}
      </div>
      <PageAction page={page} projects={projects} onOpen={onOpen} onNewThread={onNewThread} />
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
  // Within a page, that page is the way back; a page Enso doesn't have at all goes back to the thread.
  const home = page.within === undefined ? undefined : PAGE_HOMES[page.within]
  const [where, wayBack, back] =
    page.within === undefined || home === undefined
      ? ['Enso has no page called', 'Back to the thread', onLeave]
      : [MISSING_PART[page.within], `Open ${home.label}`, (): void => onOpen(home.to)]
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
      className="flex min-h-8 shrink-0 items-center gap-4 overflow-hidden border-t px-6 font-mono text-xs whitespace-nowrap text-muted-foreground max-md:gap-3 max-md:px-4"
    >
      <span className="flex items-center gap-2 font-semibold text-foreground">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full border-dot border-muted-foreground" />
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
  /** The thread behind the page: Settings' "Try a command" asks it, and Projects marks its project current. */
  readonly threadId: string | undefined
  readonly projects: ListingState<EnsoProject>
  readonly stored: ListingState<EnsoStoredThread>
  /** This page's own threads: Projects counts them with the stored ones. */
  readonly pageThreads: readonly ThreadSummary[]
  /** A thread deleted from a page (Settings' Storage): the page leaves it, as the header's Delete does. */
  readonly onDeleted: (threadId: string) => void
  /** What a Projects card's buttons do (#870). */
  readonly projectActions: ProjectCardActions
  /** What a project's page does (#871): open one of its threads, read the projects again, and remove it — then leave it for Projects. */
  readonly projectPageActions: Pick<ProjectPageActions, 'onOpenThread' | 'onCheckAgain' | 'onRemove'>
  /** Why the last project removal did not go through, or undefined: said on Projects and on the project's page. */
  readonly projectNotice: string | undefined
  /** A project the Add project page registered (#872): the page reads the projects again and opens its page. */
  readonly onProjectAdded: (project: EnsoProject) => void
}

/** The page's own content: Settings at its section, Projects, a project's page, Add project, or what was asked and not found. */
function PageBody({
  page,
  permissions,
  props,
}: {
  page: PageUrl
  permissions: PolicyEditor
  props: RoutedPageProps
}): React.ReactNode {
  const { onOpen, onLeave, threadId, projects, stored, pageThreads, onDeleted } = props
  if (page.kind === 'settings') {
    return (
      <SettingsPage
        section={page.section}
        onSection={(section) => onOpen({ kind: 'settings', section })}
        permissions={permissions}
        threadId={threadId}
        projects={projects.rows}
        stored={stored.rows}
        onDeleted={onDeleted}
        onOpenProject={(projectId, tab) => onOpen(projectRoute(projectId, tab))}
        onOpenProjects={() => onOpen(PROJECTS_ROUTE)}
      />
    )
  }
  if (page.kind === 'projects') {
    // The thread behind the page names the current project; none is marked while it is still being adopted.
    const behind = pageThreads.find((thread) => thread.threadId === threadId)
    return (
      <ProjectsPage
        projects={projects}
        pageThreads={pageThreads}
        stored={stored.rows}
        currentProjectId={behind === undefined ? undefined : projectOf(projects.rows, behind.projectId)?.projectId}
        notice={props.projectNotice}
        {...props.projectActions}
      />
    )
  }
  if (page.kind === 'project') {
    return (
      <ProjectPage
        route={page}
        projects={projects}
        pageThreads={pageThreads}
        stored={stored.rows}
        notice={props.projectNotice}
        onOpen={onOpen}
        onDeleted={onDeleted}
        {...props.projectPageActions}
      />
    )
  }
  if (page.kind === 'add-project') {
    return <AddProjectPage projects={projects.rows} onOpen={onOpen} onAdded={props.onProjectAdded} />
  }
  return <NotFound page={page} onOpen={onOpen} onLeave={onLeave} />
}

/**
 * The page on screen, in the pane's box, over the threads kept there. Mounted with or without a
 * page, so what a page holds unsaved outlives a visit: Settings' Permissions draft is held here,
 * and leaving Settings keeps it, as closing the dialog it was did.
 */
export function RoutedPage(props: RoutedPageProps): React.ReactNode {
  const { page, projects, stored } = props
  const permissions = usePermissionPolicy(page?.kind === 'settings', undefined)
  if (page === undefined) return null
  return (
    <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background">
      <div role="region" aria-labelledby="page-heading" className="min-h-0 flex-1 overflow-y-auto">
        <PageBody page={page} permissions={permissions} props={props} />
      </div>
      <PageStatus heading={headingOf(page, projects.rows)} projects={projects} stored={stored} />
    </div>
  )
}
