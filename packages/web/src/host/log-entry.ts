/**
 * A log's entries as the host's branch readers take them (#811): the stored entry's envelope and
 * the fields the readers read, in a type of ours, so no reader names the runtime's types.
 *
 * ⚠ A SUPERTYPE OF THE RUNTIME'S ENTRY, CHECKED WHERE THE BRANCH CROSSES. Every runtime entry kind
 * and message role has a variant here, carrying the fields a reader reads and leaving the rest off.
 * The branch crosses into this type in `thread-log.ts`, and in `branch-context.ts`, which hands
 * `context-history.ts` the branch it projects: the compiler checks the runtime's entries against it
 * there, so a runtime bump that renames a read field or adds a kind fails at the seam, not inside a
 * reader. Types only: an entry is still the runtime's own object, so every reading is unchanged.
 */

/** The runtime's usage, reduced to what a reader sums. */
interface LogUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: { readonly total: number }
}

/** A reply's content part: a tool call opened, the others only told apart. */
type LogReplyPart =
  | {
      readonly type: 'toolCall'
      readonly id: string
      readonly name: string
      readonly arguments: Readonly<Record<string, unknown>>
    }
  | { readonly type: 'text' | 'thinking' }

/** A tool definition a system message adds: what the context's tool element shows and prices. */
interface LogTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

/** A stored message, by role. A `content` read only as text is `unknown`: `contentToText` decodes it. */
export type LogMessage =
  | { readonly role: 'user'; readonly content: unknown }
  | {
      readonly role: 'assistant'
      readonly content: readonly LogReplyPart[]
      readonly provider: string
      readonly model: string
      readonly usage: LogUsage
      readonly stopReason: string
    }
  | {
      readonly role: 'toolResult'
      readonly toolCallId: string
      readonly toolName: string
      readonly content: unknown
      readonly isError: boolean
      /** A summarised result's own model call. */
      readonly usage?: LogUsage
    }
  | {
      readonly role: 'system'
      readonly content: unknown
      readonly sections?: Readonly<Record<string, string | null>>
      readonly toolsAdded?: readonly LogTool[]
      readonly toolsRemoved?: readonly { readonly name: string }[]
    }
  | { readonly role: 'bashExecution' | 'custom' | 'branchSummary' | 'compactionSummary' }

interface LogEntryBase {
  readonly id: string
  /** The entry before it on the branch; `null` for the root. */
  readonly parentId: string | null
  /** When it was appended, ISO. */
  readonly timestamp: string
}

/** One stored entry, by kind. */
export type LogEntry = LogEntryBase &
  (
    | { readonly type: 'message'; readonly message: LogMessage }
    | { readonly type: 'model_change'; readonly provider: string; readonly modelId: string }
    | { readonly type: 'thinking_level_change'; readonly thinkingLevel: string }
    | { readonly type: 'custom'; readonly customType: string; readonly data?: unknown }
    | { readonly type: 'custom_message'; readonly customType: string }
    | { readonly type: 'context_edit'; readonly targetId: string; readonly replacement: unknown }
    | { readonly type: 'usage' | 'compaction' | 'branch_summary' | 'label' | 'session_info' }
  )
