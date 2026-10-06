import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { assertExactKeys, runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/routes.md`: the HTTP surface dispatched by the web server.
 * Route discovery is deliberately narrow; behavior is explicit metadata whose keys are
 * checked against every discovered regex constant and literal dispatcher branch.
 */

const ROOT = findRepoRoot(import.meta.url)
const SERVER_PATH = 'packages/web/src/server/index.ts'
const FOLLOW_PATH = 'packages/web/src/server/follow.ts'
const BUNDLE_PATH = 'packages/web/src/server/bundle-route.ts'
const LOGS_PATH = 'packages/web/src/server/logs-route.ts'
const LOGS_TAIL_PATH = 'packages/web/src/server/logs-tail-route.ts'
const LOGS_STATS_PATH = 'packages/web/src/server/logs-stats-route.ts'

interface RouteMetadata {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly handler: string
  readonly input: string
  readonly success: string
  readonly errors: string
  readonly routeClass: 'control' | 'observation' | 'browser-log-ingest' | 'static'
  readonly builds: 'yes' | 'no'
  readonly logs: 'yes' | 'no'
  /**
   * The follow-module factory the handler calls, and what that factory reaches: the thread's
   * runtime (the default), or the storage seam (`AgentHost`) without a runtime — the fork route.
   */
  readonly factory?: { readonly path: string; readonly declaration: string; readonly reaches?: 'storage' }
}

/**
 * A regex route's facts. `path` is stated only where discovery cannot derive it: a
 * `threadRoute('<action>')` constant is `/api/threads/:threadId/<action>` by construction.
 */
type RegexRouteMetadata = Omit<RouteMetadata, 'path'> & { readonly path?: string }

/** What a thread read that finds no session answers — most of the read rows' errors. */
const NO_SESSION_ERRORS = '400 malformed thread id; 403 untrusted origin; 404 no session; 500 handler failure'
/** A git read's errors: a thread held nowhere, or one whose project is no longer served. */
const GIT_READ_ERRORS =
  '400 malformed thread id; 403 untrusted origin; 404 no session, or its project is no longer served; 500 handler failure'
/** What a live-only read answers. */
const NO_LIVE_SESSION_ERRORS = '400 malformed thread id; 403 untrusted origin; 404 no live session'

/**
 * A GET that reads one thread and builds nothing — every such row shares its method, input, class
 * and acquisition, so a row states its handler, what it answers, and anything beyond those.
 */
function threadRead(
  handler: string,
  success: string,
  errors: string = NO_SESSION_ERRORS,
  extra: Partial<Pick<RouteMetadata, 'input' | 'factory' | 'path' | 'builds'>> = {},
): RegexRouteMetadata {
  return {
    method: 'GET',
    input: 'path: `threadId`',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    handler,
    success,
    errors,
    ...extra,
  }
}

/**
 * A control route on one thread: a POST that logs its own outcome. A row states its handler, its
 * input, what it answers and refuses, whether it builds the session, and the follow factory it
 * calls; a route off the thread paths says its method and path.
 */
function threadControl(
  handler: string,
  input: string,
  [success, errors]: readonly [success: string, errors: string],
  facts: Pick<RouteMetadata, 'builds'> & Partial<Pick<RouteMetadata, 'factory' | 'path' | 'method'>>,
): RegexRouteMetadata {
  return { method: 'POST', handler, input, success, errors, routeClass: 'control', logs: 'yes', ...facts }
}

/** A factory in `follow.ts` that reaches the thread's runtime. */
const follows = (declaration: string): NonNullable<RouteMetadata['factory']> => ({ path: FOLLOW_PATH, declaration })

/** A prompt-library row (#443): one path, three methods, no thread, nothing built. */
function promptRoute(
  facts: Pick<RouteMetadata, 'method' | 'handler' | 'input' | 'success' | 'errors' | 'routeClass' | 'logs'>,
): RouteMetadata {
  return { ...facts, path: '/api/prompts/:id', builds: 'no' }
}

/** A literal GET that takes no input, reads, and builds nothing — the listing and inspection rows. */
function literalRead(
  facts: Pick<RouteMetadata, 'handler' | 'success'> & Partial<Pick<RouteMetadata, 'errors' | 'factory' | 'input'>>,
): Omit<RouteMetadata, 'method' | 'path'> {
  return {
    input: 'none',
    errors: '403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    ...facts,
  }
}

const BODY_ERRORS = '400 malformed id/body; 403 untrusted origin'

const REGEX_ROUTE_METADATA: Record<string, RegexRouteMetadata> = {
  THREAD_ROUTE: threadRead('respondWithThread', '200 JSON', NO_LIVE_SESSION_ERRORS, { path: '/api/threads/:threadId' }),
  THREAD_EVENTS_ROUTE: threadRead('respondWithThreadEvents', '200 `EnsoThreadEvents` JSON', NO_LIVE_SESSION_ERRORS),
  THREAD_COMMANDS_ROUTE: threadRead(
    'respondWithThreadCommands',
    '200 `EnsoThreadCommands` JSON — `source` says live, remembered or none',
    '400 malformed thread id; 403 untrusted origin',
  ),
  THREAD_PERMISSION_CHECK_ROUTE: {
    method: 'POST',
    handler: 'respondToPermissionCheck → HostedThread.checkPermission',
    input: 'path: `threadId`; body: `EnsoPermissionCheckRequest` — a `surface` and a `value`',
    success:
      "200 `EnsoPermissionVerdict` JSON (#474) — the permission engine's own verdict in the thread's mode now: its decision, the pattern that won and where that rule came from (`global`, the user's file; `agent`, the mode's preset); nothing runs",
    errors: `${BODY_ERRORS}; 409 the engine published no service for the session; 413 body too large; 500 handler failure`,
    routeClass: 'observation',
    builds: 'yes',
    logs: 'no',
  },
  THREAD_STATS_ROUTE: threadRead(
    'respondWithThreadStats',
    "200 `EnsoThreadStats` JSON — pi's session for the numbers, the log's day files for the times",
  ),
  THREAD_CONTEXT_ROUTE: threadRead(
    'respondWithThreadContext',
    "200 `EnsoThreadContext` JSON — pi's branch, request by request, and its context meter",
  ),
  THREAD_CONTEXT_REQUEST_ROUTE: threadRead(
    'respondWithContextRequest',
    "200 `EnsoContextRequestDetail` JSON — one request's context, element by element",
    '400 malformed thread id; 403 untrusted origin; 404 no session or no such turn; 500 handler failure',
    {
      path: '/api/threads/:threadId/context/:request',
      input: 'path: `threadId`, `request` (a turn number or `next`)',
    },
  ),
  THREAD_MANIFEST_ROUTE: threadRead(
    'respondWithThreadManifest',
    "200 `EnsoForkPoint` JSON — identity, then run conditions, off pi's branch",
  ),
  THREAD_EVAL_ROUTE: threadRead(
    'respondWithThreadEval',
    "200 `EnsoSessionEval` JSON — the mechanical timeline and scorecard (#441): the branch's events off pi's entries, the queued prompts and interrupts off the day files the branch spans",
  ),
  THREAD_INCIDENTS_ROUTE: threadRead(
    'respondWithThreadIncidents',
    "200 `EnsoThreadIncidents` JSON (#468) — each incident's record with the custom entries it rests on as stored, and the branch replayed under the thresholds used: same, would open, would miss. What `bun run incidents` reads",
    '400 malformed thread id, or a query naming no threshold or no whole number from 1; 403 untrusted origin; 404 no session; 500 handler failure',
    {
      path: '/api/threads/:threadId/incidents',
      input:
        'path: `threadId`; query: optional `windowCalls`, `highAtSignals`, `highAtKinds`, `incidentAtSignals` — the server’s thresholds otherwise',
    },
  ),
  THREAD_JUDGE_CASES_ROUTE: threadRead(
    'respondWithThreadJudgeCases',
    "200 `EnsoThreadJudgeCases` JSON (#469) — each call the command judge would be asked about (core's selection under the server's thresholds), why it is in scope, and the REDACTED state a backend would be sent. Sends nothing. What `bun run judge` reads",
  ),
  THREAD_GIT_ROUTE: threadRead(
    'respondWithThreadGit',
    "200 `EnsoThreadGit` JSON — the thread's cwd and git's state there (#453): repository, branch, upstream, the last-push baseline and the rule that chose it, ahead/behind, and changed files by where they sit; `not-a-repository` or `unavailable` with git's reason otherwise. Read-only, no fetch",
    GIT_READ_ERRORS,
  ),
  THREAD_CHANGES_ROUTE: threadRead(
    'respondWithThreadChanges',
    "200 `EnsoThreadChanges` JSON — git's state in the thread's cwd and every file that differs from its last-push baseline (#452): unpushed commits, staged and unstaged edits, deletions, renames and untracked files, each with its unified diff unless binary or too large; `truncated` past 500 files. A diff git cannot produce reads as `unavailable`. Read-only, no fetch",
    GIT_READ_ERRORS,
  ),
  THREAD_PAGES_ROUTE: threadRead(
    'respondWithThreadPages',
    '200 `EnsoThreadPages` JSON (#619) — the directory the thread works in (its tree, #551) and the HTML files at its top two levels, at most 50 (`truncated` past them); `.git` and `node_modules` are not walked. Read-only',
    GIT_READ_ERRORS,
  ),
  PREVIEW_ROUTE: threadRead(
    'respondWithPreview',
    "200 the file's bytes (#619) — one file of the thread's tree, a directory as its `index.html`, at most 10 MiB, typed by extension, under `Content-Security-Policy: sandbox allow-scripts allow-forms allow-pointer-lock allow-modals`: an opaque origin, so its requests to this server say `Origin: null` and are refused. `nosniff`, `no-referrer`, `no-store`",
    '400 malformed thread id; 403 untrusted origin; 404 no session, a project no longer served, a path that leaves the tree (`..` or a symlink), no such file, or one too large; 500 handler failure',
    { path: '/preview/threads/:threadId/:path', input: 'path: `threadId`, then the file, `/`-separated' },
  ),
  THREAD_HISTORY_ROUTE: threadRead(
    'respondWithThreadHistory',
    '200 `EnsoThreadHistory` JSON',
    '400 malformed thread id; 403 untrusted origin, or a session stored in a directory that is no project here (named, #378); 404 no session — an id nobody has used, which a page starts; 410 a deleted thread (#571) — this server deleted it — never started again; 500 handler failure',
  ),
  THREAD_DELETE_PREVIEW_ROUTE: threadRead(
    'respondWithDeletePreview → AgentHost.previewThreadDelete',
    "200 `EnsoThreadDeletePreview` JSON — the tree a delete would remove (or null) and its size on disk (#578; at least, past a 5 s cap), the work in it a delete is refused for (the inventory's words), and the forks whose histories keep this one's snapshots (#571); nothing is deleted and no snapshot taken — the inventory's scratch staging leaves loose objects in the store",
    '400 malformed thread id; 403 untrusted origin; 404 no session file in a served project; 410 a deleted thread; 500 handler failure',
  ),
  THREAD_FOLLOW_ROUTE: threadRead(
    'followThread',
    '200 SSE stream',
    '400 malformed thread id; 403 untrusted origin; 500 handler failure',
    { factory: follows('export async function followThread') },
  ),
  THREAD_PROMPT_ROUTE: threadControl(
    'respondToPrompt → promptThread',
    'path: `threadId`; body: `EnsoPromptBody`',
    [
      '202 `EnsoPromptReceipt` JSON',
      '400 malformed id/body or unavailable command; 403 untrusted origin; 409 the thread was taken and released again while the prompt waited on its build (rare; #444); 413 body too large; 500 handler failure',
    ],
    { builds: 'yes', factory: follows('export async function promptThread') },
  ),
  THREAD_DIALOG_ROUTE: threadControl(
    'respondToDialog → answerThreadDialog',
    'path: `threadId`; body: `DialogAnswer`',
    ['204 empty', `${BODY_ERRORS}; 404 no live question; 413 body too large; 422 answer refused; 500 handler failure`],
    { builds: 'no', factory: follows('export function answerThreadDialog') },
  ),
  THREAD_ABORT_ROUTE: threadControl(
    'respondToAbort → abortThread',
    'path: `threadId`; no body',
    [
      '200 `EnsoAbortReceipt` JSON',
      '400 malformed thread id; 403 untrusted origin; 404 no live session; 409 nothing running',
    ],
    { builds: 'no', factory: follows('export function abortThread') },
  ),
  THREAD_COMMAND_ROUTE: threadControl(
    'respondToHostCommand → runHostCommand',
    "path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing; a `view` row (`context`, `fork`) is the page's to do, never run",
    [
      '204 empty for a setting (the change arrives on the follow as `model`); 202 empty for a flow or action (`login`, `logout`, `compact`) — started, its questions and progress arrive on the follow as dialogs and `notify` lines',
      `${BODY_ERRORS}; 409 thread busy; 413 body too large; 422 unknown command, model or level, a provider without credentials, or a \`view\` (\`/context\`, \`/fork\`) the page does itself; 500 handler failure`,
    ],
    { builds: 'yes' },
  ),
  THREAD_CONFIGURE_ROUTE: threadControl(
    'respondToConfigure → configureThread',
    "path: `threadId`; body: `EnsoSessionConfiguration` — optional `systemPrompt` (a prompt reference — a user prompt's id, or `project:<id>` for the project's own, #470 — `system` or `append`, or `null` for pi's default; absent leaves the session's as it is), `model` (`provider/id`), `thinking` (a level that model supports) and `mode`; applied in that order under one lease, a value equal to the current one left alone",
    [
      '204 empty — every step applied (the changes arrive on the follow as `model` and `permission-mode`)',
      `${BODY_ERRORS}; 409 thread busy; 413 body too large; 422 JSON \`EnsoConfigurationRefusal\` — the step that refused (\`systemPrompt\`, \`model\`, \`thinking\`, \`mode\`) and the reason, the steps before it applied — a system prompt is refused by name when its reference names no library prompt, a project prompt's project is not trusted by the thread, its file is missing, unreadable or unparseable, a session prompt, or empty, or the session already sent a request (before it, a new choice — pi's default included — replaces the last); 500 handler failure`,
    ],
    { builds: 'yes' },
  ),
  THREAD_FORK_ROUTE: threadControl(
    'respondToFork → forkThreadAt → AgentHost.forkThread',
    "path: `threadId`; body: `EnsoForkRequest` — `entryId`, the pi entry id of one of the thread's user messages; the fork is pi's `/fork` at position `before`, taken from the session file",
    [
      "200 `EnsoForkReceipt` JSON — the new thread id (its session file names the source as `parentSession`) and the forked message's text, for the new composer",
      '400 malformed id/body, or an entry that is no user message; 403 untrusted origin; 404 no session file in a served project, or no such entry; 409 thread busy; 413 body too large; 500 handler failure',
    ],
    {
      builds: 'no',
      factory: { path: FOLLOW_PATH, declaration: 'export async function forkThreadAt', reaches: 'storage' },
    },
  ),
  THREAD_RESTORE_ROUTE: threadControl(
    'respondToRestore → restoreThreadAt → AgentHost.restoreThreadAt',
    "path: `threadId`; body: `EnsoRestoreRequest` — `entryId`, a user message on the thread's branch; the thread's tree is put back to the snapshot its run began with (#551), the conversation untouched. The thread is held for the whole restore, as a run holds it, and the host admits no run meanwhile",
    [
      '200 `{ hash, safety }` JSON — the snapshot restored, and the snapshot of the files it replaced, recorded on the thread as `enso-tree-restored`',
      '400 malformed id/body; 403 untrusted origin; 404 no such thread (before anything is built) or entry; 409 thread busy, the thread on no tree, no snapshot at that entry, or the restore refused; 413 body too large; 500 handler failure',
    ],
    { builds: 'yes', factory: follows('export function restoreThreadAt') },
  ),
  THREAD_RESTORE_UNDO_ROUTE: threadControl(
    'respondToRestoreUndo → undoLastRestore → AgentHost.undoLastRestore',
    "path: `threadId`; body: `EnsoRestoreUndoRequest` — `safety`, the snapshot the restore kept. The thread's tree back to its newest `enso-tree-restored` record's `safety` (#565), only when it is that one — itself a restore, recorded with a safety of its own, so a second undo puts the first restore back. Held as a restore is",
    [
      '200 `{ hash, safety }` JSON — the snapshot put back, and the snapshot of the files it replaced',
      "400 malformed id/body; 403 untrusted origin; 404 no such thread (before anything is built); 409 thread busy, the thread on no tree, no restore to undo, a later restore since (the `safety` is not the newest restore's), or the restore refused; 413 body too large; 500 handler failure",
    ],
    { builds: 'yes', factory: follows('export function undoLastRestore') },
  ),
  THREAD_DELETE_ROUTE: threadControl(
    'respondToDelete → deleteThreadAt → AgentHost.deleteThread',
    "path: `threadId`; query: `?force=1` or none — no other; header: `If-Match: \"<sha256 hex of the work's words>\"` with `?force=1`, the work the page showed (PR #572 review); no body. Deletes the thread (#571): the project's pre-#573 snapshot stores migrated first, then its tree through the inventory, its snapshot store, and the project's object store collected — what only this thread's snapshots reached goes, its forks' histories stay (#573) — then every session file under the id. The live session is retired only once the inventory has passed, and the id is refused for the server's lifetime after",
    [
      '204 empty — the session file, the tree (worktree, its registration and `enso/<thread-id>` branch, or the copy) and the store are gone',
      "400 malformed thread id, or an `If-Match` that is no strong sha256 tag; 403 untrusted origin; 404 no session file in a served project, or a query other than `?force=1`; 409 a run holds the thread, or a move, a restore or another delete does, or the project's snapshot stores are being migrated or collected (#573); 422 the tree holds work — untracked, modified or unsnapshotted files, or commits on its branch no other ref reaches — named in the text: deleted with `?force=1` only when `If-Match` confirms those very words, so work gained since is named again, never taken unseen; 500 a removal failed, the project's snapshot stores cannot be migrated, or a fork's store that could not be migrated still reads this store's objects (#573), named in the text",
    ],
    {
      builds: 'no',
      path: '/api/threads/:threadId',
      method: 'DELETE',
      factory: { path: FOLLOW_PATH, declaration: 'export async function deleteThreadAt', reaches: 'storage' },
    },
  ),
  THREAD_CONTINUE_ROUTE: threadControl(
    'respondToContinue → continueThread → ThreadRuntime.continueRun',
    'path: `threadId`; no body',
    [
      '202 empty — the torn tail is continued from the stored state with no new user message; the run arrives on the follow and its `settled` releases the thread',
      '400 malformed thread id; 403 untrusted origin; 404 no thread under that id, live or stored; 409 thread busy; 422 nothing to continue — the thread does not end on an unanswered prompt, an unfinished tool call, or tool results with no reply, or this pi build has no run lifecycle to continue in; 500 handler failure',
    ],
    { builds: 'yes', factory: follows('export async function continueThread') },
  ),
  // Idle only, like a mode change: lifting a suspension mid-run would change what the run in flight may do (#466).
  THREAD_INCIDENT_RESOLVE_ROUTE: threadControl(
    'respondToIncidentResolution → resolveThreadIncident → ThreadRuntime.resolveIncident',
    'path: `threadId`, `incidentId` (a UUID); body: `EnsoIncidentResolution` — `classification`, `outcome`, and `restricted` families only for `resume-with-restrictions`',
    [
      '204 empty — the `enso-incident-resolved` record is appended and the live guard applies it at once; the record arrives on the follow as a custom entry',
      `${BODY_ERRORS}; 404 no thread under that id, live or stored; 409 thread busy; 413 body too large; 422 the resolution is refused, with the reason — no such incident, a later one supersedes it, the thread was already ended, or \`restricted\` does not fit the outcome; 500 handler failure`,
    ],
    {
      builds: 'yes',
      path: '/api/threads/:threadId/incidents/:incidentId/resolve',
      factory: follows('export async function resolveThreadIncident'),
    },
  ),
  // Builds on ask, as the commands route does: a person opening the prompt manager (#443).
  THREAD_SYSTEM_PROMPT_ROUTE: threadRead(
    'respondWithSystemPromptPreview → HostedThread.previewSystemPrompt',
    "200 `EnsoSystemPromptPreview` JSON — pi's rendering of the next request's system prompt with that prompt, section by section (who wrote each: the library or pi), the tool definitions sent beside it, and the total the Context tab prices a first request made with it at; the thread's own choice is untouched",
    "400 malformed thread id; 403 untrusted origin; 404 a prompt named on a server without a library; 409 thread running; 422 the prompt is refused, with the reason naming it — missing, unreadable, not UTF-8 or unparseable, a session prompt, empty, or a project prompt the thread does not trust its project for; 500 pi's rendering does not split back into its sections (the prompt's own text is matched whole, so it cannot cause this), or handler failure",
    {
      path: '/api/threads/:threadId/system-prompt',
      input:
        "path: `threadId`; query: optional `prompt` — a prompt reference (`system` or `append`): a user prompt's id, or `project:<id>` for the project's own (#470, the colon unencoded); absent is pi's default",
      builds: 'yes',
    },
  ),
  // Builds nothing, as the commands route (#484): the Start dialog opens on threads no run has built.
  THREAD_PROJECT_PROMPTS_ROUTE: threadRead(
    'respondWithProjectPrompts → projectPromptListing',
    "200 `EnsoProjectPromptLibrary` JSON (#470) — `listed`: the project's own prompts (`<project>/.enso/prompts`) without their bodies and every file refused, when the thread trusts the project (none when the directory does not exist); `untrusted`: only the directory, nothing read. A thread no run built answers as its build would: pi's `trust.json`, a stored thread's own record, or the default",
    '400 malformed thread id; 403 untrusted origin; 409 the project a new thread is claimed for is gone, or a stored thread is in a directory that is no project here; 500 handler failure',
  ),
  THREAD_PROJECT_PROMPT_ROUTE: threadRead(
    'respondWithProjectPrompt → PromptLibrary.read',
    "200 `EnsoLibraryPrompt` JSON with its `ETag` (#470) — one project prompt, read-only: no route writes or deletes one, as the project's files are committed and shared",
    "400 malformed thread id; 403 untrusted origin, or the thread does not trust its project — the file is not read, and the reason names the directory; 404 no such file; 409 as the listing's; 422 the file is refused, with the reason naming it; 500 handler failure",
    {
      path: '/api/threads/:threadId/project-prompts/:id',
      input: 'path: `threadId`, `id` — the file name under `<project>/.enso/prompts` without `.md`',
    },
  ),
  THREAD_SYSTEM_PROMPT_DRAFT_ROUTE: {
    method: 'POST',
    handler: 'respondWithDraftPreview → HostedThread.previewSystemPrompt',
    input:
      "path: `threadId`; body: `EnsoSystemPromptDraft` — an unsaved prompt's `mode` (`system` or `append`), `text` and `name`",
    success:
      "200 `EnsoSystemPromptPreview` JSON — the same preview a saved prompt gets, for the editor's breakdown while it types; nothing is recorded",
    errors:
      "400 malformed id/body; 403 untrusted origin; 409 thread running; 413 body too large; 500 pi's rendering does not split back into its sections (the draft's text is matched whole, so it cannot cause this), or handler failure",
    routeClass: 'observation',
    builds: 'yes',
    logs: 'no',
  },
  PROMPT_READ_ROUTE: promptRoute({
    method: 'GET',
    handler: 'respondWithPrompt → PromptLibrary.read',
    input: 'path: `id` — the file name under `ENSO_HOME/prompts` without `.md`, lowercase words joined by hyphens',
    success:
      "200 `EnsoLibraryPrompt` JSON — its frontmatter fields, its body, the file's bytes and the body's estimated tokens — with an `ETag` header, the sha256 of the file's bytes, which a later replace or delete of this version names",
    errors:
      '403 untrusted origin; 404 no such file, or a server started without a library; 422 the file is refused, with the reason naming it — unreadable, not UTF-8, no frontmatter, an unknown key, no name, a category that is not system, append or session; 500 handler failure',
    routeClass: 'observation',
    logs: 'no',
  }),
  PROMPT_WRITE_ROUTE: promptRoute({
    method: 'PUT',
    handler: 'respondToPromptWrite → PromptLibrary.write',
    input:
      'path: `id`; headers: exactly one precondition — `If-None-Match: *` (create: no file of that name), `If-Match: <ETag>` (replace the version read), `If-Match: *` (replace whatever is there); body: `EnsoLibraryPromptWrite` — `name`, `description`, `category` (system, append or session) and the markdown `body`',
    success:
      '200 `EnsoLibraryPrompt` JSON with its new `ETag` — the file as read back after it was written whole (staged, then linked into place for a create, renamed over for a replace)',
    errors:
      '400 malformed body, or both headers, a list, or a weak tag; 403 untrusted origin; 404 a server started without a library; 412 the precondition does not hold, with the reason naming the file — it already exists (a refused file included), changed on disk since it was read, or is gone; 413 body too large; 428 no precondition — never an unconditional write; 500 the file does not read back, or a disk failure',
    routeClass: 'control',
    logs: 'yes',
  }),
  PROMPT_DELETE_ROUTE: promptRoute({
    method: 'DELETE',
    handler: 'respondToPromptRemoval → PromptLibrary.remove',
    input: 'path: `id`; header: `If-Match: <ETag>` (the version read) or `If-Match: *`',
    success: '204 empty — the file is gone; a thread that ran it keeps the text its log recorded',
    errors:
      '400 `If-None-Match`, a list, or a weak tag; 403 untrusted origin; 404 no such file, or a server started without a library; 412 the file changed on disk since it was read; 428 no `If-Match`; 500 handler failure',
    routeClass: 'control',
    logs: 'yes',
  }),
  PROJECT_ROUTE: threadControl(
    'respondToProjectRemoval → ProjectRegistry.remove',
    'path: `projectId` (sixteen hex digits)',
    [
      '204 empty — the registration is forgotten; its sessions stay on disk and are served again if the directory is registered again',
      '403 untrusted origin; 404 no registered project with that id; 409 the launch project, or a thread in the project is running',
    ],
    { builds: 'no', path: '/api/projects/:projectId', method: 'DELETE' },
  ),
  THREAD_MODE_ROUTE: threadControl(
    'respondToModeChange → changeThreadMode',
    'path: `threadId`; body: `EnsoPermissionModeChange`',
    [
      '204 empty; the change arrives on the follow as `permission-mode`',
      `${BODY_ERRORS}; 409 a restore or delete holds the thread; 413 body too large; 422 mode not offered; 500 handler failure`,
    ],
    { builds: 'yes', factory: follows('export async function changeThreadMode') },
  ),
}

