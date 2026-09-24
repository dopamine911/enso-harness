import { buildSessionProjection, type ProjectedSessionEntry, type SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  ENSO_CONTEXT_ADDITIONS_SHOWN,
  type EnsoContextAddition,
  type EnsoContextElement,
  type EnsoContextMakeup,
  type EnsoContextRequest,
} from '@enso/core'
import { promptText } from './branch-stats.ts'
import {
  type CallIndex,
  type ContextItem,
  contextItems,
  describeItem,
  emptyCallIndex,
  emptyMakeup,
  firstLine,
  makeupOf,
  messageLine,
  noteCalls,
} from './context-elements.ts'

/**
 * A thread's context, request by request (#361) — the host half of `EnsoThreadContext` and of
 * `EnsoContextRequestDetail`, read off pi's own entries for a live session and a stored file alike.
 *
 * ⚠ pi's assembly, not a copy of it. A request's context is `buildSessionProjection` over the
 * branch up to the reply's parent — the function pi's own session builds every request with
 * (`agent-session.js`): the latest compaction's summary and the prompt it re-issues, the kept
 * entries, everything after, and every `context_edit` an extension made (a tool result pruned or
 * replaced) applied. `context-elements.ts` splits it into elements and prices them.
 *
 * Numbering follows `branch-stats.ts`: a turn is an assistant message, a prompt a user message,
 * both counted along the branch — so `turn` here is `EnsoTurnStats.turn` there.
 */

export interface BranchContext {
  /** What the next request would be assembled from: the branch up to its leaf. */
  readonly next: EnsoContextMakeup
  readonly requests: EnsoContextRequest[]
}

/** One request's context, element by element, and what left it since the request before. */
export interface BranchRequestDetail {
  readonly elements: EnsoContextElement[]
  readonly left: EnsoContextAddition[]
}

type MessageEntry = Extract<SessionEntry, { type: 'message' }>
type AssistantMessage = Extract<MessageEntry['message'], { role: 'assistant' }>

/** A request's context: pi's projection, its elements priced, and the entry ids it holds. */
interface ProjectedContext {
  readonly entries: readonly ProjectedSessionEntry[]
  /** Per entry, its elements, in order. */
  readonly items: readonly (readonly ContextItem[])[]
  readonly entryIds: ReadonlySet<string>
}

const EMPTY_CONTEXT: ProjectedContext = { entries: [], items: [], entryIds: new Set() }

/**
 * The context at a leaf, with every entry's elements computed once per walk: an entry prices the
 * same in every request it is in — unless it leads the prompt in one and not another, or an edit
 * reached it in between; both are in the key.
 */
function createProjector(branch: readonly SessionEntry[]): (leafId: string | null) => ProjectedContext {
  const byId = new Map(branch.map((branchEntry) => [branchEntry.id, branchEntry]))
  const itemsByKey = new Map<string, ContextItem[]>()
  return (leafId: string | null): ProjectedContext => {
    if (leafId === null) return EMPTY_CONTEXT
    const { entries } = buildSessionProjection([...branch], leafId, byId)
    const editOf = new Map<string, string>()
    for (const { sourceEntry } of entries) {
      if (sourceEntry.type === 'context_edit') editOf.set(sourceEntry.targetId, sourceEntry.id)
    }
    let sawSystem = false
    const items = entries.map((projected) => {
      const { id } = projected.sourceEntry
      const key = `${sawSystem ? 'then' : 'lead'} ${id} ${editOf.get(id) ?? ''}`
      const entryItems = itemsByKey.get(key) ?? contextItems(projected, !sawSystem)
      itemsByKey.set(key, entryItems)
      sawSystem ||= projected.messages.some((message) => message.role === 'system')
      return entryItems
    })
    return { entries, items, entryIds: new Set(entries.map((projected) => projected.sourceEntry.id)) }
  }
}

/**
 * Walk a context's messages in order with the calls made so far, and whether each message's
 * system role leads — the one traversal the brief and the detail both need.
 */
