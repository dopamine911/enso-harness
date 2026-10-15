import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ensoLogger,
  EnsoProjectConfigApproval,
  EnsoProjectRegistration,
  EnsoProjectSettingsUpdate,
  EnsoProjectTitleUpdate,
  EnsoProjectTrustUpdate,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import type { ProjectThreadSettingsSource } from '../host/tree-setup.ts'
import {
  createProjectSettingsRoute,
  type ProjectConfigReviewAnswer,
  type ProjectSettingsAnswer,
} from './project-settings-route.ts'
import { createProjectTrustRoute, type ProjectTrustRouteAnswer } from './project-trust-route.ts'
import type { ProjectRegistry } from './projects.ts'
import { answerJson, answerOrFail, MAX_DIALOG_BODY_BYTES, readClosedJsonBody, refuseWith } from './request-plumbing.ts'
import type { ThreadRegistry, ThreadView } from './thread-registry.ts'

/**
 * The project routes (#395, #810): the projects listed, registered, browsed, renamed (#939) and
 * removed, a project's settings (#754), its trust (#873) and its config approval (#753). ⚠ `scripts/docs/routes.ts` reads the literal routes off the
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
/**
 * `/api/projects/<projectId>/trust` (#873): the project page's Trust and Revoke. `GET` reads the
 * trust and the files it turns on, `PUT` sets it. By id only: no path is ever taken here.
 */
const PROJECT_TRUST_READ_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/trust$/
const PROJECT_TRUST_WRITE_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/trust$/
/** `PUT /api/projects/<projectId>/title` (#939): the name the project is shown by; the folder keeps its own. */
const PROJECT_TITLE_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/title$/
/** What `PUT …/title` takes (#939), and how its 400 and 413 say so. */
const PROJECT_TITLE_BODY = {
  what: 'project title update',
  schema: EnsoProjectTitleUpdate,
  name: 'project title',
  requirement: 'a project title update takes exactly `title`, a name that is not blank',
}
/**
 * `/api/projects/<projectId>/config-approval` (#753): the project page's review of its own config
 * files against the versions approved. `GET` reads each file's state and diff, `PUT` approves one.
 */
const PROJECT_CONFIG_APPROVAL_READ_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/config-approval$/
const PROJECT_CONFIG_APPROVAL_WRITE_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/config-approval$/
/** An approval's body (#753), as its 413 and 400 name it. */
const APPROVAL_BODY = {
  what: 'project config approval',
  schema: EnsoProjectConfigApproval,
  name: 'project config approval',
  requirement:
    'a project config approval takes a `tier` ("shared" or "local") and `sha256`, the file\'s hash as reviewed, or null for its removal',
}

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

/**
 * A project request's body — a registration, a settings, trust or title update: at most
 * `MAX_DIALOG_BODY_BYTES` and exactly `schema`, else its 413 or 400 is answered and this is
 * undefined. `what` names it in the 413.
 */
