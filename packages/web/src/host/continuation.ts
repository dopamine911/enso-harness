import type { ContextMessage } from './context-elements.ts'

/**
 * What a Continue sends ahead of the model's next request (#436): the decision whether a torn
 * thread can be continued from exactly its stored state, and what closes it first.
 *
 * ⚠ THE HOST DECIDES, NOT pi. The run lifecycle Continue rides (`agent-host.ts`, its `continueRun`
 * header) is pi's `_runAgentPrompt`, which has no guard of its own: on a completed reply it asks the
 * model again and writes a second answer to nothing, and on an orphan tool call it sends an
 * assistant-last context, where pi-ai patches the missing result on the wire only and the file keeps
 * the orphan (spike on #436, F3 and F6). So this is `agent.continue()`'s own rule
 * (`pi-agent-core` `agent.js`, `agent-loop.js` `runAgentLoopContinue`), made explicit:
 *
 *   - the last message is a prompt — `user`, or an extension's `custom` one — or a tool result
 *     whose call's siblings all have theirs: continue with nothing ahead (`[]`);
 *   - the last assistant message has tool calls with no result after it (a kill mid-tool, or a
 *     parallel call whose sibling's result landed): one synthetic `isError` result per open call,
 *     persisted like any message the run starts with, so the file no longer holds the orphan;
 *   - anything else — a completed or failed reply, a summary, an empty thread — is refused:
 *     `undefined`, and nothing runs.
 *
 * `system` messages are instructions, not turns, and are looked past. pi's `agent.continue()`
 * would continue from one; a system message after a completed reply is not a torn tail.
 */

/** A tool result as pi stores one — the message type, narrowed to its role. */
type ToolResultMessage = Extract<ContextMessage, { role: 'toolResult' }>

/** What a continued run starts with: nothing, or the results that close the open calls. */
export type ContinuationLead = ToolResultMessage[]

/**
 * What the model reads in place of a result it never got (#436). Worded for the model: the call
 * may have run, so it should check before relying on its effect.
 */
export const LOST_TOOL_RESULT_TEXT =
  'The run stopped before this tool returned, so its result was lost. It may or may not have taken effect; check before relying on it.'

/** A tool call the last assistant message made that no result answers yet. */
interface OpenCall {
  readonly id: string
  readonly name: string
}

/** The last assistant message's tool calls with no result after it — none when there is no reply. */
function openCallsOf(turns: readonly ContextMessage[]): OpenCall[] {
  const lastAssistantIndex = turns.findLastIndex((message) => message.role === 'assistant')
  const lastAssistant = turns[lastAssistantIndex]
  if (lastAssistant?.role !== 'assistant') return []
  const answered = new Set(
    turns
      .slice(lastAssistantIndex + 1)
      .flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : [])),
  )
  const open: OpenCall[] = []
  for (const part of lastAssistant.content) {
    if (part.type === 'toolCall' && !answered.has(part.id)) open.push({ id: part.id, name: part.name })
  }
  return open
}

/** The synthetic `isError` result that closes one open call, stamped `now`. */
function lostResultOf(call: OpenCall, now: number): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: LOST_TOOL_RESULT_TEXT }],
    isError: true,
    timestamp: now,
  }
}

/**
 * The messages a Continue starts its run with — `[]`, or the synthetic results that close the open
 * calls — or `undefined` when the thread is not one a run can continue from. Pure: `now` stamps
 * the synthetic results.
 */
export function continuationLead(
  messages: readonly ContextMessage[],
  now: number = Date.now(),
): ContinuationLead | undefined {
  const turns = messages.filter((message) => message.role !== 'system')
  const last = turns.at(-1)
  if (last === undefined) return undefined
  const open = openCallsOf(turns)
  if (last.role === 'assistant' || last.role === 'toolResult') {
    if (open.length > 0) return open.map((call) => lostResultOf(call, now))
    return last.role === 'toolResult' ? [] : undefined
  }
  return last.role === 'user' || last.role === 'custom' ? [] : undefined
}

/** Why a Continue was refused — the reason the route says as its 422. */
export const NOTHING_TO_CONTINUE =
  'nothing to continue: the thread does not end on an unanswered prompt, an unfinished tool call, or tool results with no reply'

/**
 * Why a Continue was refused on a pi build without the private run lifecycle it calls (PR #442
 * review) — the one way that call could fail before it starts. The pin tests go red first.
 */
export const NO_RUN_LIFECYCLE = 'continue is unavailable: this pi build has no run lifecycle to continue in (#436)'
