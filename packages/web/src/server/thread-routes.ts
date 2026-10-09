import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ENSO_PROJECT_HEADER,
  ensoLogger,
  LIBRARY_PROMPT_ID_SOURCE,
  LIBRARY_PROMPT_REF_SOURCE,
  withEnsoLogContext,
} from '@enso/core'
import { type FollowRouteDeps, followThread } from './follow.ts'
import type { PermissionRoutes } from './permission-routes.ts'
import type { ProjectRegistry } from './projects.ts'
import type { PromptRoutes } from './prompt-routes.ts'
import { answerOrFail, decodeThreadId, endAndClose, type ThreadRouteHandler } from './request-plumbing.ts'
import type { ThreadControlRoutes } from './thread-control-routes.ts'
import type { ThreadReadRoutes } from './thread-read-routes.ts'

/**
 * The thread routes (#174, #810): every `/api/threads/<threadId>/…` path and the one table that
 * dispatches them. The handlers are the route groups' (`thread-read-routes.ts`,
 * `thread-control-routes.ts`, `prompt-routes.ts`, `permission-routes.ts`); a row names one.
 * ⚠ `scripts/docs/routes.ts` reads the routes off the `const *_ROUTE` declarations below and their
 * rows in the table: a route is declared and dispatched in this file.
 */

const log = ensoLogger('server', 'http')

/**
 * `/api/threads/<threadId>/<action>`: the id is one path segment, percent-encoded by the caller,
 * and the route's first capture; the action names what is asked of the thread.
 */
function threadRoute(action: string): RegExp {
  return new RegExp(`^/api/threads/([^/?#]+)/${action}$`)
}

