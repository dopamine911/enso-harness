import { buildSessionProjection, type ProjectedSessionEntry, type SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  ENSO_CONTEXT_ADDITIONS_SHOWN,
  type EnsoContextAddition,
  type EnsoContextElement,
  type EnsoContextEvent,
  type EnsoContextMakeup,
  type EnsoContextRequest,
  type EnsoFileOperation,
  type EnsoThreadSystemPrompt,
} from '@enso/core'
import { promptText } from './branch-stats.ts'
import {
  type CallIndex,
  type ContextItem,
  contextItems,
  describeItem,
  emptyCallIndex,
  emptyMakeup,
  foldSystem,
  heldUnchanged,
  makeupOf,
  messageLine,
  noteCalls,
  replyText,
  SYSTEM_KEY,
  type SystemItem,
  systemLine,
  systemSources,
} from './context-elements.ts'
import { contextEvents, fileOperations, totalOfItems } from './context-history.ts'
import { threadSystemPrompt } from './system-prompt.ts'
import { transcriptOf } from './transcript.ts'

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
  /** When and why the context changed (`context-history.ts`). */
  readonly events: EnsoContextEvent[]
  /** What the file tools did (`context-history.ts`). */
  readonly files: EnsoFileOperation[]
  /** The system prompt the branch records (#443). */
  readonly systemPrompt: EnsoThreadSystemPrompt
}

/** One request's context, element by element, and what left it since the request before. */
export interface BranchRequestDetail {
  readonly elements: EnsoContextElement[]
  readonly left: EnsoContextAddition[]
}

type MessageEntry = Extract<SessionEntry, { type: 'message' }>
type AssistantMessage = Extract<MessageEntry['message'], { role: 'assistant' }>

/** A request's context: pi's projection, its system prompt folded, its other elements priced, the messages it holds. */
interface ProjectedContext {
  readonly entries: readonly ProjectedSessionEntry[]
  /** The one system prompt pi sends, folded from every system message (`foldSystem`). */
  readonly system: readonly SystemItem[]
  /** Per entry, its elements but its system messages, in order. */
  readonly items: readonly (readonly ContextItem[])[]
  /**
   * Every message it holds, as `<entry id>#<message index>` — by MESSAGE, not by entry: an
   * older compaction stays in the projection but sends nothing once a newer one keeps it.
   */
  readonly messageKeys: ReadonlySet<string>
}

const EMPTY_CONTEXT: ProjectedContext = { entries: [], system: [], items: [], messageKeys: new Set() }

/** Every element of a context: the folded prompt first, as pi sends it, then each entry's. */
function allItems(context: ProjectedContext): ContextItem[] {
  return [...context.system.map((folded) => folded.item), ...context.items.flat()]
}

/**
 * The context at a leaf, with every entry's elements computed once per walk: an entry prices the
 * same in every request it is in — unless an edit reached it in between, or it projects to other
 * messages there; both are in the key. ⚠ A compaction projects by POSITION (#362 review): pi
 * sends the latest one's summary, and an older one inside the latest's kept range sends nothing
 * (`buildSessionProjection`) — keyed by id alone, the walk replayed the older summary into every
 * later request. The prompt is folded per context: which system messages it replays is the context's.
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
    const items = entries.map((projected) => {
      const { id } = projected.sourceEntry
      const key = `${id} ${editOf.get(id) ?? ''} ${projected.messages.length}`
      const entryItems = itemsByKey.get(key) ?? contextItems(projected)
      itemsByKey.set(key, entryItems)
      return entryItems
    })
    return {
      entries,
      system: foldSystem(systemSources(entries)),
      items,
      messageKeys: new Set(
        entries.flatMap(({ sourceEntry, messages }) => messages.map((_message, index) => `${sourceEntry.id}#${index}`)),
      ),
    }
  }
}

/** Walk a context's messages but its system ones (the fold's) in order, with the calls made so far. */
function eachMessage(
  context: ProjectedContext,
  visit: (projected: ProjectedSessionEntry, messageIndex: number, calls: CallIndex) => void,
): CallIndex {
  const calls = emptyCallIndex()
  for (const projected of context.entries) {
    for (const [messageIndex, message] of projected.messages.entries()) {
      if (message.role === 'system') continue
      noteCalls(message, calls)
      visit(projected, messageIndex, calls)
    }
  }
  return calls
}

/**
 * What the folded prompt gained since `previous`: the whole prompt as one line when there was
 * none (the first request), else each element new or changed — a compaction's re-issue of the
 * same prompt is neither.
 */
function systemAdditions(previous: ProjectedContext, current: ProjectedContext): EnsoContextAddition[] {
  if (current.system.length === 0) return []
  if (previous.system.length === 0) return [{ category: 'system', label: 'system prompt', key: SYSTEM_KEY }]
  return current.system
    .filter((folded) => !heldUnchanged(previous.system, folded.item))
    .map((folded) => systemLine(folded.item))
}

/** What entered `current` that `previous` did not hold — the brief's "In" row; a reply is the previous request's own output. */
function additionsSince(previous: ProjectedContext, current: ProjectedContext): EnsoContextAddition[] {
  const additions = systemAdditions(previous, current)
  eachMessage(current, (projected, messageIndex, calls) => {
    const message = projected.messages[messageIndex]
    const key = `${projected.sourceEntry.id}#${messageIndex}`
    if (message === undefined || message.role === 'assistant' || previous.messageKeys.has(key)) return
    additions.push(messageLine(message, calls, key))
  })
  return additions
}

function replyOf(message: AssistantMessage): { reply: string; toolCalls: string[] } {
  const toolCalls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : []))
  return { reply: replyText(message), toolCalls }
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
      estimated: makeupOf(allItems(context)),
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
  return {
    next: last === undefined ? emptyMakeup() : makeupOf(allItems(contextAt(last.id))),
    requests,
    events: contextEvents(branch, (leafId) => totalOfItems(allItems(contextAt(leafId)))),
    files: fileOperations(branch),
    systemPrompt: threadSystemPrompt(transcriptOf(branch)),
  }
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
  const calls = eachMessage(current, () => undefined)
  // The folded prompt first: an element entered when it is new or changed since the request
  // before, never because a compaction re-issued it under its own entry (header).
  const elements: EnsoContextElement[] = current.system.map(({ item, at }) => ({
    ...describeItem(item, calls),
    at,
    entered: !heldUnchanged(before.system, item),
  }))
  for (const [entryIndex, projected] of current.entries.entries()) {
    const at = projected.sourceEntry.timestamp
    for (const contextItem of current.items[entryIndex] ?? [])
      elements.push({ ...describeItem(contextItem, calls), at, entered: !before.messageKeys.has(contextItem.key) })
  }
  // What left: a prompt element the fold no longer holds (a section deleted, a tool removed),
  // then every message no longer in the context.
  const currentKeys = new Set(current.system.map(({ item }) => item.key))
  const left: EnsoContextAddition[] = before.system
    .filter(({ item }) => !currentKeys.has(item.key))
    .map(({ item }) => systemLine(item))
  eachMessage(before, (projected, messageIndex, beforeCalls) => {
    const message = projected.messages[messageIndex]
    const key = `${projected.sourceEntry.id}#${messageIndex}`
    if (message === undefined || current.messageKeys.has(key)) return
    left.push(messageLine(message, beforeCalls, key))
  })
  return { elements, left }
}
