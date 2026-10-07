import { EnsoDirectoryListing, EnsoProject, type EnsoStoredThread } from '@enso/core'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { createListingStore, type ListingStore } from './listing-store.ts'
import { describeFailedResponse } from './stored-threads.ts'
import type { ThreadSummary } from './thread-stores.ts'

/**
 * The projects the rail groups threads under (#395): the launch directory first, then the ones
 * registered under the install's roots, as `GET /api/projects` lists them. Refreshed on load
 * (`listing-store.ts` has the rules). A page names a project by its id, never by its path.
 */
export type ProjectsStore = ListingStore<EnsoProject>

export function createProjectsStore(fetchProjects: () => Promise<unknown> = fetchProjectList): ProjectsStore {
  return createListingStore(EnsoProject, 'project listing', fetchProjects)
}

async function fetchProjectList(): Promise<unknown> {
  const response = await fetch('/api/projects')
  if (!response.ok) throw new Error(await describeFailedResponse(response))
  return response.json()
}

/**
 * The project a thread is in, as the page lists them — ONE rule for the rail's sections and the
 * Start dialog's label (PR #400 review). A thread that named no project was built in the launch
 * directory, so it is the launch project's; an id no longer listed is no project the page shows.
 */
export function projectOf(projects: readonly EnsoProject[], projectId: string | undefined): EnsoProject | undefined {
  return projects.find((project) => (projectId === undefined ? project.launch : project.projectId === projectId))
}

/** Where the page goes when the thread on screen is deleted: a thread to show, on this page or stored. */
export interface ThreadAfterDelete {
  readonly threadId: string
  /** Already a pane on this page (shown at once); otherwise a stored thread, resumed. */
  readonly onPage: boolean
}

/**
 * The thread to show when the one on screen is deleted (#663): its project's most recently active
 * OTHER thread that holds something — one on this page with a first prompt, or a stored one with
 * messages — or undefined when there is none, and the page starts a fresh one. Measured in the arena:
 * a delete of one of two approaches opened a new empty thread and its Start dialog, though the other
 * was right there in the rail. A page thread's project is the rail's (`projectOf`: none is the
 * launch project's), so the two lists are compared by the same project id.
 */
export function threadAfterDelete(
  deleted: string,
  deletedProjectId: string | undefined,
  context: {
    readonly projects: readonly EnsoProject[]
    readonly pageThreads: readonly ThreadSummary[]
    readonly stored: readonly EnsoStoredThread[]
  },
): ThreadAfterDelete | undefined {
  const project = projectOf(context.projects, deletedProjectId)?.projectId
  if (project === undefined) return undefined
  const onPage = context.pageThreads
    .filter((thread) => thread.threadId !== deleted && thread.title !== undefined)
    .filter((thread) => projectOf(context.projects, thread.projectId)?.projectId === project)
    .map((thread) => ({ threadId: thread.threadId, onPage: true, at: thread.lastActivityAt.getTime() }))
  const pageIds = new Set(context.pageThreads.map((thread) => thread.threadId))
  const storedOnly = context.stored
    .filter((thread) => thread.threadId !== deleted && !pageIds.has(thread.threadId))
    .filter((thread) => thread.projectId === project && thread.messageCount > 0)
    .map((thread) => ({ threadId: thread.threadId, onPage: false, at: Date.parse(thread.lastActivityAt) }))
  const latest = [...onPage, ...storedOnly].toSorted((left, right) => right.at - left.at)[0]
  return latest === undefined ? undefined : { threadId: latest.threadId, onPage: latest.onPage }
}

/** What a project request answered: the value, or the server's reason in one line. */
export type ProjectRequestOutcome<Value> =
  | { readonly kind: 'ok'; readonly value: Value }
  | { readonly kind: 'refused'; readonly reason: string }

async function refusedBy(response: Response): Promise<{ readonly kind: 'refused'; readonly reason: string }> {
  return { kind: 'refused', reason: await describeFailedResponse(response) }
}

/** `GET /api/projects/browse`: the declared roots, or the directories under `path` a project may be. */
export async function browseDirectories(
  path: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoDirectoryListing>> {
  const query = path === null ? '' : `?path=${encodeURIComponent(path)}`
  const response = await fetchImpl(`/api/projects/browse${query}`)
  if (!response.ok) return refusedBy(response)
  const listing: unknown = await response.json()
  if (!Check(EnsoDirectoryListing, listing))
    return { kind: 'refused', reason: "the server's listing did not match its schema" }
  return { kind: 'ok', value: listing }
}

/** `POST /api/projects`: register a directory; the project, new or already registered. */
export async function registerProject(
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProject>> {
  const response = await fetchImpl('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!response.ok) return refusedBy(response)
  const project: unknown = await response.json()
  if (!Check(EnsoProject, project)) return { kind: 'refused', reason: "the server's project did not match its schema" }
  return { kind: 'ok', value: project }
}

/** `DELETE /api/projects/:id`: forget the registration — its sessions stay on disk. */
export async function removeProject(
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<null>> {
  const response = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  return response.ok ? { kind: 'ok', value: null } : refusedBy(response)
}
