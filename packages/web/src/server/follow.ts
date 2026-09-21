import type { ServerResponse } from 'node:http'
import {
  base64DecodedBytes,
  type DialogAnswer,
  isWholeBase64,
  type PromptImageContent,
  type StreamingBehavior,
  validateDialogAnswer,
  ZEN_IMAGE_MAX_BYTES,
  type ZenAbortReceipt,
  type ZenFollowFrame,
  ZenPermissionModeChange,
  ZenPromptBody,
  type ZenPromptReceipt,
  zenLogger,
} from '@zen/core'
import { Check, Errors } from 'typebox/value'
import type { AgentHost } from '../host/agent-host.ts'
import { SSE_HEADERS, startSseKeepalive } from './sse.ts'
import type { ThreadFeedFrame, ThreadRegistry } from './thread-registry.ts'
import { interruptedTail, transcriptToMessages } from './transcript-to-messages.ts'

/**
 * The prompt/follow split (#112) — the server↔browser wire.
 *
 * Four routes, none of which is a run:
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
 * The wire shapes — `ZenFollowFrame`, `ZenPromptReceipt` — are TypeBox in `@zen/core`
 * (`follow.ts` there), like every other crossing; the payload is `ZenObservation`, and AG-UI
 * is not on this wire (`docs/architecture.md`, decided constraints). The receipt of what the
 * split retires is on #109; the decision and its sequence are #112.
 */

const log = zenLogger('server', 'follow')

export interface FollowRouteDeps {
  readonly threads: ThreadRegistry
  readonly host: AgentHost
  readonly sseKeepaliveMs: number
}

export interface PromptBody {
  readonly message: string
  readonly streamingBehavior?: StreamingBehavior
  /** Attached images (#68), already in pi's shape; absent — not empty — when the prompt has none. */
  readonly images?: readonly PromptImageContent[]
}

export type PromptOutcome =
  | { readonly status: 202; readonly receipt: ZenPromptReceipt }
  | { readonly status: 400; readonly reason: string }

