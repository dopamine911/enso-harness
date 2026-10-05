import type { ServerResponse } from 'node:http'
import {
  base64DecodedBytes,
  type DialogAnswer,
  ENSO_IMAGE_MAX_BYTES,
  type EnsoAbortReceipt,
  type EnsoConfigurationRefusal,
  type EnsoFollowFrame,
  type EnsoForkReceipt,
  EnsoForkRequest,
  EnsoRestoreRequest,
  EnsoRestoreUndoRequest,
  EnsoHostCommandRun,
  EnsoIncidentResolution,
  EnsoPermissionModeChange,
  type EnsoPromptAdmission,
  EnsoPromptBody,
  type EnsoPromptReceipt,
  EnsoQuestionAnswers,
  EnsoSessionConfiguration,
  ensoLogger,
  isWholeBase64,
  type PromptImageContent,
  type ThreadRuntime,
  validateDialogAnswer,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { Check, Errors } from 'typebox/value'
import { HostCommandRefused, modelOptionId } from '../host/host-commands.ts'
import type { SystemPromptPick } from './prompt-library.ts'
import { forgetRun, noteRunAdmitted } from './run-timing.ts'
import { SSE_HEADERS, startSseKeepalive } from './sse.ts'
import { readThreadMount, type ThreadReadDeps } from './thread-read.ts'
import type { ThreadFeedFrame, ThreadLease, ThreadRegistry, ThreadView } from './thread-registry.ts'

/**
 * The prompt/follow split (#112) — the server↔browser wire.
 *
 * Six routes, none of which is a run:
 *
 *   POST /api/threads/:id/prompt   unary. Takes the thread, fires the prompt, answers at
 *                                  once with a message id. The thread's own `settled`
 *                                  releases it — not an HTTP response ending.
 *   POST /api/threads/:id/continue unary (#436). Takes the thread like a prompt and continues
 *                                  its torn tail from the stored state — no new user message.
 *                                  202 accepted (the run arrives on the follow, its `settled`
 *                                  releases the thread), 404 for a thread neither live nor
 *                                  stored, 409 while a run holds it, 422 with the runtime's
 *                                  reason for a tail there is nothing to continue from.
 *   GET  /api/threads/:id/follow   one snapshot frame, then observations and status
 *                                  frames for as long as the client stays. Observation
 *                                  only: never builds a session; a thread that is not live
 *                                  is served cold from its file and followed from build.
 *   POST /api/threads/:id/dialog   unary. A human's answer to a blocking dialog, checked
 *                                  against the question and delivered to the live session.
 *                                  Nothing parks: the extension's promise is still pending
 *                                  inside pi, the run keeps going on the follow.
 *   POST /api/threads/:id/mode     unary (L3 step C, #162 workstream 4). Switch the thread's
 *                                  permission mode as a control route, not a prompt: 204 once the
 *                                  runtime was told, 409 while a run is in flight (a mode change is
 *                                  never queued behind one), 422 for a mode this thread does not
 *                                  offer. The second route that ACQUIRES, and it releases on
 *                                  acceptance — an extension command's acceptance IS its
 *                                  completion. The change arrives on the follow as
 *                                  `permission-mode`; a rejection after the 204, as
 *                                  `permission-mode-rejected`.
 *   POST /api/threads/:id/abort    unary (#116). Stop the run in flight: pi is told, and the
 *                                  prompts waiting behind the run come back in the answer
 *                                  (#75, clear-and-restore — pi's queue is cleared, every
 *                                  follower sees `queue` empty). The
 *                                  run ENDS ON THE FOLLOW like any other — `agent_settled`
 *                                  is emitted from pi's own `finally` — so every follower
 *                                  sees the same `settled` + `status`, and the thread is
 *                                  released by the prompt route's observer, not by this
 *                                  route. 200 with the restored queue; 409 nothing in flight; 404 not live.
 *
 * The wire shapes — `EnsoFollowFrame`, `EnsoPromptReceipt` — are TypeBox in `@enso/core`
 * (`follow.ts` there), like every other crossing; the payload is `EnsoObservation`, and AG-UI
 * is not on this wire (`docs/architecture.md`, decided constraints). The receipt of what the
 * split retires is on #109; the decision and its sequence are #112.
 */

const log = ensoLogger('server', 'follow')

export interface FollowRouteDeps extends ThreadReadDeps {
  readonly sseKeepaliveMs: number
}

export interface PromptBody {
  readonly message: string
  readonly admission?: EnsoPromptAdmission
  /** Attached images (#68), already in pi's shape; absent — not empty — when the prompt has none. */
  readonly images?: readonly PromptImageContent[]
}

/** A route's refusal: the status it answers with, and the reason that is the body. */
type Refusal<Status extends number> = { readonly status: Status; readonly reason: string }

export type PromptOutcome =
  | { readonly status: 202; readonly receipt: EnsoPromptReceipt }
  | Refusal<400>
  /** The thread was taken and released again while this prompt waited on its build (#444) — rare. */
  | Refusal<409>

/**
 * Leading token of a slash input, without the slash. `/mode auto` -> `mode`.
 *
 * Leading whitespace is not part of the question: `" /login"` is `/login` (#337 review) — the
 * body's emptiness check already trims, and a slash command that hid behind a space would walk
 * past the refusal and reach the model as text, the exact no-op the refusal exists to prevent.
 */
function slashCommandName(prompt: string): string | undefined {
  const trimmed = prompt.trimStart()
  if (!trimmed.startsWith('/')) return undefined
  const name = trimmed.slice(1).trimEnd().split(/\s/)[0]
  return name === undefined || name.length === 0 ? undefined : name
}

/**
 * Why a slash command cannot run here, or `undefined` when it can. Takes the command already
 * parsed, so the one parse serves both this and the idle path's "acceptance is completion".
 *
 * ⚠ ASKED ON BOTH ADMISSION PATHS. The runtime treats a slash command it does not know as
 * ORDINARY TEXT for the model, so the refusal is what stands between `/login` and a chat
 * message that says "/login". It was asked only of an idle thread: a command sent while a run
 * held the thread was queued straight into the runtime, and vanished — pi's TUI built-ins
 * (`/login`, `/model`, `/compact`, …) are not extension commands and have no handler here.
 *
 * A `host` row (#338 slice 2) is in the list and is NOT a prompt: `/model` typed into the
 * composer would walk past a name check and reach the model as text, exactly the no-op above.
 * It runs through `POST …/command`, which the palette does; the refusal says so.
 */
function unavailableCommand(runtime: ThreadRuntime, command: string): string | undefined {
  const available = runtime.listCommands()
  const known = available.find((candidate) => candidate.name === command)
  if (known === undefined) {
    const runnable = available.filter((candidate) => candidate.source !== 'host')
    return `/${command} is not available on this surface. Available here: ${
      runnable.length === 0 ? 'none' : runnable.map((candidate) => `/${candidate.name}`).join(', ')
    }`
  }
  if (known.source === 'host') return `/${command} is a setting here, not a prompt: choose it from the palette`
  return undefined
}

/**
 * Write one frame, recording it into the thread's sent tail (#97) when the thread is live
 * — the one place every frame crosses to a browser, so the record and the wire agree.
 *
 * ⚠ One frame does not cross at all (#279): a `tool-result` observation that is not
 * complete. pi's tools report progress with the ACCUMULATED output, not a delta (see
 * `docs/seams/tool-result.md`), and `bash` does it every 100 ms, so writing them costs
 * O(output × ticks) — measured, a 3-second command producing 240 KB of output wrote
 * 3724 KB of partial frames. The only browser consumer of the kind,
 * `observationToAguiEvents` (`to-agui.ts`, its `tool-result` case), returns `[]` for
 * `complete: false`: all 3724 KB were serialised, pushed through the SSE socket and
 * schema-checked for no rendered pixel. The OBSERVATION is untouched — the feed still
 * numbers it, `recordObservation` still logs it and the emitted tail still counts it, so
 * the partial text is still in the `trace` record and in `/api/threads/:id/events`; this
 * elides the WIRE. Frame `seq` therefore skips the elided numbers, which nothing on the
 * browser side reads, and the sent tail does not record them either: it claims only what
 * crossed.
 */
function writeFrame(threads: ThreadRegistry, threadId: string, response: ServerResponse, frame: EnsoFollowFrame): void {
  if (frame.type === 'observation' && frame.observation.kind === 'tool-result' && !frame.observation.complete) return
  const name = frame.type === 'observation' ? frame.observation.kind : undefined
  threads.sentTail(threadId)?.record(frame.type, name, 'sent')
  response.write(`data: ${JSON.stringify(frame)}\n\n`)
}

/**
 * Serve one follow.
 *
 * @flow follow-snapshot-frames The follow: snapshot, then frames; held, replayed, live
 * A browser's view of a thread is one `GET /api/threads/:id/follow`: a snapshot exact as of a
 * sequence number, then every later observation with a greater one, and status frames as the
 * thread's busy flag and generation move. There is no cursor to resume from, because the snapshot
 * IS the resync: a reconnect is a new follow and a new snapshot (#112, #114). Beneath the wire,
 * the host holds events that happen before anyone subscribes and replays them to the first
 * subscriber, and its tail records how each was delivered (`held`, `replayed`, `live`,
 * `dropped`): the ordering evidence #88 and #69 were reconstructed without (#97).
 * @contract packages/core/src/follow.ts#EnsoFollowSnapshot
 * @see docs/seams/observation.md the wire, as a seam
 * @see docs/architecture.md decided constraints: AG-UI is derived in the browser, never on the wire
 *
 * @invariant follow-snapshot-frames/snapshot-exact The snapshot is exact as of `asOfSeq`, and no observation falls between the two.
 * The snapshot is read through the one live-or-cold reader (`thread-read.ts#readThreadMount`,
 * #214), the same read `/history` serves, so the two routes cannot disagree about a thread that
 * goes live mid-read; and it is taken in the same tick as the subscription, so every later
 * frame's `seq` is greater (dsh: one complete snapshot per generation, then only deltas;
 * reconnect = a new follow = a new snapshot). Two followers of one thread share one feed and see
 * every frame with the same `seq`; one leaving detaches nothing.
 *
 * @invariant follow-snapshot-frames/cold-empty A cold thread is an empty snapshot, not a 404.
 * A thread with neither a session nor a file is an EMPTY snapshot (`present` is ignored here):
 * observation may precede the first prompt, and must, or the prompt's opening events have no
 * follower. The cold read is awaited BEFORE subscribing, so a thread built during the read is
 * then seen live.
 *
 * @invariant resume/cold-then-live Cold, then live, on one follow; nothing is resumed by cursor.
 * A resumed pane's follow opens before any run and reads `live: false` (the file's messages, the
 * file's usage with no context, `openDialogs: []`); the first prompt acquires, `createSession`
 * opens the file, and the same follow carries `status live: true`, then `busy: true, generation: 1`.
 */
export async function followThread(deps: FollowRouteDeps, threadId: string, response: ServerResponse): Promise<void> {
  const { threads } = deps
  const mount = await readThreadMount(deps, threadId)

  response.writeHead(200, SSE_HEADERS)
  const stopKeepalive = startSseKeepalive(response, deps.sseKeepaliveMs)
  const follow = threads.observe(threadId, (frame: ThreadFeedFrame) => {
    if (response.destroyed || response.writableEnded) return
    writeFrame(
      threads,
      threadId,
      response,
      frame.kind === 'observation'
        ? { type: 'observation', seq: frame.seq, observation: frame.observation }
        : { type: 'status', live: frame.live, busy: frame.busy, generation: frame.generation },
    )
  })
  response.once('close', () => {
    stopKeepalive()
    follow.unsubscribe()
  })
  // ⚠ A client that left DURING the read above had already fired `close`, before the listener
  // existed: the subscription would stay in the feed for the life of the process (#160 §6).
  if (response.destroyed || response.writableEnded) {
    stopKeepalive()
    follow.unsubscribe()
    return
  }
  // What this follower was told the thread is, and as of which seq (#482's flow traces: the
  // frame itself crosses a socket, so the record is what a trace can show in order).
  log.debug('snapshot as of seq {asOfSeq}: live {live}, busy {busy}, run {generation}, {openDialogs} open questions', {
    threadId,
    asOfSeq: follow.asOfSeq,
    live: mount.live,
    busy: mount.busy,
    generation: mount.generation,
    openDialogs: mount.openDialogs.length,
  })

  writeFrame(threads, threadId, response, {
    type: 'snapshot',
    threadId,
    asOfSeq: follow.asOfSeq,
    live: mount.live,
    busy: mount.busy,
    generation: mount.generation,
    permissionMode: mount.permissionMode,
    sessionRisk: mount.sessionRisk,
    incidents: mount.incidents,
    model: mount.model,
    ...(mount.recordedModel === undefined ? {} : { recordedModel: mount.recordedModel }),
    cwd: mount.cwd,
    tree: mount.tree,
    usage: mount.usage,
    messages: mount.messages,
    openDialogs: mount.openDialogs,
    ...(mount.interrupted === undefined ? {} : { interrupted: mount.interrupted }),
    ...(mount.login === undefined ? {} : { login: mount.login }),
  })
}

const MEGABYTE = 1024 * 1024
const megabytes = (bytes: number): string => `${(bytes / MEGABYTE).toFixed(1)} MB`

/**
 * The prompt body, shape-checked against `EnsoPromptBody` (#112: closed schemas on the wire).
 *
 * Throws `Error`s whose message is the 400 text — the first thing wrong, by path, so a refused
 * image says which one and why rather than "did not match" (#68: never silently dropped). The
 * byte cap is on the DECODED size: what the provider counts.
 */
export function readPromptBody(raw: string): PromptBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed prompt body: ${String(error)}`, { cause: error })
  }
  if (!Check(EnsoPromptBody, parsed)) {
    const first = Errors(EnsoPromptBody, parsed)[0]
    const where =
      first === undefined ? '' : ` at ${first.instancePath === '' ? '/' : first.instancePath}: ${first.message}`
    throw new Error(`prompt body must match EnsoPromptBody${where}`)
  }
  // Whitespace-only is refused here rather than taking a lease to hand pi nothing.
  if (parsed.message.trim().length === 0 && parsed.images === undefined) {
    throw new Error('prompt body needs a message')
  }
  const images = parsed.images?.map((image, position): PromptImageContent => {
    if (!isWholeBase64(image.data)) {
      throw new Error(`prompt body must match EnsoPromptBody at /images/${position}/data: must be whole base64 groups`)
    }
    const bytes = base64DecodedBytes(image.data)
    if (bytes > ENSO_IMAGE_MAX_BYTES) {
      throw new Error(
        `image ${position + 1} of ${parsed.images?.length ?? 0} is ${megabytes(bytes)}; an image is at most ${megabytes(ENSO_IMAGE_MAX_BYTES)}`,
      )
    }
    return { type: 'image', data: image.data, mimeType: image.mimeType }
  })
  return {
    message: parsed.message,
    ...(parsed.admission === undefined ? {} : { admission: parsed.admission }),
    ...(images === undefined ? {} : { images }),
  }
}

/**
 * Fire a prompt and answer at admission.
 *
 * @flow prompt-run-settle Prompt → run → settle: admitted on the POST, ended on the follow
 * A prompt from the browser is one `POST /api/threads/:id/prompt`, and the route's whole job is
 * admission: check the body, take the thread or queue behind the run that holds it, answer 202
 * with a receipt. Nothing of the run is an HTTP response (#112). The run lives on the follow
 * (observations, `settled`, then a released `status`), and the thread's own `settled`, read off
 * the feed by the route, gives the lease back. Busy is queued, not refused (#75), and a late
 * refusal is an observation.
 * @contract packages/core/src/follow.ts#EnsoPromptReceipt
 * @see docs/reference/routes.md the route table
 * @see docs/seams/thread-runtime.md acceptance versus completion, the runtime's contract
 * @see docs/glossary.md the words: Thread and Control
 *
 * @invariant prompt-run-settle/admission Admission is the answer; the run is not an HTTP response.
 * An IDLE thread is taken, `runtime.prompt` is fired and the 202 goes out at once. The prompt's
 * own `settled` (or, for a slash command, its acceptance: an extension command never settles)
 * releases the thread through the feed, read the way any follower reads it. The receipt's ids
 * are the admission record's ids.
 *
 * @invariant prompt-run-settle/busy-queued Busy is queued, not refused and not re-acquired.
 * A BUSY thread (a run in flight, or a dialog the follow is showing) is read with `peek`: the
 * message goes to the runtime with an admission (`enqueue` unless the caller asked to `steer`),
 * which is #75's decision, and the receipt names the run in flight with `queued: true`. That run
 * keeps its lease; its `settled` releases the thread once everything queued has run.
 *
 * @invariant prompt-run-settle/refusals Refusals fall before the lease where they can; after the receipt they are observations.
 * A whitespace-only body is a 400 from `readPromptBody` before any lease or session exists. The
 * ONE refusal both paths share is a slash command this surface cannot run (`unavailableCommand`,
 * #337): a 400 before anything is queued, busy or idle alike, and on the idle path the lease it
 * took is given back. Once the 202 is out the feed is the only channel: a rejection is announced
 * as `prompt-rejected` with the receipt's message id, in sequence with the runtime's observations.
 */
export async function promptThread(deps: FollowRouteDeps, threadId: string, body: PromptBody): Promise<PromptOutcome> {
  const { threads } = deps
  const messageId = crypto.randomUUID()
  /** pi refused the prompt after the receipt went out: the feed is the client's only way to hear it. */
  const rejected = (reason: string): void => {
    log.warn('prompt {messageId} rejected: {reason}', { threadId, messageId, reason })
    threads.announce(threadId, { kind: 'prompt-rejected', messageId, reason })
  }

  const command = slashCommandName(body.message)
  /** The busy path: the prompt joins the run that holds the thread, with its admission (#75). */
  const joinRun = (live: ThreadView): PromptOutcome => {
    const unavailable = command === undefined ? undefined : unavailableCommand(live.hosted.runtime, command)
    if (unavailable !== undefined) return { status: 400, reason: unavailable }
    live.hosted.runtime.prompt(
      {
        message: body.message,
        admission: body.admission ?? 'enqueue',
        ...(body.images === undefined ? {} : { images: body.images }),
      },
      { onAccepted: () => undefined, onRejected: rejected },
    )
    return { status: 202, receipt: { threadId, messageId, generation: live.generation, queued: true } }
  }
  const live = threads.peek(threadId)
  if (live?.busy === true) return joinRun(live)

  const lease = await threads.acquire(threadId)
  if (lease === 'busy') {
    // Another request took the thread while this one waited on the build or an abort (#444): join
    // its run as a prompt that found it busy would. Released again in between — the other request
    // was refused — there is nothing to join, and the prompt is not run without a lease: 409.
    const holder = threads.peek(threadId)
    if (holder?.busy === true) return joinRun(holder)
    // Not "is running" (PR #438 review): the client shows this verbatim, and the thread is idle now.
    return {
      status: 409,
      reason: `thread ${threadId} was taken and released again while this prompt waited on its build; send it again`,
    }
  }
  const unavailable = command === undefined ? undefined : unavailableCommand(lease.runtime, command)
  if (unavailable !== undefined) {
    lease.release()
    return { status: 400, reason: unavailable }
  }

  // The clock the first-delta record measures from (#144), started BEFORE pi is told: a rejection
  // or a command's completion can arrive inside `prompt`, and must find the entry to forget. A
  // queued prompt (the busy path above) joins the run in flight and does not restart it.
  noteRunAdmitted(threadId, lease.generation)

  // The run's end, observed the way a follower would: the thread's own `settled`.
  const settle = threads.observe(threadId, (frame: ThreadFeedFrame) => {
    if (frame.kind !== 'observation' || frame.observation.kind !== 'settled') return
    settle.unsubscribe()
    lease.release()
  })
  lease.runtime.prompt(
    {
      message: body.message,
      ...(body.admission === undefined ? {} : { admission: body.admission }),
      ...(body.images === undefined ? {} : { images: body.images }),
    },
    {
      onAccepted: () => {
        // An extension command's acceptance IS its completion (pi reports it after the
        // command ran); an ordinary prompt's acceptance is only admission.
        if (command === undefined) return
        forgetRun(threadId, lease.generation)
        settle.unsubscribe()
        lease.release()
      },
      // Neither ending publishes `settled`, the one the timing otherwise forgets on (#160 §8).
      onRejected: (reason: string) => {
        rejected(reason)
        forgetRun(threadId, lease.generation)
        settle.unsubscribe()
        lease.release()
      },
    },
  )
  return { status: 202, receipt: { threadId, messageId, generation: lease.generation, queued: false } }
}

export type ContinueOutcome = { readonly status: 202 } | Refusal<404 | 409 | 422>

/**
 * Continue a torn thread from its stored state (#436): no prompt, no new user message — the run the
 * cut-off one never finished. Taken like a prompt's idle path: refused while a run holds the thread
 * (409 — there is nothing torn about a thread that is running), else acquired (a resumed thread
 * BUILDS here, which is the case this exists for) and handed to the runtime. The runtime's refusal —
 * a tail that is no unanswered prompt, unfinished tool call or tool results with no reply, or a pi
 * build without the run lifecycle — is the 422, verbatim, and releases the lease. Accepted, it
 * answers 202 and the run arrives on the follow like any other; the thread's own `settled` releases
 * it, as it releases a prompt's.
 *
 * A thread neither live here nor stored is a 404 BEFORE anything is built (PR #442 review): there is
 * nothing to continue by definition, and `acquire` would build a fresh session under the id and hold
 * it for the idle window only to refuse it — unlike `/command` and `/configure`, which build on purpose.
 */
export async function continueThread(deps: FollowRouteDeps, threadId: string): Promise<ContinueOutcome> {
  const { threads, host } = deps
  const running = runningRefusal(threads, threadId, 'continue')
  if (running !== undefined) return running
  if (threads.peek(threadId) === undefined && (await host.storedThreadDirectory(threadId)) === undefined) {
    return { status: 404, reason: `no thread ${threadId} to continue` }
  }
  // The one check that cannot race (#444): a second Continue — another tab, or a prompt that won
  // the thread while this one waited on the build — is refused here, before it holds a lease.
  const lease = await threads.acquire(threadId)
  if (lease === 'busy') return busyRefusal(threadId, 'continue')
  noteRunAdmitted(threadId, lease.generation)
  const settle = threads.observe(threadId, (frame: ThreadFeedFrame) => {
    if (frame.kind !== 'observation' || frame.observation.kind !== 'settled') return
    settle.unsubscribe()
    lease.release()
  })
  /** A refusal, or a fault before either signal: nothing runs, so nothing will settle. */
  const giveBack = (): void => {
    forgetRun(threadId, lease.generation)
    settle.unsubscribe()
    lease.release()
  }
  return new Promise<ContinueOutcome>((resolve, reject) => {
    // Unlike `promptThread`'s call to pi's public `prompt`, `continueRun` reads pi's private run
    // state (#436), so a fault before either callback is plausible after a pi bump: the lease goes
    // back and the route answers 500, rather than leaving the thread held (PR #442 review).
    try {
      lease.runtime.continueRun({
        onAccepted: () => resolve({ status: 202 }),
        onRejected: (reason: string) => {
          giveBack()
          resolve({ status: 422, reason })
        },
      })
    } catch (error) {
      giveBack()
      reject(error)
    }
  })
}

/** The dialog body: pi's response shape, keyed by the request id the follow showed. */
export function readDialogBody(raw: string): DialogAnswer {
  let body: { id?: unknown; cancelled?: unknown; value?: unknown; confirmed?: unknown; answers?: unknown }
  try {
    body = JSON.parse(raw) as typeof body
  } catch (error) {
    throw new Error(`malformed dialog body: ${String(error)}`, { cause: error })
  }
  if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('dialog body needs the request id')
  if (body.cancelled === true) return { id: body.id, cancelled: true }
  if (typeof body.value === 'string') return { id: body.id, value: body.value }
  if (typeof body.confirmed === 'boolean') return { id: body.id, confirmed: body.confirmed }
  // A questionnaire's answers (#12): the shape is checked here, where the body is read; whether
  // they answer THIS question is `validateDialogAnswer`'s, against the open dialog.
  if (body.answers !== undefined) {
    if (!Check(EnsoQuestionAnswers, body.answers)) {
      throw new Error('dialog body answers must be [{ selected: string[], other?: string }]')
    }
    return { id: body.id, answers: body.answers }
  }
  throw new Error('dialog body needs cancelled, value, confirmed, or answers')
}

export type DialogOutcome = { readonly status: 204 } | Refusal<404 | 422>

/**
 * Deliver the answer to the LIVE session's OPEN question.
 *
 * @invariant dialog-ask-answer-settled/answer-checked An answer is checked against the question it names before the runtime sees it.
 * This peeks, never builds, then finds the id in the runtime's `openDialogs()`: a cold thread or
 * a spent question is 404. A non-cancel answer `validateDialogAnswer` refuses is 422 and the
 * question stays open: pi hands a select's value to the extension VERBATIM, so an unoffered value
 * is an injection seam the server closes (#112), the same check the run path's resume made. Only
 * a real `cancelled: true` skips the check (#225). Only then is `answerDialog` called, and 204
 * returned; the response says nothing else.
 */
export function answerThreadDialog(deps: FollowRouteDeps, threadId: string, answer: DialogAnswer): DialogOutcome {
  const live = deps.threads.peek(threadId)
  if (live === undefined) return { status: 404, reason: `no live session for thread ${threadId}` }
  const question = live.hosted.runtime.openDialogs().find((open) => open.id === answer.id)?.dialog
  if (question === undefined) {
    return {
      status: 404,
      reason: `no open question ${answer.id} on thread ${threadId} — answered, expired, or never asked`,
    }
  }
  if (answer.cancelled !== true) {
    const refusal = validateDialogAnswer(question, answer)
    if (refusal !== undefined) return { status: 422, reason: `answer refused: ${refusal}` }
  }
  live.hosted.runtime.answerDialog(answer)
  return { status: 204 }
}

export type ModeChangeOutcome = { readonly status: 204 } | Refusal<409 | 422>

/**
 * Switch a thread's permission mode (L3 step C, #162 workstream 4): a control route, not a
 * prompt.
 *
 * The thread is acquired like a prompt would acquire it — a fresh page changes mode before its
 * first prompt — and refused while busy (409): a mode change is not queued behind a run (#75's
 * rule), and the composer's select is disabled then for the same reason. The mode must be one
 * the thread offers now (422). The change itself arrives on the follow as `permission-mode`,
 * said by the host when its extension has persisted it; an extension command's acceptance is
 * its completion, so the lease is released on acceptance as `promptThread` releases a slash
 * command's. A rejection after the 204 is announced on the feed as `permission-mode-rejected`,
 * as `promptThread` announces its own.
 */
export async function changeThreadMode(
  deps: FollowRouteDeps,
  threadId: string,
  change: EnsoPermissionModeChange,
): Promise<ModeChangeOutcome> {
  const { threads } = deps
  const lease = await controlLease(threads, threadId, 'change the mode')
  if ('reason' in lease) return lease
  const { available } = lease.runtime.permissionModeState()
  if (!available.includes(change.mode)) {
    lease.release()
    return {
      status: 422,
      reason: `mode ${change.mode} is not offered here. Available: ${available.length === 0 ? 'none' : available.join(', ')}`,
    }
  }
  lease.runtime.setPermissionMode(change.mode, {
    onAccepted: () => lease.release(),
    onRejected: (reason: string) => {
      // The 204 has gone out; the feed is the one way to say the click did nothing.
      log.warn('mode change to {mode} rejected: {reason}', { threadId, mode: change.mode, reason })
      threads.announce(threadId, { kind: 'permission-mode-rejected', mode: change.mode, reason })
      lease.release()
    },
  })
  return { status: 204 }
}

/** The mode-change body, checked against its schema — a control route takes exactly its shape. */
export function readModeChangeBody(raw: string): EnsoPermissionModeChange {
  return readClosedBody(raw, EnsoPermissionModeChange, 'mode', 'mode body needs a non-empty `mode`')
}

type IncidentResolveOutcome = { readonly status: 204 } | Refusal<404 | 409 | 422>

/**
 * Record a human's resolution of a thread's incident (#466) — the only way a suspension is lifted.
 *
 * A thread neither live nor stored is a 404 before anything is built, as `continueThread`'s is:
 * there is no incident to resolve. Otherwise it is a control route: refused while a run holds the
 * thread (409 — a resolution is not queued behind a run, and lifting a suspension mid-run would
 * change what the run in flight may do between two of its calls), else acquired — a cold thread
 * BUILDS here, so the record goes through pi and the guard that loads with it replays it — and
 * released once the runtime answered. The runtime checks it against the live branch with
 * `incidentResolutionRefusal`: its reason is the 422, verbatim. Recorded, 204; the record arrives
 * on the follow as its custom entry.
 */
export async function resolveThreadIncident(
  deps: FollowRouteDeps,
  threadId: string,
  incidentId: string,
  resolution: EnsoIncidentResolution,
): Promise<IncidentResolveOutcome> {
  const { threads, host } = deps
  const action = `resolve incident ${incidentId}`
  const running = runningRefusal(threads, threadId, action)
  if (running !== undefined) return running
  if (threads.peek(threadId) === undefined && (await host.storedThreadDirectory(threadId)) === undefined) {
    return { status: 404, reason: `no thread ${threadId} to resolve an incident on` }
  }
  const lease = await controlLease(threads, threadId, action)
  if ('reason' in lease) return lease
  try {
    const refusal = lease.runtime.resolveIncident(incidentId, resolution)
    return refusal === undefined ? { status: 204 } : { status: 422, reason: refusal }
  } finally {
    lease.release()
  }
}

/** The resolution body, checked against its schema (#466) — a control route takes exactly its shape. */
export function readIncidentResolutionBody(raw: string): EnsoIncidentResolution {
  return readClosedBody(
    raw,
    EnsoIncidentResolution,
    'incident resolution',
    'incident resolution body needs a `classification` and an `outcome`, and `restricted` families only for resume-with-restrictions',
  )
}

/**
 * A control route's body: JSON, and exactly its closed schema — the shared half of every control
 * reader (`mode`, `command`, `configure`, a project registration). `name` says which body was
 * malformed; `requirement` what a well-formed one holds.
 */
export function readClosedBody<Schema extends TSchema>(
  raw: string,
  schema: Schema,
  name: string,
  requirement: string,
): Static<Schema> {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed ${name} body: ${String(error)}`, { cause: error })
  }
  if (!Check(schema, body)) throw new Error(requirement)
  return body
}