const LITERAL_ROUTE_METADATA: Record<string, Omit<RouteMetadata, 'method' | 'path'>> = {
  'GET /api/mode': {
    handler: 'respondWithFreshThreadMode',
    input: 'none',
    success: '200 permission-mode JSON',
    errors: '403 untrusted origin',
    routeClass: 'static',
    builds: 'no',
    logs: 'no',
  },
  'GET /api/threads': literalRead({ handler: 'respondWithThreads', success: '200 `EnsoThreadSummary[]` JSON' }),
  'GET /api/stored-threads': literalRead({
    handler: 'respondWithStoredThreads',
    success: '200 `EnsoStoredThread[]` JSON',
    errors: '403 untrusted origin; 500 handler failure',
  }),
  'GET /api/prompts': literalRead({
    handler: 'respondWithPrompts → PromptLibrary.list',
    success:
      "200 `EnsoLibraryPromptListing` JSON — the library's prompts by name without their bodies, each with its bytes and estimated tokens, and every `.md` file it refused, with the reason naming it",
    errors: '403 untrusted origin; 404 a server started without a library; 500 handler failure',
  }),
  'GET /api/permissions': literalRead({
    handler: 'answerPolicy → readPermissionPolicy',
    success:
      "200 `EnsoPermissionPolicyRead` JSON (#474) — `ok` with the whole file as written, or `unreadable` with why (missing, not JSON, not an object: the engine runs such a file as an EMPTY policy); both with its path, the engine's review-log directory and Enso's default policy, and an `ETag` header (the sha256 of the file's bytes) when there is a file",
    errors: '403 untrusted origin; 500 handler failure',
  }),
  'PUT /api/permissions': {
    handler: 'respondToPolicyWrite → writePermissionPolicy',
    input:
      'headers: exactly one precondition — `If-Match: <ETag>` (the version read), `If-Match: *` (whatever is there) or `If-None-Match: *` (no file); body: `EnsoPermissionPolicyWrite` — `{ file }`, the whole file',
    success:
      "200 `EnsoPermissionPolicyRead` JSON with its new `ETag` — the file as written: Enso's `**` put first where a mode needs it (#499), validated against the engine's own schema, written to a temporary file and renamed over, its modification time moved so every running session reloads it at its next call",
    errors:
      '400 malformed body, or both headers, a list, or a weak tag; 403 untrusted origin; 412 the file changed on disk since it was read; 413 body too large; 422 `EnsoPermissionPolicyRefusal` JSON — the engine would not run it, each problem at its place; nothing written; 428 no precondition; 500 handler failure',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
  },
  'POST /api/permissions/reset': {
    handler: 'respondToPolicyReset → resetPermissionPolicy',
    input: 'header: `If-Match: <ETag>` or `If-Match: *`, or `If-None-Match: *` when there is no file; no body',
    success:
      "200 `EnsoPermissionPolicyReset` JSON — Enso's default policy in force, and `backup`, the replaced file's copy at the first free `permissions.json.bak[.N]` (absent when there was no file)",
    errors:
      '400 both headers, a list, or a weak tag; 403 untrusted origin; 412 the file changed on disk since it was read; 428 no precondition; 500 handler failure',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
  },
  'GET /api/projects': literalRead({
    handler: 'respondWithProjects',
    success: '200 `EnsoProject[]` JSON — the launch project first, then the registered ones',
  }),
  'GET /api/projects/browse*': literalRead({
    handler: 'respondWithBrowse → ProjectRegistry.browse',
    input: 'query: optional `path` — a directory inside a declared root; absent, the roots themselves',
    success:
      '200 `EnsoDirectoryListing` JSON — the directories under it that are inside a root and not hidden (symlinks resolved), which already are projects, and whether this one may be added',
    errors:
      '403 untrusted origin; 422 refused, with the reason — not absolute, missing, not a directory, outside every root, or inside a hidden directory',
  }),
  'POST /api/projects': {
    handler: 'respondToProjectRegistration → ProjectRegistry.register',
    input:
      'body: `EnsoProjectRegistration` — an absolute `path` strictly under a root the ENSO_HOME config declares (`projects.roots`), optional `title`',
    success: '201 `EnsoProject` JSON when registered; 200 when the directory already is a project',
    errors:
      '400 malformed body; 403 untrusted origin; 413 body too large; 422 refused, with the reason — not absolute, missing, not a directory, a root itself, outside every root (resolved through symlinks), or inside a hidden directory; 500 handler failure',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
  },
  'GET /api/trees': literalRead({
    handler: 'respondWithTrees → AgentHost.listTrees',
    success:
      "200 `EnsoTreesListing` JSON (#578) — per project this server serves a thread of: each thread tree on disk (the thread whose branch records it, or `null` for a tree directory no thread records), its kind, branch, size (`measured`; `partial` — at least, cut short by the listing's time cap or an unreadable directory; `unreadable` — never `0`) and the work it holds in the delete inventory's words; and the project's snapshot object store's size. Reads only",
    errors: '403 untrusted origin; 500 handler failure',
  }),
  'GET /api/about': literalRead({
    handler: 'createAboutRoute → about',
    success: '200 `EnsoBundleAbout` JSON',
    factory: { path: BUNDLE_PATH, declaration: 'export function createAboutRoute' },
  }),
  'GET /api/logs/bundle*': {
    handler: 'createBundleRoute → bundle',
    input: 'query: optional `thread` id/prefix',
    success: '200 Markdown attachment',
    errors: '400 malformed thread filter; 403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: BUNDLE_PATH, declaration: 'export function createBundleRoute' },
  },
  'GET /api/logs/tail*': {
    handler: 'followLogTail',
    input:
      'query: optional `level`, `thread` id/prefix, `process`, `since` duration, `from` byte offset with the `day` it belongs to',
    success: '200 SSE stream of `EnsoLogTailFrame`; a read the server cannot do ends it with an `error` event',
    errors: '400 unknown level, malformed thread filter, malformed since or from; 403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: LOGS_TAIL_PATH, declaration: 'export function followLogTail' },
  },
  'GET /api/logs/stats': literalRead({
    handler: 'createLogStatsRoute → stats',
    success: '200 `EnsoDayStats` JSON',
    factory: { path: LOGS_STATS_PATH, declaration: 'export function createLogStatsRoute' },
  }),
  'POST /api/logs': {
    handler: 'respondToBrowserLogs → receiveBrowserLogs',
    input: 'body: `EnsoBrowserLogBatch`',
    success: '204 empty',
    errors: '400 malformed batch; 403 untrusted origin; 413 body too large; 500 body-read failure',
    routeClass: 'browser-log-ingest',
    builds: 'no',
    logs: 'no',
    factory: { path: LOGS_PATH, declaration: 'export function receiveBrowserLogs' },
  },
}

