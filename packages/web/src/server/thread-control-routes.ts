import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  base64DecodedBytes,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_LOG_EVENTS,
  ENSO_PROMPT_BODY_MAX_BYTES,
  ENSO_PROMPT_MAX_IMAGES,
  ensoLogger,
} from '@enso/core'
import {
  abortThread,
  answerThreadDialog,
  changeThreadMode,
  configureThread,
  continueThread,
  deleteThreadAt,
  type FollowRouteDeps,
  forkThreadAt,
  promptThread,
  readConfigureBody,
  readDialogBody,
  readForkBody,
  readHostCommandBody,
  readIncidentResolutionBody,
  readModeChangeBody,
  readPromptBody,
  readRenameBody,
  readRestoreBody,
  readRestoreUndoBody,
  renameThreadAt,
  resolveThreadIncident,
  restoreThreadAt,
  runHostCommand,
  undoLastRestore,
} from './follow.ts'
import type { SystemPromptPick } from './prompt-library.ts'
import {
  answerJson,
  MAX_DIALOG_BODY_BYTES,
  PROMPT_ETAG,
  readJsonBody,
  refuseWith,
  type ThreadResponder,
  type ThreadRouteHandler,
} from './request-plumbing.ts'
import type { ThreadReadDeps } from './thread-read.ts'

/**
 * The thread controls (#810): a prompt, an abort, a continue, a delete, and the small JSON control
 * routes — a dialog answer, a mode change, a host command, a configuration, an incident's resolution,
 * a fork, a restore and its undo, a name. Each logs its own outcome; each is a row of the thread
 * route table (`thread-routes.ts`).
 */

const log = ensoLogger('server', 'http')

/** What the thread controls take from the server (#810): the follow's reach, the live-or-cold read, the library's pick. */
export interface ThreadControlRoutesState {
  readonly followDeps: FollowRouteDeps
  readonly threadRead: ThreadReadDeps
  /** A prompt reference as the thread's system prompt, or why not (`prompt-routes.ts`). */
  readonly pickSystemPrompt: (threadId: string, ref: string) => SystemPromptPick
}

/** The thread controls' handlers (#810): the two that read no body, and the ones that read the request. */
export type ThreadControlRoutes = Readonly<
  Record<'respondToAbort' | 'respondToContinue', ThreadResponder> &
    Record<
      | 'respondToPrompt'
      | 'respondToDelete'
      | 'respondToDialog'
      | 'respondToModeChange'
      | 'respondToIncidentResolution'
      | 'respondToHostCommand'
      | 'respondToConfigure'
      | 'respondToFork'
      | 'respondToRestore'
      | 'respondToRestoreUndo'
      | 'respondToRename',
      ThreadRouteHandler
    >
>