/** Leading token of a slash input, without the slash. `/mode auto` -> `mode`. */
function slashCommandName(prompt: string): string | undefined {
  if (!prompt.startsWith('/')) return undefined
  const name = prompt.slice(1).trimEnd().split(/\s/)[0]
  return name === undefined || name.length === 0 ? undefined : name
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
function writeFrame(threads: ThreadRegistry, threadId: string, response: ServerResponse, frame: ZenFollowFrame): void {
  if (frame.type === 'observation' && frame.observation.kind === 'tool-result' && !frame.observation.complete) return
  const name = frame.type === 'observation' ? frame.observation.kind : undefined
  threads.peek(threadId)?.sent.record(frame.type, name, 'sent')
  response.write(`data: ${JSON.stringify(frame)}\n\n`)
}

/**
 * Serve one follow. The snapshot is taken in the same tick as the subscription, so it is
 * exact as of `asOfSeq` and no observation can fall between the two (dsh: one complete
 * snapshot per generation, then only deltas; reconnect = a new follow = a new snapshot).
 */
export async function followThread(deps: FollowRouteDeps, threadId: string, response: ServerResponse): Promise<void> {
  const { threads, host } = deps
  const live = threads.peek(threadId)
  // Cold read for a thread that is not live — the file, as `/history` reads it. Awaited
  // BEFORE subscribing: a thread built during the read is then seen live below. A thread
  // with neither a session nor a file is an EMPTY snapshot, not a 404: observation may
  // precede the first prompt, and must, or the prompt's opening events have no follower.
  const storedTranscript = live === undefined ? await host.readTranscript(threadId) : undefined
  const nowLive = threads.peek(threadId)
  const transcript = nowLive === undefined ? (storedTranscript ?? []) : nowLive.hosted.inspect().entries

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

  const messages = transcriptToMessages(transcript)
  const interrupted = interruptedTail(messages)
  writeFrame(threads, threadId, response, {
    type: 'snapshot',
    threadId,
    asOfSeq: follow.asOfSeq,
    live: nowLive !== undefined,
    busy: nowLive?.busy ?? false,
    generation: nowLive?.generation ?? 0,
    permissionMode:
      nowLive === undefined ? deps.host.storedPermissionMode(transcript) : nowLive.hosted.runtime.permissionModeState(),
    messages,
    openDialogs: nowLive === undefined ? [] : nowLive.hosted.runtime.openDialogs(),
    ...(interrupted === undefined ? {} : { interrupted }),
  })
}

const MEGABYTE = 1024 * 1024
const megabytes = (bytes: number): string => `${(bytes / MEGABYTE).toFixed(1)} MB`

/**
 * The prompt body, shape-checked against `ZenPromptBody` (#112: closed schemas on the wire).
 * Throws `Error`s whose message is the 400 text — the first thing wrong, by path, so a
 * refused image says which one and why rather than "did not match" (#68: never silently
 * dropped). The byte cap is on the DECODED size: what the provider counts.
 */
export function readPromptBody(raw: string): PromptBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed prompt body: ${String(error)}`)
  }
  if (!Check(ZenPromptBody, parsed)) {
    const first = Errors(ZenPromptBody, parsed)[0]
    const where =
      first === undefined ? '' : ` at ${first.instancePath === '' ? '/' : first.instancePath}: ${first.message}`
    throw new Error(`prompt body must match ZenPromptBody${where}`)
  }
  // Whitespace-only is refused here rather than taking a lease to hand pi nothing.
  if (parsed.message.trim().length === 0 && parsed.images === undefined) {
    throw new Error('prompt body needs a message')
  }
  const images = parsed.images?.map((image, position): PromptImageContent => {
    if (!isWholeBase64(image.data)) {
      throw new Error(`prompt body must match ZenPromptBody at /images/${position}/data: must be whole base64 groups`)
    }
    const bytes = base64DecodedBytes(image.data)
    if (bytes > ZEN_IMAGE_MAX_BYTES) {
      throw new Error(
        `image ${position + 1} of ${parsed.images?.length ?? 0} is ${megabytes(bytes)}; an image is at most ${megabytes(ZEN_IMAGE_MAX_BYTES)}`,
      )
    }
    return { type: 'image', data: image.data, mimeType: image.mimeType }
  })
  return {
    message: parsed.message,
    ...(parsed.streamingBehavior === undefined ? {} : { streamingBehavior: parsed.streamingBehavior }),
    ...(images === undefined ? {} : { images }),
  }
}

/**
 * Fire a prompt and answer at admission.
 *
 * A BUSY thread (a run in flight, or a dialog the follow is showing) is not refused and
 * not acquired again: the message goes to pi with a streaming behaviour (`followUp` unless
 * the caller asked to `steer`), which is #75's decision. The run in flight keeps its lease;
 * its `settled` releases the thread once everything queued has run.
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

  const live = threads.peek(threadId)
  if (live?.busy === true) {
    live.hosted.runtime.prompt(
      {
        message: body.message,
        streamingBehavior: body.streamingBehavior ?? 'followUp',
        ...(body.images === undefined ? {} : { images: body.images }),
      },
      { onAccepted: () => undefined, onRejected: rejected },
    )
    return { status: 202, receipt: { threadId, messageId, generation: live.generation, queued: true } }
  }

  const lease = await threads.acquire(threadId)
  const command = slashCommandName(body.message)
  if (command !== undefined) {
    const available = lease.runtime.listCommands()
    if (!available.some((known) => known.name === command)) {
      lease.release()
      return {
        status: 400,
        reason: `/${command} is not available on this surface. Available here: ${
          available.length === 0 ? 'none' : available.map((known) => `/${known.name}`).join(', ')
        }`,
      }
    }
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
      ...(body.streamingBehavior === undefined ? {} : { streamingBehavior: body.streamingBehavior }),
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
 * Deliver the answer to the LIVE session's OPEN question. Validated against what was
 * asked (#112): pi hands a select's value to the extension VERBATIM, so an unoffered value
 * is an injection seam the server closes — the same check the run path's resume made. A
 * refused answer leaves the question open; a cancellation needs no validation.
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
  if (!('cancelled' in answer)) {
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
 * prompt. The thread is acquired like a prompt would acquire it — a fresh page changes mode
 * before its first prompt — and refused while busy (409): a mode change is not queued
 * behind a run (#75's rule), and the composer's select is disabled then for the same
 * reason. The mode must be one the thread offers now (422). The change itself arrives on
 * the follow as `permission-mode`, said by the host when its extension has persisted it;
 * an extension command's acceptance is its completion, so the lease is released on
 * acceptance as `promptThread` releases a slash command's. A rejection after the 204 is
 * announced on the feed as `permission-mode-rejected`, as `promptThread` announces its own.
 */
export async function changeThreadMode(
  deps: FollowRouteDeps,
  threadId: string,
  change: ZenPermissionModeChange,
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
export function readModeChangeBody(raw: string): ZenPermissionModeChange {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed mode body: ${String(error)}`)
  }
  if (!Check(ZenPermissionModeChange, body)) throw new Error('mode body needs a non-empty `mode`')
  return body
}

export type AbortRouteOutcome =
  | { readonly status: 200; readonly receipt: ZenAbortReceipt }
  | { readonly status: 404; readonly reason: string }
  | { readonly status: 409; readonly reason: string }

/**
 * Stop the run in flight on a live thread (#116). The run's end arrives on the follow; the
 * answer carries the prompts that were waiting behind it (#75, clear-and-restore), so the
 * stopping tab can hand them back to its composer.
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
