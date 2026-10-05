import { estimateTokens, type ProjectedSessionEntry } from '@earendil-works/pi-coding-agent'
import {
  base64DecodedBytes,
  contentToText,
  ENSO_CONTEXT_IMAGE_PREVIEW_BYTES,
  type EnsoContextAddition,
  type EnsoContextBody,
  type EnsoContextCategory,
  type EnsoContextElement,
  type EnsoContextImage,
  type EnsoContextMakeup,
  estimateTextTokens,
  summarizeToolInput,
} from '@enso/core'

/**
 * A request's context as ELEMENTS (#361) — dsh-context's browser rows: a prompt section, a tool
 * definition, a message, a tool result — and the prices the makeup sums, so the trend's bars and
 * the browser's rows are one computation, not two that could drift.
 *
 * ⚠ THE SYSTEM PROMPT IS WHAT pi SENDS, FOLDED. A later system message is a DELTA, not an
 * addition: pi writes one whenever the prompt changes (`agent-session.js`
 * `_preparePromptAndToolLoadout` → `diffSystemPromptSections`), and pi-ai replays every system
 * message into ONE head before the request (`getCurrentSystemMessage`, `utils/transcript.js`):
 * content appended, a section patched by name (`null` deletes it), `toolsRemoved` then
 * `toolsAdded` by name. That head is what every model here receives — mid-conversation system
 * messages are off unless a model's compat says otherwise (`supportsMidConvoSystemMessages`,
 * default false; none of ours sets it). So `foldSystem` makes the same head, and its elements
 * are keyed by NAME (`system:section:<name>`), never by the entry that carried them: a
 * compaction re-issues the folded prompt under its own entry (`session-manager.js`
 * `appendCompaction`), and a prompt that did not move must not read as entered and left.
 *
 * The head's elements: its instructions (`system`), each section — pi's own (`preamble`,
 * `tools`, `rules`, `docs`, `cwd`, `buildSystemPromptSections`) `system`, any other `injected` —
 * and each tool definition (`tools`). Each is priced as pi prices text, characters over four
 * rounded up — `@enso/core`'s `estimateTextTokens`, the one the prompt library's sizes use (#443),
 * so an editor and this tab cannot disagree about the same text; every other message is ONE
 * element, priced by pi's `estimateTokens`.
 */

// pi-coding-agent does not re-export pi-agent-core's `AgentMessage`; the projection's entry type,
// which it does export, names it.
export type ContextMessage = ProjectedSessionEntry['messages'][number]
type SystemMessage = Extract<ContextMessage, { role: 'system' }>
type SystemTool = NonNullable<SystemMessage['toolsAdded']>[number]

/** What an element is made of, before it is described. */
type ItemSource =
  | { readonly kind: 'message'; readonly message: ContextMessage }
  | { readonly kind: 'instructions'; readonly text: string }
  | { readonly kind: 'section'; readonly name: string; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: SystemTool }

/** One element, priced: enough for the makeup; `describeItem` makes it a browser row. */
export interface ContextItem {
  readonly key: string
  readonly category: EnsoContextCategory
  readonly tokens: number
  readonly source: ItemSource
}

const BASE_SECTIONS: Readonly<Record<string, true>> = Object.fromEntries(
  ['preamble', 'tools', 'rules', 'docs', 'cwd'].map((sectionName) => [sectionName, true]),
)

/** The category of every message role but `system`, which is split into elements. */
const CATEGORY_OF_ROLE: Readonly<Record<string, EnsoContextCategory>> = {
  user: 'user',
  bashExecution: 'user',
  assistant: 'assistant',
  toolResult: 'toolResults',
  custom: 'injected',
  branchSummary: 'injected',
  compactionSummary: 'injected',
}

const LABEL_MAX = 80
const REPLY_MAX = 120

/** The first line of `text`, clipped — a row and a brief line are one line. */
function firstLine(text: string, maximum: number = LABEL_MAX): string {
  const line = (text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '').trim()
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line
}

/** The key every element of the folded system prompt starts with — the brief's "system prompt" line opens them all. */
export const SYSTEM_KEY = 'system'

/** A system message as the fold reads it: the message, and when its entry was stored. */
export interface SystemSource {
  readonly message: SystemMessage
  readonly at: string
}

/** A folded element, and when the message that last set it was stored. */
export interface SystemItem {
  readonly item: ContextItem
  readonly at: string
}

/** The system messages of a projection's entries, in order — the fold's input. */
export function systemSources(entries: readonly ProjectedSessionEntry[]): SystemSource[] {
  return entries.flatMap(({ sourceEntry, messages }) =>
    messages.flatMap((message) => (message.role === 'system' ? [{ message, at: sourceEntry.timestamp }] : [])),
  )
}

