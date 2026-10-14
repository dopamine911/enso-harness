import type { TruncationResult } from '@earendil-works/pi-coding-agent'
import {
  ENSO_IMAGES_KIND,
  ENSO_TOOL_RESULT_KEY,
  EnsoDialogOutcome,
  type EnsoDialogSpec,
  EnsoLoginState,
  EnsoModelState,
  EnsoNotifyType,
  type EnsoObservation,
  EnsoPermissionModeState,
  EnsoProviderRefusal,
  EnsoProviderRetry,
  EnsoProviderRetryEnd,
  EnsoSessionUsage,
  type EnsoToolResultDescriptor,
  type EnsoUsage,
  contentToText,
  isEnsoDialogSpec,
  readEnsoToolResultDescriptor,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { EventDelivery, RuntimeEvent } from './runtime-event.ts'

/**
 * pi rpc events → the observations a surface renders (#24).
 *
 * This is the one seam that has to understand both protocols, and owning it is what buys
 * back the two things `@tanstack/ai-acp` drops: image input and streamed usage.
 *
 * ⚠ The observation SCHEMAS live in `@enso/core`. This module is the mapping only — the
 * shapes are declared once, in one package, so a second `usage` or a second `truncation`
 * cannot appear beside a different consumer.
 *
 * ⚠ DESIGN RULE: an unrecognised event becomes an `unmapped` observation, never nothing.
 * Every silent-drop bug this project has hit had the same shape — a producer emitting
 * something a consumer quietly ignored. So the union has no "skip" member and this
 * function cannot return undefined.
 */

/**
 * Methods that block pi until a response arrives — see the `extension_ui_request` case. The
 * last is ours, not pi's: the questionnaire the host lifts from `ask_user`'s component (#12).
 */
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor', 'questionnaire'])

function readUsage(raw: unknown): EnsoUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const usage = raw as Record<string, unknown>
  const numberAt = (key: string): number => (typeof usage[key] === 'number' ? usage[key] : 0)
  const cost = usage.cost as Record<string, unknown> | undefined
  const totalCost = typeof cost?.total === 'number' ? cost.total : undefined
  return {
    input: numberAt('input'),
    output: numberAt('output'),
    cacheRead: numberAt('cacheRead'),
    cacheWrite: numberAt('cacheWrite'),
    ...(totalCost === undefined ? {} : { totalCost }),
  }
}

/**
 * Build our descriptor from pi's `details` and `content`.
 *
 * ⚠ No `kind` is invented per tool here: that would put rendering decisions in the transport. A
 * tool that wants a richer descriptor emits one in its `details`, under {@link ENSO_TOOL_RESULT_KEY}
 * (`ask_user`'s answers, the `write` receipt — #920), and it is taken as it stands. Truncation is
 * mapped for every tool; an image the tool returned in its `content` (`read` of a PNG — #920), which
 * the text this seam keeps names only as `[image content]`, is mapped unless the tool emits its own
 * descriptor — then the tool's descriptor stands and the image is not drawn (no tool does both).
 *
 * `truncation` is pi's `TruncationResult` — the one shape every built-in tool (read, bash, grep,
 * find, ls) puts there (#411: this once read `shown`/`total`/`unit`, which pi never sends, so no
 * pi result ever had a descriptor). It is said in LINES whenever lines were dropped, even when
 * the byte limit is what cut them — the reader counts lines, and pi's own notice does
 * (`Showing lines 1-1841 of 3000 (50.0KB limit)`). Only a cut inside one line is said in bytes.
 */
export function descriptorFrom(
  toolName: string,
  details: unknown,
  content: unknown,
): EnsoToolResultDescriptor | undefined {
  const record = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : undefined
  const emitted = readEnsoToolResultDescriptor(record)
  const images = imagesOf(content)
  const truncated = truncationOf(record)
  if (emitted === undefined && images.length === 0 && truncated === undefined) return undefined
  const base =
    emitted ??
    (images.length > 0 ? { kind: ENSO_IMAGES_KIND, props: { images } } : { kind: `pi.tool.${toolName}`, props: {} })
  return truncated === undefined ? base : { ...base, truncated }
}