/** The 409 every control route answers while a run holds the thread (#75: never queued behind a run). */
function busyRefusal(threadId: string, action: string): Refusal<409> {
  return { status: 409, reason: `thread ${threadId} is running; ${action} when it settles` }
}

/** {@link busyRefusal} when a peek already sees the thread held, or `undefined` — the fast answer before any wait. */
function runningRefusal(threads: ThreadRegistry, threadId: string, action: string): Refusal<409> | undefined {
  return threads.peek(threadId)?.busy === true ? busyRefusal(threadId, action) : undefined
}

/**
 * A control route's hold on the thread (#75): refused while a run holds it, else acquired — a thread
 * that has never run builds here — or refused if a run won it while this waited. Either refusal is
 * the 409 `busyRefusal` words with `action`.
 */
async function controlLease(
  threads: ThreadRegistry,
  threadId: string,
  action: string,
): Promise<ThreadLease | Refusal<409>> {
  const running = runningRefusal(threads, threadId, action)
  if (running !== undefined) return running
  const lease = await threads.acquire(threadId)
  return lease === 'busy' ? busyRefusal(threadId, action) : lease
}

export type HostCommandOutcome = { readonly status: 204 } | { readonly status: 202 } | Refusal<409 | 422>

/**
 * Run a `host` command (#338 slice 2) — `/model`, `/thinking` — as a control route, the way
 * `changeThreadMode` runs a mode change: refused while a run holds the thread (409; the model is
 * not swapped under a run in flight), else the thread is acquired — a thread that has never run
 * BUILDS here, which is the point of choosing the model before the first prompt (#341) — the
 * runtime applies it, the lease is released, 204. The runtime's refusal — an unknown command, a
 * model not offered, a level this model lacks, a provider whose credentials pi rejects — is the
 * 422's text verbatim. The change itself arrives on the follow as a `model` observation, said by
 * the host once it holds; nothing is announced from here.
 */
