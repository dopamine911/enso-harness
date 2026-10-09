import type { IncomingMessage, ServerResponse } from 'node:http'
import { ensoLogger, type EnsoSystemPromptChoice, LIBRARY_PROMPT_ID_SOURCE } from '@enso/core'
import { type AgentHost, SessionDirectoryRefused } from '../host/agent-host.ts'
import type { ProjectRegistry } from './projects.ts'
import {
  draftChoice,
  type LibraryRead,
  NO_PROMPT_LIBRARY,
  pickLibrarySystemPrompt,
  type ProjectLibraryAccess,
  projectLibraryAccess,
  projectPromptListing,
  type PromptLibrary,
  readPromptWriteBody,
  readSystemPromptDraftBody,
  type SystemPromptPick,
  untrustedProjectReason,
} from './prompt-library.ts'
import {
  answerJson,
  answerOrFail,
  endAndClose,
  readPromptSizedBody,
  refuseWith,
  type ThreadResponder,
  type ThreadRouteHandler,
  writeConditionOf,
} from './request-plumbing.ts'
import type { ThreadRegistry, ThreadView } from './thread-registry.ts'

/**
 * The prompt routes (#443, #810): the library's own routes (`/api/prompts…`), and the thread routes
 * that read a library — the system-prompt preview and its draft, the project's prompts (#470). The
 * library's pick for a thread is here too: the configure route asks it.
 */

const log = ensoLogger('server', 'http')

/**
 * `/api/prompts/<id>` (#443): a library prompt. The id is its file name in the library's own shape
 * (`LIBRARY_PROMPT_ID_SOURCE`), so it needs no decoding and can never leave the directory.
 */
function promptRoute(): RegExp {
  return new RegExp(`^/api/prompts/(${LIBRARY_PROMPT_ID_SOURCE})$`)
}
/** One constant per method, as the routes reference reads them: `GET` reads it, `PUT` writes it whole, `DELETE` removes it. */
const PROMPT_READ_ROUTE = promptRoute()
const PROMPT_WRITE_ROUTE = promptRoute()
const PROMPT_DELETE_ROUTE = promptRoute()

/** What the prompt routes read from the server (#810): the user's library, the registries, the host's trust. */
export interface PromptRoutesState {
  /** The user's library; absent, the server has none and says so. */
  readonly prompts: PromptLibrary | undefined
  readonly threads: ThreadRegistry
  readonly host: AgentHost
  readonly projects: ProjectRegistry
}