/** The images a tool returned in its `content`, as bytes — never a URL. */
function imagesOf(content: unknown): { mimeType: string; data: string }[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part: { type?: unknown; mimeType?: unknown; data?: unknown } | null) =>
    part?.type === 'image' && typeof part.mimeType === 'string' && typeof part.data === 'string'
      ? [{ mimeType: part.mimeType, data: part.data }]
      : [],
  )
}

function truncationOf(details: Record<string, unknown> | undefined): EnsoToolResultDescriptor['truncated'] {
  const truncation = details?.['truncation'] as Partial<TruncationResult> | null | undefined
  if (truncation?.truncated !== true) return undefined
  const { outputLines, totalLines, outputBytes, totalBytes } = truncation
  if (typeof outputLines === 'number' && typeof totalLines === 'number' && outputLines < totalLines) {
    return { shown: outputLines, total: totalLines, unit: 'lines' }
  }
  if (typeof outputBytes !== 'number' || typeof totalBytes !== 'number') return undefined
  return { shown: outputBytes, total: totalBytes, unit: 'bytes' }
}

/** The metadata bag to attach to a TanStack `ToolResultPart`, or undefined if there is none. */
export function toolResultMetadata(
  descriptor: EnsoToolResultDescriptor | undefined,
): Record<string, unknown> | undefined {
  return descriptor === undefined ? undefined : { [ENSO_TOOL_RESULT_KEY]: descriptor }
}

/** The `extension_ui_request` case of {@link mapPiEvent}, on its own because of its size. */
function mapExtensionUiRequest(event: RuntimeEvent, delivery: EventDelivery): EnsoObservation {
  // ⚠ pi's Extension UI sub-protocol, and it splits in two (`docs/rpc.md` § Extension
  // UI Protocol):
  //
  //   DIALOG methods    select | confirm | input | editor
  //                     emit a request and BLOCK until the client answers it (over
  //                     rpc: an `extension_ui_response` line on stdin; in-process:
  //                     `ThreadRuntime.answerDialog`) with the matching id.
  //   FIRE-AND-FORGET   notify | setStatus | setWidget | setTitle | set_editor_text
  //                     emit and continue; a client may ignore them.
  //
  // ⚠⚠ A blocking request means pi is WAITING and stays blocked until an answer
  // carrying this id reaches the extension's promise. The session
  // layer answers dialogs by handing them to the browser as AG-UI interrupts
  // (#27), and what it needs from this hop is the QUESTION — so the dialog fields
  // are read here, defensively, into the one shared `EnsoDialogSpec` shape.
  //
  // ⚠ Defensively means: a blocking request whose fields do not form a
  // well-shaped question still maps as `blocking: true` with `dialog` absent.
  // The session layer declines those on the wire (the pre-#27 behaviour) —
  // mapping them as unmapped or non-blocking instead would hang pi silently,
  // which is the bug this observation kind exists to make inexpressible.
  const method = textOr(event.method, 'unknown')
  const dialogCandidate: Record<string, unknown> = { method }
  for (const field of [
    'title',
    'options',
    'message',
    'placeholder',
    'prefill',
    'secret',
    'link',
    'timeout',
    'questions',
  ]) {
    if (event[field] !== undefined) dialogCandidate[field] = event[field]
  }
  const dialog: EnsoDialogSpec | undefined = isEnsoDialogSpec(dialogCandidate) ? dialogCandidate : undefined
  // ⚠ A notify's `message` IS the request (#29): pi's wire shape is
  // `{method: "notify", message, notifyType?}`, and dropping the message here is
  // how a mode change once completed with nothing visible. Copied for notify ONLY —
  // a dialog's `message` is part of the QUESTION and travels inside `dialog` above,
  // and giving it a second home would invite the two to drift. `notifyType` is
  // copied only when it is one of pi's three declared values (info|warning|error);
  // an unrecognised value degrades to an untyped notification, never a validation
  // failure.
  const notifyFields: { message?: string; notifyType?: EnsoNotifyType; sender?: string } = {}
  if (method === 'notify') {
    notifyFields.message = textOr(event.message, '')
    // Who said it (#387), as the host tagged it — never read from the message.
    if (typeof event.sender === 'string' && event.sender.length > 0) notifyFields.sender = event.sender
    // The declared values come from the schema, not a literal list — the browser
    // router (custom-event-router.ts) makes the same check the same way.
    const notifyTypeCandidate = event.notifyType
    if (Check(EnsoNotifyType, notifyTypeCandidate)) {
      notifyFields.notifyType = notifyTypeCandidate
    }
  }
  return {
    kind: 'extension-ui-request',
    id: textOr(event.id, ''),
    method,
    blocking: DIALOG_UI_METHODS.has(method),
    // Tagged from the host's delivery, never inferred from position (#96).
    origin: delivery === 'replayed' ? 'session-start' : 'run',
    ...(dialog === undefined ? {} : { dialog }),
    ...notifyFields,
  }
}

