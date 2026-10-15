import { isEnsoThreadId } from '@enso/core'
import { type PaneLayout, paneLayoutOf } from './pane-layout.ts'

/**
 * The thread a page URL names (#142): `?thread=<id>`. The URL is the source of truth for
 * the active pane, so a reload shows the thread you were in, back/forward walk the threads
 * you switched between, and a thread has a link.
 *
 * The query form, not a path: the dev server serves one page and a path would need a
 * fallback route; `?debug`, `?log` and `?fixture` already live in the query, and every
 * write here keeps them. A thread id IS pi's session id (#95), so the value is checked
 * with the same `isEnsoThreadId` the server checks it with — a malformed one is not a
 * thread, and the page says so rather than showing nothing.
 */
const THREAD_QUERY_PARAMETER = 'thread'

export type ThreadUrl =
  /** The URL names a thread; adopt it from `/history` before showing anything. */
  | { readonly kind: 'resume'; readonly threadId: string }
  /** No thread named — a fresh page — or one that cannot be a thread id, with why. */
  | { readonly kind: 'fresh'; readonly notice?: string }

/**
 * What the page did INSTEAD when the id was not one — the notice's second half. The chat page
 * opens a new thread; the debug page falls back to the day's tail, and a notice that said it
 * "opened a new thread" there told the reader the page did something it cannot do (PR #336
 * review). The page that knows what it fell back to says so.
 *
 * @invariant resume/url-names-thread The URL names the thread; the latest navigation wins.
 * A thread id resumes, none is fresh, a malformed one is fresh AND said; `urlForThread` keeps
 * every other parameter. The boot resumes with `pop` (no history written), a rail click pushes
 * (`chat-screen.tsx`, `BOOT` and `show`), and two guards drop a late answer whole:
 * `createResumeRequests` (last click wins) and the page's `epoch` (a navigation or a request since).
 */
export function readThreadUrl(search: string, fellBackTo = 'opened a new thread instead'): ThreadUrl {
  const named = new URLSearchParams(search).get(THREAD_QUERY_PARAMETER)
  if (named === null || named === '') return { kind: 'fresh' }
  // Checked as `unknown`: the guard narrows to `string`, which would leave `named` as `never` below.
  const candidate: unknown = named
  if (isEnsoThreadId(candidate)) return { kind: 'resume', threadId: candidate }
  return {
    kind: 'fresh',
    notice: `?thread=${named.slice(0, 40)} is not a thread id — ${fellBackTo}`,
  }
}

/** The same URL with `thread` set to `threadId` — every other parameter kept, in its order. */
export function urlForThread(search: string, threadId: string): string {
  const parameters = new URLSearchParams(search)
  parameters.set(THREAD_QUERY_PARAMETER, threadId)
  return `?${parameters.toString()}`
}

/**
 * The panes beside the thread (#938): `?panes=<id>,<id>,<id>`, left to right, beside `?thread=`,
 * which stays the focused pane's — so a link from before panes opens its one thread, and a reload
 * keeps the panes and the focus. Written only while there are two or more.
 */
const PANES_QUERY_PARAMETER = 'panes'

/**
 * The panes a URL names around its thread, `focusedId` (#938): the listed ids that can be threads,
 * each once, at most three — or the thread alone, when the list does not hold it or there is none.
 *
 * @invariant resume/url-names-panes The URL names the open panes and the focused one, and reading
 * it back gives that layout again: what a reload and back/forward restore from.
 *
 * Which entry a change writes is the page's (`show` in `chat-screen.tsx`), not pinned here: opening
 * or closing a pane pushes (`urlOpeningPanes`); moving the focus, or a delete putting another
 * thread in a pane, rewrites the entry it is on (`urlForPanes`).
 */
export function readPaneLayout(search: string, focusedId: string): PaneLayout {
  const listed = new URLSearchParams(search).get(PANES_QUERY_PARAMETER)?.split(',') ?? []
  const threadIds = listed.filter((named) => {
    // Checked as `unknown`, as `readThreadUrl` checks it: the guard narrows `string` to `never`.
    const candidate: unknown = named
    return isEnsoThreadId(candidate)
  })
  return paneLayoutOf(threadIds, focusedId)
}

