import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { EnsoPromptStats, EnsoToolStats, EnsoTurnStats } from '@enso/core'
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
 */

/** One tool's tally before the log's durations are joined. */
export type ToolTally = Omit<EnsoToolStats, 'durations'>

export interface BranchStats {
  /** The turns' cost plus summarised tool results' — what the branch's own messages were attributed. */
  readonly branchCost: number
  readonly turnStats: EnsoTurnStats[]
  readonly promptStats: EnsoPromptStats[]
  /** Most calls first; ties by name. */
  readonly toolStats: ToolTally[]
  /** The branch's first entry, ISO — where the thread's log days begin. Undefined for an empty branch. */
  readonly firstAt: string | undefined
}

/** A prompt as a row names it: whitespace folded, at most this many characters. */
const REQUEST_TEXT_MAX = 120

function promptText(content: unknown): string {
  const folded = contentToText(content).replace(/\s+/g, ' ').trim()
  return folded.length > REQUEST_TEXT_MAX ? `${folded.slice(0, REQUEST_TEXT_MAX - 1)}…` : folded
}

type MutablePrompt = { -readonly [Key in keyof EnsoPromptStats]: EnsoPromptStats[Key] }
type MutableTally = { -readonly [Key in keyof ToolTally]: ToolTally[Key] }

function freshPrompt(prompt: number, text: string): MutablePrompt {
  return { prompt, text, turnCount: 0, cost: 0, toolCalls: 0, failedToolCalls: 0 }
}

/** The walk's state: the prompt being answered, and each call's tool by id so its result lands on it. */
interface Walk {
  readonly prompts: MutablePrompt[]
  readonly turnStats: EnsoTurnStats[]
  readonly tools: Map<string, MutableTally>
  readonly toolNameByCallId: Map<string, string>
  branchCost: number
}

function tallyOf(walk: Walk, toolName: string): MutableTally {
  let tally = walk.tools.get(toolName)
  if (tally === undefined) {
    tally = { toolName, calls: 0, failures: 0, inputChars: 0, outputChars: 0 }
    walk.tools.set(toolName, tally)
  }
  return tally
}

function currentPrompt(walk: Walk): MutablePrompt {
  // The walk starts with prompt 0 in place, so there is always one.
  return walk.prompts[walk.prompts.length - 1] ?? freshPrompt(0, '')
}

type Message = Extract<SessionEntry, { type: 'message' }>['message']
type AssistantMessage = Extract<Message, { role: 'assistant' }>
type ToolResultMessage = Extract<Message, { role: 'toolResult' }>

function walkAssistant(walk: Walk, message: AssistantMessage): void {
  const prompt = currentPrompt(walk)
  let toolCalls = 0
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue
    toolCalls += 1
    const tally = tallyOf(walk, part.name)
    tally.calls += 1
    tally.inputChars += JSON.stringify(part.arguments ?? {}).length
    walk.toolNameByCallId.set(part.id, part.name)
  }
  const { usage } = message
  walk.turnStats.push({
    turn: walk.turnStats.length + 1,
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
  // The CALL names the tool, as in the log's fold: a result spelling it differently lands on its call.
  const tally = tallyOf(walk, walk.toolNameByCallId.get(message.toolCallId) ?? message.toolName)
  tally.outputChars += contentToText(message.content).length
  if (message.isError) {
    tally.failures += 1
    prompt.failedToolCalls += 1
  }
  // A summarised result is a model call of its own (pi's attribution rule): the prompt's spend, no turn.
  if (message.usage !== undefined) {
    prompt.cost += message.usage.cost.total
    walk.branchCost += message.usage.cost.total
  }
}

/** Walk one branch, root to leaf. */
export function branchStats(branch: readonly SessionEntry[]): BranchStats {
  const walk: Walk = {
    prompts: [freshPrompt(0, '')],
    turnStats: [],
    tools: new Map(),
    toolNameByCallId: new Map(),
    branchCost: 0,
  }
  for (const sessionEntry of branch) {
    if (sessionEntry.type !== 'message') continue
    const { message } = sessionEntry
    if (message.role === 'user') walk.prompts.push(freshPrompt(walk.prompts.length, promptText(message.content)))
    else if (message.role === 'assistant') walkAssistant(walk, message)
    else if (message.role === 'toolResult') walkToolResult(walk, message)
  }
  // Prompt 0 collects what came before the first prompt; with nothing in it, it is not a row.
  const [beforeFirstPrompt, ...prompted] = walk.prompts
  const promptStats = beforeFirstPrompt !== undefined && beforeFirstPrompt.turnCount > 0 ? walk.prompts : prompted
  return {
    branchCost: walk.branchCost,
    turnStats: walk.turnStats,
    promptStats,
    toolStats: [...walk.tools.values()].sort(
      (first, second) => second.calls - first.calls || first.toolName.localeCompare(second.toolName),
    ),
    firstAt: branch[0]?.timestamp,
  }
}