export async function runHostCommand(
  deps: FollowRouteDeps,
  threadId: string,
  run: EnsoHostCommandRun,
): Promise<HostCommandOutcome> {
  const { threads } = deps
  const lease = await controlLease(threads, threadId, `change ${run.name}`)
  if ('reason' in lease) return lease
  // ⚠ A `flow` row STARTS and the route answers 202 (#338 slice 3), and so does an `action` (slice
  // 4: `/compact` is a model call, seconds to a minute): a login may wait minutes on a
  // device code, and its questions and progress are on the feed, not in this response. The lease
  // is released on acceptance, as `changeThreadMode` releases on a command's acceptance: a lease
  // IS the registry's "busy" (composer disabled, prompts 409, a generation bumped), and a login is
  // not a run — the slice-3 smoke showed a held lease locking the thread for the device-code
  // wait. The flow lives on the session; the host aborts it if the session is disposed.
  let started: 'flow' | 'action' | undefined
  try {
    const row = lease.runtime.listCommands().find((command) => command.source === 'host' && command.name === run.name)
    started = row?.kind === 'flow' || row?.kind === 'action' ? row.kind : undefined
  } catch (error) {
    lease.release()
    throw error
  }
  if (started !== undefined) {
    // ⚠ THE LEASE FOLLOWS THE KIND (PR #347 review). A `flow` releases on acceptance — a login is
    // not a run, and holding it locked the composer for the device-code wait. An `action` holds
    // until it settles — a compaction REWRITES THE BRANCH, pi refuses a prompt while it runs and
    // arms that guard only after its own `abort()`, so the held lease is what keeps a prompt out
    // of the window, marks the thread busy, and lets Stop reach it.
    const releaseOn = started === 'flow' ? 'accepted' : 'settled'
    // ⚠ Every exit releases (PR #346 review): the two outcomes, and a synchronous fault in
    // `startHostFlow` before either — which stays a fault (the handler's 500), with the lease
    // back, rather than the held-lease lock this branch exists to avoid.
    return new Promise<HostCommandOutcome>((resolve, reject) => {
      let answered = false
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        lease.release()
      }
      const answer = (outcome: () => void): void => {
        if (answered) return
        answered = true
        outcome()
      }
      try {
        lease.runtime.startHostFlow(run, {
          onAccepted: () => {
            if (releaseOn === 'accepted') release()
            answer(() => resolve({ status: 202 }))
          },
          onRejected: (reason: string) => {
            release()
            answer(() => resolve({ status: 422, reason }))
          },
          onSettled: release,
        })
      } catch (error) {
        release()
        answer(() => reject(error))
      }
    })
  }
  try {
    await lease.runtime.runHostCommand(run)
  } catch (error) {
    // ⚠ Only a refusal the host DECIDED is the caller's 422 (PR #344 review). Anything else is a
    // fault — a pi API that moved, a bug — and propagates to the handler's 500 rather than
    // reaching the user as a sentence claiming their choice was refused.
    if (error instanceof HostCommandRefused) return { status: 422, reason: error.message }
    throw error
  } finally {
    lease.release()
  }
  return { status: 204 }
}

