import { ENSO_LOG_EVENTS, type EnsoLogProperties, type EnsoObservation, ensoLogger, providerReasonOf } from '@enso/core'
import { forgetRun, takeFirstDeltaMs } from './run-timing.ts'

/**
 * Every observation the server publishes becomes a record (#132, "trace everything") —
 * at the tier it belongs to, with the ids that join it to the transcript, the event tail
 * (#97) and the other layers' lines about the same moment.
 *
 *   `info`  — the spine: what happened. Tool calls and their results, the run's end, a
 *             question asked (a BLOCKING ui request — not a notify or a status line) and
 *             settled, the queue moving, a prompt pi refused, an extension that threw.
 *   `debug` — every observation, one compact line: kind, seq, generation, ids. Deltas
 *             become a count of characters, not the text.
 *   `trace` — the same, plus a second record carrying the whole observation.
 *
 * `ENSO_LOG_LEVEL` picks the tier (`log-process.ts`); `enso.server.events` is the category to
 * turn up alone (`ENSO_LOG_LEVEL=info,enso.server.events=trace`).
 *
 * ⚠ Never the text itself below `trace`. At `debug` a delta is `{ chars }`, a tool result
 * `{ chars, isError }` — the transcript is pi's session file, not this one; this file says
 * WHEN and WHAT KIND, and at `trace`, for one investigation, everything.
 */

const events = ensoLogger('server', 'events')

/** The kinds that are the spine at `info`; everything else is `debug`. */
const SPINE: Readonly<Record<string, true>> = {
  'tool-call': true,
  'tool-result': true,
  'extension-ui-request': true,
  'dialog-settled': true,
  queue: true,
  'prompt-rejected': true,
  'extension-error': true,
  'run-ended': true,
  settled: true,
  // A provider's refusal, pi's retry, and its end (#340, #380 review): the outcome of a request,
  // not a boundary — two hours of 429s were once only the SHAPE of a failure here (`run-ended`,
  // no tokens).
  'provider-refused': true,
  'provider-retry': true,
  'provider-retry-ended': true,
  // A compaction rewrote the branch (#348): a reader of the log should see where the history changed.
  'branch-compacted': true,
}

/**
 * The name of a pi event an `unmapped` observation wraps — `message_update/toolcall_delta`,
 * `agent_start` — so the compact line says which, not that one happened. The whole event
 * is on the `trace` line.
 */
function piEventName(event: unknown): string {
  if (typeof event !== 'object' || event === null) return '(not an object)'
  const record = event as { type?: unknown; assistantMessageEvent?: { type?: unknown } }
  const outer = typeof record.type === 'string' ? record.type : '(untyped)'
  const inner = record.assistantMessageEvent?.type
  return typeof inner === 'string' ? `${outer}/${inner}` : outer
}

/** The ids and sizes a compact line carries, per kind — no text below `trace`. */
function compactOf(observation: EnsoObservation): EnsoLogProperties {
  switch (observation.kind) {
    case 'tool-call':
      return { toolCallId: observation.toolCallId, toolName: observation.toolName }
    case 'tool-result':
      return {
        toolCallId: observation.toolCallId,
        toolName: observation.toolName,
        chars: observation.text.length,
        complete: observation.complete,
        isError: observation.isError,
      }
    case 'text-delta':
    case 'thinking-delta':
      return { contentIndex: observation.contentIndex, chars: observation.delta.length }
    case 'message-start':
    case 'message-end':
      return { role: observation.role }
    case 'extension-ui-request':
      return { requestId: observation.id, method: observation.method, blocking: observation.blocking }
    case 'dialog-settled':
      return { dialogId: observation.id, outcome: observation.outcome }
    case 'queue':
      return { interrupting: observation.interrupting.length, enqueued: observation.enqueued.length }
    case 'prompt-rejected':
      return { messageId: observation.messageId, reason: observation.reason }
    case 'custom-entry':
      return { customType: observation.customType }
    case 'permission-mode':
      return { mode: observation.mode }
    case 'permission-mode-rejected':
      return { mode: observation.mode, reason: observation.reason }
    case 'model':
      return {
        model: observation.model === null ? 'none' : `${observation.model.provider}/${observation.model.id}`,
        thinkingLevel: observation.thinkingLevel,
      }
    case 'session-usage':
      return {
        cost: observation.cost,
        ...(observation.context?.percent == null ? {} : { contextPercent: observation.context.percent }),
      }
    case 'branch-compacted':
      return { reason: observation.reason }
    case 'extension-error':
      return { extensionPath: observation.extensionPath, event: observation.event }
    case 'run-ended':
      return { willRetry: observation.willRetry }
    case 'provider-refused':
      return {
        ...(observation.provider === undefined ? {} : { provider: observation.provider }),
        ...(observation.model === undefined ? {} : { model: observation.model }),
        ...(observation.status === undefined ? {} : { status: observation.status }),
        // What classes a refusal with no status (#384): the provider's own stop reason.
        ...(observation.providerStopReason === undefined ? {} : { stopReason: observation.providerStopReason }),
        // The provider's own sentence (#340) — the fact, not transcript text; the whole message is on `trace`.
        reason: providerReasonOf(observation.message),
      }
    case 'provider-retry':
      return { attempt: observation.attempt, maxAttempts: observation.maxAttempts, delayMs: observation.delayMs }
    case 'provider-retry-ended':
      return {
        success: observation.success,
        attempt: observation.attempt,
        ...(observation.finalError === undefined ? {} : { reason: providerReasonOf(observation.finalError) }),
      }
    case 'turn-start':
      return {}
    case 'turn-end':
      return { toolResults: observation.toolResults }
    case 'unmapped':
      return { event: piEventName(observation.event) }
    case 'settled':
      return {}
  }
}