/** The library's pick, the prompt-reading thread routes, and the library's dispatcher (#810). */
export interface PromptRoutes {
  readonly pickSystemPrompt: (threadId: string, ref: string) => SystemPromptPick
  readonly respondWithSystemPromptPreview: ThreadRouteHandler
  readonly respondWithDraftPreview: ThreadRouteHandler
  readonly respondWithProjectPrompts: ThreadResponder
  readonly respondWithProjectPrompt: ThreadRouteHandler
  /** True when the request was a prompt-library route (#443). */
  readonly dispatchPromptRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

export function createPromptRoutes(state: PromptRoutesState): PromptRoutes {
  const { prompts, threads, host, projects } = state

  /**
   * A prompt reference as `threadId`'s system prompt, or why not — the configure route's first step
   * (#443). A project reference (#470) is read through the LIVE thread, under its own trust: both
   * callers have built it by now (configure holds its lease, the preview ensures it first).
   */
  function pickSystemPrompt(threadId: string, ref: string): SystemPromptPick {
    return pickLibrarySystemPrompt(ref, prompts, () => {
      const live = threads.peek(threadId)
      if (live === undefined) throw new Error(`thread ${threadId}: a project prompt is picked only on a built thread`)
      return liveProjectLibrary(live)
    })
  }
  /** A built thread's project library: its own project (a tree's checkout, #551), its own trust (#470). */
  function liveProjectLibrary(thread: ThreadView): ProjectLibraryAccess {
    const { directory, trusted } = thread.hosted.projectTrust()
    return projectLibraryAccess(directory, trusted)
  }
  /**
   * `threadId`'s project library, built or not (#470): a live thread's own answer; else the one a
   * build would make — a stored thread's directory and branch, or the project a new one is claimed
   * for — and nothing is built (#484). A stored thread in a directory that is no project here is
   * refused as a build of it would be.
   */
  async function projectLibraryOf(threadId: string): Promise<ProjectLibraryAccess> {
    const live = threads.peek(threadId)
    if (live !== undefined) return liveProjectLibrary(live)
    const storedDirectory = await host.storedThreadDirectory(threadId)
    if (storedDirectory === undefined) {
      const { directory, trusted } = host.projectTrust(projects.directoryForNewThread(threadId), [])
      return projectLibraryAccess(directory, trusted)
    }
    const stored = await host.readStoredThread(threadId)
    if (stored === undefined) {
      throw new SessionDirectoryRefused(`stored in ${storedDirectory} — not a project here; add it as one to open it`)
    }
    const { directory, trusted } = host.projectTrust(stored.cwd, stored.transcript)
    return projectLibraryAccess(directory, trusted)
  }

  /**
   * The system-prompt preview (#443): the candidate from the library (`?prompt=`), or pi's default;
   * the thread built on ask, as the commands route builds it — this is a person opening the prompt
   * manager, not a look (#86). Nothing about the thread changes. A library prompt that cannot be one
   * is the pick's refusal (422); a thread in a run is 409, since pi's rendering is then the run's.
   */
  async function respondWithSystemPromptPreview(
    threadId: string,
    _request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const ref = match[2]
    // Built first: a project reference is read through the thread, under its trust (#470).
    if (ref !== undefined) await threads.ensure(threadId)
    const pick = ref === undefined ? undefined : pickSystemPrompt(threadId, ref)
    if (pick?.kind === 'refused') {
      refuseWith(response, { status: pick.reason === NO_PROMPT_LIBRARY ? 404 : 422, reason: pick.reason })
      return
    }
    await answerPreview(threadId, pick?.choice ?? null, response)
  }

  /**
   * `POST …/system-prompt` (#443): an unsaved prompt's text, previewed as the editor types it. The
   * draft is a choice like a saved one's — its hash taken here — that nothing records.
   */
  async function respondWithDraftPreview(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const draft = await readPromptSizedBody(request, response, readSystemPromptDraftBody)
    if (draft === undefined) return
    await answerPreview(threadId, draftChoice(draft), response)
  }

  /**
   * A preview of `candidate` on the thread, built on ask; 409 while it runs. A rendering that does
   * not split is a 500: the host matches the candidate's own text whole (preamble and addendum,
   * `system-prompt-preview.ts`), so whatever it holds cannot be the cause — pi rendered something the
   * splitter does not know.
   */
  async function answerPreview(
    threadId: string,
    candidate: EnsoSystemPromptChoice | null,
    response: ServerResponse,
  ): Promise<void> {
    const thread = await threads.ensure(threadId)
    const outcome = thread.busy ? { kind: 'busy' as const } : thread.hosted.previewSystemPrompt(candidate)
    if (outcome.kind === 'preview') {
      answerJson(response, outcome.preview)
      return
    }
    if (outcome.kind === 'busy') {
      refuseWith(response, {
        status: 409,
        reason: `thread ${threadId} is running; preview its system prompt when it settles`,
      })
      return
    }
    log.error('pi rendered a system prompt that does not split back', { threadId, id: candidate?.id ?? null })
    refuseWith(response, {
      status: 500,
      reason: "pi's rendering of this system prompt does not split back into its sections",
    })
  }

  /**
   * `PUT /api/prompts/:id` (#443): write a library prompt whole under the precondition its headers
   * state; the answer is the file as read back, with its `ETag`, so a page never shows fields the
   * file does not hold. A precondition the disk does not meet is a 412 naming the file.
   */
  async function respondToPromptWrite(
    library: PromptLibrary,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const condition = writeConditionOf(request, 'write', 'prompt')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    const fields = await readPromptSizedBody(request, response, readPromptWriteBody)
    if (fields === undefined) return
    const written = library.write(id, fields, condition)
    if (written.kind === 'conflict') {
      log.warn('prompt {id} not written: {reason}', { id, reason: written.reason })
      refuseWith(response, { status: 412, reason: written.reason })
      return
    }
    if (written.kind !== 'prompt')
      log.error('prompt {id} did not read back after its write: {read}', { id, read: written })
    answerLibraryRead(response, written, 500)
  }

  /**
   * A library read, answered: the prompt as JSON with its `ETag`, a missing file 404, a refused one
   * with its reason at `refusedStatus` — 422 for a read, 500 for a write that does not read back.
   */
  function answerLibraryRead(response: ServerResponse, read: LibraryRead, refusedStatus: 422 | 500): void {
    if (read.kind === 'prompt') {
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: read.etag })
      response.end(JSON.stringify(read.prompt))
      return
    }
    refuseWith(response, { status: read.kind === 'missing' ? 404 : refusedStatus, reason: read.reason })
  }

  /** `GET /api/prompts/:id`: the prompt, 404 when there is no such file, 422 naming why a file is refused. */
  function respondWithPrompt(library: PromptLibrary, id: string, response: ServerResponse): void {
    answerLibraryRead(response, library.read(id), 422)
  }

  /** `GET …/project-prompts` (#470): the thread's project library, or where it is and that it is not trusted. */
  async function respondWithProjectPrompts(threadId: string, response: ServerResponse): Promise<void> {
    answerJson(response, projectPromptListing(await projectLibraryOf(threadId)))
  }

  /**
   * `GET …/project-prompts/:id` (#470): one project prompt, as `GET /api/prompts/:id` answers one; 403
   * naming the directory when the thread does not trust its project — the file is not read.
   */
  async function respondWithProjectPrompt(
    threadId: string,
    _request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const id = match[2] ?? ''
    const access = await projectLibraryOf(threadId)
    if (access.kind === 'untrusted') {
      refuseWith(response, { status: 403, reason: untrustedProjectReason(access.directory) })
      return
    }
    answerLibraryRead(response, access.library.read(id), 422)
  }

  /** `GET /api/prompts`: the library's prompts, and every file it refused, by name. */
  function respondWithPrompts(library: PromptLibrary, response: ServerResponse): void {
    answerJson(response, library.list())
  }

  /**
   * `DELETE /api/prompts/:id` under its `If-Match`: 204, 404 when there was no such file, 412 when it
   * is not the version the caller read. A thread that ran it keeps its own copy.
   */
  function respondToPromptRemoval(
    library: PromptLibrary,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const condition = writeConditionOf(request, 'delete', 'prompt')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    if (condition.kind === 'absent') {
      endAndClose(request, response, 400, 'a delete takes `If-Match`, not `If-None-Match`')
      return
    }
    const removed = library.remove(id, condition)
    if (removed === 'missing') {
      refuseWith(response, { status: 404, reason: `no prompt ${id} in ${library.directory}` })
      return
    }
    if (removed !== 'removed') {
      log.warn('prompt {id} not deleted: {reason}', { id, reason: removed.reason })
      refuseWith(response, { status: 412, reason: removed.reason })
      return
    }
    response.writeHead(204)
    response.end()
  }

  /** A library route's work, answered or failed: a disk that throws is a 500, never a throw with nothing above it. */
  function withLibrary(
    request: IncomingMessage,
    response: ServerResponse,
    work: (library: PromptLibrary) => void | Promise<void>,
  ): true {
    if (prompts === undefined) {
      endAndClose(request, response, 404, NO_PROMPT_LIBRARY)
      return true
    }
    answerOrFail(
      Promise.resolve().then(() => work(prompts)),
      response,
    )
    return true
  }

  /** True when the request was a prompt-library route (#443). */
  function dispatchPromptRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/prompts') {
      return withLibrary(request, response, (library) => respondWithPrompts(library, response))
    }
    const read = request.method === 'GET' ? PROMPT_READ_ROUTE.exec(url)?.[1] : undefined
    if (read !== undefined)
      return withLibrary(request, response, (library) => respondWithPrompt(library, read, response))
    const written = request.method === 'PUT' ? PROMPT_WRITE_ROUTE.exec(url)?.[1] : undefined
    if (written !== undefined) {
      return withLibrary(request, response, (library) => respondToPromptWrite(library, written, request, response))
    }
    const removed = request.method === 'DELETE' ? PROMPT_DELETE_ROUTE.exec(url)?.[1] : undefined
    if (removed !== undefined) {
      return withLibrary(request, response, (library) => respondToPromptRemoval(library, removed, request, response))
    }
    return false
  }

  return {
    pickSystemPrompt,
    respondWithSystemPromptPreview,
    respondWithDraftPreview,
    respondWithProjectPrompts,
    respondWithProjectPrompt,
    dispatchPromptRoute,
  }
}