/** The host-command body, checked against its closed schema — `name`, optionally `value`, nothing else. */
export function readHostCommandBody(raw: string): EnsoHostCommandRun {
  return readClosedBody(
    raw,
    EnsoHostCommandRun,
    'command',
    'command body needs a non-empty `name` and at most a non-empty `value`',
  )
}

export type ConfigureOutcome =
  | { readonly status: 204 }
  | Refusal<409>
  | { readonly status: 422; readonly refusal: EnsoConfigurationRefusal }

/**
 * A new session's settings, applied together (#391): the Start-a-session dialog's Start. Refused
 * while a run holds the thread (409), as every control route is; else ONE lease for all of them, in
 * the order that matters — the system prompt first (#443: a session takes one only before its first
 * request; the library's pick is `pickSystemPrompt`), then the model (the effort a model allows
 * depends on it), then the effort, then the mode. A value equal to the current one is left alone,
 * so choosing what the session already has says nothing on the feed. The first refusal stops it and
 * is the 422, NAMING the step: the steps before it applied, the ones after it did not run. The mode
 * is awaited to its acceptance (the mode route answers before it), so the prompt the page sends next
 * cannot overtake it and a rejected mode is this response, not a later line.
 */
export async function configureThread(
  deps: FollowRouteDeps,
  threadId: string,
  configuration: EnsoSessionConfiguration,
  pickSystemPrompt: (id: string) => SystemPromptPick,
): Promise<ConfigureOutcome> {
  const { threads } = deps
  const lease = await controlLease(threads, threadId, 'configure it')
  if ('reason' in lease) return lease
  try {
    const refusal =
      systemPromptRefusal(lease.runtime, configuration.systemPrompt, pickSystemPrompt) ??
      (await applyConfiguration(lease.runtime, configuration))
    return refusal === undefined ? { status: 204 } : { status: 422, refusal }
  } finally {
    lease.release()
  }
}