interface DetectedRoute {
  readonly key: string
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly line: number
  readonly kind: 'regex' | 'literal'
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function declarationLine(source: string, declaration: string, path: string): number {
  const offset = source.indexOf(declaration)
  if (offset < 0) throw new Error(`routes: ${path} no longer declares ${declaration}`)
  return lineAt(source, offset)
}

/** A discovered route with its metadata and the lines that prove both ends of it. */
export interface ResolvedRoute extends RouteMetadata {
  readonly dispatch: { readonly path: string; readonly line: number }
  readonly factoryLine?: number
}

/**
 * Every route the server dispatches, with its checked metadata — the page's rows, and the
 * control-plane diagram's nodes (#188), from ONE discovery.
 *
 * Exported because a second reader of the same dispatcher would be a second answer to
 * "what routes exist": `flow-diagrams.ts` draws these, it does not re-find them.
 */
export function discoverRoutes(): ResolvedRoute[] {
  const server = readFileSync(join(ROOT, SERVER_PATH), 'utf8')
  const supportingSources: Record<string, string> = {
    [FOLLOW_PATH]: readFileSync(join(ROOT, FOLLOW_PATH), 'utf8'),
    [BUNDLE_PATH]: readFileSync(join(ROOT, BUNDLE_PATH), 'utf8'),
    [LOGS_PATH]: readFileSync(join(ROOT, LOGS_PATH), 'utf8'),
    [LOGS_TAIL_PATH]: readFileSync(join(ROOT, LOGS_TAIL_PATH), 'utf8'),
    [LOGS_STATS_PATH]: readFileSync(join(ROOT, LOGS_STATS_PATH), 'utf8'),
  }

  // A route constant is a regex literal, `threadRoute('<action>')` — the server's builder for
  // `/api/threads/<threadId>/<action>`, whose path is derived here rather than restated — or a
  // pattern built around the library's prompt id (`promptRoute()`, `new RegExp(` — its pattern on the
  // next lines, or the whole call on one), whose metadata states its path.
  const regexRoutes: DetectedRoute[] = [
    ...server.matchAll(
      /^const ([A-Z][A-Z_]*_ROUTE) = (?:\/.*\/|threadRoute\('([a-z/-]+)'\)|promptRoute\(\)|new RegExp\((?:`.*`\))?)$/gm,
    ),
  ].map((match) => {
    const key = match[1] ?? ''
    const metadata = REGEX_ROUTE_METADATA[key]
    const action = match[2]
    const path = metadata?.path ?? (action === undefined ? undefined : `/api/threads/:threadId/${action}`)
    // Only `threadRoute(...)` derives its path; any other route's metadata must state it.
    if (metadata !== undefined && path === undefined) throw new Error(`routes: ${key} has no path in its metadata`)
    return {
      key,
      method: metadata?.method ?? 'GET',
      path: path ?? 'UNCLASSIFIED',
      line: lineAt(server, match.index),
      kind: 'regex',
    }
  })
  for (const route of regexRoutes) {
    const references = [...server.matchAll(new RegExp(`\\b${route.key}\\b`, 'g'))]
    if (references.length < 2) throw new Error(`routes: ${route.key} is declared but not dispatched`)
  }
  assertExactKeys(
    'regex route',
    regexRoutes.map((route) => route.key),
    Object.keys(REGEX_ROUTE_METADATA),
  )

  const literalRoutes: DetectedRoute[] = []
  for (const match of server.matchAll(/request\.method === '(GET|POST|PUT)' && url === '([^']+)'/g)) {
    const method = match[1] as 'GET' | 'POST' | 'PUT'
    const path = match[2] ?? ''
    literalRoutes.push({ key: `${method} ${path}`, method, path, line: lineAt(server, match.index), kind: 'literal' })
  }
  for (const match of server.matchAll(/request\.method === '(GET|POST)' && url\.startsWith\('([^']+)'\)/g)) {
    const method = match[1] as 'GET' | 'POST'
    const path = `${match[2] ?? ''}*`
    literalRoutes.push({ key: `${method} ${path}`, method, path, line: lineAt(server, match.index), kind: 'literal' })
  }
  assertExactKeys(
    'literal route',
    literalRoutes.map((route) => route.key),
    Object.keys(LITERAL_ROUTE_METADATA),
  )

