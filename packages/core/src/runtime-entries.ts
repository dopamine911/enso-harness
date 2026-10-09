import type { EnsoTranscriptCustom, EnsoTranscriptEntry, EnsoTranscriptPart } from './transcript.ts'

/**
 * The runtime's stored session entries → the transcript of ours (#557, after #555's rule 4).
 *
 * ⚠ THIS IS THE ONE MODULE IN `core` THAT NAMES THE RUNTIME'S ENVELOPE — `{ type, id, timestamp,
 * customType, data, message: { role, content, toolCallId, toolName, isError } }`. Every fold in
 * `core` (`recordedPermissionMode`, `sessionIncidentsOf`, `riskEventsOfTranscript`, the readers of
 * the run context, the system prompt and the project trust) takes `EnsoTranscriptEntry`, which
 * this produces. A different runtime means a different module here, and nothing else in `core`.
 *
 * Who calls it: the web host (`host/transcript.ts`, which adds what needs the vendor's types — a
 * provider refusal, a tool result's descriptor), the harness extensions on
 * `ctx.sessionManager.getBranch()` and `getEntries()`, and the corpus scripts over the omp corpus,
 * whose files are pi-shaped.
 *
 * ⚠ The runtime's shapes are carried, not modelled: every field is read defensively, and an entry
 * kind this does not model (`model_change`, `thinking_level_change`, a compaction, a label)
 * becomes `other` with its `type` — counted by the drawer, invented by nothing. A malformed
 * message is a message with an empty part list rather than a throw into a route. The output is
 * as long as the input, in the same order: a caller may zip the two.
 */

interface RuntimeSessionEntry {
  type?: unknown
  id?: unknown
  timestamp?: unknown
  customType?: unknown
  data?: unknown
  message?: unknown
}

interface RuntimeStoredMessage {
  role?: unknown
  content?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
}

/** The runtime's content parts: `{type:"text"|"thinking"|"toolCall"|"image", …}`, or a bare string for a user prompt. */
interface RuntimeContentPart {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  arguments?: unknown
  data?: unknown
  mimeType?: unknown
}

/**
 * The runtime's `content` as text: the text parts joined, a part that is not text named —
 * `[image content]` — never dropped (`transcript-reveal.ts` counts on the naming).
 *
 * @group Transcript
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as RuntimeContentPart[])
    .map((part) =>
      part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : `[${typeof part.type === 'string' ? part.type : 'unknown'} content]`,
    )
    .join('')
}

type PartNarrower = (raw: RuntimeContentPart) => EnsoTranscriptPart | undefined

/**
 * Each rendered part type's narrowing: `undefined` when the fields are not the shape that type
 * carries, so the part falls through to `other`. ⚠ Looked up through `Object.hasOwn`, so a `type`
 * of `constructor` or `toString` finds no inherited entry (#816).
 */
const PART_NARROWERS: Readonly<Record<string, PartNarrower>> = {
  text: (raw): EnsoTranscriptPart | undefined =>
    typeof raw.text === 'string' ? { type: 'text', text: raw.text } : undefined,
  thinking: (raw): EnsoTranscriptPart | undefined =>
    typeof raw.thinking === 'string' ? { type: 'thinking', thinking: raw.thinking } : undefined,
  image: (raw): EnsoTranscriptPart | undefined =>
    typeof raw.data === 'string' && typeof raw.mimeType === 'string'
      ? { type: 'image', data: raw.data, mimeType: raw.mimeType }
      : undefined,
  toolCall: (raw): EnsoTranscriptPart | undefined =>
    typeof raw.id === 'string' && typeof raw.name === 'string'
      ? { type: 'tool-call', toolCallId: raw.id, toolName: raw.name, args: raw.arguments ?? {} }
      : undefined,
}

function partOf(raw: RuntimeContentPart): EnsoTranscriptPart {
  const kind = typeof raw.type === 'string' ? raw.type : 'unknown'
  const narrowed = Object.hasOwn(PART_NARROWERS, kind) ? PART_NARROWERS[kind]?.(raw) : undefined
  return narrowed ?? { type: 'other', kind }
}

function partsOf(content: unknown): EnsoTranscriptPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const parts: EnsoTranscriptPart[] = []
  for (const raw of content as RuntimeContentPart[]) {
    if (typeof raw !== 'object' || raw === null) continue
    parts.push(partOf(raw))
  }
  return parts
}

function stampOf(entry: RuntimeSessionEntry): { at?: string } {
  return typeof entry.timestamp === 'string' ? { at: entry.timestamp } : {}
}

function messageEntry(entry: RuntimeSessionEntry, id: string): EnsoTranscriptEntry | undefined {
  if (typeof entry.message !== 'object' || entry.message === null) return undefined
  const stored = entry.message as RuntimeStoredMessage
  if (stored.role === 'user' || stored.role === 'assistant') {
    return { kind: 'message', id, ...stampOf(entry), role: stored.role, parts: partsOf(stored.content) }
  }
  if (stored.role === 'toolResult' && typeof stored.toolCallId === 'string') {
    return {
      kind: 'tool-result',
      id,
      ...stampOf(entry),
      toolCallId: stored.toolCallId,
      toolName: typeof stored.toolName === 'string' ? stored.toolName : 'unknown',
      text: contentToText(stored.content),
      isError: stored.isError === true,
    }
  }
  return undefined
}

/**
 * One stored entry → one entry of ours; never undefined, so a transcript is as long as its branch.
 * `position` names an entry the runtime left unnamed (`entry-<position>`).
 *
 * @group Transcript
 */
export function transcriptEntryOf(raw: unknown, position: number): EnsoTranscriptEntry {
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as RuntimeSessionEntry
  const id = typeof entry.id === 'string' ? entry.id : `entry-${position}`
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  if (type === 'message') {
    // A message this does not render (a role that is not user/assistant/toolResult, or a result
    // without its call id) is `other` with the role in its type — `message:system` — so the
    // drawer's row says what it was, not just that it was unknown.
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

/**
 * The runtime's branch (or its whole entry list), root to leaf, as the transcript — same length,
 * same order.
 *
 * @group Transcript
 */
export function transcriptOf(entries: readonly unknown[]): EnsoTranscriptEntry[] {
  return entries.map(transcriptEntryOf)
}

/**
 * The transcript's custom entries, in order — what the folds over extension state take
 * (`sessionIncidentsOf`, `recordedPermissionMode`, `lastCustomEntryData`).
 *
 * @group Transcript
 */
export function customEntriesOf(transcript: readonly EnsoTranscriptEntry[]): EnsoTranscriptCustom[] {
  return transcript.flatMap((transcriptEntry) => (transcriptEntry.kind === 'custom' ? [transcriptEntry] : []))
}