/** `GET /api/threads/<threadId>` — the id is one path segment, percent-encoded by the caller. */
const THREAD_ROUTE = /^\/api\/threads\/([^/?#]+)$/
/**
 * `DELETE /api/threads/<threadId>[?force=1]` (#571): delete the thread — its session, tree and store.
 * `force` deletes a tree that holds work; it is the only query the route takes.
 */
const THREAD_DELETE_ROUTE = /^\/api\/threads\/([^/?#]+)(\?force=1)?$/
/** `GET …/delete-preview` (#571): what deleting the thread would do — its tree, the work in it, the forks that keep its snapshots. */
const THREAD_DELETE_PREVIEW_ROUTE = threadRoute('delete-preview')
/** `GET /api/threads/<threadId>/events` — the thread's two event tails (#97). */
const THREAD_EVENTS_ROUTE = threadRoute('events')
/**
 * `GET /api/threads/<threadId>/history[?before=<messageId>]` — the branch as messages, live or stored
 * (#95): its last page, or the page before that message (#739).
 */
const THREAD_HISTORY_ROUTE = /^\/api\/threads\/([^/?#]+)\/history(?:\?([^#]*))?$/
/** `GET /api/threads/<threadId>/commands` — the slash commands the thread can run, for the palette (#338). */
const THREAD_COMMANDS_ROUTE = threadRoute('commands')
/** `GET /api/threads/<threadId>/stats` — the thread analysed: per prompt, turn and tool (#45). */
const THREAD_STATS_ROUTE = threadRoute('stats')
/** `GET /api/threads/<threadId>/context` — the thread's context, request by request (#361). */
const THREAD_CONTEXT_ROUTE = threadRoute('context')
/** `GET /api/threads/<threadId>/context/<turn|next>` — one request's context, element by element (#361). */
const THREAD_CONTEXT_REQUEST_ROUTE = /^\/api\/threads\/([^/?#]+)\/context\/([1-9]\d*|next)$/
/** `GET /api/threads/<threadId>/manifest` — the thread's fork point: identity, then run conditions (#435). */
const THREAD_MANIFEST_ROUTE = threadRoute('manifest')
/** `GET /api/threads/<threadId>/eval` — the thread's session eval: mechanical timeline and scorecard (#441). */
const THREAD_EVAL_ROUTE = threadRoute('eval')
/** `GET /api/threads/<threadId>/git` — git in the thread's cwd: branch, last-push baseline, unpushed work (#453). */
const THREAD_GIT_ROUTE = threadRoute('git')
/** `GET /api/threads/<threadId>/changes` — every file that differs from the last-push baseline, with its patch (#452). */
const THREAD_CHANGES_ROUTE = threadRoute('changes')
/**
 * `GET /api/threads/<threadId>/tree` — where the thread works, the HTML pages it holds, and the origin
 * its preview is served from (#619, #713: an origin of its own, not a route of this server).
 */
const THREAD_PAGES_ROUTE = threadRoute('tree')
/** `GET /api/threads/<threadId>/judge-cases` — the calls the command judge would be asked about, redacted (#469). */
const THREAD_JUDGE_CASES_ROUTE = threadRoute('judge-cases')
/** The wire (#112): `POST …/prompt`, `GET …/follow`, `POST …/dialog`, `POST …/abort` (#116). See `follow.ts`. */
const THREAD_FOLLOW_ROUTE = threadRoute('follow')
const THREAD_PROMPT_ROUTE = threadRoute('prompt')
const THREAD_DIALOG_ROUTE = threadRoute('dialog')
const THREAD_ABORT_ROUTE = threadRoute('abort')
/** `POST …/mode` (#162 workstream 4, L3 step C): switch the mode as a control route, not a prompt. */
const THREAD_MODE_ROUTE = threadRoute('mode')
/** `POST …/command` (#338 slice 2): run a `host` command — `/model`, `/thinking` — as a control route, not a prompt. */
const THREAD_COMMAND_ROUTE = threadRoute('command')
/** `POST …/configure` (#391): a new session's model, effort and mode, applied together — the Start-a-session dialog. */
const THREAD_CONFIGURE_ROUTE = threadRoute('configure')
/**
 * `POST …/permissions/check` (#474): the permission engine's verdict for `{ surface, value }` in the
 * thread's mode now — Settings' "Try a command". Builds the thread on ask, as a preview does.
 */
const THREAD_PERMISSION_CHECK_ROUTE = threadRoute('permissions/check')
/**
 * `GET …/system-prompt[?prompt=<ref>]` (#443): the system prompt the thread's next request would carry
 * with a library prompt — pi's default without one — section by section. Builds the thread on ask.
 * The one query parameter is part of the pattern on purpose: its value is a prompt reference in the
 * library's own shape (`LIBRARY_PROMPT_REF_SOURCE`: an id, or `project:` and an id, #470 — the colon
 * sent as it is), so a malformed one or any other parameter is a 404, never a file lookup.
 */
const THREAD_SYSTEM_PROMPT_ROUTE = new RegExp(
  `^/api/threads/([^/?#]+)/system-prompt(?:\\?prompt=(${LIBRARY_PROMPT_REF_SOURCE}))?$`,
)
/**
 * `GET …/project-prompts` (#470): the thread's project library — listed when the thread trusts its
 * project, else only where it is. Builds nothing: a thread with no session answers as a build would.
 */
const THREAD_PROJECT_PROMPTS_ROUTE = threadRoute('project-prompts')
/**
 * `GET …/project-prompts/<id>` (#470): one project prompt, read-only — there is no route that writes
 * one. The id is the library's own shape, as `/api/prompts/<id>`'s is.
 */
const THREAD_PROJECT_PROMPT_ROUTE = new RegExp(`^/api/threads/([^/?#]+)/project-prompts/(${LIBRARY_PROMPT_ID_SOURCE})$`)
/** `POST …/system-prompt` (#443): the same preview for an unsaved prompt's text — the editor's breakdown. */
const THREAD_SYSTEM_PROMPT_DRAFT_ROUTE = threadRoute('system-prompt')
/** `POST …/fork` (#433): fork the thread at one of its user messages — a new thread naming this one as its parent. */
const THREAD_FORK_ROUTE = threadRoute('fork')
/** `POST …/restore` (#551): restore the thread's files to an entry's snapshot — the conversation is unchanged. */
const THREAD_RESTORE_ROUTE = threadRoute('restore')
/** `POST …/restore/undo` (#565): undo the thread's last restore — its files back to that restore's safety snapshot. */
const THREAD_RESTORE_UNDO_ROUTE = threadRoute('restore/undo')
/** `POST …/continue` (#436): continue a torn thread from its stored state — no new prompt. */
const THREAD_CONTINUE_ROUTE = threadRoute('continue')
/** `POST …/name` (#670): name the thread — pi's `session_info`, which the listing and the history carry. */
const THREAD_NAME_ROUTE = threadRoute('name')
/**
 * `POST …/incidents/<incidentId>/resolve` (#466): a human's resolution of the thread's incident — the
 * one way a suspension is lifted. The incident id is the shape both writers mint (a UUID), so it
 * needs no decoding; any other is no route.
 */
const THREAD_INCIDENT_RESOLVE_ROUTE = /^\/api\/threads\/([^/?#]+)\/incidents\/([0-9A-Za-z-]+)\/resolve$/
/**
 * `GET …/incidents` (#468): the thread's incident history and its replay — under the server's
 * thresholds, or the ones the query names (`?incidentAtSignals=4`). One of two thread reads that
 * take a query; `…/history?before=` is the other.
 */
const THREAD_INCIDENTS_ROUTE = /^\/api\/threads\/([^/?#]+)\/incidents(?:\?([^#]*))?$/

/** What the thread route table is handed (#810): the route groups whose handlers its rows name, the project registry, the follow's reach. */
export interface ThreadRoutesState {
  readonly reads: ThreadReadRoutes
  readonly controls: ThreadControlRoutes
  readonly prompts: PromptRoutes
  readonly permissions: PermissionRoutes
  readonly projects: ProjectRegistry
  readonly followDeps: FollowRouteDeps
}

/** The thread routes' one dispatcher (#810). */
export interface ThreadRoutes {
  /** True when the request was a thread route — answered, or refused (`decodeThreadId`, `admitProjectClaim`). */
  readonly dispatchThreadRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

export function createThreadRoutes(state: ThreadRoutesState): ThreadRoutes {
  const { reads, controls, prompts, permissions, projects, followDeps } = state

  /**
   * The thread routes, one row each, in precedence order (#174, workstream 6): method, the
   * path pattern with the id as its one capture, and the handler. The dispatcher below is the
   * table, not a case per row — it was seven copies of match → decode → handler in two
   * ladders. Every row runs under the thread's log context, so a record from any of them
   * names its thread; before the table only the wire's four did. A handler that returns a
   * promise is answered-or-failed (a rejection is a 500, the server stays up); a bad body is
   * a 400 inside the handler, never a throw. A row whose handler reads the body takes
   * `request` as it is (`respondToPrompt`, `respondToDialog`); one that reads only the id is
   * wrapped in `idOnly`, so the table says which is which.
   */
  interface ThreadRoute {
    readonly method: 'GET' | 'POST' | 'DELETE'
    readonly route: RegExp
    readonly respond: ThreadRouteHandler
  }
  /** A handler that reads no body: the row's arrow names the id and the response. */
  function idOnly(respond: (threadId: string, response: ServerResponse) => void | Promise<void>): ThreadRouteHandler {
    return (threadId: string, _request: IncomingMessage, response: ServerResponse) => respond(threadId, response)
  }
  /** The GET rows that read only the id — most of the table, so it says them as route and handler. */
  const idOnlyReads: ReadonlyArray<
    readonly [RegExp, (threadId: string, response: ServerResponse) => void | Promise<void>]
  > = [
    [THREAD_EVENTS_ROUTE, reads.respondWithThreadEvents],
    [THREAD_COMMANDS_ROUTE, reads.respondWithThreadCommands],
    [THREAD_STATS_ROUTE, reads.respondWithThreadStats],
    [THREAD_CONTEXT_ROUTE, reads.respondWithThreadContext],
    [THREAD_MANIFEST_ROUTE, reads.respondWithThreadManifest],
    [THREAD_EVAL_ROUTE, reads.respondWithThreadEval],
    [THREAD_GIT_ROUTE, reads.respondWithThreadGit],
    [THREAD_CHANGES_ROUTE, reads.respondWithThreadChanges],
    [THREAD_JUDGE_CASES_ROUTE, reads.respondWithThreadJudgeCases],
    [THREAD_DELETE_PREVIEW_ROUTE, reads.respondWithDeletePreview],
    [THREAD_PAGES_ROUTE, reads.respondWithThreadPages],
  ]
  const THREAD_ROUTES: readonly ThreadRoute[] = [
    ...idOnlyReads.map(([route, respond]): ThreadRoute => ({ method: 'GET', route, respond: idOnly(respond) })),
    { method: 'GET', route: THREAD_CONTEXT_REQUEST_ROUTE, respond: reads.respondWithContextRequest },
    { method: 'GET', route: THREAD_SYSTEM_PROMPT_ROUTE, respond: prompts.respondWithSystemPromptPreview },
    { method: 'GET', route: THREAD_PROJECT_PROMPTS_ROUTE, respond: idOnly(prompts.respondWithProjectPrompts) },
    { method: 'GET', route: THREAD_PROJECT_PROMPT_ROUTE, respond: prompts.respondWithProjectPrompt },
    { method: 'GET', route: THREAD_INCIDENTS_ROUTE, respond: reads.respondWithThreadIncidents },
    { method: 'GET', route: THREAD_HISTORY_ROUTE, respond: reads.respondWithThreadHistory },
    { method: 'GET', route: THREAD_ROUTE, respond: idOnly(reads.respondWithThread) },
    {
      method: 'GET',
      route: THREAD_FOLLOW_ROUTE,
      respond: idOnly((threadId: string, response: ServerResponse) => followThread(followDeps, threadId, response)),
    },
    { method: 'POST', route: THREAD_PROMPT_ROUTE, respond: controls.respondToPrompt },
    { method: 'POST', route: THREAD_DIALOG_ROUTE, respond: controls.respondToDialog },
    { method: 'POST', route: THREAD_MODE_ROUTE, respond: controls.respondToModeChange },
    { method: 'POST', route: THREAD_COMMAND_ROUTE, respond: controls.respondToHostCommand },
    { method: 'POST', route: THREAD_CONFIGURE_ROUTE, respond: controls.respondToConfigure },
    { method: 'POST', route: THREAD_SYSTEM_PROMPT_DRAFT_ROUTE, respond: prompts.respondWithDraftPreview },
    { method: 'POST', route: THREAD_PERMISSION_CHECK_ROUTE, respond: permissions.respondToPermissionCheck },
    { method: 'POST', route: THREAD_FORK_ROUTE, respond: controls.respondToFork },
    { method: 'POST', route: THREAD_RESTORE_ROUTE, respond: controls.respondToRestore },
    { method: 'POST', route: THREAD_RESTORE_UNDO_ROUTE, respond: controls.respondToRestoreUndo },
    { method: 'POST', route: THREAD_NAME_ROUTE, respond: controls.respondToRename },
    { method: 'POST', route: THREAD_CONTINUE_ROUTE, respond: idOnly(controls.respondToContinue) },
    { method: 'POST', route: THREAD_ABORT_ROUTE, respond: idOnly(controls.respondToAbort) },
    { method: 'POST', route: THREAD_INCIDENT_RESOLVE_ROUTE, respond: controls.respondToIncidentResolution },
    { method: 'DELETE', route: THREAD_DELETE_ROUTE, respond: controls.respondToDelete },
  ]

  /**
   * A page names a NEW thread's project on its requests (`X-Enso-Project`, #395). An id that is no
   * registered project is refused here (400), before any route runs — the page would otherwise have
   * its thread built somewhere else without a word — and so is a name that contradicts the one the
   * thread already has (409). The body is never read, so the connection closes.
   */
  function admitProjectClaim(threadId: string, request: IncomingMessage, response: ServerResponse): boolean {
    const header = request.headers[ENSO_PROJECT_HEADER]
    const refusal = projects.claim(threadId, typeof header === 'string' ? header : undefined)
    if (refusal === undefined) return true
    log.warn('thread request refused: {reason}', { threadId, reason: refusal.reason })
    endAndClose(request, response, refusal.status, refusal.reason)
    return false
  }

  /** True when the request was a thread route — answered, or refused (`decodeThreadId`, `admitProjectClaim`). */
  function dispatchThreadRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    for (const { method, route, respond } of THREAD_ROUTES) {
      if (request.method !== method) continue
      const match = route.exec(url)
      const segment = match?.[1]
      if (match === null || segment === undefined) continue
      const threadId = decodeThreadId(segment, response)
      if (threadId !== undefined && admitProjectClaim(threadId, request, response)) {
        withEnsoLogContext({ threadId }, () => {
          const work = respond(threadId, request, response, match)
          if (work !== undefined) answerOrFail(work, response)
        })
      }
      return true
    }
    return false
  }

  return { dispatchThreadRoute }
}
