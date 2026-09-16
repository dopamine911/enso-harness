import type { MessagePart, UIMessage } from '@tanstack/ai-client'
import type { ZenInterruptedTail } from '@zen/core'
// L2-P's crossing: these read the runtime's stored content parts, which is why they live below
// the seam; this file follows them there when it reads a transcript of ours instead.
import { contentToText, descriptorFrom, toolResultMetadata } from '../host/map-events.ts'

/**
 * pi's session branch → TanStack `UIMessage`s (#95): the history a resumed thread mounts
 * with. The read-side twin of `to-agui.ts`: that maps the LIVE stream (rpc events → AG-UI
 * chunks); this maps the STORED branch (session entries → messages). Neither shape is
 * stored by zen — pi's entries are the durable form, TanStack's is the browser's.
 *
 * ⚠ pi's shapes are carried, not modelled (`thread-runtime.ts`): every field is read defensively,
 * and an entry this surface does not render (`model_change`, `thinking_level_change`,
 * picc's `modes`, compaction summaries) is skipped, not invented. A malformed message
 * renders as an empty part list rather than throwing into the page.
 *
 * Tool results take the shape TanStack itself normalises a stream into (`processor.js`
 * `reconcileSnapshotToolCalls`): the `tool-result` part sits in the assistant message that
 * holds the matching `tool-call`, and that call reads `complete` with the result as its
 * `output` — so a resumed transcript's step rows (#93) render exactly like a live one's.
 */

interface PiSessionEntry {
  type?: unknown
  id?: unknown
  timestamp?: unknown
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

interface PiAssistantContentPart {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  arguments?: unknown
}

/** pi's user content: `string`, or `[{type:"text", text}, {type:"image", data, mimeType}, …]` (`UserMessage` in pi-ai). */
interface PiUserContentPart {
  type?: unknown
  text?: unknown
  data?: unknown
  mimeType?: unknown
}

/**
 * A stored user message as parts: its text, and each image pi kept beside it (#68) as a
 * TanStack `ImagePart` with a `data` source — the bytes ARE in the session file (pi stores
 * the prompt's images in the user entry), so a reload shows the user's image without the
 * browser holding anything. Unknown part kinds render as text markers, as `contentToText`
 * does, rather than vanishing.
 */
function userParts(content: unknown): MessagePart[] {
  if (typeof content === 'string') return [{ type: 'text', content }]
  if (!Array.isArray(content)) return [{ type: 'text', content: '' }]
  const parts: MessagePart[] = []
  for (const raw of content as PiUserContentPart[]) {
    if (typeof raw !== 'object' || raw === null) continue
    if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', content: raw.text })
    else if (raw.type === 'image' && typeof raw.data === 'string' && typeof raw.mimeType === 'string') {
      parts.push({ type: 'image', source: { type: 'data', value: raw.data, mimeType: raw.mimeType } })
    } else parts.push({ type: 'text', content: `[${typeof raw.type === 'string' ? raw.type : 'unknown'} content]` })
  }
  return parts
}

function assistantParts(content: unknown): MessagePart[] {
  if (!Array.isArray(content)) return []
  const parts: MessagePart[] = []
  for (const raw of content as PiAssistantContentPart[]) {
    if (typeof raw !== 'object' || raw === null) continue
    if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', content: raw.text })
    else if (raw.type === 'thinking' && typeof raw.thinking === 'string') {
      parts.push({ type: 'thinking', content: raw.thinking })
    } else if (raw.type === 'toolCall' && typeof raw.id === 'string' && typeof raw.name === 'string') {
      parts.push({
        type: 'tool-call',
        id: raw.id,
        name: raw.name,
        arguments: JSON.stringify(raw.arguments ?? {}),
        input: raw.arguments,
        state: 'input-complete',
      })
    }
  }
  return parts
}

function createdAt(entry: PiSessionEntry): Date | undefined {
  if (typeof entry.timestamp !== 'string') return undefined
  const parsed = new Date(entry.timestamp)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** Attach a stored tool result to the assistant message holding its call; false if no call is found. */
function attachToolResult(messages: UIMessage[], stored: PiStoredMessage): boolean {
  if (typeof stored.toolCallId !== 'string') return false
  const toolName = typeof stored.toolName === 'string' ? stored.toolName : 'unknown'
  const text = contentToText(stored.content)
  const isError = stored.isError === true
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const candidate = messages[position]
    if (candidate === undefined || candidate.role !== 'assistant') continue
    const call = candidate.parts.find((part) => part.type === 'tool-call' && part.id === stored.toolCallId)
    if (call === undefined || call.type !== 'tool-call') continue
    call.state = isError ? 'error' : 'complete'
    call.output = text
    const metadata = toolResultMetadata(descriptorFrom(toolName, stored.details))
    candidate.parts.push({
      type: 'tool-result',
      toolCallId: stored.toolCallId,
      name: toolName,
      content: text,
      state: isError ? 'error' : 'complete',
      ...(isError ? { error: text } : {}),
      ...(metadata === undefined ? {} : { metadata }),
    })
    return true
  }
  return false
}

/** The branch, root to leaf, as the messages a chat mounts with. Entries that are not messages are skipped. */
export function branchToMessages(branch: readonly unknown[]): UIMessage[] {
  const messages: UIMessage[] = []
  for (const raw of branch) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as PiSessionEntry
    if (entry.type !== 'message' || typeof entry.message !== 'object' || entry.message === null) continue
    const stored = entry.message as PiStoredMessage
    const id = typeof entry.id === 'string' ? entry.id : `entry-${messages.length}`
    const at = createdAt(entry)
    if (stored.role === 'user') {
      messages.push({
        id,
        role: 'user',
        parts: userParts(stored.content),
        ...(at === undefined ? {} : { createdAt: at }),
      })
    } else if (stored.role === 'assistant') {
      messages.push({
        id,
        role: 'assistant',
        parts: assistantParts(stored.content),
        ...(at === undefined ? {} : { createdAt: at }),
      })
    } else if (stored.role === 'toolResult') {
      // A result whose call is not on the branch (a compacted or edited history) is
      // dropped: TanStack keeps detached results verbatim, which renders as a stray row.
      attachToolResult(messages, stored)
    }
  }
  return messages
}

/**
 * Whether the branch ends inside a turn (#109, `ZenInterruptedTail`). Read off the mapped
 * messages, not the raw entries, so "a call without its result" is the same fact the step
 * rows render: a `tool-call` part `attachToolResult` never completed.
 *
 * ⚠ Only the two shapes a next prompt would silently paper over are named. An assistant
 * reply with text and no open call reads as settled even if it was cut short — the branch
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
