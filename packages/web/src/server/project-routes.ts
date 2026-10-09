import type { IncomingMessage, ServerResponse } from 'node:http'
import { ensoLogger, EnsoProjectRegistration, EnsoProjectSettingsUpdate } from '@enso/core'
import type { ProjectThreadSettingsSource } from '../host/tree-setup.ts'
import { createProjectSettingsRoute, type ProjectSettingsAnswer } from './project-settings-route.ts'
import type { ProjectRegistry } from './projects.ts'
import { answerJson, answerOrFail, MAX_DIALOG_BODY_BYTES, readClosedJsonBody, refuseWith } from './request-plumbing.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * The project routes (#395, #810): the projects listed, registered, browsed and removed, and a
 * project's settings (#754). ⚠ `scripts/docs/routes.ts` reads the literal routes off the
 * `request.method === … && url …` conditions below (#174): keep that spelling.
 */

const log = ensoLogger('server', 'http')

/** `DELETE /api/projects/<projectId>` (#395) — the id is sixteen hex digits, so it needs no decoding. */
const PROJECT_ROUTE = /^\/api\/projects\/([0-9a-f]{16})$/
/**
 * `/api/projects/<projectId>/settings` (#754): the project page's Worktrees section. One constant
 * per method, as the routes reference reads them: `GET` reads the settings, `PUT` writes a tier.
 */
const PROJECT_SETTINGS_READ_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/settings$/
const PROJECT_SETTINGS_WRITE_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/settings$/

/** What the project routes read from the server (#810): the registries, and where project settings come from. */
export interface ProjectRoutesState {
  readonly projects: ProjectRegistry
  readonly threads: ThreadRegistry
  /** Each project's thread settings by tier (#754); absent, the settings routes refuse. */
  readonly threadSettings: ProjectThreadSettingsSource | undefined
  readonly agentDir: string
}

/** The project routes' one dispatcher (#810). */
export interface ProjectRoutes {
  /** True when the request was a project route. */
  readonly dispatchProjectRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

export function createProjectRoutes(state: ProjectRoutesState): ProjectRoutes {
  const { projects, threads, threadSettings, agentDir } = state
  const projectSettings = createProjectSettingsRoute({
    projects,
    source: threadSettings,
    agentDir,
  })

  // ── Projects (#395): the directories threads run in — listed, registered under a declared
  // root, forgotten. Registration is the one request that carries a path; `projects.ts` decides it.
  function respondWithProjects(response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(projects.list()))
  }

  async function respondToProjectRegistration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const registration = await readClosedJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a project registration is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      schema: EnsoProjectRegistration,
      name: 'project',
      requirement: 'a project registration takes an absolute `path` and an optional `title`',
    })
    if (registration === undefined) return
    const outcome = projects.register(registration)
    if (outcome.kind === 'refused') {
      log.warn('project registration refused: {reason}', { path: registration.path, reason: outcome.reason })
      refuseWith(response, { status: 422, reason: outcome.reason })
      return
    }
    response.writeHead(outcome.kind === 'registered' ? 201 : 200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.project))
  }

  /**
   * Forget a registration. Its sessions stay on disk. Refused while one of its threads is RUNNING
   * here — a run would go on in a directory the rail no longer shows, with nothing to stop it from.
   * Its live threads that are NOT running are retired with it: a live thread is
   * taken again without a build, so a page still showing one could otherwise go on prompting it in
   * the removed directory for as long as it kept it from idling out.
   */
  function respondToProjectRemoval(projectId: string, response: ServerResponse): void {
    // The launch project first: it is never removable, running or not, so it is not told to wait.
    if (projects.get(projectId)?.launch === true) {
      refuseWith(response, { status: 409, reason: 'the launch directory is always a project' })
      return
    }
    // `inspect()` decodes a branch (#285); removal is a rare, explicit act, and live threads are few.
    const live = threads
      .list()
      .filter((thread) => projects.byDirectory(thread.hosted.inspect().cwd)?.projectId === projectId)
    if (live.some((thread) => thread.busy)) {
      refuseWith(response, { status: 409, reason: 'a thread in this project is running; remove it when that settles' })
      return
    }
    const outcome = projects.remove(projectId)
    if (outcome === 'launch') {
      refuseWith(response, { status: 409, reason: 'the launch directory is always a project' })
      return
    }
    if (outcome === 'unknown') {
      refuseWith(response, { status: 404, reason: `no registered project has the id ${projectId}` })
      return
    }
    for (const thread of live) threads.retire(thread.threadId, 'its project was removed')
    response.writeHead(204)
    response.end()
  }

  /**
   * What a page may browse while adding a project: the declared roots, or `?path=` inside them. Read
   * only; the rules are the registration's (`projects.ts#browse`), so nothing listed is refused later.
   * It reads the disk under a root, so it answers through `answerOrFail`: whatever the
   * disk throws that `browse` did not foresee is a 500, never a throw with nothing above it.
   */
  async function respondWithBrowse(url: string, response: ServerResponse): Promise<void> {
    const path = new URL(url, 'http://loopback').searchParams.get('path') ?? undefined
    const outcome = projects.browse(path)
    if (outcome.kind === 'refused') {
      refuseWith(response, { status: 422, reason: outcome.reason })
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.listing))
  }

  /** True when the request was a project route. */
  function dispatchProjectRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/projects') {
      respondWithProjects(response)
      return true
    }
    if (request.method === 'POST' && url === '/api/projects') {
      answerOrFail(respondToProjectRegistration(request, response), response)
      return true
    }
    if (request.method === 'GET' && url.startsWith('/api/projects/browse')) {
      answerOrFail(respondWithBrowse(url, response), response)
      return true
    }
    if (dispatchProjectSettingsRoute(request, response, url)) return true
    const projectId = PROJECT_ROUTE.exec(url)?.[1]
    if (projectId === undefined || request.method !== 'DELETE') return false
    respondToProjectRemoval(projectId, response)
    return true
  }

  /** True when the request was a project settings route (#754): GET reads them, PUT writes a tier. */
  function dispatchProjectSettingsRoute(request: IncomingMessage, response: ServerResponse, url: string): boolean {
    if (request.method === 'GET') {
      const projectId = PROJECT_SETTINGS_READ_ROUTE.exec(url)?.[1]
      if (projectId === undefined) return false
      answerOrFail(respondWithProjectSettings(projectId, response), response)
      return true
    }
    const projectId = request.method === 'PUT' ? PROJECT_SETTINGS_WRITE_ROUTE.exec(url)?.[1] : undefined
    if (projectId === undefined) return false
    answerOrFail(respondToProjectSettingsWrite(projectId, request, response), response)
    return true
  }

  /** `GET /api/projects/<projectId>/settings` (#754): resolved now, as the next tree would be. */
  async function respondWithProjectSettings(projectId: string, response: ServerResponse): Promise<void> {
    answerProjectSettings(response, projectSettings.read(projectId))
  }

  /**
   * `PUT /api/projects/<projectId>/settings` (#754): `threads` keys set or removed in the project's
   * shared or local file, answered with the settings as they now resolve. A body that is not exactly
   * an `EnsoProjectSettingsUpdate` is a 400; a write that cannot be made, a 422 with its reason.
   */
  async function respondToProjectSettingsWrite(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const update = await readClosedJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a project settings update is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      schema: EnsoProjectSettingsUpdate,
      name: 'project settings',
      requirement:
        'a project settings update takes a `tier` ("shared" or "local") and `threads` with any of `tree`, `setup`, `copy` — `null` removes one',
    })
    if (update === undefined) return
    const answer = projectSettings.write(projectId, update)
    if (answer.kind === 'settings') {
      log.info('project {projectId}: its {tier} settings were written: {keys}', {
        projectId,
        tier: update.tier,
        keys: Object.keys(update.threads),
      })
    } else log.warn('project {projectId}: settings not written: {reason}', { projectId, reason: answer.reason })
    answerProjectSettings(response, answer)
  }

  function answerProjectSettings(response: ServerResponse, answer: ProjectSettingsAnswer): void {
    if (answer.kind === 'settings') answerJson(response, answer.settings)
    else refuseWith(response, answer)
  }

  return { dispatchProjectRoute }
}