  return [...regexRoutes, ...literalRoutes]
    .map((detected): ResolvedRoute => {
      // `assertExactKeys` above already proved every detected key has metadata; these throws are
      // the type system asking for the same proof, and they name the key if it ever stops holding.
      const metadata = ((): RouteMetadata => {
        if (detected.kind === 'regex') {
          const regex = REGEX_ROUTE_METADATA[detected.key]
          if (regex === undefined) throw new Error(`routes: metadata disappeared for ${detected.key}`)
          return { ...regex, path: detected.path }
        }
        const literal = LITERAL_ROUTE_METADATA[detected.key]
        if (literal === undefined) throw new Error(`routes: metadata disappeared for ${detected.key}`)
        return { method: detected.method, path: detected.path, ...literal }
      })()
      const dispatch = { path: SERVER_PATH, line: detected.line }
      if (metadata.factory === undefined) return { ...metadata, dispatch }
      const source = supportingSources[metadata.factory.path]
      if (source === undefined) throw new Error(`routes: source was not loaded for ${metadata.factory.path}`)
      return {
        ...metadata,
        dispatch,
        factoryLine: declarationLine(source, metadata.factory.declaration, metadata.factory.path),
      }
    })
    .toSorted((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      if (left.method === right.method) return 0
      return left.method < right.method ? -1 : 1
    })
}

