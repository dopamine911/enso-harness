import {
  EnsoDirectoryListing,
  EnsoProject,
  EnsoProjectSettings,
  type EnsoProjectSettingsUpdate,
  EnsoProjectTrust,
  type EnsoProjectTrustUpdate,
  type EnsoStoredThread,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { createListingStore, type ListingStore } from './listing-store.ts'
import { boundedFailureDetail, describeFailedResponse } from './stored-threads.ts'
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
 * The threads that hold something — one on this page with a first prompt, or a stored one with
 * messages — in the section `inSection` says, by the listed project each is in (`projectOf`: a page
 * thread with none is the launch project's; one not listed is in none), most recently active
 * first. One on this page is counted once, as the page thread.
 */
function heldThreads(
  context: ProjectThreadsContext,
  inSection: (listedProjectId: string | undefined) => boolean,
): ProjectThread[] {
  const listedOf = (projectId: string | undefined): string | undefined =>
    projectOf(context.projects, projectId)?.projectId
  const onPage = context.pageThreads
    .filter((thread) => thread.title !== undefined && inSection(listedOf(thread.projectId)))
    .map((thread) => ({ threadId: thread.threadId, onPage: true, at: thread.lastActivityAt.getTime() }))
  const pageIds = new Set(context.pageThreads.map((thread) => thread.threadId))
  const storedOnly = context.stored
    .filter((thread) => !pageIds.has(thread.threadId))
    .filter((thread) => thread.messageCount > 0 && inSection(listedOf(thread.projectId)))
    .map((thread) => ({ threadId: thread.threadId, onPage: false, at: Date.parse(thread.lastActivityAt) }))
  return [...onPage, ...storedOnly].toSorted((left, right) => right.at - left.at)
}

/**
 * A project's threads that hold something (`heldThreads`): what the Projects page counts and opens
 * (#870), what the rail's switcher opens (#876), and where a delete goes next.
 */
export function threadsOfProject(projectId: string, context: ProjectThreadsContext): ProjectThread[] {
  return heldThreads(context, (listedProjectId) => listedProjectId === projectId)
}

/** The threads that hold something in no listed project (`heldThreads`): what the switcher's **Not in a project** opens (#876). */
export function threadsInNoProject(context: ProjectThreadsContext): ProjectThread[] {
  return heldThreads(context, (listedProjectId) => listedProjectId === undefined)
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
 * A browse's or a registration's answer: a 422 is the rule refusing the folder, in words written for
 * the person choosing it (#872), shown as they are; any other failure keeps its status.
 */
async function folderAnswer<Schema extends TSchema>(
  response: Response,
  schema: Schema,
  what: string,
): Promise<ProjectRequestOutcome<Static<Schema>>> {
  if (response.status !== 422) return checkedAnswer(response, schema, what)
  return { kind: 'refused', reason: boundedFailureDetail(await response.text()) }
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
  return folderAnswer(await fetchImpl(`/api/projects/browse${search}`), EnsoDirectoryListing, 'listing')
}

/** A registration's answer: the project, and whether this request added it (201) or it already was one (200). */
export interface ProjectRegistered {
  readonly project: EnsoProject
  readonly added: boolean
}

/**
 * `POST /api/projects`: register a directory under `title`, the name the page shows it by (#872).
 * `hidden`: one inside a hidden folder may be (#866).
 */
export async function registerProject(
  request: { readonly path: string; readonly title: string; readonly hidden: boolean },
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<ProjectRegistered>> {
  const { path, title, hidden } = request
  const response = await fetchImpl('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hidden ? { path, title, hidden } : { path, title }),
  })
  const outcome = await folderAnswer(response, EnsoProject, 'project')
  return outcome.kind === 'ok'
    ? { kind: 'ok', value: { project: outcome.value, added: response.status === 201 } }
    : outcome
}

/** `DELETE /api/projects/:id`: forget the registration — its sessions stay on disk. */
export async function removeProject(
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<null>> {
  const response = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  return response.ok ? { kind: 'ok', value: null } : refusedBy(response)
}

/**
 * One of a project's own resources — its `settings` (#754) or its `trust` (#873) — read, or with
 * `update` written by a PUT, and the answer checked against `schema`.
 */
async function projectResource<Schema extends TSchema>(
  request: { readonly projectId: string; readonly resource: 'settings' | 'trust'; readonly update?: unknown },
  schema: Schema,
  fetchImpl: FetchLike,
): Promise<ProjectRequestOutcome<Static<Schema>>> {
  const url = `/api/projects/${encodeURIComponent(request.projectId)}/${request.resource}`
  const response =
    request.update === undefined
      ? await fetchImpl(url)
      : await fetchImpl(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.update),
        })
  return checkedAnswer(response, schema, `project ${request.resource}`)
}

/** `GET /api/projects/:id/settings` (#754): the project's tiered settings, each value with the tier it came from. */
export function readProjectSettings(
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProjectSettings>> {
  return projectResource({ projectId, resource: 'settings' }, EnsoProjectSettings, fetchImpl)
}

/** `PUT /api/projects/:id/settings` (#754): set or clear keys in one of the project's own tiers; the settings as they now resolve. */
export function saveProjectSettings(
  projectId: string,
  update: EnsoProjectSettingsUpdate,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProjectSettings>> {
  return projectResource({ projectId, resource: 'settings', update }, EnsoProjectSettings, fetchImpl)
}

/**
 * `GET /api/projects/:id/trust` (#873) with no `change`: whether the project is trusted, and the
 * files and setup commands trust turns on. With one, `PUT`: trust it (`true`) or revoke it
 * (`false`). Either way the trust as it now stands; a request that never reached the server is a
 * refusal with its reason, never a rejection.
 */
export function requestProjectTrust(
  projectId: string,
  change: boolean | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<ProjectRequestOutcome<EnsoProjectTrust>> {
  const update: EnsoProjectTrustUpdate | undefined = change === undefined ? undefined : { trusted: change }
  return projectResource({ projectId, resource: 'trust', update }, EnsoProjectTrust, fetchImpl).catch(
    (error: unknown) => ({ kind: 'refused', reason: `the trust request did not reach the server: ${String(error)}` }),
  )
}
