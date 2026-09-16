import type { ZenTranscriptEntry, ZenTranscriptPart } from '@zen/core'
import { contentToText, descriptorFrom } from './map-events.ts'

/**
 * The runtime's session branch → the transcript of ours (#162 workstream 4, L2's persistence
 * side). This is where the runtime's stored entry shapes are read, and the only place above
 * `session-events.ts` that reads them: `AgentHost.readTranscript` and a hosted thread's
 * `inspect()` hand out what this produces, and nothing above the seam decodes a stored
 * entry again.
 *
 * ⚠ The runtime's shapes are carried, not modelled: every field is read defensively, and an
 * entry kind this does not model (`model_change`, `thinking_level_change`, a compaction, a
 * label) becomes `other` with its `type` — counted by the drawer, invented by nothing. A
 * malformed message is a message with an empty part list rather than a throw into a route.
 */

interface PiSessionEntry {
  type?: unknown
  id?: unknown
  timestamp?: unknown
  customType?: unknown
  data?: unknown
  message?: unknown
}

interface PiStoredMessage {
  role?: unknown
  content?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
  details?: unknown
}

/** The runtime's content parts: `{type:"text"|"thinking"|"toolCall"|"image", …}`, or a bare string for a user prompt. */
interface PiContentPart {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  arguments?: unknown
  data?: unknown
  mimeType?: unknown
}

function partsOf(content: unknown): ZenTranscriptPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const parts: ZenTranscriptPart[] = []
  for (const raw of content as PiContentPart[]) {
    if (typeof raw !== 'object' || raw === null) continue
    if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', text: raw.text })
    else if (raw.type === 'thinking' && typeof raw.thinking === 'string') {
      parts.push({ type: 'thinking', thinking: raw.thinking })
    } else if (raw.type === 'image' && typeof raw.data === 'string' && typeof raw.mimeType === 'string') {
      parts.push({ type: 'image', data: raw.data, mimeType: raw.mimeType })
    } else if (raw.type === 'toolCall' && typeof raw.id === 'string' && typeof raw.name === 'string') {
      parts.push({ type: 'tool-call', toolCallId: raw.id, toolName: raw.name, args: raw.arguments ?? {} })
    } else parts.push({ type: 'other', kind: typeof raw.type === 'string' ? raw.type : 'unknown' })
  }
  return parts
}

function stampOf(entry: PiSessionEntry): { at?: string } {
  return typeof entry.timestamp === 'string' ? { at: entry.timestamp } : {}
}

function messageEntry(entry: PiSessionEntry, id: string): ZenTranscriptEntry | undefined {
  if (typeof entry.message !== 'object' || entry.message === null) return undefined
  const stored = entry.message as PiStoredMessage
  if (stored.role === 'user' || stored.role === 'assistant') {
    return { kind: 'message', id, ...stampOf(entry), role: stored.role, parts: partsOf(stored.content) }
  }
  if (stored.role === 'toolResult' && typeof stored.toolCallId === 'string') {
    const toolName = typeof stored.toolName === 'string' ? stored.toolName : 'unknown'
    const descriptor = descriptorFrom(toolName, stored.details)
    return {
      kind: 'tool-result',
      id,
      ...stampOf(entry),
      toolCallId: stored.toolCallId,
      toolName,
      text: contentToText(stored.content),
      isError: stored.isError === true,
      ...(descriptor === undefined ? {} : { descriptor }),
    }
  }
  return undefined
}

/** One stored entry → one entry of ours; never undefined, so the transcript is as long as the branch. */
function transcriptEntryOf(raw: unknown, position: number): ZenTranscriptEntry {
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as PiSessionEntry
  const id = typeof entry.id === 'string' ? entry.id : `entry-${position}`
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  if (type === 'message') {
    // A message this does not render (a role that is not user/assistant/toolResult, or a
    // result without its call id) is `other` with the role in its type — `message:system` —
    // so the drawer's row says what it was, not just that it was unknown.
    const role =
      typeof entry.message === 'object' && entry.message !== null && 'role' in entry.message
        ? String(entry.message.role)
        : 'malformed'
    return messageEntry(entry, id) ?? { kind: 'other', id, ...stampOf(entry), type: `message:${role}` }
  }
  if (type === 'custom' && typeof entry.customType === 'string') {
    return { kind: 'custom', id, ...stampOf(entry), customType: entry.customType, data: entry.data }
  }
  return { kind: 'other', id, ...stampOf(entry), type }
}

/** The branch, root to leaf, as the transcript — same length, same order. */
export function transcriptOf(branch: readonly unknown[]): ZenTranscriptEntry[] {
  return branch.map(transcriptEntryOf)
}
