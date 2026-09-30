import {
  ENSO_GUARD_DENIAL_KEY,
  ENSO_PROVIDER_REFUSAL_KEY,
  ENSO_TOOL_RESULT_KEY,
  type EnsoGuardDenial,
  type EnsoInterruptedTail,
  type EnsoTranscriptEntry,
  type EnsoTranscriptPart,
  readEnsoGuardDenial,
} from '@enso/core'
import type { MessagePart, UIMessage } from '@tanstack/ai-client'

/**
 * The transcript → TanStack `UIMessage`s (#95): the history a resumed thread mounts with.
 * The read-side twin of `to-agui.ts`: that maps the LIVE stream (observations → AG-UI
 * chunks); this maps the STORED transcript (entries of ours → messages). Since #162
 * workstream 4 (L2) the entries ARE ours — the host decoded the runtime's stored shapes below
 * the seam (`host/transcript.ts`) — so this file assembles and never decodes: no vendor field
 * name, no defensive read of an unknown, and an entry kind it does not render (`other`, a
 * `custom` entry that is not a guard refusal) is skipped, not invented.
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

/** The bag a stored result carries: the #18 descriptor, and the guard's refusal (#387) — each only when there is one. */
function resultMetadata(
  result: Extract<EnsoTranscriptEntry, { kind: 'tool-result' }>,
  denial: EnsoGuardDenial | undefined,
): { metadata?: Record<string, unknown> } {
  if (result.descriptor === undefined && denial === undefined) return {}
  return {
    metadata: {
      ...(result.descriptor === undefined ? {} : { [ENSO_TOOL_RESULT_KEY]: result.descriptor }),
      ...(denial === undefined ? {} : { [ENSO_GUARD_DENIAL_KEY]: denial }),
    },
  }
}

/** Attach a tool result to the assistant message holding its call; false if no call is found. */
function attachToolResult(
  messages: UIMessage[],
  result: Extract<EnsoTranscriptEntry, { kind: 'tool-result' }>,
  denial: EnsoGuardDenial | undefined,
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
      ...resultMetadata(result, denial),
    })
    return true
  }
  return false
}

/**
 * The transcript, root to leaf, as the messages a chat mounts with. Entries that are not messages are skipped.
 *
 * @invariant resume/transcript-ours The transcript is ours; the reader assembles and never decodes.
 * Below the seam `host/transcript.ts#transcriptOf` reads the runtime's stored entries
 * defensively: same length, same order, an unmodelled kind is `other` with its `type`. Here a
 * tool result is paired into the assistant message holding its call, one whose call is not on
 * the branch is dropped, and `custom` and `other` are skipped; an image's bytes render as a data
 * URL, never a fetch (`selected-message-part.tsx`). A refused attempt (#381), which pi keeps on
 * the branch with `stopReason: "error"`, is a message carrying its `refusal`, and its bubble says
 * `<Provider> · <model> refused: <class> (<status>) — <reason>` where the reply would have been,
 * not an empty bubble. The provider is pi's display name for it (#387), from pi-ai's built-in
 * catalogue, since a cold read has no session to ask.
 */
export function transcriptToMessages(transcript: readonly EnsoTranscriptEntry[]): UIMessage[] {
  const messages: UIMessage[] = []
  // The guard writes its refusal entry before pi builds the error result (#387), so a
  // refusal is always read before the result it belongs to.
  const denials = new Map<string, EnsoGuardDenial>()
  for (const transcriptEntry of transcript) {
    if (transcriptEntry.kind === 'message') {
      messages.push({
        id: transcriptEntry.id,
        role: transcriptEntry.role,
        parts: transcriptEntry.parts.map(messagePart),
        ...createdAt(transcriptEntry.at),
        // A refused attempt (#381) says so in its own place; the bubble reads it back off the bag.
        ...(transcriptEntry.refusal === undefined
          ? {}
          : { metadata: { [ENSO_PROVIDER_REFUSAL_KEY]: transcriptEntry.refusal } }),
      })
    } else if (transcriptEntry.kind === 'custom') {
      const denial = readEnsoGuardDenial(transcriptEntry.customType, transcriptEntry.data)
      if (denial !== undefined) denials.set(denial.toolCallId, denial)
    } else if (transcriptEntry.kind === 'tool-result') {
      // A result whose call is not on the transcript (a compacted or edited history) is
      // dropped: TanStack keeps detached results verbatim, which renders as a stray row.
      attachToolResult(messages, transcriptEntry, denials.get(transcriptEntry.toolCallId))
    }
  }
  return messages
}

/**
 * Whether a `tool-result` entry AFTER `messageIndex` answers `toolCallId` — the same
 * direction `attachToolResult` pairs in, so a result that precedes its call counts for
 * neither (it is dropped from the messages too).
 */
function answerAfter(
  transcript: readonly EnsoTranscriptEntry[],
  messageIndex: number,
  toolCallId: string,
): Extract<EnsoTranscriptEntry, { kind: 'tool-result' }> | undefined {
  for (let position = messageIndex + 1; position < transcript.length; position += 1) {
    const entry = transcript[position]
    if (entry?.kind === 'tool-result' && entry.toolCallId === toolCallId) return entry
  }
  return undefined
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
 * ⚠ Only the shapes a next prompt would silently paper over are named. An assistant reply with
 * text and no open call reads as settled even if it was cut short — the transcript carries no
 * fact that says so, and inventing one would be a guess. A last turn whose calls were ALL
 * answered is torn too (PR #442 review): pi keeps the reply to the results only at its end, so a
 * kill anywhere in that model call — the longest window on a tool-using turn — leaves exactly
 * this. A Stop never does (PR #438 review, run against the real host): after the aborted results
 * pi's loop makes one more model call on the aborted signal, and persists its `aborted` error reply
 * — a stopped branch ends on an assistant message with no call, settled by the rule above. So an
 * `Operation aborted` result with nothing after it is a kill that landed before that reply: torn.
 */
export function interruptedTail(transcript: readonly EnsoTranscriptEntry[]): EnsoInterruptedTail | undefined {
  const lastMessageIndex = transcript.findLastIndex((entry) => entry.kind === 'message')
  const lastMessage = transcript[lastMessageIndex]
  if (lastMessage === undefined || lastMessage.kind !== 'message') return undefined
  if (lastMessage.role === 'user') return 'unanswered-prompt'
  const answers = lastMessage.parts.flatMap((part) =>
    part.type === 'tool-call' ? [answerAfter(transcript, lastMessageIndex, part.toolCallId)] : [],
  )
  if (answers.length === 0) return undefined
  if (answers.includes(undefined)) return 'tool-call-without-result'
  return 'tool-results-without-reply'
}
