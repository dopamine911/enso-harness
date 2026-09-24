import { estimateTokens, type ProjectedSessionEntry } from '@earendil-works/pi-coding-agent'
import {
  base64DecodedBytes,
  ENSO_CONTEXT_IMAGE_PREVIEW_BYTES,
  type EnsoContextAddition,
  type EnsoContextBody,
  type EnsoContextCategory,
  type EnsoContextElement,
  type EnsoContextImage,
  type EnsoContextMakeup,
  summarizeToolInput,
} from '@enso/core'
import { contentToText } from './map-events.ts'

/**
 * A request's context as ELEMENTS (#361) — dsh-context's browser rows: a prompt section, a tool
 * definition, a message, a tool result — and the prices the makeup sums, so the trend's bars and
 * the browser's rows are one computation, not two that could drift.
 *
 * A system message is several elements: its instructions, each section, each tool it declares.
 * The LEADING one is the prompt — its instructions and pi's own sections (`preamble`, `tools`,
 * `rules`, `docs`, `cwd`, pi's `buildSystemPromptSections`) are `system`, every other section
 * `injected`; a later one changes the prompt from that point on, so all of its text is `injected`.
 * Tool definitions are `tools` either way. Each element is priced as pi prices text, characters
 * over four rounded up; every other message is ONE element, priced by pi's `estimateTokens`.
 */

// pi-coding-agent does not re-export pi-agent-core's `AgentMessage`; the projection's entry type,
// which it does export, names it.
export type ContextMessage = ProjectedSessionEntry['messages'][number]
type SystemMessage = Extract<ContextMessage, { role: 'system' }>
type SystemTool = NonNullable<SystemMessage['toolsAdded']>[number]

/** What an element is made of, before it is described. */
type ItemSource =
  | { readonly kind: 'message'; readonly message: ContextMessage }
  | { readonly kind: 'instructions'; readonly text: string; readonly later: boolean }
  | { readonly kind: 'section'; readonly name: string; readonly text: string; readonly later: boolean }
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

const tokensOf = (characters: number): number => Math.ceil(characters / 4)

/** The first line of `text`, clipped — a row and a brief line are one line. */
export function firstLine(text: string, maximum: number = LABEL_MAX): string {
  const line = (text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '').trim()
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line
}

function systemItems(message: SystemMessage, leading: boolean, key: string): ContextItem[] {
  const items: ContextItem[] = []
  const instructions = contentToText(message.content)
  if (instructions.length > 0) {
    items.push({
      key: `${key}:instructions`,
      category: leading ? 'system' : 'injected',
      tokens: tokensOf(instructions.length),
      source: { kind: 'instructions', text: instructions, later: !leading },
    })
  }
  for (const [sectionName, section] of Object.entries(message.sections ?? {})) {
    if (section === null) continue
    items.push({
      key: `${key}:section:${sectionName}`,
      category: leading && BASE_SECTIONS[sectionName] === true ? 'system' : 'injected',
      tokens: tokensOf(section.length),
      source: { kind: 'section', name: sectionName, text: section, later: !leading },
    })
  }
  for (const tool of message.toolsAdded ?? []) {
    items.push({
      key: `${key}:tool:${tool.name}`,
      category: 'tools',
      tokens: tokensOf(JSON.stringify(tool).length),
      source: { kind: 'tool', tool },
    })
  }
  return items
}

/** An entry's elements, in order; the first system message among them leads when `leading`. */
export function contextItems(projected: ProjectedSessionEntry, leading: boolean): ContextItem[] {
  const items: ContextItem[] = []
  let first = leading
  for (const [messageIndex, message] of projected.messages.entries()) {
    const key = `${projected.sourceEntry.id}#${messageIndex}`
    if (message.role === 'system') {
      items.push(...systemItems(message, first, key))
      first = false
      continue
    }
    const category = CATEGORY_OF_ROLE[message.role]
    if (category !== undefined)
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

/** A reply's first line of text; failing that, the tools it called. */
function replyLine(message: Extract<ContextMessage, { role: 'assistant' }>): string {
  const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  const line = firstLine(text, REPLY_MAX)
  if (line !== '') return line
  const calls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : []))
  return calls.length === 0 ? '(thinking)' : `calls ${calls.join(', ')}`
}

/**
 * One line naming a whole message, and the key of its elements — the brief's "In" row, and a
 * request's "left" list. A tool result is named by its call's subject (`bash ls -la`), as the
 * transcript's step row names it.
 */
export function messageLine(
  message: ContextMessage,
  leading: boolean,
  calls: CallIndex,
  key: string,
): EnsoContextAddition {
  switch (message.role) {
    case 'system': {
      const sections = Object.keys(message.sections ?? {})
      const label = leading ? 'system prompt' : `system: ${sections.join(', ') || 'instructions'}`
      return { category: leading ? 'system' : 'injected', label, key }
    }
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
    case 'system':
      return { kind: 'text', text: contentToText(message.content), images: [] }
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
        label: source.later ? 'system: instructions' : 'instructions',
        body: { kind: 'text', text: source.text, images: [] },
      }
    case 'section':
      return {
        key,
        category,
        tokens,
        label: source.later ? `system: ${source.name}` : source.name,
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
        label: messageLine(source.message, false, calls, key).label,
        body: messageBody(source.message, calls),
      }
  }
}