/**
 * The system-prompt step (#443), first: the library's pick, then the runtime's own refusal — a
 * session that already sent a request keeps the prompt it sent. `null` is pi's default, chosen: it
 * replaces a prompt an earlier, refused Start applied. Absent leaves the session's as it is.
 */
function systemPromptRefusal(
  runtime: ThreadRuntime,
  id: string | null | undefined,
  pickSystemPrompt: (id: string) => SystemPromptPick,
): EnsoConfigurationRefusal | undefined {
  if (id === undefined) return undefined
  const pick = id === null ? undefined : pickSystemPrompt(id)
  if (pick?.kind === 'refused') return { step: 'systemPrompt', reason: pick.reason }
  const reason = runtime.setSystemPrompt(pick === undefined ? null : pick.choice)
  return reason === undefined ? undefined : { step: 'systemPrompt', reason }
}

/** The steps in order; the first refusal, or `undefined` when every step applied or was already so. */
async function applyConfiguration(
  runtime: ThreadRuntime,
  configuration: EnsoSessionConfiguration,
): Promise<EnsoConfigurationRefusal | undefined> {
  const before = runtime.modelState()
  const { model, thinking, mode } = configuration
  if (model !== undefined && (before.model === null || model !== modelOptionId(before.model))) {
    const reason = await hostRefusalOf(runtime, { name: 'model', value: model })
    if (reason !== undefined) return { step: 'model', reason }
  }
  if (thinking !== undefined && thinking !== runtime.modelState().thinkingLevel) {
    const reason = await hostRefusalOf(runtime, { name: 'thinking', value: thinking })
    if (reason !== undefined) return { step: 'thinking', reason }
  }
  if (mode === undefined) return undefined
  const permission = runtime.permissionModeState()
  if (mode === permission.mode) return undefined
  if (!permission.available.includes(mode)) {
    const offered = permission.available.length === 0 ? 'none' : permission.available.join(', ')
    return { step: 'mode', reason: `mode ${mode} is not offered here. Available: ${offered}` }
  }
  const rejected = await new Promise<string | undefined>((resolve) => {
    runtime.setPermissionMode(mode, {
      onAccepted: () => resolve(undefined),
      onRejected: (reason: string) => resolve(reason),
    })
  })
  return rejected === undefined ? undefined : { step: 'mode', reason: rejected }
}

