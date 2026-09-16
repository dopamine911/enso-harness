import { type Static, Type } from 'typebox'
import { ZenToolResultDescriptor } from './tool-result.ts'

/**
 * The transcript (#162 workstream 4, leak L2's persistence side): a thread's branch, root to
 * leaf, as entries of OURS. The host reads the runtime's session log and produces these
 * below the `AgentHost` seam; nothing above it — the history route, the cold snapshot, the
 * `?debug` drawer, `zen-thread.mjs`, the mode walk — sees the runtime's stored shapes.
 *
 * The same discipline as `ZenObservation`: decoded, not carried. A message's content is
 * already parts of ours (text, thinking, an image, a tool call), a tool result is already a
 * result with its descriptor, so a reader assembles and never decodes. An entry kind the
 * host does not model crosses as `other` with its `type` — counted, never invented, and a
 * new kind in the runtime's log is a row in the drawer rather than a parse failure.
 */

/** One piece of a message's content, as the runtime stored it. */
export const ZenTranscriptPart = Type.Union([
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
export type ZenTranscriptPart = Static<typeof ZenTranscriptPart>

const base = {
  id: Type.String(),
  /** ISO time the runtime stamped, when it did. */
  at: Type.Optional(Type.String()),
}

/** A prompt or a reply. */
export const ZenTranscriptMessage = Type.Object({
  kind: Type.Literal('message'),
  ...base,
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  parts: Type.Array(ZenTranscriptPart),
})
export type ZenTranscriptMessage = Static<typeof ZenTranscriptMessage>

/** A tool's answer to a call, with the rendering descriptor the tool attached (#18). */
export const ZenTranscriptToolResult = Type.Object({
  kind: Type.Literal('tool-result'),
  ...base,
  toolCallId: Type.String(),
  toolName: Type.String(),
  /** The result as text — what a transcript shows and a step row's `output` reads. */
  text: Type.String(),
  isError: Type.Boolean(),
  descriptor: Type.Optional(ZenToolResultDescriptor),
})
export type ZenTranscriptToolResult = Static<typeof ZenTranscriptToolResult>

/** State an extension persisted (`pi.appendEntry`): the shape belongs to the extension. */
export const ZenTranscriptCustom = Type.Object({
  kind: Type.Literal('custom'),
  ...base,
  customType: Type.String(),
  data: Type.Unknown(),
})
export type ZenTranscriptCustom = Static<typeof ZenTranscriptCustom>

/** An entry kind the host does not model — a model change, a compaction, a label. Counted, never invented. */
export const ZenTranscriptOther = Type.Object({
  kind: Type.Literal('other'),
  ...base,
  type: Type.String(),
})
export type ZenTranscriptOther = Static<typeof ZenTranscriptOther>

export const ZenTranscriptEntry = Type.Union([
  ZenTranscriptMessage,
  ZenTranscriptToolResult,
  ZenTranscriptCustom,
  ZenTranscriptOther,
])
export type ZenTranscriptEntry = Static<typeof ZenTranscriptEntry>

/**
 * One entry as a row — `12:34:56 message user`, `12:34:56 custom:modes mode=plan` — THE
 * definition (PR #100 review): the drawer and `zen-thread.mjs` had one each and had drifted.
 * A custom entry's `data.mode` is shown when present because the drawer's one use of this
 * row is checking which mode the branch ended in; the entry's own shape is otherwise not
 * this function's to know.
 */
export function describeTranscriptEntry(entry: ZenTranscriptEntry): string {
  const when = entry.at === undefined ? '' : entry.at.slice(11, 19)
  switch (entry.kind) {
    case 'message':
      return `${when} message ${entry.role}`.trim()
    case 'tool-result':
      return `${when} tool-result ${entry.toolName}${entry.isError ? ' error' : ''}`.trim()
    case 'custom': {
      const mode =
        typeof entry.data === 'object' && entry.data !== null && 'mode' in entry.data
          ? ` mode=${String(entry.data.mode)}`
          : ''
      return `${when} custom:${entry.customType}${mode}`.trim()
    }
    case 'other':
      return `${when} ${entry.type}`.trim()
  }
}