/** The same URL showing `layout`: its focused thread, and its panes while there are several — every other parameter kept. */
export function urlForPanes(search: string, layout: PaneLayout): string {
  const parameters = new URLSearchParams(search)
  const focused = layout.threadIds[layout.focused]
  if (focused !== undefined) parameters.set(THREAD_QUERY_PARAMETER, focused)
  if (layout.threadIds.length > 1) parameters.set(PANES_QUERY_PARAMETER, layout.threadIds.join(','))
  else parameters.delete(PANES_QUERY_PARAMETER)
  return `?${parameters.toString()}`
}

/**
 * The pages beside the threads (#869): `?page=<name>`, with the page's own parameters, set beside
 * `?thread=` and never in place of it. The thread stays named while a page is open, so a reload
 * comes back to the page with the thread behind it, and leaving the page shows that thread again.
 * The query, as the thread's id is, never the hash (#868's URL decision).
 */
const PAGE_QUERY_PARAMETER = 'page'
const SECTION_QUERY_PARAMETER = 'section'
const PROJECT_QUERY_PARAMETER = 'project'
const TAB_QUERY_PARAMETER = 'tab'
/** Every parameter a page writes: opening a thread takes them all away, so back returns to the page. */
const PAGE_PARAMETERS = [
  PAGE_QUERY_PARAMETER,
  SECTION_QUERY_PARAMETER,
  PROJECT_QUERY_PARAMETER,
  TAB_QUERY_PARAMETER,
] as const

/** Settings' sections, in the order its navigation lists them; the first is where Settings opens. */
export const SETTINGS_SECTIONS = [
  'appearance',
  'providers',
  'roles',
  'permissions',
  'security',
  'projects',
  'storage',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const isSettingsSection = (value: string): value is SettingsSection =>
  (SETTINGS_SECTIONS as readonly string[]).includes(value)

/** A project page's tabs (#871), in the order the page lists them; the first is where it opens. */
export const PROJECT_TABS = ['threads', 'worktrees', 'storage'] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]

const isProjectTab = (value: string): value is ProjectTab => (PROJECT_TABS as readonly string[]).includes(value)

/** A page the URL can name and the page can open: a Settings section, the Projects page (#870), one project's (#871), or Add project (#872). */
export type PageRoute =
  | { readonly kind: 'settings'; readonly section: SettingsSection }
  | { readonly kind: 'projects' }
  | { readonly kind: 'project'; readonly projectId: string; readonly tab: ProjectTab }
  | { readonly kind: 'add-project' }

/** Settings as its link opens it: the first section. */
export const SETTINGS_ROUTE: PageRoute = { kind: 'settings', section: SETTINGS_SECTIONS[0] }

/** The Projects page (#870): every project as a card. It has no sections. */
export const PROJECTS_ROUTE: PageRoute = { kind: 'projects' }

/** The Add project page (#872): choose a folder, then confirm what pi can reach there. It has no sections. */
export const ADD_PROJECT_ROUTE: PageRoute = { kind: 'add-project' }

/** One project's page at `tab` (#871): its threads unless another tab is named. */
export function projectRoute(projectId: string, tab: ProjectTab = PROJECT_TABS[0]): PageRoute {
  return { kind: 'project', projectId, tab }
}

/**
 * What a URL's `page` names: a page, or something Enso has no page for — said as such, never a
 * blank page. `asked` is what the URL named (cut to 40 characters, as a thread's notice is);
 * `within`, the page it is a section of, when the page itself exists.
 */
export type PageUrl =
  | PageRoute
  | { readonly kind: 'not-found'; readonly asked: string; readonly within?: PageRoute['kind'] }

/** Settings by its `section`: none is the first section; one Settings doesn't have is not found. */
function readSettingsUrl(parameters: URLSearchParams): PageUrl {
  const section = parameters.get(SECTION_QUERY_PARAMETER)
  if (section === null || section === '') return SETTINGS_ROUTE
  if (isSettingsSection(section)) return { kind: 'settings', section }
  return { kind: 'not-found', asked: section.slice(0, 40), within: 'settings' }
}

