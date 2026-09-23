import type { ServerResponse } from 'node:http'
import {
  base64DecodedBytes,
  type DialogAnswer,
  ENSO_IMAGE_MAX_BYTES,
  type EnsoAbortReceipt,
  type EnsoFollowFrame,
  EnsoHostCommandRun,
  EnsoPermissionModeChange,
  type EnsoPromptAdmission,
  EnsoPromptBody,
  type EnsoPromptReceipt,
  ensoLogger,
  isWholeBase64,
  type PromptImageContent,
  type ThreadRuntime,
  validateDialogAnswer,
} from '@enso/core'
import { Check, Errors } from 'typebox/value'
import type { AgentHost } from '../host/agent-host.ts'
import { HostCommandRefused } from '../host/host-commands.ts'
import { SSE_HEADERS, startSseKeepalive } from './sse.ts'
import { readThreadMount } from './thread-read.ts'
import type { ThreadFeedFrame, ThreadRegistry } from './thread-registry.ts'

/**
 * The prompt/follow split (#112) — the server↔browser wire.
 *
 * Five routes, none of which is a run:
 *
 *   POST /api/threads/:id/prompt   unary. Takes the thread, fires the prompt, answers at
 *                                  once with a message id. The thread's own `settled`
 *                                  releases it — not an HTTP response ending.
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

export interface FollowRouteDeps {
  readonly threads: ThreadRegistry
  readonly host: AgentHost
  readonly sseKeepaliveMs: number
}

export interface PromptBody {
  readonly message: string
  readonly admission?: EnsoPromptAdmission
  /** Attached images (#68), already in pi's shape; absent — not empty — when the prompt has none. */
  readonly images?: readonly PromptImageContent[]
}

export type PromptOutcome =
  | { readonly status: 202; readonly receipt: EnsoPromptReceipt }
  | { readonly status: 400; readonly reason: string }

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
 * The snapshot is read through the one live-or-cold reader (`thread-read.ts#readThreadMount`,
 * #214) — the same read `/history` serves, so the two routes cannot disagree about a thread
 * that goes live mid-read — and it is taken in the same tick as the subscription, so it is
 * exact as of `asOfSeq` and no observation can fall between the two (dsh: one complete snapshot
 * per generation, then only deltas; reconnect = a new follow = a new snapshot).
 *
 * A thread with neither a session nor a file is an EMPTY snapshot, not a 404 (`present` is
 * ignored here): observation may precede the first prompt, and must, or the prompt's
 * opening events have no follower.
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

  writeFrame(threads, threadId, response, {
    type: 'snapshot',
    threadId,
    asOfSeq: follow.asOfSeq,
    live: mount.live,
    busy: mount.busy,
    generation: mount.generation,
    permissionMode: mount.permissionMode,
    model: mount.model,
    messages: mount.messages,
    openDialogs: mount.openDialogs,
    ...(mount.interrupted === undefined ? {} : { interrupted: mount.interrupted }),
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
    throw new Error(`malformed prompt body: ${String(error)}`)
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
 * A BUSY thread (a run in flight, or a dialog the follow is showing) is not acquired again:
 * the message goes to the runtime with an admission (`enqueue` unless the caller asked to
 * `steer`), which is #75's decision. The run in flight keeps its lease; its `settled`
 * releases the thread once everything queued has run. The ONE refusal both paths share is a
 * slash command this surface cannot run (`unavailableCommand`, #337): that is a 400 before
 * anything is queued, busy or idle alike.
 *
 * An IDLE thread is taken; the prompt's own `settled` (or, for a slash command, its
 * acceptance — an extension command never settles) releases it through the feed. No HTTP
 * response is open for any of this.
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
  const live = threads.peek(threadId)
  if (live?.busy === true) {
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

  const lease = await threads.acquire(threadId)
  const unavailable = command === undefined ? undefined : unavailableCommand(lease.runtime, command)
  if (unavailable !== undefined) {
    lease.release()
    return { status: 400, reason: unavailable }
  }

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
        settle.unsubscribe()
        lease.release()
      },
      onRejected: (reason: string) => {
        rejected(reason)
        settle.unsubscribe()
        lease.release()
      },
    },
  )
  return { status: 202, receipt: { threadId, messageId, generation: lease.generation, queued: false } }
}

