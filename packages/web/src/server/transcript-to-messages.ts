import {
  ENSO_TOOL_RESULT_KEY,
  type EnsoInterruptedTail,
  type EnsoTranscriptEntry,
  type EnsoTranscriptPart,
} from '@enso/core'
import type { MessagePart, UIMessage } from '@tanstack/ai-client'

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
 *
 * ⚠ The direction of travel is one-way, and since #220 that is true of the whole module and
 * not of `transcriptToMessages` alone: every fact here is READ from the entries and WRITTEN
 * in the vendor's shape. Nothing reads a vendor field to decide something of ours.
 */

/** One part as TanStack renders it. An unmodelled part renders as a marker, never vanishes. */
function messagePart(part: EnsoTranscriptPart): MessagePart {
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
  result: Extract<EnsoTranscriptEntry, { kind: 'tool-result' }>,
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
      ...(result.descriptor === undefined ? {} : { metadata: { [ENSO_TOOL_RESULT_KEY]: result.descriptor } }),
    })
    return true
  }
  return false
}

/** The transcript, root to leaf, as the messages a chat mounts with. Entries that are not messages are skipped. */
export function transcriptToMessages(transcript: readonly EnsoTranscriptEntry[]): UIMessage[] {
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
 * Whether a `tool-result` entry AFTER `messageIndex` answers `toolCallId` — the same
 * direction `attachToolResult` pairs in, so a result that precedes its call counts for
 * neither (it is dropped from the messages too).
 */
function isAnsweredAfter(
  transcript: readonly EnsoTranscriptEntry[],
  messageIndex: number,
  toolCallId: string,
): boolean {
  for (let position = messageIndex + 1; position < transcript.length; position += 1) {
    const entry = transcript[position]
    if (entry?.kind === 'tool-result' && entry.toolCallId === toolCallId) return true
  }
  return false
}

/**
 * Whether the transcript ends inside a turn (#109, `EnsoInterruptedTail`).
 *
 * ⚠ READ OFF THE ENTRIES, NEVER OFF THE MESSAGES (#220). Both vocabularies can express
 * "a call without its result", and they are not equals: `EnsoInterruptedTail` is a enso wire
 * value — it crosses on the snapshot frame and the history payload and becomes a warning
 * notice in the browser (`thread-stores.ts`) — while a `ToolCallPart.state` literal is
 * TanStack's, pinned but not ours. Deriving the wire value from the renderer's spelling made
 * a vendor rename silently change what the wire MEANS: with `complete` respelled, the
 * comparison went vacuously true and every resumed thread reported a torn tail (measured
 * before the fix). The pairing fact is the transcript's anyway — `attachToolResult` reads
 * entries to establish it.
 *
 * The last MESSAGE, not the last entry: a `custom` or `other` entry the runtime appended
 * after the turn (a model change, a compaction) is not what ended the branch.
 *
 * ⚠ Only the two shapes a next prompt would silently paper over are named. An assistant
 * reply with text and no open call reads as settled even if it was cut short — the transcript
 * carries no fact that says so, and inventing one would be a guess.
 */
export function interruptedTail(transcript: readonly EnsoTranscriptEntry[]): EnsoInterruptedTail | undefined {
  const lastMessageIndex = transcript.findLastIndex((entry) => entry.kind === 'message')
  const lastMessage = transcript[lastMessageIndex]
  if (lastMessage === undefined || lastMessage.kind !== 'message') return undefined
  if (lastMessage.role === 'user') return 'unanswered-prompt'
  for (const part of lastMessage.parts) {
    if (part.type !== 'tool-call') continue
    if (!isAnsweredAfter(transcript, lastMessageIndex, part.toolCallId)) return 'tool-call-without-result'
  }
  return undefined
}