/**
 * The host's refusal of one host command, or `undefined` when it applied. Only a refusal the host
 * DECIDED is a refusal (PR #344 review's rule): anything else is a fault and propagates to the 500.
 */
async function hostRefusalOf(runtime: ThreadRuntime, run: EnsoHostCommandRun): Promise<string | undefined> {
  try {
    await runtime.runHostCommand(run)
    return undefined
  } catch (error) {
    if (error instanceof HostCommandRefused) return error.message
    throw error
  }
}

/** The configure body, checked against its closed schema — `model`, `thinking`, `mode`, `systemPrompt`; each optional. */
export function readConfigureBody(raw: string): EnsoSessionConfiguration {
  return readClosedBody(
    raw,
    EnsoSessionConfiguration,
    'configure',
    "configure body takes only `model`, `thinking`, `mode` and `systemPrompt`, each a non-empty string; `systemPrompt` may also be `null` for pi's default",
  )
}

export type ForkRouteOutcome =
  | { readonly status: 200; readonly receipt: EnsoForkReceipt }
  | { readonly status: 400 | 404 | 409; readonly reason: string }

/** The host's fork refusal → the status the route answers it with. */
const FORK_REFUSAL_STATUS = {
  'no-thread': 404,
  'no-entry': 404,
  'not-a-user-message': 400,
  'tree-refused': 409,
} as const