/** The head pi sends, replayed: every text it appends, each section and tool by name, with when each was last set. */
interface ReplayedSystem {
  readonly instructions: string[]
  instructionsAt: string
  readonly sections: Map<string, { text: string; at: string }>
  readonly tools: Map<string, { tool: SystemTool; at: string }>
}

/** One system message applied to the replay, as `getCurrentSystemMessage` applies it. */
function replay(replayed: ReplayedSystem, { message, at }: SystemSource): void {
  const text = contentToText(message.content)
  if (text.length > 0) {
    replayed.instructions.push(text)
    replayed.instructionsAt = at
  }
  for (const [sectionName, section] of Object.entries(message.sections ?? {})) {
    if (section === null) replayed.sections.delete(sectionName)
    else replayed.sections.set(sectionName, { text: section, at })
  }
  for (const tool of message.toolsRemoved ?? []) replayed.tools.delete(tool.name)
  for (const tool of message.toolsAdded ?? []) replayed.tools.set(tool.name, { tool, at })
}

/** A folded text element: priced as pi prices text. */
function textItem(key: string, category: EnsoContextCategory, source: ItemSource & { text: string }): ContextItem {
  return { key: `${SYSTEM_KEY}:${key}`, category, tokens: estimateTextTokens(source.text), source }
}

/**
 * Every system message replayed into the one head pi sends (header): content appended, a section
 * set or deleted by name, a tool removed or set by name — each element keyed by what it is.
 */
export function foldSystem(sources: readonly SystemSource[]): SystemItem[] {
  const replayed: ReplayedSystem = { instructions: [], instructionsAt: '', sections: new Map(), tools: new Map() }
  for (const source of sources) replay(replayed, source)
  const folded: SystemItem[] = []
  if (replayed.instructions.length > 0) {
    const text = replayed.instructions.join('\n\n')
    folded.push({
      item: textItem('instructions', 'system', { kind: 'instructions', text }),
      at: replayed.instructionsAt,
    })
  }
  for (const [sectionName, { text: sectionText, at }] of replayed.sections) {
    const category = BASE_SECTIONS[sectionName] === true ? 'system' : 'injected'
    folded.push({
      item: textItem(`section:${sectionName}`, category, { kind: 'section', name: sectionName, text: sectionText }),
      at,
    })
  }
  for (const [toolName, { tool, at }] of replayed.tools) {
    const item: ContextItem = {
      key: `${SYSTEM_KEY}:tool:${toolName}`,
      category: 'tools',
      tokens: estimateTextTokens(JSON.stringify(tool)),
      source: { kind: 'tool', tool },
    }
    folded.push({ item, at })
  }
  return folded
}

/** A folded element's content, to tell one that changed from one that stayed. */
function systemText(source: ItemSource): string {
  if (source.kind === 'tool') return JSON.stringify(source.tool)
  return source.kind === 'message' ? '' : source.text
}

/** Whether `folded` holds this element unchanged — the same key, the same content. */
export function heldUnchanged(folded: readonly SystemItem[], contextItem: ContextItem): boolean {
  const held = folded.find((candidate) => candidate.item.key === contextItem.key)
  return held !== undefined && systemText(held.item.source) === systemText(contextItem.source)
}

/** A folded element as one line: the brief's "In" row, a request's "left" list. */
export function systemLine(contextItem: ContextItem): EnsoContextAddition {
  const { key, category, source } = contextItem
  if (source.kind === 'tool') return { category, label: `tool ${source.tool.name}`, key }
  return { category, label: source.kind === 'section' ? `system: ${source.name}` : 'system: instructions', key }
}

/** An entry's elements but its system messages, in order — those are the fold's (header). */
export function contextItems(projected: ProjectedSessionEntry): ContextItem[] {
  const items: ContextItem[] = []
  for (const [messageIndex, message] of projected.messages.entries()) {
    const category = CATEGORY_OF_ROLE[message.role]
    if (category === undefined) continue
    const key = `${projected.sourceEntry.id}#${messageIndex}`
    items.push({ key, category, tokens: estimateTokens(message), source: { kind: 'message', message } })
  }
  return items
}

export function emptyMakeup(): EnsoContextMakeup {
  return { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 }
}

export function makeupOf(items: Iterable<ContextItem>): EnsoContextMakeup {
  const makeup = emptyMakeup()
  for (const contextItem of items) makeup[contextItem.category] += contextItem.tokens
  return makeup
}

/** Every call the context has made: its subject (`ls -la`) for a label, its arguments for the result's row. */
export interface CallIndex {
  readonly subjects: Map<string, string>
  readonly arguments: Map<string, unknown>
}

export function emptyCallIndex(): CallIndex {
  return { subjects: new Map(), arguments: new Map() }
}

/** Note each call a reply makes, so its result can be named by it and shown beside it. */
export function noteCalls(message: ContextMessage, calls: CallIndex): void {
  if (message.role !== 'assistant') return
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue
    calls.arguments.set(part.id, part.arguments)
    const subject = summarizeToolInput(part.arguments)
    if (subject !== undefined) calls.subjects.set(part.id, subject)
  }
}