function generate(): string {
  const routes = discoverRoutes()
  const regexCount = Object.keys(REGEX_ROUTE_METADATA).length
  const literalCount = Object.keys(LITERAL_ROUTE_METADATA).length

  const sourceLink = (path: string, line: number): string => `[\`${path}:${line}\`](../../${path}#L${line})`
  const rows = routes.map((route) => {
    const sources = [sourceLink(route.dispatch.path, route.dispatch.line)]
    if (route.factory !== undefined && route.factoryLine !== undefined) {
      sources.push(sourceLink(route.factory.path, route.factoryLine))
    }
    return `| ${route.method} | \`${route.path}\` | \`${route.handler}\` | ${route.input} | ${route.success} | ${route.errors} | ${route.routeClass} | ${route.builds} | ${route.logs} | ${sources.join('<br>')} |`
  })

  return [
    '<!-- generated: scripts/docs/routes.ts -->',
    '# HTTP routes',
    '',
    'Generated from the route constants and dispatcher in `packages/web/src/server/index.ts`, with handler contracts from `server/follow.ts`, `server/bundle-route.ts`, and `server/logs-route.ts`.',
    '',
    "Every `/api/threads/:threadId…` route also reads the `X-Enso-Project` header (#395): a page names a new thread's project with it, and an id that is no registered project is a 400 before the route runs.",
    '',
    '> Parser limitation: discovery recognizes top-level `const *_ROUTE = /…/`, `const *_ROUTE = threadRoute(…)`, `const *_ROUTE = promptRoute()` and `const *_ROUTE = new RegExp(…)` declarations — the call open at the end of its line, or whole on one — (only `threadRoute` derives its path; every other form states it in its metadata) plus direct `request.method` branches using `url === …` or `url.startsWith(…)`. Statuses, input shapes, classes, acquisition, and self-logging are intentionally explicit checked metadata rather than inferred behavior.',
    '',
    '| Method | Rendered path | Handler / factory | Input shape | Success | Named error statuses | Class | Builds / acquires? | Logs itself? | Source |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Detected ${regexCount} regex route constants and ${literalCount} literal dispatcher routes; metadata is exhaustive for both sets.`,
    '',
  ].join('\n')
}

// Importable: `flow-diagrams.ts` reuses `discoverRoutes`, and importing must not print a page.
if (import.meta.main) runGenerator('routes', generate)