/**
 * Fork a thread at one of its user messages (#433): a new thread whose session file names this
 * one as its parent — the host's `forkThread`, from the file, building nothing (#86). Refused
 * while a run holds the thread (409), as every control route is: the file is still growing, and
 * the fork point the page chose may not be where the run leaves the branch.
 */
export async function forkThreadAt(
  deps: ThreadReadDeps,
  threadId: string,
  request: EnsoForkRequest,
): Promise<ForkRouteOutcome> {
  const running = runningRefusal(deps.threads, threadId, 'fork it')
  if (running !== undefined) return running
  const outcome = await deps.host.forkThread(threadId, request.entryId)
  if (outcome.kind !== 'forked') return { status: FORK_REFUSAL_STATUS[outcome.kind], reason: outcome.reason }
  return { status: 200, receipt: { threadId: outcome.threadId, prefill: outcome.prefill } }
}

/** The fork body, checked against its closed schema — `entryId`, nothing else. */
export function readForkBody(raw: string): EnsoForkRequest {
  return readClosedBody(raw, EnsoForkRequest, 'fork', 'fork body needs a non-empty `entryId` and nothing else')
}

export type RestoreRouteOutcome =
  | { readonly status: 200; readonly receipt: { readonly hash: string; readonly safety: string } }
  | { readonly status: 400 | 404 | 409; readonly reason: string }

/** The host's restore refusal → the status the route answers it with. */
const RESTORE_REFUSAL_STATUS = {
  'no-thread': 404,
  'no-entry': 404,
  'no-tree': 409,
  'no-snapshot': 409,
  'no-restore': 409,
  superseded: 409,
  refused: 409,
} as const

/**
 * Run a restore of the thread's tree holding the thread (#551, PR #561 review): a run started
 * while the files are put back would read a half-restored tree, and its snapshot would race the
 * restore on the same store's index. So the thread is LEASED, as a run is, for the whole restore
 * — refused 409 while one runs, or if one wins it meanwhile. An unknown thread is answered before
 * the lease, which would otherwise build a NEW thread under the id.
 */