/** pi's message role off a `message_start` / `message_end`, or `unknown` when the record has none. */
function roleOf(message: { role?: unknown } | undefined): string {
  return typeof message?.role === 'string' ? message.role : 'unknown'
}

/** A string field pi carries, or `fallback` when the record has none. */
function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** The length of an array field pi carries, or 0 — `toolResults`, `steering`, `followUp`. */
function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** The strings of an array field pi carries, in order; anything that is not a string is dropped, an absent field is empty. */
function textsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((element): element is string => typeof element === 'string') : []
}

/**
 * The host's own events — its state, said whole, as the host reads it: the MODE after its mode
 * extension persisted a change (L3, #162 workstream 4 — the browser never learns which entry
 * that was); the MODEL and thinking level after a `/model`, a `/thinking` or a failover swap pi's
 * extension made (#338 slice 2 — `agent-host.ts`'s header says where each half is heard); the
 * session's USAGE after a turn, a run, a compaction or a model change (#45 — pi's
 * `getSessionStats`). Checked like every crossing: a malformed one is carried as unmapped, never
 * dropped.
 */
function hostState<Schema extends TSchema>(
  event: RuntimeEvent,
  schema: Schema,
  observe: (state: Static<Schema>) => EnsoObservation,
): EnsoObservation {
  const { type: _type, ...state } = event
  return Check(schema, state) ? observe(state) : { kind: 'unmapped', event }
}

/**
 * A message began (#112). A USER message carries its text so a second follower sees the
 * prompt another tab sent; every other role's content arrives by its own events.
 */
function mapMessageStart(event: RuntimeEvent): EnsoObservation {
  const message = event.message as { role?: unknown; content?: unknown } | undefined
  const role = roleOf(message)
  return role === 'user'
    ? { kind: 'message-start', role, text: contentToText(message?.content) }
    : { kind: 'message-start', role }
}

/**
 * One completed message (#45, #112), with its accounting when pi attributes any.
 *
 * ⚠ The per-delta `usage` on `message_update` is CUMULATIVE for the in-flight message —
 * summing it would multiply cost by the delta count — so the completed message is the one
 * honest accounting unit, emitted exactly once.
 *
 * The role gate copies pi's own attribution rule (`core/usage-totals.js`
 * getUsageCostBreakdown): assistant messages and toolResult messages WITH usage are
 * attributable spend; every other completed message is a boundary without it.
 */
function mapMessageEnd(event: RuntimeEvent): EnsoObservation {
  const message = event.message as { role?: unknown; usage?: unknown; model?: unknown } | undefined
  const role = roleOf(message)
  const usage = readUsage(message?.usage)
  if (usage !== undefined && (role === 'assistant' || role === 'toolResult')) {
    // pi names the model on the assistant message it came from (#144 slice 4); a summarised
    // tool result carries none, and the observation says nothing rather than borrowing one.
    return typeof message?.model === 'string'
      ? { kind: 'message-end', role, usage, model: message.model }
      : { kind: 'message-end', role, usage }
  }
  return { kind: 'message-end', role }
}

/**
 * pi retries the refused request (#340). The three fields, picked rather than spread: pi's event
 * also carries the error again, which the refusal before it already said.
 */
function mapRetryStart(event: RuntimeEvent): EnsoObservation {
  const retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs }
  return Check(EnsoProviderRetry, retry) ? { kind: 'provider-retry', ...retry } : { kind: 'unmapped', event }
}