export function createThreadControlRoutes(state: ThreadControlRoutesState): ThreadControlRoutes {
  const { followDeps, threadRead, pickSystemPrompt } = state

  async function respondToPrompt(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request, response, {
      maxBytes: ENSO_PROMPT_BODY_MAX_BYTES,
      capText: `a prompt body is at most ${ENSO_PROMPT_BODY_MAX_BYTES} bytes (${ENSO_PROMPT_MAX_IMAGES} images of ${ENSO_IMAGE_MAX_BYTES} bytes, base64, plus text)`,
      parse: readPromptBody,
    })
    if (body === undefined) return
    if (body.images !== undefined) {
      // The audit line (#68): what crossed, never the bytes. One record per prompt with images.
      log.info('prompt carries {count} image(s): {mimeTypes}, {bytes} bytes', {
        threadId,
        count: body.images.length,
        mimeTypes: body.images.map((image) => image.mimeType),
        bytes: body.images.reduce((total, image) => total + base64DecodedBytes(image.data), 0),
      })
    }
    const outcome = await promptThread(followDeps, threadId, body)
    if (outcome.status !== 202) {
      log.warn('prompt refused: {reason}', { threadId, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    const { messageId, generation, queued } = outcome.receipt
    // ⚠ TWO DIFFERENT FACTS, TWO NAMES. `admission` is what the SERVER did —
    // `queued` or `opened`, the record #132 asks for — and `requestedAdmission` is what the
    // CLIENT asked for. #216's rename gave the request the word `admission` too, and an object
    // literal's later key wins: the spread silently overwrote the outcome on every queued
    // prompt the browser sends, which is every prompt typed while a run is in flight. The
    // wire field keeps its name; the record's older one keeps its meaning.
    log.info(ENSO_LOG_EVENTS.promptAdmitted, {
      threadId,
      messageId,
      generation,
      admission: queued ? 'queued' : 'opened',
      ...(body.admission === undefined ? {} : { requestedAdmission: body.admission }),
    })
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.receipt))
  }

  /** No body to read: the thread id is the whole request (#116). The answer is the restored queue (#75). */
  function respondToAbort(threadId: string, response: ServerResponse): void {
    const outcome = abortThread(followDeps, threadId)
    if (outcome.status !== 200) {
      log.warn('abort refused ({status}): {reason}', { threadId, status: outcome.status, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    log.info('abort: queue of {restored} restored to the caller', {
      threadId,
      restored: outcome.receipt.restored.length,
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.receipt))
  }

  /** No body: the thread id is the whole request (#436). The run arrives on the follow. */
  async function respondToContinue(threadId: string, response: ServerResponse): Promise<void> {
    const outcome = await continueThread(followDeps, threadId)
    if (outcome.status !== 202) {
      log.warn('continue refused ({status}): {reason}', { threadId, status: outcome.status, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    log.info('continue accepted', { threadId })
    response.writeHead(202)
    response.end()
  }

  /**
   * `DELETE …[?force=1]` (#571): 204 once the thread is gone; 400 an `If-Match` that is no strong
   * sha256 tag; 404 an unknown thread; 409 a run, a move, a restore or another delete holding it;
   * 422 a tree that holds work — the reason names it — deleted by `?force=1` only with `If-Match`
   * the sha256 of those very words: work gained since the page showed its list is
   * named first, never taken unseen. No body.
   */
  async function respondToDelete(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const force = match[2] !== undefined
    const ifMatch = request.headers['if-match']
    if (ifMatch !== undefined && !PROMPT_ETAG.test(ifMatch)) {
      refuseWith(response, {
        status: 400,
        reason: 'If-Match names the work a delete confirms: a strong tag, "<sha256 hex of its words>"',
      })
      return
    }
    const confirmedWork = ifMatch?.slice(1, -1)
    const outcome = await deleteThreadAt(threadRead, threadId, force, confirmedWork)
    if (outcome.status !== 204) {
      log.warn('delete refused ({status}): {reason}', {
        threadId,
        force,
        status: outcome.status,
        reason: outcome.reason,
      })
      refuseWith(response, outcome)
      return
    }
    log.info('thread deleted', { threadId, force })
    response.writeHead(204)
    response.end()
  }

  /** A control route's refusal: the status and the reason it answers with. */
  type ControlRefusal = { readonly status: number; readonly reason: string }
  /** The refusals among a route's outcomes: the ones carrying a reason. */
  const isRefusal = <Outcome extends { readonly status: number }>(
    outcome: Outcome,
  ): outcome is Extract<Outcome, ControlRefusal> => 'reason' in outcome

  /**
   * A control route whose body is a small JSON value (#265): read under the dialog cap, run, and
   * answered — a refusal as its status and reason, logged in the route's own words with the object
   * it refused (`subject`), an acceptance logged and answered as the route says (by default its
   * status, empty). Every route states its messages: the log is searched by them.
   */
  async function answerControl<Body, Outcome extends { readonly status: number }>(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
    route: {
      /** The body as its cap names it: `a dialog answer is at most … bytes`. */
      readonly body: string
      readonly parse: (text: string) => Body
      readonly run: (body: Body) => Outcome | Promise<Outcome>
      /** What the records name: the dialog id, the mode, the command. */
      readonly subject: (body: Body) => Record<string, unknown>
      readonly refused: string
      readonly accepted: (
        outcome: Exclude<Outcome, ControlRefusal>,
        body: Body,
      ) => { readonly message: string; readonly facts?: object }
      readonly answer?: (outcome: Exclude<Outcome, ControlRefusal>) => void
    },
  ): Promise<void> {
    const body = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `${route.body} is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: route.parse,
    })
    if (body === undefined) return
    const outcome = await route.run(body)
    if (isRefusal(outcome)) {
      log.warn(route.refused, { threadId, ...route.subject(body), status: outcome.status, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    // The guard's false branch: TypeScript does not narrow a generic union by exclusion.
    const accepted = outcome as Exclude<Outcome, ControlRefusal>
    const { message, facts = {} } = route.accepted(accepted, body)
    log.info(message, { threadId, ...route.subject(body), ...facts })
    if (route.answer !== undefined) route.answer(accepted)
    else {
      response.writeHead(outcome.status)
      response.end()
    }
  }

  // A dialog answer is an id and a short value; nothing legitimate approaches the cap.
  function respondToDialog(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a dialog answer',
      parse: readDialogBody,
      run: (answer) => answerThreadDialog(followDeps, threadId, answer),
      subject: (answer) => ({ dialogId: answer.id }),
      refused: 'dialog {dialogId} answer refused ({status}): {reason}',
      accepted: () => ({ message: 'dialog {dialogId} answered' }),
    })
  }

  // A mode name; nothing legitimate approaches the dialog cap either.
  function respondToModeChange(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a mode change',
      parse: readModeChangeBody,
      run: (change) => changeThreadMode(followDeps, threadId, change),
      subject: (change) => ({ mode: change.mode }),
      refused: 'mode change to {mode} refused ({status}): {reason}',
      accepted: () => ({ message: 'mode change to {mode} told' }),
    })
  }

  // A classification, an outcome and at most three families; the dialog cap is generous for it.
  function respondToIncidentResolution(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    // The pattern has the capture; a match without it is no match.
    const incidentId = match[2] ?? ''
    return answerControl(threadId, request, response, {
      body: 'an incident resolution',
      parse: readIncidentResolutionBody,
      run: (resolution) => resolveThreadIncident(followDeps, threadId, incidentId, resolution),
      subject: (resolution) => ({ incidentId, classification: resolution.classification, outcome: resolution.outcome }),
      refused: 'incident {incidentId} resolution refused ({status}): {reason}',
      accepted: () => ({ message: 'incident {incidentId} resolution recorded: {classification}, {outcome}' }),
    })
  }

  // A command name and one option id; the dialog cap is generous for it. A setting answers 204, a
  // flow or action 202 — started, its questions arrive on the follow.
  function respondToHostCommand(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a host command',
      parse: readHostCommandBody,
      run: (run) => runHostCommand(followDeps, threadId, run),
      subject: (run) => ({ name: run.name }),
      refused: 'host command {name} refused ({status}): {reason}',
      accepted: (outcome, run) => ({
        message: outcome.status === 202 ? 'host flow {name} started' : 'host command {name} applied',
        facts: run.value === undefined ? {} : { value: run.value },
      }),
    })
  }

  /**
   * `POST …/configure` (#391): a new session's model, effort and mode, applied together — the
   * Start-a-session dialog's Start. A refused step answers 422 with its JSON refusal (the step and
   * the reason), so the dialog can say which; a run in flight is the usual 409 text.
   */
  async function respondToConfigure(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const configuration = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a session configuration is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: readConfigureBody,
    })
    if (configuration === undefined) return
    const outcome = await configureThread(followDeps, threadId, configuration, (ref) => pickSystemPrompt(threadId, ref))
    if (outcome.status === 409) {
      log.warn('configure refused (409): {reason}', { threadId, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    if (outcome.status === 422) {
      log.warn('configure refused at {step}: {reason}', { threadId, ...outcome.refusal })
      response.writeHead(422, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(outcome.refusal))
      return
    }
    log.info('session configured', { threadId, ...configuration })
    response.writeHead(204)
    response.end()
  }

  /**
   * `POST …/fork` (#433): the new thread's id and the text to prefill its composer with. An unknown
   * thread or entry is a 404, a non-user entry a 400, a thread a run holds the usual 409 — each with
   * its reason as text, as the other control routes answer.
   */
  function respondToFork(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a fork request',
      parse: readForkBody,
      run: (fork) => forkThreadAt(threadRead, threadId, fork),
      subject: (fork) => fork,
      refused: 'fork at {entryId} refused ({status}): {reason}',
      accepted: (outcome) => ({
        message: 'forked at {entryId} as {forkThreadId}',
        facts: { forkThreadId: outcome.receipt.threadId },
      }),
      answer: (outcome) => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(outcome.receipt))
      },
    })
  }

  /**
   * `POST …/restore` (#551): the restored snapshot's hash and the safety snapshot of the files it
   * replaced. An unknown thread or entry is a 404; no tree, no snapshot, a refused restore or a
   * thread a run holds a 409 — each with its reason as text.
   */
  function respondToRestore(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a restore request',
      parse: readRestoreBody,
      run: (restore) => restoreThreadAt(threadRead, threadId, restore),
      subject: (restore) => restore,
      refused: 'restore at {entryId} refused ({status}): {reason}',
      accepted: (outcome) => ({
        message: 'restored files at {entryId} to {hash} (safety {safety})',
        facts: { hash: outcome.receipt.hash, safety: outcome.receipt.safety },
      }),
      answer: (outcome) => answerJson(response, outcome.receipt),
    })
  }

  /**
   * `POST …/restore/undo` (#565): the thread's tree back to its last restore's safety snapshot —
   * body `{ safety }`, the one the restore promised. 200 with the snapshot put back and the new
   * safety; 400 a bad body; 404 an unknown thread; 409 no tree, no restore to undo, a later restore
   * since (the safety is not the newest restore's), a refused restore, or a run holding the thread.
   */
  function respondToRestoreUndo(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'an undo request',
      parse: readRestoreUndoBody,
      run: (undo) => undoLastRestore(threadRead, threadId, undo),
      subject: (undo) => undo,
      refused: 'undo of the restore that kept {safety} refused ({status}): {reason}',
      accepted: (outcome) => ({
        message: 'restore undone: files back to {safety} (safety {kept})',
        facts: { kept: outcome.receipt.safety },
      }),
      answer: (outcome) => answerJson(response, outcome.receipt),
    })
  }

  /**
   * `POST …/name` (#670): name the thread — body `{ name }`, not blank, at most 120 characters,
   * trimmed. 204 once pi's `session_info` holds it; 400 a bad body; 404 an unknown thread; 409 a
   * thread a run holds. The listing and the history carry it from then on.
   */
  function respondToRename(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a rename request',
      parse: readRenameBody,
      run: (rename) => renameThreadAt(threadRead, threadId, rename),
      subject: (rename) => rename,
      refused: 'rename to {name} refused ({status}): {reason}',
      accepted: () => ({ message: 'thread named {name}' }),
    })
  }

  return {
    respondToPrompt,
    respondToAbort,
    respondToContinue,
    respondToDelete,
    respondToDialog,
    respondToModeChange,
    respondToIncidentResolution,
    respondToHostCommand,
    respondToConfigure,
    respondToFork,
    respondToRestore,
    respondToRestoreUndo,
    respondToRename,
  }
}