async function restoreUnderLease(
  deps: ThreadReadDeps,
  threadId: string,
  action: string,
  restore: () => ReturnType<ThreadReadDeps['host']['restoreThreadAt']>,
): Promise<RestoreRouteOutcome> {
  if (deps.threads.peek(threadId) === undefined && (await deps.host.storedThreadDirectory(threadId)) === undefined) {
    return { status: 404, reason: `thread ${threadId} has no session in a project this server serves` }
  }
  const lease = await controlLease(deps.threads, threadId, action)
  if ('reason' in lease) return lease
  try {
    const outcome = await restore()
    if (outcome.kind !== 'restored') return { status: RESTORE_REFUSAL_STATUS[outcome.kind], reason: outcome.reason }
    return { status: 200, receipt: { hash: outcome.hash, safety: outcome.safety } }
  } finally {
    lease.release()
  }
}

/**
 * Restore a thread's tree to the snapshot at one of its entries (#551): the current files are
 * kept as a safety snapshot first, the conversation is untouched.
 */
export function restoreThreadAt(
  deps: ThreadReadDeps,
  threadId: string,
  request: EnsoRestoreRequest,
): Promise<RestoreRouteOutcome> {
  return restoreUnderLease(deps, threadId, 'restore its files', () =>
    deps.host.restoreThreadAt(threadId, request.entryId),
  )
}

/**
 * Undo the thread's last restore (#565): its tree back to that restore's safety snapshot — itself a
 * restore, with its own safety, so a second undo puts the first restore back. The body names the
 * safety the caller was promised; a later restore since is a 409 (PR #561 review).
 */
export function undoLastRestore(
  deps: ThreadReadDeps,
  threadId: string,
  request: EnsoRestoreUndoRequest,
): Promise<RestoreRouteOutcome> {
  return restoreUnderLease(deps, threadId, 'undo its last restore', () =>
    deps.host.undoLastRestore(threadId, request.safety),
  )
}

export type DeleteRouteOutcome =
  | { readonly status: 204 }
  | { readonly status: 404 | 409 | 422 | 500; readonly reason: string }

/** The host's delete refusal → the status the route answers it with: only `holds-work` is forceable. */
const DELETE_REFUSAL_STATUS = { 'no-thread': 404, busy: 409, 'holds-work': 422, refused: 500 } as const

/**
 * Delete the thread (#571): its session file, its tree and its store — a 422 while the tree holds
 * work, unless `force` AND `confirmedWork`, the sha256 of the work's words as the page showed them,
 * matches the work the tree holds now (PR #572 review). Refused 409 while a run holds it, as every
 * control route is; the live session is retired by the host only once the inventory has passed, so
 * a refusal leaves the open page as it was. A claim for the id, from a page that named its
 * project, goes with it.
 */
export async function deleteThreadAt(
  deps: ThreadReadDeps,
  threadId: string,
  force: boolean,
  confirmedWork: string | undefined,
): Promise<DeleteRouteOutcome> {
  const running = runningRefusal(deps.threads, threadId, 'delete it')
  if (running !== undefined) return running
  const outcome = await deps.host.deleteThread(threadId, {
    force,
    confirmedWork,
    retire: () => deps.threads.retire(threadId, 'the thread was deleted'),
  })
  if (outcome.kind !== 'deleted') return { status: DELETE_REFUSAL_STATUS[outcome.kind], reason: outcome.reason }
  deps.projects.dropClaim(threadId)
  return { status: 204 }
}

/** The restore body, checked against its closed schema — `entryId`, nothing else. */
export function readRestoreBody(raw: string): EnsoRestoreRequest {
  return readClosedBody(raw, EnsoRestoreRequest, 'restore', 'restore body needs a non-empty `entryId` and nothing else')
}

/** The undo body, checked against its closed schema — `safety`, a commit hash, nothing else. */
export function readRestoreUndoBody(raw: string): EnsoRestoreUndoRequest {
  return readClosedBody(
    raw,
    EnsoRestoreUndoRequest,
    'restore undo',
    'undo body needs `safety`, the commit hash the restore kept, and nothing else',
  )
}

export type AbortRouteOutcome = { readonly status: 200; readonly receipt: EnsoAbortReceipt } | Refusal<404 | 409>

/**
 * Stop the run in flight on a live thread (#116).
 *
 * @flow abort-clear-restore Abort: clear the queue, hand it back, let the settle end the run
 * A stop is one `POST /api/threads/:id/abort` with no body: the thread id is the whole request
 * (#116). The registry clears the runtime's queue BEFORE telling it to abort and answers with what
 * was waiting (clear-and-restore, #75), for the composer of the tab that stopped. The route
 * releases nothing: the run ends on the follow by its own `settled`, as any run does, and the
 * runtime is told once; a repeat while the abort is pending gets the same answer with nothing
 * restored. 200 with the receipt; 409 nothing in flight; 404 not live.
 * @contract packages/core/src/follow.ts#EnsoAbortReceipt
 * @see docs/seams/thread-runtime.md `abort` and `clearQueue`, the runtime's contract
 * @see docs/seams/presentation.md a stop restores through the receipt, not the `queue` frame
 * @see docs/architecture.md decided constraints: abort is by thread, not by lease (#116); a stop hands the queue back (#75); control-plane invariant 2
 * @see docs/glossary.md the words: abort, stop (Control)
 *
 * @invariant abort-clear-restore/settle-ends-run The run ends on the follow by its settle, not by the route.
 * The runtime's `abort()` resolves when the agent is idle again, and the run still settles (pi
 * emits `agent_settled` from a `finally`); the prompt route's settle observer
 * (`promptThread`) releases the lease, so every follower sees the same `settled` + `status` it
 * would for a natural end. The registry keeps the abort in flight and the next `acquire` awaits
 * it, so a prompt straight after a stop starts against an idle session (the module header's
 * abort-then-prompt race). The browser's `abort()` closes no run either; `idle`, `gone`,
 * `unreachable` are outcomes, not throws.
 */
export function abortThread(deps: FollowRouteDeps, threadId: string): AbortRouteOutcome {
  const { outcome, restored } = deps.threads.abort(threadId)
  switch (outcome) {
    case 'aborted':
      return { status: 200, receipt: { threadId, restored: [...restored] } }
    case 'idle':
      return { status: 409, reason: `nothing is running on thread ${threadId}` }
    default:
      return { status: 404, reason: `no live session for thread ${threadId}` }
  }
}