/**
 * pi stopped retrying (#380 review): picked like the start. `finalError` only when pi gave one —
 * it does on running out and on a cancel, not on a success.
 */
function mapRetryEnd(event: RuntimeEvent): EnsoObservation {
  const end = {
    success: event.success,
    attempt: event.attempt,
    ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
  }
  return Check(EnsoProviderRetryEnd, end) ? { kind: 'provider-retry-ended', ...end } : { kind: 'unmapped', event }
}

/**
 * pi's `compaction_end` (#348): the branch was rewritten under any page holding it. Only a
 * FINISHED compaction — an aborted or failed one rewrote nothing, and a page re-reading for it
 * would read the same.
 */
function mapCompactionEnd(event: RuntimeEvent): EnsoObservation {
  const reason = event.reason
  const finished = event.aborted !== true && event.result !== undefined && event.result !== null
  if (finished && (reason === 'manual' || reason === 'threshold' || reason === 'overflow')) {
    return { kind: 'branch-compacted', reason }
  }
  return { kind: 'unmapped', event }
}

/** One streamed delta of the in-flight message: its text or its thinking, with the usage pi attaches. */
function mapMessageUpdate(event: RuntimeEvent): EnsoObservation {
  const delta = event.assistantMessageEvent as { type?: string; contentIndex?: number; delta?: string } | undefined
  const usage = readUsage(event.usage)
  const contentIndex = typeof delta?.contentIndex === 'number' ? delta.contentIndex : 0
  const text = typeof delta?.delta === 'string' ? delta.delta : ''
  if (delta?.type === 'text_delta') {
    return { kind: 'text-delta', contentIndex, delta: text, ...(usage ? { usage } : {}) }
  }
  if (delta?.type === 'thinking_delta') {
    return { kind: 'thinking-delta', contentIndex, delta: text, ...(usage ? { usage } : {}) }
  }
  // start/end markers and any future delta type: carried, not dropped.
  return { kind: 'unmapped', event }
}

/** A running tool's partial result: never complete, never an error. */
function mapToolExecutionUpdate(event: RuntimeEvent): EnsoObservation {
  const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined
  const toolName = String(event.toolName)
  const descriptor = descriptorFrom(toolName, partial?.details, partial?.content)
  return {
    kind: 'tool-result',
    toolCallId: String(event.toolCallId),
    toolName,
    text: contentToText(partial?.content),
    complete: false,
    isError: false,
    ...(descriptor === undefined ? {} : { descriptor }),
  }
}

/** A tool's final result — a refused call included. */
function mapToolExecutionEnd(event: RuntimeEvent): EnsoObservation {
  const result = event.result as { content?: unknown; details?: unknown } | undefined
  const toolName = String(event.toolName)
  const descriptor = descriptorFrom(toolName, result?.details, result?.content)
  return {
    kind: 'tool-result',
    toolCallId: String(event.toolCallId),
    toolName,
    text: contentToText(result?.content),
    complete: true,
    // ⚠ `isError` is the only signal a refused call has: the runtime turns a guard's
    // `{block: true, reason}` into an error result with the reason as its content —
    // `@earendil-works/pi-agent-core@1.1.0` (bun.lock), `dist/agent-loop.js`, the
    // `beforeResult?.block` branch: `createErrorToolResult(reason)`, `isError: true` —
    // pinned by `__tests__/agent-loop-contract.test.ts`, so a bump that moves it goes red. No distinct
    // "blocked" event exists. Treating any error result as displayable covers it — see
    // also `extension_error` below.
    isError: event.isError === true,
    ...(descriptor === undefined ? {} : { descriptor }),
  }
}

/**
 * The host's own record (#114) — emitted by `extension-ui-context.ts` at the one
 * point every settle path crosses, in stream order with the request it closes.
 * An outcome the union does not name is a host/mapper drift, not a pi event to
 * carry through: it stays unmapped so the debug pane shows it.
 */
function mapExtensionUiSettled(event: RuntimeEvent): EnsoObservation {
  const { id, outcome } = event
  if (typeof id === 'string' && id.length > 0 && Check(EnsoDialogOutcome, outcome)) {
    return { kind: 'dialog-settled', id, outcome }
  }
  return { kind: 'unmapped', event }
}