function readProjectBody<Schema extends TSchema>(
  request: IncomingMessage,
  response: ServerResponse,
  body: { readonly what: string; readonly schema: Schema; readonly name: string; readonly requirement: string },
): Promise<Static<Schema> | undefined> {
  const { what, ...closed } = body
  return readClosedJsonBody(request, response, {
    maxBytes: MAX_DIALOG_BODY_BYTES,
    capText: `a ${what} is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
    ...closed,
  })
}

export function createProjectRoutes(state: ProjectRoutesState): ProjectRoutes {
  const { projects, threads, threadSettings, agentDir } = state
  const projectSettings = createProjectSettingsRoute({
    projects,
    source: threadSettings,
    agentDir,
  })
  const projectTrust = createProjectTrustRoute({ projects, agentDir })

  // ── Projects (#395, #866): the directories threads run in — listed, registered by path, forgotten.
  // Registration is the one request that carries a path; `projects.ts` decides it.
  function respondWithProjects(response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(projects.list()))
  }

  async function respondToProjectRegistration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const registration = await readProjectBody(request, response, {
      what: 'project registration',
      schema: EnsoProjectRegistration,
      name: 'project',
      requirement:
        'a project registration takes a `path` (absolute or `~/`), an optional `title` and an optional `hidden`',
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
    const live = idleThreadsOf(projectId, response, 'remove it')
    if (live === undefined) return
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
   * `PUT /api/projects/<projectId>/title` (#939): `{ title }`, not blank, trimmed and stored in
   * `projects.json`, answered with the project as it is now listed. Only the name changes: the
   * folder, its path and the id stay. An id no served project has is a 404.
   */
  async function respondToProjectRetitle(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const update = await readProjectBody(request, response, PROJECT_TITLE_BODY)
    const outcome = update === undefined ? undefined : projects.retitle(projectId, update.title.trim())
    if (outcome?.kind === 'retitled') answerJson(response, outcome.project)
    else if (outcome !== undefined)
      refuseWith(response, { status: 404, reason: `no registered project has the id ${projectId}` })
  }

  /**
   * The project's live threads here, none of them running — or, when one runs, undefined, its 409
   * answered (`act`: what waits for it to settle). Removal and revoke retire these. `inspect()`
   * decodes a branch (#285); both are rare, explicit acts, and live threads are few.
   */
  function idleThreadsOf(projectId: string, response: ServerResponse, act: string): ThreadView[] | undefined {
    const live = threads
      .list()
      .filter((thread) => projects.byDirectory(thread.hosted.inspect().cwd)?.projectId === projectId)
    if (!live.some((thread) => thread.busy)) return live
    refuseWith(response, { status: 409, reason: `a thread in this project is running; ${act} when that settles` })
    return undefined
  }

  /**
   * `PUT /api/projects/<projectId>/trust` (#873): `{ trusted }` into pi's `trust.json` — a revoke as
   * an explicit `false` — answered with the trust as it now stands (the change logs itself,
   * `project-trust-route.ts`). ⚠ A REVOKE FAILS CLOSED AT ONCE, as removal does: refused (409) while
   * one of the project's threads runs, and its live threads that are not running are retired, so
   * each is built again — under the revoke — at its next prompt. Check, write and retire run in one
   * turn, so no run starts between them. A grant retires nothing: an open thread picks it up when it
   * is next built.
   */
  async function respondToProjectTrustWrite(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const update = await readProjectBody(request, response, {
      what: 'project trust update',
      schema: EnsoProjectTrustUpdate,
      name: 'project trust',
      requirement: 'a project trust update takes exactly `trusted`, true or false',
    })
    const live = update?.trusted === false ? idleThreadsOf(projectId, response, 'revoke its trust') : []
    if (update === undefined || live === undefined) return
    const answer = projectTrust.write(projectId, update.trusted)
    if (answer.kind === 'trust')
      for (const thread of live) threads.retire(thread.threadId, 'its project’s trust was revoked')
    answerProjectTrust(response, answer)
  }

  /**
   * What a page may browse while adding a project: where browsing starts, or `?path=`; `&hidden=1`
   * lists hidden folders too (#866). Read only; the rules are the registration's
   * (`projects.ts#browse`), so nothing listed is refused later.
   * It reads the disk, so it answers through `answerOrFail`: whatever the
   * disk throws that `browse` did not foresee is a 500, never a throw with nothing above it.
   */
  async function respondWithBrowse(url: string, response: ServerResponse): Promise<void> {
    const query = new URL(url, 'http://loopback').searchParams
    const outcome = projects.browse(query.get('path') ?? undefined, query.get('hidden') === '1')
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
    if (dispatchProjectSubroute(request, response, url)) return true
    const retitled = request.method === 'PUT' ? PROJECT_TITLE_ROUTE.exec(url)?.[1] : undefined
    if (retitled !== undefined) {
      answerOrFail(respondToProjectRetitle(retitled, request, response), response)
      return true
    }
    const projectId = PROJECT_ROUTE.exec(url)?.[1]
    if (projectId === undefined || request.method !== 'DELETE') return false
    respondToProjectRemoval(projectId, response)
    return true
  }

  /** A project's own subroute: `GET` reads it, `PUT` writes it — settings (#754), trust (#873). */
  interface ProjectSubroute {
    readonly read: RegExp
    readonly write: RegExp
    readonly respondWithRead: (projectId: string, response: ServerResponse) => Promise<void>
    readonly respondToWrite: (projectId: string, request: IncomingMessage, response: ServerResponse) => Promise<void>
  }

  const projectSubroutes: readonly ProjectSubroute[] = [
    {
      read: PROJECT_SETTINGS_READ_ROUTE,
      write: PROJECT_SETTINGS_WRITE_ROUTE,
      respondWithRead: respondWithProjectSettings,
      respondToWrite: respondToProjectSettingsWrite,
    },
    // #873: `GET` the trust and the files and setup commands it turns on; `PUT` sets or revokes it.
    {
      read: PROJECT_TRUST_READ_ROUTE,
      write: PROJECT_TRUST_WRITE_ROUTE,
      respondWithRead: async (projectId, response) => answerProjectTrust(response, projectTrust.read(projectId)),
      respondToWrite: respondToProjectTrustWrite,
    },
    // #753: `GET` each own config file against the version approved; `PUT` approves one as it was shown.
    {
      read: PROJECT_CONFIG_APPROVAL_READ_ROUTE,
      write: PROJECT_CONFIG_APPROVAL_WRITE_ROUTE,
      respondWithRead: async (projectId, response) =>
        answerProjectConfigReview(response, projectSettings.review(projectId)),
      respondToWrite: respondToProjectConfigApproval,
    },
  ]

  /** True when the request was one of a project's own subroutes. */
  function dispatchProjectSubroute(request: IncomingMessage, response: ServerResponse, url: string): boolean {
    for (const subroute of projectSubroutes) {
      if (request.method === 'GET') {
        const projectId = subroute.read.exec(url)?.[1]
        if (projectId === undefined) continue
        answerOrFail(subroute.respondWithRead(projectId, response), response)
        return true
      }
      const projectId = request.method === 'PUT' ? subroute.write.exec(url)?.[1] : undefined
      if (projectId === undefined) continue
      answerOrFail(subroute.respondToWrite(projectId, request, response), response)
      return true
    }
    return false
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
    const update = await readProjectBody(request, response, {
      what: 'project settings update',
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

  /**
   * `PUT /api/projects/<projectId>/config-approval` (#753): `{ tier, sha256 }` — the file as the page
   * showed it, `null` for its removal — becomes the version that applies, answered with the review as
   * it now stands (the approval logs itself, `project-settings-route.ts`). A file that changed since
   * is a 409; one that cannot be approved as it is, a 422.
   */
  async function respondToProjectConfigApproval(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const approval = await readProjectBody(request, response, APPROVAL_BODY)
    if (approval !== undefined) answerProjectConfigReview(response, projectSettings.approve(projectId, approval))
  }

  function answerProjectConfigReview(response: ServerResponse, answer: ProjectConfigReviewAnswer): void {
    if ('kind' in answer) refuseWith(response, answer)
    else answerJson(response, answer)
  }

  function answerProjectSettings(response: ServerResponse, answer: ProjectSettingsAnswer): void {
    if (answer.kind === 'settings') answerJson(response, answer.settings)
    else refuseWith(response, answer)
  }

  function answerProjectTrust(response: ServerResponse, answer: ProjectTrustRouteAnswer): void {
    if (answer.kind === 'trust') answerJson(response, answer.trust)
    else refuseWith(response, answer)
  }

  return { dispatchProjectRoute }
}
