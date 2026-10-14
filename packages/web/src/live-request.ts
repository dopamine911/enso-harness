import type { ToolCallPart, ToolResultPart, UIMessage } from '@tanstack/ai-client'
import type { ComposingCall, RequestPulse } from './follow-connection.ts'
import { formatElapsed } from './run-status.ts'

/**
 * The model request in flight, as the views say it (#913).
 *
 * In auto mode one request can be a whole task — minutes of thinking, then one large `write` —
 * and Context, Stats and Diff fill only when something settles. These are the words and the
 * readings they show meanwhile, all from what the follow already carries (`RunPulse.request`,
 * `RunPulse.composing`, the transcript): no new route, no new data source.
 *
 * ⚠ ESTIMATES ARE SAID TO BE ONE (#692). The output is counted in characters as it streams; its
 * token figure is characters ÷ 4, pi's own rule for its `next` estimate. The provider's count
 * replaces both when the request completes, and nothing here is ever added to a total.
 *
 * ⚠ A PENDING WRITE IS NOT APPLIED. It is model output no guard has judged yet: every place that
 * draws one says "not applied", and a refused or failed call replaces it with the refusal.
 */

/** The run in flight as the views read it (#913), as of one render of the pane. */
export interface LiveRun {
  /** When the oldest run open on the page opened; undefined at rest. */
  readonly runSince: number | undefined
  /** The model request in flight; undefined between requests and at rest. */
  readonly request: RequestPulse | undefined
  /** The page's clock (`Date.now()`), ticking while the run is in flight. */
  readonly now: number
}

