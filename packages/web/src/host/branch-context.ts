import {
  buildSessionProjection,
  estimateTokens,
  type ProjectedSessionEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import {
  ENSO_CONTEXT_ADDITIONS_SHOWN,
  type EnsoContextAddition,
  type EnsoContextCategory,
  type EnsoContextMakeup,
  type EnsoContextRequest,
  summarizeToolInput,
} from '@enso/core'
import { promptText } from './branch-stats.ts'
import { contentToText } from './map-events.ts'

/**
 * A thread's context, request by request (#361) — the host half of `EnsoThreadContext`, read off
 * pi's own entries for a live session and a stored file alike.
 *
 * ⚠ pi's assembly, not a copy of it. A request's context is `buildSessionProjection` over the
 * branch up to the reply's parent — the function pi's own session builds every request with
 * (`agent-session.js`): the latest compaction's summary and the prompt it re-issues, the kept
 * entries, everything after, and every `context_edit` an extension made (a tool result pruned or
 * replaced) applied. Each message is priced by pi's `estimateTokens` — except a system message,
 * which carries three categories at once and is split here by the same rule (characters over
 * four, rounded up).
 *
 * Numbering follows `branch-stats.ts`: a turn is an assistant message, a prompt a user message,
 * both counted along the branch — so `turn` here is `EnsoTurnStats.turn` there.
 */

export interface BranchContext {
  /** What the next request would be assembled from: the branch up to its leaf. */
  readonly next: EnsoContextMakeup
  readonly requests: EnsoContextRequest[]
}

type ContextMessage = ProjectedSessionEntry['messages'][number]
type SystemMessage = Extract<ContextMessage, { role: 'system' }>
type MessageEntry = Extract<SessionEntry, { type: 'message' }>
type AssistantMessage = Extract<MessageEntry['message'], { role: 'assistant' }>

/** The sections pi writes for every thread — `buildSystemPromptSections`. Any other is injected. */
const BASE_SECTIONS: Readonly<Record<string, true>> = Object.fromEntries(
  ['preamble', 'tools', 'rules', 'docs', 'cwd'].map((sectionName) => [sectionName, true]),
)

/** The category of every message role but `system`, which is split (see the header). */
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

function emptyMakeup(): EnsoContextMakeup {
  return { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 }
}

function addMakeup(into: EnsoContextMakeup, from: EnsoContextMakeup): EnsoContextMakeup {
  return {
    system: into.system + from.system,
    tools: into.tools + from.tools,
    user: into.user + from.user,
    injected: into.injected + from.injected,
    assistant: into.assistant + from.assistant,
    toolResults: into.toolResults + from.toolResults,
  }
}

const tokensOf = (characters: number): number => Math.ceil(characters / 4)

/** The first line of `text`, clipped — a brief row is one line. */
function firstLine(text: string, maximum: number): string {
  const line = (text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '').trim()
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line
}

/**
 * A system message's three categories. The LEADING one is the prompt: its instructions and pi's
 * own sections are `system`, every other section `injected`. A later one changes the prompt from
 * that point on, so all of its text is `injected`. Its tool definitions are `tools` either way.
 */
function systemMakeup(message: SystemMessage, leading: boolean): EnsoContextMakeup {
  const makeup = emptyMakeup()
  const instructions = contentToText(message.content).length
  let own = leading ? instructions : 0
  let added = leading ? 0 : instructions
  for (const [sectionName, section] of Object.entries(message.sections ?? {})) {
    if (section === null) continue
    if (leading && BASE_SECTIONS[sectionName] === true) own += section.length
    else added += section.length
  }
  makeup.system = tokensOf(own)
  makeup.injected = tokensOf(added)
  makeup.tools = message.toolsAdded === undefined ? 0 : tokensOf(JSON.stringify(message.toolsAdded).length)
  return makeup
}

function messageMakeup(message: ContextMessage, leading: boolean): EnsoContextMakeup {
  if (message.role === 'system') return systemMakeup(message, leading)
  const makeup = emptyMakeup()
  const category = CATEGORY_OF_ROLE[message.role]
  if (category !== undefined) makeup[category] = estimateTokens(message)
  return makeup
}

/**
 * One line naming what a message is, for the brief's "In" row. A tool result is named by its
 * call's subject (`bash ls -la`), as the transcript's step row names it; `callSubjects` holds the
 * subject of every call the context has made so far.
 */
function additionOf(
  message: ContextMessage,
  leading: boolean,
  callSubjects: ReadonlyMap<string, string>,
): EnsoContextAddition | undefined {
  switch (message.role) {
    case 'system': {
      const sections = Object.keys(message.sections ?? {})
      const label = leading ? 'system prompt' : `system: ${sections.join(', ') || 'instructions'}`
      return { category: leading ? 'system' : 'injected', label }
    }
    case 'user':
      return { category: 'user', label: firstLine(contentToText(message.content), LABEL_MAX) }
    case 'bashExecution':
      return { category: 'user', label: firstLine(`!${message.command}`, LABEL_MAX) }
    case 'toolResult':
      return {
        category: 'toolResults',
        label: firstLine(
          `${message.toolName} ${callSubjects.get(message.toolCallId) ?? contentToText(message.content)}`,
          LABEL_MAX,
        ),
      }
    case 'custom':
      return { category: 'injected', label: message.customType }
    case 'compactionSummary':
      return { category: 'injected', label: 'compaction summary' }
    case 'branchSummary':
      return { category: 'injected', label: 'branch summary' }
    default:
      // A reply entering the next request's context is the previous request's own output.
      return undefined
  }
}

/** A context's makeup and the entry ids it holds, with each entry priced once per walk. */
interface PricedContext {
  readonly makeup: EnsoContextMakeup
  readonly entryIds: ReadonlySet<string>
  readonly entries: readonly ProjectedSessionEntry[]
}

/** An entry's messages priced, the first system message among them as the leading one if `leading`. */
function projectedMakeup(projected: ProjectedSessionEntry, leading: boolean): EnsoContextMakeup {
  let makeup = emptyMakeup()
  let first = leading
  for (const message of projected.messages) {
    makeup = addMakeup(makeup, messageMakeup(message, first && message.role === 'system'))
    if (message.role === 'system') first = false
  }
  return makeup
}

function createPricer(branch: readonly SessionEntry[]): (leafId: string | null) => PricedContext {
  const byId = new Map(branch.map((branchEntry) => [branchEntry.id, branchEntry]))
  // An entry prices the same in every request it is in — unless it leads the prompt in one and
  // not another, or an edit reached it in between: both are in the key.
  const priced = new Map<string, EnsoContextMakeup>()
  return (leafId: string | null): PricedContext => {
    if (leafId === null) return { makeup: emptyMakeup(), entryIds: new Set(), entries: [] }
    const { entries } = buildSessionProjection([...branch], leafId, byId)
    const editOf = new Map<string, string>()
    for (const { sourceEntry } of entries) {
      if (sourceEntry.type === 'context_edit') editOf.set(sourceEntry.targetId, sourceEntry.id)
    }
    let makeup = emptyMakeup()
    let sawSystem = false
    for (const projected of entries) {
      const { id } = projected.sourceEntry
      const key = `${sawSystem ? 'then' : 'lead'} ${id} ${editOf.get(id) ?? ''}`
      const entryMakeup = priced.get(key) ?? projectedMakeup(projected, !sawSystem)
      priced.set(key, entryMakeup)
      makeup = addMakeup(makeup, entryMakeup)
      sawSystem ||= projected.messages.some((message) => message.role === 'system')
    }
    return { makeup, entryIds: new Set(entries.map((projected) => projected.sourceEntry.id)), entries }
  }
}

/** Note each call a reply makes by its subject, so its result can be named by it later. */
function noteCallSubjects(message: ContextMessage, callSubjects: Map<string, string>): void {
  if (message.role !== 'assistant') return
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue
    const subject = summarizeToolInput(part.arguments)
    if (subject !== undefined) callSubjects.set(part.id, subject)
  }
}