/** The dialog body: pi's response shape, keyed by the request id the follow showed. */
export function readDialogBody(raw: string): DialogAnswer {
  let body: { id?: unknown; cancelled?: unknown; value?: unknown; confirmed?: unknown }
  try {
    body = JSON.parse(raw) as typeof body
  } catch (error) {
    throw new Error(`malformed dialog body: ${String(error)}`)
  }
  if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('dialog body needs the request id')
  if (body.cancelled === true) return { id: body.id, cancelled: true }
  if (typeof body.value === 'string') return { id: body.id, value: body.value }
  if (typeof body.confirmed === 'boolean') return { id: body.id, confirmed: body.confirmed }
  throw new Error('dialog body needs cancelled, value, or confirmed')
}

export type DialogOutcome =
  | { readonly status: 204 }
  | { readonly status: 404; readonly reason: string }
  | { readonly status: 422; readonly reason: string }

/**
 * Deliver the answer to the LIVE session's OPEN question.
 *
 * Validated against what was asked (#112): pi hands a select's value to the extension VERBATIM,
 * so an unoffered value is an injection seam the server closes — the same check the run path's
 * resume made. A refused answer leaves the question open; only a real `cancelled: true` skips
 * the check (#225).
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

export type ModeChangeOutcome =
  | { readonly status: 204 }
  | { readonly status: 409; readonly reason: string }
  | { readonly status: 422; readonly reason: string }

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
  const live = threads.peek(threadId)
  if (live?.busy === true)
    return { status: 409, reason: `thread ${threadId} is running; change the mode when it settles` }
  const lease = await threads.acquire(threadId)
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
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed mode body: ${String(error)}`)
  }
  if (!Check(EnsoPermissionModeChange, body)) throw new Error('mode body needs a non-empty `mode`')
  return body
}

export type HostCommandOutcome =
  | { readonly status: 204 }
  | { readonly status: 202 }
  | { readonly status: 409; readonly reason: string }
  | { readonly status: 422; readonly reason: string }

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
  const live = threads.peek(threadId)
  if (live?.busy === true) {
    return { status: 409, reason: `thread ${threadId} is running; change ${run.name} when it settles` }
  }
  const lease = await threads.acquire(threadId)
  // ⚠ A `flow` row STARTS and the route answers 202 (#338 slice 3): a login may wait minutes on a
  // device code, and its questions and progress are on the feed, not in this response. The lease
  // is released on acceptance, as `changeThreadMode` releases on a command's acceptance: a lease
  // IS the registry's "busy" (composer disabled, prompts 409, a generation bumped), and a login is
  // not a run — the slice-3 smoke showed a held lease locking the thread for the device-code
  // wait. The flow lives on the session; the host aborts it if the session is disposed.
  const row = lease.runtime.listCommands().find((command) => command.source === 'host' && command.name === run.name)
  if (row?.kind === 'flow') {
    return new Promise<HostCommandOutcome>((resolve) => {
      lease.runtime.startHostFlow(run, {
        onAccepted: () => {
          lease.release()
          resolve({ status: 202 })
        },
        onRejected: (reason: string) => {
          lease.release()
          resolve({ status: 422, reason })
        },
      })
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
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed command body: ${String(error)}`)
  }
  if (!Check(EnsoHostCommandRun, body)) {
    throw new Error('command body needs a non-empty `name` and at most a non-empty `value`')
  }
  return body
}

export type AbortRouteOutcome =
  | { readonly status: 200; readonly receipt: EnsoAbortReceipt }
  | { readonly status: 404; readonly reason: string }
  | { readonly status: 409; readonly reason: string }

/**
 * Stop the run in flight on a live thread (#116).
 *
 * The run's end arrives on the follow; the answer carries the prompts that were waiting behind
 * it (#75, clear-and-restore), so the stopping tab can hand them back to its composer.
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
