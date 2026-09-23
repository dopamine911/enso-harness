import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { RuntimeEvent } from './runtime-event.ts'

/**
 * `AgentSessionEvent` → the rpc WIRE shape (#69).
 *
 * Replicated from pi-coding-agent 0.87.1 `dist/modes/json-event.js` (`toJsonEvent`,
 * github.com/earendil-works/pi, MIT). pi does not export the function — only the resulting
 * `JsonAgentSessionEvent` type — so it is copied here, and it is copied rather than bypassed
 * so that `map-events.ts` keeps consuming exactly the shape it consumed over the subprocess
 * pipe: its 29 tests and every fixture in this package stay valid without a change.
 *
 * What the wire shape drops, and why (pi's own rationale, `json-event.d.ts`): every
 * `message_update` carries a CUMULATIVE `partial` snapshot of the assistant message. On a
 * pipe that is bandwidth; in-process it is a reference — but the mapper reads `usage` and
 * `assistantMessageEvent` off the top level, so the shape is what matters, not the cost.
 * `message_start` supplies the initial message and `message_end` the final one, so nothing
 * is lost. `toolcall_start` keeps the tool id and name hoisted off the partial, because those
 * are constant-size and the mapper's tool-call observation needs them.
 *
 * Every other event type passes through unchanged — `agent_end`, `agent_settled`,
 * `tool_execution_*`, `entry_appended`, `queue_update`, … — which is why an unmodelled pi
 * event still reaches the browser as `unmapped` (the design rule from `map-events.ts`).
 */
export function toRpcWireEvent(event: AgentSessionEvent): RuntimeEvent {
  if (event.type !== 'message_update') {
    // A copy, not a cast: the union's members are object literals, so the spread is an
    // open record and needs no type assertion to become the wire shape.
    return { ...event }
  }
  if (event.message.role !== 'assistant') {
    throw new Error('message_update message is not an assistant message')
  }
  return {
    type: 'message_update',
    usage: event.message.usage,
    assistantMessageEvent: stripCumulativeSnapshot(event.assistantMessageEvent),
  }
}

/** The `partial` snapshot goes; on `toolcall_start` the tool's id and name are hoisted first. */
function stripCumulativeSnapshot(
  assistantMessageEvent: AgentSessionEvent & { type: 'message_update' } extends {
    assistantMessageEvent: infer E
  }
    ? E
    : never,
): Record<string, unknown> {
  if (assistantMessageEvent.type === 'toolcall_start') {
    const toolCall = assistantMessageEvent.partial.content[assistantMessageEvent.contentIndex]
    if (toolCall?.type !== 'toolCall') {
      throw new Error(`toolcall_start content at index ${assistantMessageEvent.contentIndex} is not a tool call`)
    }
    const { partial: _partial, ...deltaEvent } = assistantMessageEvent
    return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name }
  }
  if (!('partial' in assistantMessageEvent)) {
    return assistantMessageEvent
  }
  const { partial: _partial, ...deltaEvent } = assistantMessageEvent
  return deltaEvent
}