/** A page with no sections (Projects, Add project): one named is not found — never a section guessed at. */
function sectionlessReader(route: PageRoute): (parameters: URLSearchParams) => PageUrl {
  return (parameters) => {
    const section = parameters.get(SECTION_QUERY_PARAMETER)
    if (section === null || section === '') return route
    return { kind: 'not-found', asked: section.slice(0, 40), within: route.kind }
  }
}

/**
 * A project's page by its `project` id and `tab`: none is the first tab; one the page doesn't have is
 * not found. The id is not judged here — whether a project has it is the server's listing's to say,
 * and the page says "no such project" when it hasn't (`project-page.tsx`).
 */
function readProjectUrl(parameters: URLSearchParams): PageUrl {
  const projectId = (parameters.get(PROJECT_QUERY_PARAMETER) ?? '').slice(0, 40)
  const tab = parameters.get(TAB_QUERY_PARAMETER)
  if (tab === null || tab === '') return projectRoute(projectId)
  if (isProjectTab(tab)) return projectRoute(projectId, tab)
  return { kind: 'not-found', asked: tab.slice(0, 40), within: 'project' }
}

/** The route table: a page's name in the URL → how its own parameters read. */
const PAGE_READERS: Readonly<Record<string, (parameters: URLSearchParams) => PageUrl>> = {
  settings: readSettingsUrl,
  projects: sectionlessReader(PROJECTS_ROUTE),
  project: readProjectUrl,
  'add-project': sectionlessReader(ADD_PROJECT_ROUTE),
}

/**
 * The page a URL names beside its thread, or undefined for none: the thread is what is shown.
 *
 * @invariant resume/url-names-page The URL names the page beside the thread; reload and back/forward
 * show it. `?page=` with its own parameters sits beside `?thread=`, which stays: opening a page
 * pushes the same thread with the page added (`urlForPage`), opening a thread from a page pushes it
 * without the page (`urlOpeningPanes`), so back returns to the page; a page's own rewrite of the
 * thread (a delete, a failed resume) keeps the page. A page or section Enso doesn't have is
 * not-found, never a blank page and never a guess at a page it might have meant.
 */
export function readPageUrl(search: string): PageUrl | undefined {
  const parameters = new URLSearchParams(search)
  const page = parameters.get(PAGE_QUERY_PARAMETER)
  if (page === null || page === '') return undefined
  // Own keys only: `?page=constructor` names no page, not `Object`'s.
  const read = Object.hasOwn(PAGE_READERS, page) ? PAGE_READERS[page] : undefined
  return read?.(parameters) ?? { kind: 'not-found', asked: page.slice(0, 40) }
}

/** The URL without any page parameter: the thread, and every parameter that is no page's, in order. */
function withoutPage(search: string): URLSearchParams {
  const parameters = new URLSearchParams(search)
  for (const pageParameter of PAGE_PARAMETERS) parameters.delete(pageParameter)
  return parameters
}

/** The same URL showing `route`: the page before it replaced, the thread and every other parameter kept. */
export function urlForPage(search: string, route: PageRoute): string {
  const parameters = withoutPage(search)
  parameters.set(PAGE_QUERY_PARAMETER, route.kind)
  if (route.kind === 'settings') parameters.set(SECTION_QUERY_PARAMETER, route.section)
  if (route.kind === 'project') {
    parameters.set(PROJECT_QUERY_PARAMETER, route.projectId)
    parameters.set(TAB_QUERY_PARAMETER, route.tab)
  }
  return `?${parameters.toString()}`
}

/** Whether `search` already shows `route`: the same page, at the same section, project and tab. */
export function showsPage(search: string, route: PageRoute): boolean {
  const shown = readPageUrl(search)
  if (shown?.kind === 'settings' && route.kind === 'settings') return shown.section === route.section
  if (shown?.kind === 'project' && route.kind === 'project')
    return shown.projectId === route.projectId && shown.tab === route.tab
  return shown?.kind === route.kind && (route.kind === 'projects' || route.kind === 'add-project')
}

/** The URL showing `layout` and no page — a thread opened from a page leaves it; every other parameter kept. */
export function urlOpeningPanes(search: string, layout: PaneLayout): string {
  return urlForPanes(`?${withoutPage(search).toString()}`, layout)
}