/** A reply's first line of text, clipped; empty when it wrote none — the brief's "Reply" row. */
export function replyText(message: Extract<ContextMessage, { role: 'assistant' }>): string {
  const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  return firstLine(text, REPLY_MAX)
}

/** A reply's first line of text; failing that, the tools it called. */
function replyLine(message: Extract<ContextMessage, { role: 'assistant' }>): string {
  const line = replyText(message)
  if (line !== '') return line
  const calls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : []))
  return calls.length === 0 ? '(thinking)' : `calls ${calls.join(', ')}`
}

/**
 * One line naming a whole message, and the key of its elements — the brief's "In" row, and a
 * request's "left" list. A tool result is named by its call's subject (`bash ls -la`), as the
 * transcript's step row names it.
 */
export function messageLine(message: ContextMessage, calls: CallIndex, key: string): EnsoContextAddition {
  switch (message.role) {
    // A system message is the fold's (header), never a line of its own; named for completeness.
    case 'system':
      return { category: 'system', label: 'system prompt', key }
    case 'user':
      return { category: 'user', label: firstLine(contentToText(message.content)), key }
    case 'bashExecution':
      return { category: 'user', label: firstLine(`!${message.command}`), key }
    case 'assistant':
      return { category: 'assistant', label: replyLine(message), key }
    case 'toolResult': {
      const subject = calls.subjects.get(message.toolCallId) ?? contentToText(message.content)
      return { category: 'toolResults', label: firstLine(`${message.toolName} ${subject}`), key }
    }
    case 'custom':
      return { category: 'injected', label: message.customType, key }
    case 'compactionSummary':
      return { category: 'injected', label: 'compaction summary', key }
    default:
      return { category: 'injected', label: 'branch summary', key }
  }
}

// ── rows ───────────────────────────────────────────────────────────────────────────────────

interface PiContentPart {
  readonly type?: unknown
  readonly text?: unknown
  readonly data?: unknown
  readonly mimeType?: unknown
}

/** A message's text parts, joined; its images described, with bytes when small (`EnsoContextImage`). */
function textAndImages(content: unknown): { text: string; images: EnsoContextImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: EnsoContextImage[] = []
  for (const part of content as PiContentPart[]) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    if (part.type !== 'image' || typeof part.data !== 'string' || typeof part.mimeType !== 'string') continue
    const bytes = base64DecodedBytes(part.data)
    images.push({
      mimeType: part.mimeType,
      bytes,
      ...(bytes <= ENSO_CONTEXT_IMAGE_PREVIEW_BYTES ? { data: part.data } : {}),
    })
  }
  return { text: texts.join('\n'), images }
}

function messageBody(message: ContextMessage, calls: CallIndex): EnsoContextBody {
  switch (message.role) {
    case 'assistant':
      return {
        kind: 'reply',
        parts: message.content.map((part) => {
          if (part.type === 'toolCall') return { type: 'toolCall', name: part.name, arguments: part.arguments }
          return part.type === 'thinking'
            ? { type: 'thinking', text: part.thinking }
            : { type: 'text', text: part.text }
        }),
      }
    case 'toolResult': {
      const callArguments = calls.arguments.get(message.toolCallId)
      return {
        kind: 'toolResult',
        toolName: message.toolName,
        ...(callArguments === undefined ? {} : { arguments: callArguments }),
        isError: message.isError,
        ...textAndImages(message.content),
      }
    }
    case 'bashExecution':
      return { kind: 'text', text: `$ ${message.command}\n\n${message.output}`, images: [] }
    case 'compactionSummary':
    case 'branchSummary':
      return { kind: 'text', text: message.summary, images: [] }
    default:
      return { kind: 'text', ...textAndImages(message.content) }
  }
}

/** An element as the browser draws it: a label and a body; `entered` is the caller's to say. */
export function describeItem(item: ContextItem, calls: CallIndex): Omit<EnsoContextElement, 'entered' | 'at'> {
  const { key, category, tokens, source } = item
  switch (source.kind) {
    case 'instructions':
      return {
        key,
        category,
        tokens,
        label: 'instructions',
        body: { kind: 'text', text: source.text, images: [] },
      }
    case 'section':
      return {
        key,
        category,
        tokens,
        label: source.name,
        body: { kind: 'text', text: source.text, images: [] },
      }
    case 'tool':
      return {
        key,
        category,
        tokens,
        label: source.tool.name,
        body: {
          kind: 'tool',
          name: source.tool.name,
          description: source.tool.description,
          parameters: source.tool.parameters,
        },
      }
    default:
      return {
        key,
        category,
        tokens,
        label: messageLine(source.message, calls, key).label,
        body: messageBody(source.message, calls),
      }
  }
}
