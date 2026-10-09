import { type Static, Type } from 'typebox'
import { EnsoProviderRefusal } from './provider-refusal.ts'
import { EnsoToolResultDescriptor } from './tool-result.ts'

/**
 * The transcript (#162 workstream 4, leak L2's persistence side): a thread's branch, root to
 * leaf, as entries of OURS.
 *
 * The host reads the runtime's session log and produces these below the `AgentHost` seam;
 * nothing above it — the history route, the cold snapshot, the `?debug` drawer,
 * `enso-thread.ts`, the mode walk — sees the runtime's stored shapes.
 *
 * The same discipline as `EnsoObservation`: decoded, not carried. A message's content is
 * already parts of ours (text, thinking, an image, a tool call), a tool result is already a
 * result with its descriptor, so a reader assembles and never decodes. An entry kind the
 * host does not model crosses as `other` with its `type` — counted, never invented, and a
 * new kind in the runtime's log is a row in the drawer rather than a parse failure.
 */

/**
 * One piece of a message's content, as the runtime stored it.
 *
 * @group Transcript
 */
export const EnsoTranscriptPart = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({ type: Type.Literal('thinking'), thinking: Type.String() }),
  Type.Object({ type: Type.Literal('image'), data: Type.String(), mimeType: Type.String() }),
  Type.Object({
    type: Type.Literal('tool-call'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    args: Type.Unknown(),
  }),
  /** A content kind the host did not model; `type` says which, for a reader to mark rather than drop. */
  Type.Object({ type: Type.Literal('other'), kind: Type.String() }),
])
/** @group Transcript */
export type EnsoTranscriptPart = Static<typeof EnsoTranscriptPart>

const base = {
  id: Type.String(),
  /** ISO time the runtime stamped, when it did. */
  at: Type.Optional(Type.String()),
}

/**
 * A prompt or a reply.
 *
 * @group Transcript
 */
export const EnsoTranscriptMessage = Type.Object({
  kind: Type.Literal('message'),
  ...base,
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  parts: Type.Array(EnsoTranscriptPart),
  /**
   * The provider refused the request this reply was for (#381): an assistant message only. pi keeps
   * the failed attempt on the branch (its parts usually empty) marked as an error, so a reload has the
   * fact without anything new being persisted — without this it read as an empty reply.
   */
  refusal: Type.Optional(EnsoProviderRefusal),
})
/** @group Transcript */
export type EnsoTranscriptMessage = Static<typeof EnsoTranscriptMessage>

/**
 * A tool's answer to a call, with the rendering descriptor the tool attached (#18).
 *
 * @group Transcript
 */
export const EnsoTranscriptToolResult = Type.Object({
  kind: Type.Literal('tool-result'),
  ...base,
  toolCallId: Type.String(),
  toolName: Type.String(),
  /** The result as text — what a transcript shows and a step row's `output` reads. */
  text: Type.String(),
  isError: Type.Boolean(),
  descriptor: Type.Optional(EnsoToolResultDescriptor),
})
/** @group Transcript */
export type EnsoTranscriptToolResult = Static<typeof EnsoTranscriptToolResult>

/**
 * State an extension persisted (`pi.appendEntry`): the shape belongs to the extension.
 *
 * @group Transcript
 */
export const EnsoTranscriptCustom = Type.Object({
  kind: Type.Literal('custom'),
  ...base,
  customType: Type.String(),
  data: Type.Unknown(),
})
/** @group Transcript */
export type EnsoTranscriptCustom = Static<typeof EnsoTranscriptCustom>

/**
 * An entry kind the host does not model — a model change, a compaction, a label. Counted, never invented.
 *
 * @group Transcript
 */
export const EnsoTranscriptOther = Type.Object({
  kind: Type.Literal('other'),
  ...base,
  type: Type.String(),
})
/** @group Transcript */
export type EnsoTranscriptOther = Static<typeof EnsoTranscriptOther>

/** @group Transcript */
export const EnsoTranscriptEntry = Type.Union([
  EnsoTranscriptMessage,
  EnsoTranscriptToolResult,
  EnsoTranscriptCustom,
  EnsoTranscriptOther,
])
/** @group Transcript */
export type EnsoTranscriptEntry = Static<typeof EnsoTranscriptEntry>

/**
 * One entry as a row — `12:34:56 message user`, `12:34:56 custom:modes mode=plan` — THE
 * definition: the drawer and `enso-thread.ts` had one each and had drifted.
 * A custom entry's `data.mode` is shown when present because the drawer's one use of this
 * row is checking which mode the branch ended in; the entry's own shape is otherwise not
 * this function's to know.
 */
function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** @group Transcript */
export function describeTranscriptEntry(entry: EnsoTranscriptEntry): string {
  const when = entry.at === undefined ? '' : entry.at.slice(11, 19)
  switch (entry.kind) {
    case 'message': {
      // A refused attempt (#381) says so, as a tool result says ` error`: the log bundle and the
      // drawer are where this bug is read, and a plain `message assistant` reads as a reply.
      const refused =
        entry.refusal === undefined
          ? ''
          : ` refused${entry.refusal.status === undefined ? '' : ` (${entry.refusal.status})`}`
      return `${when} message ${entry.role}${refused}`.trim()
    }
    case 'tool-result':
      return `${when} tool-result ${entry.toolName}${entry.isError ? ' error' : ''}`.trim()
    case 'custom': {
      // A primitive `mode` only: an object would print as `[object Object]`, which reads as a row lying.
      const mode =
        typeof entry.data === 'object' && entry.data !== null && 'mode' in entry.data && isPrimitive(entry.data.mode)
          ? ` mode=${String(entry.data.mode)}`
          : ''
      return `${when} custom:${entry.customType}${mode}`.trim()
    }
    case 'other':
      return `${when} ${entry.type}`.trim()
  }
}