/** Characters streamed so far in the request: thinking, reply and tool-call arguments. */
export function requestOutput(request: RequestPulse): number {
  return request.thinking + request.text + request.tool
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** `~18k chars` — the output so far, as counted on the page. */
export function outputCharsText(characters: number): string {
  return `~${COMPACT.format(characters)} chars`
}

/** pi's estimate rule, characters ÷ 4 (`/context`'s `next`): the in-flight output's token figure. */
export function estimatedTokens(characters: number): number {
  return Math.round(characters / 4)
}

/** `≈4.5k` — an estimated token count. */
export function estimatedTokensText(characters: number): string {
  return `≈${COMPACT.format(estimatedTokens(characters))}`
}

/** What a hover says of an in-flight figure. */
export const IN_FLIGHT_ESTIMATE_TITLE =
  'counted on this page as the response streams — an estimate (characters ÷ 4 for tokens) until the provider counts it when the request completes'

/** `the first response is still running · 7m 12s` — an empty state's words while a run is in flight. */
export function runningEmptyText(firstRequest: boolean, since: number | undefined, now: number): string {
  const elapsed = since === undefined ? '' : ` · ${formatElapsed(now - since)}`
  return firstRequest ? `the first response is still running${elapsed}` : `a run is in progress${elapsed}`
}

/**
 * The Stats view's line for the turn in flight (#913): what is running, its figures, and what they
 * are. Between requests (a tool running, a question waiting) no turn is in flight: the run is.
 */
export function runningTurnWords(
  turn: number,
  live: LiveRun,
): { readonly head: string; readonly figures: string; readonly note: string } {
  const { request } = live
  if (request === undefined) {
    return {
      head: 'a run is in progress',
      figures: live.runSince === undefined ? '' : ` · ${formatElapsed(live.now - live.runSince)}`,
      note: 'no model request is running now; each one shows here once the provider has counted it',
    }
  }
  const output = requestOutput(request)
  return {
    head: `turn ${turn} in progress`,
    figures: ` · ${formatElapsed(live.now - request.startedAt)} · output ${estimatedTokensText(output)} tokens so far (${outputCharsText(output)})`,
    note: 'estimates, not in the totals until the turn completes',
  }
}

// ── a write or an edit being composed ────────────────────────────────────────────────────────

/** The tools whose arguments are a change to a file. */
const WRITE_TOOLS: Readonly<Record<string, true>> = { write: true, edit: true }

/** One replacement of an `edit` call, as far as it has streamed. */
export interface PendingEdit {
  readonly oldText: string | undefined
  readonly newText: string | undefined
}

/** What a write or an edit's arguments say so far. */
export interface PendingChange {
  readonly toolCallId: string
  readonly tool: string
  readonly path: string | undefined
  /** A `write`'s content so far. */
  readonly content: string | undefined
  /** An `edit`'s replacements so far. */
  readonly edits: readonly PendingEdit[]
  /** The arguments' length so far, in characters. */
  readonly size: number
}

/**
 * The file change the run has in hand and has not applied (#913):
 *
 *   composing  the model is still writing the call's arguments;
 *   judging    the call is whole and pi has it — the guards, the permission engine or the tool
 *              itself have not answered;
 *   refused    a guard, a rule or the person refused it — nothing was applied;
 *   failed     the tool tried and failed — nothing was applied.
 *
 * Once the tool succeeds there is none: the diff itself shows the change.
 */
export type PendingWrite =
  | { readonly state: 'composing' | 'judging'; readonly change: PendingChange }
  | { readonly state: 'refused' | 'failed'; readonly change: PendingChange; readonly reason: string }

/**
 * The pending write, if any: the call the model is composing when it is a `write` or an `edit`,
 * else the latest `write` or `edit` since the last prompt while it is unanswered (and the run is
 * open) or was refused or failed.
 */
export function pendingWrite(
  messages: ReadonlyArray<UIMessage>,
  composing: ComposingCall | undefined,
  refusals: ReadonlyMap<string, unknown>,
  generating: boolean,
): PendingWrite | undefined {
  if (composing !== undefined && WRITE_TOOLS[composing.toolName] === true) {
    return { state: 'composing', change: changeOf(composing.toolCallId, composing.toolName, composing.args) }
  }
  const latest = latestWriteSincePrompt(messages)
  if (latest === undefined) return undefined
  const { call, result } = latest
  const change = changeOf(call.id, call.name, call.arguments)
  if (result === undefined) return generating ? { state: 'judging', change } : undefined
  if (result.error === undefined && result.state !== 'error') return undefined
  const reason = result.error ?? (typeof result.content === 'string' ? result.content : '')
  return { state: refusals.has(call.id) ? 'refused' : 'failed', change, reason }
}

/**
 * The latest `write` or `edit` since the last prompt, with its result when it has one — which the
 * server may stamp onto a later message than its call's.
 */
function latestWriteSincePrompt(
  messages: ReadonlyArray<UIMessage>,
): { readonly call: ToolCallPart; readonly result: ToolResultPart | undefined } | undefined {
  let call: ToolCallPart | undefined
  const results = new Map<string, ToolResultPart>()
  for (const message of messages.slice(messages.findLastIndex((candidate) => candidate.role === 'user') + 1)) {
    for (const part of message.parts) {
      if (part.type === 'tool-result') results.set(part.toolCallId, part)
      if (part.type === 'tool-call' && WRITE_TOOLS[part.name] === true) call = part
    }
  }
  return call === undefined ? undefined : { call, result: results.get(call.id) }
}

function changeOf(toolCallId: string, tool: string, args: string): PendingChange {
  const fields = objectOf(parsePartialJson(args))
  const text = (field: unknown): string | undefined => (typeof field === 'string' ? field : undefined)
  const edits = Array.isArray(fields.edits) ? fields.edits.map(objectOf) : []
  return {
    toolCallId,
    tool,
    path: text(fields.path),
    content: text(fields.content),
    edits: edits.map((edit) => ({ oldText: text(edit.oldText), newText: text(edit.newText) })),
    size: args.length,
  }
}

/** A value's fields when it is an object; none otherwise. */
function objectOf(value: Json | undefined): { readonly [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

// ── JSON cut off mid-stream ──────────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * A JSON value read as far as it goes (#913): a tool call's arguments while they stream are cut
 * anywhere — mid-string, mid-escape, between a key and its value. What has arrived is kept (a
 * string cut short is the string so far); what has not is absent. Never throws.
 */
export function parsePartialJson(source: string): Json | undefined {
  const reader = { source, at: 0 }
  return readValue(reader)
}

interface Reader {
  readonly source: string
  at: number
}

const WHITESPACE = /\s*/y
const PLAIN = /[^"\\]*/y
const LITERAL = /[^,}\]\s]*/y

function skipWhitespace(reader: Reader): void {
  WHITESPACE.lastIndex = reader.at
  WHITESPACE.exec(reader.source)
  reader.at = WHITESPACE.lastIndex
}

function readValue(reader: Reader): Json | undefined {
  skipWhitespace(reader)
  const char = reader.source[reader.at]
  if (char === undefined) return undefined
  if (char === '{') return readObject(reader)
  if (char === '[') return readArray(reader)
  if (char === '"') return readString(reader)
  LITERAL.lastIndex = reader.at
  const literal = LITERAL.exec(reader.source)?.[0] ?? ''
  reader.at += literal.length
  try {
    return JSON.parse(literal) as Json
  } catch {
    return undefined
  }
}

function readObject(reader: Reader): { [key: string]: Json } {
  const object: { [key: string]: Json } = {}
  reader.at += 1
  for (;;) {
    skipWhitespace(reader)
    const char = reader.source[reader.at]
    if (char === undefined) return object
    if (char === '}') {
      reader.at += 1
      return object
    }
    if (char === ',') {
      reader.at += 1
      continue
    }
    if (char !== '"' || !readMember(reader, object)) return object
  }
}

/** One `"key": value` into `object`; false when the arguments end before its value begins. */
function readMember(reader: Reader, object: { [key: string]: Json }): boolean {
  const start = reader.at
  const key = readString(reader)
  // A key cut short has no value yet.
  if (reader.source[reader.at - 1] !== '"' || reader.at - start < 2) return false
  skipWhitespace(reader)
  if (reader.source[reader.at] !== ':') return false
  reader.at += 1
  const value = readValue(reader)
  if (value !== undefined) object[key] = value
  return true
}

function readArray(reader: Reader): Json[] {
  const array: Json[] = []
  reader.at += 1
  for (;;) {
    skipWhitespace(reader)
    const char = reader.source[reader.at]
    if (char === undefined) return array
    if (char === ']') {
      reader.at += 1
      return array
    }
    if (char === ',') {
      reader.at += 1
      continue
    }
    const before = reader.at
    const value = readValue(reader)
    if (value !== undefined) array.push(value)
    if (reader.at === before) return array
  }
}

/** A string from its opening quote; cut short, the string so far (an escape cut in half dropped). */
function readString(reader: Reader): string {
  const { source } = reader
  let decoded = ''
  reader.at += 1
  for (;;) {
    PLAIN.lastIndex = reader.at
    const plain = PLAIN.exec(source)?.[0] ?? ''
    decoded += plain
    reader.at += plain.length
    const char = source[reader.at]
    if (char === undefined) return decoded
    if (char === '"') {
      reader.at += 1
      return decoded
    }
    // A backslash: an escape, possibly cut. `\uXXXX` takes six characters, every other escape two.
    const width = source[reader.at + 1] === 'u' ? 6 : 2
    const escape = source.slice(reader.at, reader.at + width)
    if (escape.length < width) {
      reader.at = source.length
      return decoded
    }
    try {
      decoded += JSON.parse(`"${escape}"`) as string
    } catch {
      // Not an escape JSON knows: the text after the backslash, as written.
      decoded += escape.slice(1)
    }
    reader.at += width
  }
}