/** What entered `current` that `previous` did not hold, one line each, in context order. */
function additionsSince(previous: PricedContext, current: PricedContext): EnsoContextAddition[] {
  const additions: EnsoContextAddition[] = []
  const callSubjects = new Map<string, string>()
  let sawSystem = false
  for (const projected of current.entries) {
    const isNew = !previous.entryIds.has(projected.sourceEntry.id)
    for (const message of projected.messages) {
      const leading = message.role === 'system' && !sawSystem
      if (message.role === 'system') sawSystem = true
      noteCallSubjects(message, callSubjects)
      const addition = isNew ? additionOf(message, leading, callSubjects) : undefined
      if (addition !== undefined) additions.push(addition)
    }
  }
  return additions
}

function replyOf(message: AssistantMessage): { reply: string; toolCalls: string[] } {
  const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  const toolCalls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : []))
  return { reply: firstLine(text, REPLY_MAX), toolCalls }
}

/** Walk one branch, root to leaf. */
export function branchContext(branch: readonly SessionEntry[]): BranchContext {
  const contextAt = createPricer(branch)
  const requests: EnsoContextRequest[] = []
  let prompt = 0
  let promptTextNow = ''
  let turn = 0
  let previous = contextAt(null)
  let compaction: { tokensBefore: number } | undefined
  for (const sessionEntry of branch) {
    if (sessionEntry.type === 'compaction') compaction = { tokensBefore: sessionEntry.tokensBefore }
    if (sessionEntry.type !== 'message') continue
    const { message } = sessionEntry
    if (message.role === 'user') {
      prompt += 1
      promptTextNow = promptText(message.content)
    }
    if (message.role !== 'assistant') continue
    turn += 1
    const context = contextAt(sessionEntry.parentId)
    const additions = additionsSince(previous, context)
    const { usage } = message
    requests.push({
      turn,
      prompt,
      at: sessionEntry.timestamp,
      model: message.model,
      estimated: context.makeup,
      actual: {
        prompt: usage.input + usage.cacheRead + usage.cacheWrite,
        output: usage.output,
        cacheRead: usage.cacheRead,
      },
      ...(compaction === undefined ? {} : { compaction }),
      brief: {
        prompt: promptTextNow,
        added: additions.slice(0, ENSO_CONTEXT_ADDITIONS_SHOWN),
        moreAdded: Math.max(0, additions.length - ENSO_CONTEXT_ADDITIONS_SHOWN),
        ...replyOf(message),
      },
    })
    compaction = undefined
    previous = contextAt(sessionEntry.id)
  }
  return { next: contextAt(branch.at(-1)?.id ?? null).makeup, requests }
}
