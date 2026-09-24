import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { EnsoPromptStats, EnsoToolCallStats, EnsoTurnStats } from '@enso/core'
import { contentToText } from './map-events.ts'

/**
 * A thread's branch, analysed (#45 phase 2): per prompt, per turn, per tool — the session half
 * of `EnsoThreadStats`. The log half (how long each took) is joined above the host, by the route.
 *
 * Read off pi's own entries, root to leaf (`getBranch()`), for a live session and a stored file
 * alike, so a thread of any age answers — the log keeps 14 days, the session keeps everything.
 *
 * ⚠ THE BRANCH, NOT THE SESSION. A turn on an abandoned branch is not this conversation's turn,
 * and a compaction's model call is nobody's turn. Both are in pi's session TOTAL
 * (`session-usage.ts`); `branchCost` is what this walk attributed, and the reader states the
 * difference instead of spreading it over turns it does not belong to.
 *
 * ⚠ A failure is `isError === true` and nothing else — pi's own signal, the one a guard's refusal
 * also carries (map-events.ts). An error turn (`stopReason: 'error'`) is a turn, with its cost.
 *
 * ⓘ A prompt's duration is the one duration read here (#359): its entry's timestamp to the last
 * message entry that answers it. pi stamps an entry as it appends it — a reply at its end — so the
 * span is the prompt's wall time to its last word, for a thread of any age.
 */

/** One call before the log's duration is joined. */
export type BranchCall = Omit<EnsoToolCallStats, 'durationMs'>

export interface BranchStats {
  /** The turns' cost plus summarised tool results' — what the branch's own messages were attributed. */
  readonly branchCost: number
  readonly turnStats: EnsoTurnStats[]
  readonly promptStats: EnsoPromptStats[]
  /** In branch order; a call whose result has not landed is `pending`. */
  readonly callStats: BranchCall[]
  /** The branch's first entry, ISO — where the thread's log days begin. Undefined for an empty branch. */
  readonly firstAt: string | undefined
}

/** A prompt as a row names it: whitespace folded, at most this many characters. */
const REQUEST_TEXT_MAX = 120

export function promptText(content: unknown): string {
  const folded = contentToText(content).replace(/\s+/g, ' ').trim()
  return folded.length > REQUEST_TEXT_MAX ? `${folded.slice(0, REQUEST_TEXT_MAX - 1)}…` : folded
}

type MutablePrompt = { -readonly [Key in keyof EnsoPromptStats]: EnsoPromptStats[Key] }
type MutableCall = { -readonly [Key in keyof BranchCall]: BranchCall[Key] }

function freshPrompt(prompt: number, text: string): MutablePrompt {
  return { prompt, text, turnCount: 0, cost: 0, toolCalls: 0, failedToolCalls: 0 }
}

/** A prompt's first and last entry instants, epoch ms; `last` stays undefined until something answers. */
interface PromptSpan {
  readonly first: number
  last: number | undefined
}

/** The walk's state: the prompt being answered, and each call by id so its result lands on it. */
interface Walk {
  readonly prompts: MutablePrompt[]
  /** By prompt number; prompt 0 has none — nothing opened it. */
  readonly spans: Map<number, PromptSpan>
  readonly turnStats: EnsoTurnStats[]
  readonly calls: MutableCall[]
  readonly callById: Map<string, MutableCall>
  branchCost: number
}

/** A span's length in ms, or undefined: nothing answered its prompt, or the clocks disagree. */
function spanMs(span: PromptSpan | undefined): number | undefined {
  if (span?.last === undefined || Number.isNaN(span.first) || Number.isNaN(span.last)) return undefined
  const elapsed = span.last - span.first
  return elapsed >= 0 ? elapsed : undefined
}

function currentPrompt(walk: Walk): MutablePrompt {
  // The walk starts with prompt 0 in place, so there is always one.
  return walk.prompts[walk.prompts.length - 1] ?? freshPrompt(0, '')
}

type MessageEntry = Extract<SessionEntry, { type: 'message' }>
type Message = MessageEntry['message']
type AssistantMessage = Extract<Message, { role: 'assistant' }>
type ToolResultMessage = Extract<Message, { role: 'toolResult' }>

function walkAssistant(walk: Walk, message: AssistantMessage): void {
  const prompt = currentPrompt(walk)
  const turn = walk.turnStats.length + 1
  let toolCalls = 0
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue
    toolCalls += 1
    const call: MutableCall = {
      toolCallId: part.id,
      toolName: part.name,
      turn,
      prompt: prompt.prompt,
      inputChars: JSON.stringify(part.arguments ?? {}).length,
      outputChars: 0,
      isError: false,
      pending: true,
    }
    walk.calls.push(call)
    walk.callById.set(part.id, call)
  }
  const { usage } = message
  walk.turnStats.push({
    turn,
    prompt: prompt.prompt,
    model: message.model,
    cost: usage.cost.total,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    toolCalls,
    stopReason: message.stopReason,
  })
  prompt.turnCount += 1
  prompt.cost += usage.cost.total
  prompt.toolCalls += toolCalls
  walk.branchCost += usage.cost.total
}

function walkToolResult(walk: Walk, message: ToolResultMessage): void {
  const prompt = currentPrompt(walk)
  // Joined to its CALL by id, as the log's fold joins: the call names the tool.
  const call = walk.callById.get(message.toolCallId)
  if (call !== undefined) {
    call.pending = false
    call.outputChars = contentToText(message.content).length
    call.isError = message.isError
  }
  if (message.isError) prompt.failedToolCalls += 1
  // A summarised result is a model call of its own (pi's attribution rule): the prompt's spend, no turn.
  if (message.usage !== undefined) {
    prompt.cost += message.usage.cost.total
    walk.branchCost += message.usage.cost.total
  }
}

/** One message entry into the walk: a prompt opens a span; a reply or a result moves its end. */
function walkMessage(walk: Walk, sessionEntry: MessageEntry): void {
  const { message } = sessionEntry
  const instant = Date.parse(sessionEntry.timestamp)
  if (message.role === 'user') {
    walk.spans.set(walk.prompts.length, { first: instant, last: undefined })
    walk.prompts.push(freshPrompt(walk.prompts.length, promptText(message.content)))
    return
  }
  if (message.role === 'assistant') walkAssistant(walk, message)
  else if (message.role === 'toolResult') walkToolResult(walk, message)
  else return
  const span = walk.spans.get(currentPrompt(walk).prompt)
  if (span !== undefined) span.last = instant
}

/** Walk one branch, root to leaf. */
export function branchStats(branch: readonly SessionEntry[]): BranchStats {
  const walk: Walk = {
    prompts: [freshPrompt(0, '')],
    spans: new Map(),
    turnStats: [],
    calls: [],
    callById: new Map(),
    branchCost: 0,
  }
  for (const sessionEntry of branch) if (sessionEntry.type === 'message') walkMessage(walk, sessionEntry)
  for (const prompt of walk.prompts) {
    const durationMs = spanMs(walk.spans.get(prompt.prompt))
    if (durationMs !== undefined) prompt.durationMs = durationMs
  }
  // Prompt 0 collects what came before the first prompt; with nothing in it, it is not a row.
  const [beforeFirstPrompt, ...prompted] = walk.prompts
  const promptStats = beforeFirstPrompt !== undefined && beforeFirstPrompt.turnCount > 0 ? walk.prompts : prompted
  return {
    branchCost: walk.branchCost,
    turnStats: walk.turnStats,
    promptStats,
    callStats: walk.calls,
    firstAt: branch[0]?.timestamp,
  }
}