/**
 * Whether this observation is the spine: its kind is, and — for a ui request — it BLOCKS.
 * A notify or a status line is a fire-and-forget request pi's extensions send by the dozen
 * at session start (four before the first prompt, live); a question is the one that matters.
 */
function isSpine(observation: EnsoObservation): boolean {
  if (observation.kind === 'extension-ui-request') return observation.blocking
  return SPINE[observation.kind] === true
}

/** One observation, on its way to every follower: the compact line at its tier, the payload at `trace`. */
export function recordObservation(
  threadId: string,
  generation: number,
  seq: number,
  observation: EnsoObservation,
): void {
  // ⚠ THUNKS, not objects (#284). At the default tier both of these are dropped, and the
  // eager payload — `compactOf`'s switch, a spread, a second object holding the whole
  // observation — was built per observation anyway: 1.04 µs of the 1.62 µs `recordObservation`
  // cost, against 0.15 µs to serialise the frame that actually reaches the browser. LogTape
  // calls the thunk only once a sink will read it.
  const compact = (): EnsoLogProperties => ({
    threadId,
    generation,
    seq,
    kind: observation.kind,
    ...compactOf(observation),
  })
  if (isSpine(observation)) events.info(ENSO_LOG_EVENTS.observation, compact)
  else events.debug(ENSO_LOG_EVENTS.observation, compact)
  events.trace('{kind} payload', () => ({ threadId, generation, seq, kind: observation.kind, observation }))
  // Time to first token, at `info` (#144): the deltas themselves are `debug`, so without this
  // one line the latency a person actually asks about is only visible to whoever was already
  // turned up. One record per run — the second delta finds nothing to take.
  if (observation.kind === 'text-delta' || observation.kind === 'thinking-delta') {
    const firstDeltaMs = takeFirstDeltaMs(threadId, generation)
    if (firstDeltaMs !== undefined) {
      events.info(ENSO_LOG_EVENTS.runFirstDelta, {
        threadId,
        generation,
        seq,
        kind: observation.kind,
        firstDeltaMs,
      })
    }
  } else if (observation.kind === 'settled') forgetRun(threadId, generation)
  // Spend, at `info` (#144 slice 4): `message-end` is not the spine — most are boundaries
  // with nothing on them — but the ones pi attributes usage to are the whole of "what did
  // today cost", and at `debug` that answer was only in the file for whoever was already
  // turned up. One record per attributed message, the same unit pi's `/stats` sums, so a
  // day's cost derived here matches pi's — never the per-delta usage, which is cumulative.
  if (observation.kind === 'message-end' && observation.usage !== undefined) {
    events.info(ENSO_LOG_EVENTS.messageUsage, {
      threadId,
      generation,
      seq,
      role: observation.role,
      ...(observation.model === undefined ? {} : { model: observation.model }),
      input: observation.usage.input,
      output: observation.usage.output,
      cacheRead: observation.usage.cacheRead,
      cacheWrite: observation.usage.cacheWrite,
      ...(observation.usage.totalCost === undefined ? {} : { totalCost: observation.usage.totalCost }),
    })
  }
}