/**
 * ⚠ Only CUSTOM entries are promoted (#29): an extension persisting state via
 * `pi.appendEntry(customType, data)` is a receipt a surface may want (the mode's
 * `active_agent` entry is how a mode change is recorded, #496; the host follows it with
 * its own `permission_mode` event). Every other entry
 * kind (messages, compaction, labels) duplicates information that already flows
 * as first-class observations, so those stay unmapped, exactly as before.
 */
function mapEntryAppended(event: RuntimeEvent): EnsoObservation {
  const entry = event.entry as { type?: string; customType?: string; data?: unknown } | undefined
  if (entry?.type === 'custom' && typeof entry.customType === 'string') {
    return { kind: 'custom-entry', customType: entry.customType, data: entry.data }
  }
  return { kind: 'unmapped', event }
}

/**
 * Map one pi rpc event. Never returns undefined — see the design rule above.
 *
 * `delivery` is how the host handed the event over (#96): `replayed` from its held buffer —
 * the session's own start — becomes `origin: "session-start"` on a ui request; `live` is
 * `"run"`. Defaults to live: every caller but the pump is mapping a run's stream.
 */
export function mapPiEvent(event: RuntimeEvent, delivery: EventDelivery = 'live'): EnsoObservation {
  switch (event.type) {
    case 'message_update':
      return mapMessageUpdate(event)

    case 'message_start':
      return mapMessageStart(event)

    case 'message_end':
      return mapMessageEnd(event)

    case 'turn_start':
      return { kind: 'turn-start' }

    case 'turn_end':
      // pi's turn: one model request and its tool results (dsh's step — see @enso/core).
      return { kind: 'turn-end', toolResults: countOf(event.toolResults) }

    case 'queue_update':
      // pi's two field names, read here and nowhere else (#216): the wire carries Enso's.
      return { kind: 'queue', interrupting: textsOf(event.steering), enqueued: textsOf(event.followUp) }

    case 'tool_execution_start':
      return {
        kind: 'tool-call',
        toolCallId: String(event.toolCallId),
        toolName: String(event.toolName),
        args: event.args,
      }

    case 'tool_execution_update':
      return mapToolExecutionUpdate(event)

    case 'tool_execution_end':
      return mapToolExecutionEnd(event)

    case 'extension_ui_request':
      return mapExtensionUiRequest(event, delivery)

    case 'extension_ui_settled':
      return mapExtensionUiSettled(event)

    case 'permission_mode':
      return hostState(event, EnsoPermissionModeState, (mode) => ({ kind: 'permission-mode', ...mode }))

    case 'model':
      return hostState(event, EnsoModelState, (model) => ({ kind: 'model', ...model }))

    case 'session_usage':
      return hostState(event, EnsoSessionUsage, (usage) => ({ kind: 'session-usage', ...usage }))

    case 'login':
      // The host's own event (#348): a login began waiting on its provider, or stopped.
      return hostState(event, EnsoLoginState, (login) => ({ kind: 'login', ...login }))

    case 'provider_refused':
      // The host's own event (#340): the provider refused the request pi just made.
      return hostState(event, EnsoProviderRefusal, (refusal) => ({ kind: 'provider-refused', ...refusal }))

    case 'auto_retry_start':
      return mapRetryStart(event)

    case 'auto_retry_end':
      return mapRetryEnd(event)

    case 'compaction_end':
      return mapCompactionEnd(event)

    case 'entry_appended':
      return mapEntryAppended(event)

    case 'extension_error':
      return {
        kind: 'extension-error',
        extensionPath: textOr(event.extensionPath, 'unknown'),
        event: textOr(event.event, 'unknown'),
        error: textOr(event.error, 'unknown error'),
      }

    case 'agent_end':
      return { kind: 'run-ended', willRetry: event.willRetry === true }

    case 'agent_settled':
      // pi 1.1.0 says whether the run was stopped (#766); an older record without it finished.
      return { kind: 'settled', aborted: event.aborted === true }

    default:
      return { kind: 'unmapped', event }
  }
}
