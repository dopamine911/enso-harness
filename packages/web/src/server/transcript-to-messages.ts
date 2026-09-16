import type { MessagePart, UIMessage } from '@tanstack/ai-client'
import {
  ZEN_TOOL_RESULT_KEY,
  type ZenInterruptedTail,
  type ZenTranscriptEntry,
  type ZenTranscriptPart,
} from '@zen/core'

/**
 * The transcript → TanStack `UIMessage`s (#95): the history a resumed thread mounts with.
 * The read-side twin of `to-agui.ts`: that maps the LIVE stream (observations → AG-UI
 * chunks); this maps the STORED transcript (entries of ours → messages). Since #162
 * workstream 4 (L2) the entries ARE ours — the host decoded the runtime's stored shapes below
 * the seam (`host/transcript.ts`) — so this file assembles and never decodes: no vendor field
 * name, no defensive read of an unknown, and an entry kind it does not render (`custom`,
 * `other`) is skipped, not invented.
 *
 * Tool results take the shape TanStack itself normalises a stream into (`processor.js`
 * `reconcileSnapshotToolCalls`): the `tool-result` part sits in the assistant message that
 * holds the matching `tool-call`, and that call reads `complete` with the result as its
 * `output` — so a resumed transcript's step rows (#93) render exactly like a live one's.
 */

/** One part as TanStack renders it. An unmodelled part renders as a marker, never vanishes. */
function messagePart(part: ZenTranscriptPart): MessagePart {
  switch (part.type) {
    case 'text':
      return { type: 'text', content: part.text }
    case 'thinking':
      return { type: 'thinking', content: part.thinking }
    case 'image':
      return { type: 'image', source: { type: 'data', value: part.data, mimeType: part.mimeType } }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: part.toolCallId,
        name: part.toolName,
        arguments: JSON.stringify(part.args ?? {}),
        input: part.args,
        state: 'input-complete',
      }
    default:
      return { type: 'text', content: `[${part.kind} content]` }
  }
}

function createdAt(at: string | undefined): { createdAt?: Date } {
  if (at === undefined) return {}
  const parsed = new Date(at)
  return Number.isNaN(parsed.getTime()) ? {} : { createdAt: parsed }
}

/** Attach a tool result to the assistant message holding its call; false if no call is found. */
function attachToolResult(
  messages: UIMessage[],
  result: Extract<ZenTranscriptEntry, { kind: 'tool-result' }>,
): boolean {
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const candidate = messages[position]
    if (candidate === undefined || candidate.role !== 'assistant') continue
    const call = candidate.parts.find((part) => part.type === 'tool-call' && part.id === result.toolCallId)
    if (call === undefined || call.type !== 'tool-call') continue
    call.state = result.isError ? 'error' : 'complete'
    call.output = result.text
    candidate.parts.push({
      type: 'tool-result',
      toolCallId: result.toolCallId,
      name: result.toolName,
      content: result.text,
      state: result.isError ? 'error' : 'complete',
      ...(result.isError ? { error: result.text } : {}),
      ...(result.descriptor === undefined ? {} : { metadata: { [ZEN_TOOL_RESULT_KEY]: result.descriptor } }),
    })
    return true
  }
  return false
}

/** The transcript, root to leaf, as the messages a chat mounts with. Entries that are not messages are skipped. */
export function transcriptToMessages(transcript: readonly ZenTranscriptEntry[]): UIMessage[] {
  const messages: UIMessage[] = []
  for (const transcriptEntry of transcript) {
    if (transcriptEntry.kind === 'message') {
      messages.push({
        id: transcriptEntry.id,
        role: transcriptEntry.role,
        parts: transcriptEntry.parts.map(messagePart),
        ...createdAt(transcriptEntry.at),
      })
    } else if (transcriptEntry.kind === 'tool-result') {
      // A result whose call is not on the transcript (a compacted or edited history) is
      // dropped: TanStack keeps detached results verbatim, which renders as a stray row.
      attachToolResult(messages, transcriptEntry)
    }
  }
  return messages
}

/**
 * Whether the transcript ends inside a turn (#109, `ZenInterruptedTail`). Read off the mapped
 * messages, not the entries, so "a call without its result" is the same fact the step rows
 * render: a `tool-call` part `attachToolResult` never completed.
 *
 * ⚠ Only the two shapes a next prompt would silently paper over are named. An assistant
 * reply with text and no open call reads as settled even if it was cut short — the transcript
 * carries no fact that says so, and inventing one would be a guess.
 */
export function interruptedTail(messages: readonly UIMessage[]): ZenInterruptedTail | undefined {
  const last = messages.at(-1)
  if (last === undefined) return undefined
  if (last.role === 'user') return 'unanswered-prompt'
  if (last.role !== 'assistant') return undefined
  const unresolved = last.parts.some(
    (part) => part.type === 'tool-call' && part.state !== 'complete' && part.state !== 'error',
  )
  return unresolved ? 'tool-call-without-result' : undefined
}