function eachMessage(
  context: ProjectedContext,
  visit: (projected: ProjectedSessionEntry, messageIndex: number, leading: boolean, calls: CallIndex) => void,
): CallIndex {
  const calls = emptyCallIndex()
  let sawSystem = false
  for (const projected of context.entries) {
    for (const [messageIndex, message] of projected.messages.entries()) {
      const leading = message.role === 'system' && !sawSystem
      if (message.role === 'system') sawSystem = true
      noteCalls(message, calls)
      visit(projected, messageIndex, leading, calls)
    }
  }
  return calls
}

/** What entered `current` that `previous` did not hold — the brief's "In" row; a reply is the previous request's own output. */
function additionsSince(previous: ProjectedContext, current: ProjectedContext): EnsoContextAddition[] {
  const additions: EnsoContextAddition[] = []
  eachMessage(current, (projected, messageIndex, leading, calls) => {
    const message = projected.messages[messageIndex]
    if (message === undefined || message.role === 'assistant' || previous.entryIds.has(projected.sourceEntry.id)) return
    additions.push(messageLine(message, leading, calls, `${projected.sourceEntry.id}#${messageIndex}`))
  })
  return additions
}

function replyOf(message: AssistantMessage): { reply: string; toolCalls: string[] } {
  const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  const toolCalls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : []))
  return { reply: firstLine(text, 120), toolCalls }
}

/** Walk one branch, root to leaf. */
export function branchContext(branch: readonly SessionEntry[]): BranchContext {
  const contextAt = createProjector(branch)
  const requests: EnsoContextRequest[] = []
  let prompt = 0
  let promptTextNow = ''
  let turn = 0
  let previous = EMPTY_CONTEXT
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
      estimated: makeupOf(context.items.flat()),
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
    previous = context
  }
  const last = branch.at(-1)
  return { next: last === undefined ? emptyMakeup() : makeupOf(contextAt(last.id).items.flat()), requests }
}

/**
 * The leaves a request is read at: its own context (the reply's parent) and the request before's.
 * `next` is the branch's leaf, and the request before it the last one made. Undefined for a turn
 * the branch does not have.
 */
function leavesOf(
  branch: readonly SessionEntry[],
  request: number | 'next',
): { leaf: string | null; before: string | null } | undefined {
  const replies = branch.filter(
    (branchEntry) => branchEntry.type === 'message' && branchEntry.message.role === 'assistant',
  )
  if (request === 'next') return { leaf: branch.at(-1)?.id ?? null, before: replies.at(-1)?.parentId ?? null }
  const reply = replies[request - 1]
  if (reply === undefined) return undefined
  return { leaf: reply.parentId, before: replies[request - 2]?.parentId ?? null }
}

/** One request's context, element by element (#361 phase 3) — the Context Browser's rows. */
export function branchRequestDetail(
  branch: readonly SessionEntry[],
  request: number | 'next',
): BranchRequestDetail | undefined {
  const leaves = leavesOf(branch, request)
  if (leaves === undefined) return undefined
  const contextAt = createProjector(branch)
  const current = contextAt(leaves.leaf)
  const before = contextAt(leaves.before)
  const elements: EnsoContextElement[] = []
  const calls = eachMessage(current, () => undefined)
  for (const [entryIndex, projected] of current.entries.entries()) {
    const entered = !before.entryIds.has(projected.sourceEntry.id)
    const at = projected.sourceEntry.timestamp
    for (const contextItem of current.items[entryIndex] ?? [])
      elements.push({ ...describeItem(contextItem, calls), at, entered })
  }
  const left: EnsoContextAddition[] = []
  eachMessage(before, (projected, messageIndex, leading, beforeCalls) => {
    const message = projected.messages[messageIndex]
    if (message === undefined || current.entryIds.has(projected.sourceEntry.id)) return
    left.push(messageLine(message, leading, beforeCalls, `${projected.sourceEntry.id}#${messageIndex}`))
  })
  return { elements, left }
}
