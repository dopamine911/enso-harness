import {
  EnsoDirectoryListing,
  EnsoProject,
  EnsoProjectSettings,
  type EnsoProjectSettingsUpdate,
  type EnsoStoredThread,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
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
 * Start dialog's label. A thread that named no project was built in the launch
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

/** What a page knows of a project's threads: its own threads, the server's stored ones, and the projects that place them. */
export interface ProjectThreadsContext {
  readonly projects: readonly EnsoProject[]
  readonly pageThreads: readonly ThreadSummary[]
  readonly stored: readonly EnsoStoredThread[]
}

/** One of a project's threads: on this page (a pane, shown at once) or stored only (resumed), and when it was last active. */
export interface ProjectThread extends ThreadAfterDelete {
  /** Its last activity, in epoch milliseconds. */
  readonly at: number
}

/**
 * A project's threads that hold something — one on this page with a first prompt, or a stored one
 * with messages — most recently active first: what the Projects page counts and opens (#870), and
 * where a delete goes next. A page thread's project is the rail's (`projectOf`: none is the launch
 * project's), so the two lists are compared by the same project id; one on this page is counted
 * once, as the page thread.
 */
export function threadsOfProject(projectId: string, context: ProjectThreadsContext): ProjectThread[] {
  const onPage = context.pageThreads
    .filter((thread) => thread.title !== undefined)
    .filter((thread) => projectOf(context.projects, thread.projectId)?.projectId === projectId)
    .map((thread) => ({ threadId: thread.threadId, onPage: true, at: thread.lastActivityAt.getTime() }))
  const pageIds = new Set(context.pageThreads.map((thread) => thread.threadId))
  const storedOnly = context.stored
    .filter((thread) => !pageIds.has(thread.threadId))
    .filter((thread) => thread.projectId === projectId && thread.messageCount > 0)
    .map((thread) => ({ threadId: thread.threadId, onPage: false, at: Date.parse(thread.lastActivityAt) }))
  return [...onPage, ...storedOnly].toSorted((left, right) => right.at - left.at)
}

/**
 * The thread to show when the one on screen is deleted (#663): its project's most recently active
 * OTHER thread that holds something (`threadsOfProject`), or undefined when there is none, and the
 * page starts a fresh one. Measured in the arena: a delete of one of two approaches opened a new
 * empty thread and its Start dialog, though the other was right there in the rail.
 */
export function threadAfterDelete(
  deleted: string,
  deletedProjectId: string | undefined,
  context: ProjectThreadsContext,
): ThreadAfterDelete | undefined {
  const project = projectOf(context.projects, deletedProjectId)?.projectId
  if (project === undefined) return undefined
  const latest = threadsOfProject(project, context).find((thread) => thread.threadId !== deleted)
  return latest === undefined ? undefined : { threadId: latest.threadId, onPage: latest.onPage }
}

/** What a project request answered: the value, or the server's reason in one line. */
export type ProjectRequestOutcome<Value> =
  | { readonly kind: 'ok'; readonly value: Value }
  | { readonly kind: 'refused'; readonly reason: string }

async function refusedBy(response: Response): Promise<{ readonly kind: 'refused'; readonly reason: string }> {
  return { kind: 'refused', reason: await describeFailedResponse(response) }
}

/** A project request's answer: the server's refusal, or its JSON checked against `schema` — `what` names it when it does not match. */
async function checkedAnswer<Schema extends TSchema>(
  response: Response,
  schema: Schema,
  what: string,
): Promise<ProjectRequestOutcome<Static<Schema>>> {
  if (!response.ok) return refusedBy(response)
  const value: unknown = await response.json()
  return Check(schema, value)
    ? { kind: 'ok', value }
    : { kind: 'refused', reason: `the server's ${what} did not match its schema` }
}

/**
 * `GET /api/projects/browse`: where browsing starts, or the directories under `path` a project may be;
 * hidden ones too when the person asked to see them (#866).
 */
export async function browseDirectories(
  path: string | null,
  hidden: boolean,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoDirectoryListing>> {
  const query = new URLSearchParams()
  if (path !== null) query.set('path', path)
  if (hidden) query.set('hidden', '1')
  const search = query.size === 0 ? '' : `?${query.toString()}`
  return checkedAnswer(await fetchImpl(`/api/projects/browse${search}`), EnsoDirectoryListing, 'listing')
}

/** `POST /api/projects`: register a directory; the project, new or already registered. `hidden`: one inside a hidden folder may be (#866). */
export async function registerProject(
  path: string,
  hidden: boolean,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProject>> {
  const response = await fetchImpl('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hidden ? { path, hidden } : { path }),
  })
  return checkedAnswer(response, EnsoProject, 'project')
}

/** `DELETE /api/projects/:id`: forget the registration — its sessions stay on disk. */
export async function removeProject(
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<null>> {
  const response = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  return response.ok ? { kind: 'ok', value: null } : refusedBy(response)
}

/** `GET /api/projects/:id/settings` (#754): the project's tiered settings, each value with the tier it came from. */
export async function readProjectSettings(
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProjectSettings>> {
  return checkedAnswer(
    await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/settings`),
    EnsoProjectSettings,
    'project settings',
  )
}

/** `PUT /api/projects/:id/settings` (#754): set or clear keys in one of the project's own tiers; the settings as they now resolve. */
export async function saveProjectSettings(
  projectId: string,
  update: EnsoProjectSettingsUpdate,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProjectSettings>> {
  return checkedAnswer(
    await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    }),
    EnsoProjectSettings,
    'project settings',
  )
}
