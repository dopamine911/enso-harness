import {
  buildSessionProjection,
  type ContextEditEntry,
  type ProjectedSessionEntry,
  type SessionEntry,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent'
import {
  ENSO_CONTEXT_ADDITIONS_SHOWN,
  type EnsoContextAddition,
  type EnsoContextCategory,
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
  type SystemSource,
  systemSources,
} from './context-elements.ts'
import { contextEvents, fileOperations } from './context-history.ts'
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

/** A request's context: pi's projection, its system prompt folded, its other elements priced. */
interface ProjectedContext {
  readonly entries: readonly ProjectedSessionEntry[]
  /** The one system prompt pi sends, folded from every system message (`foldSystem`). */
  readonly system: readonly SystemItem[]
  /** Per entry, its elements but its system messages, in order. */
  readonly items: readonly (readonly ContextItem[])[]
}

const EMPTY_CONTEXT: ProjectedContext = { entries: [], system: [], items: [] }

/**
 * Every message a context holds, as `<entry id>#<message index>` — by MESSAGE, not by entry: an
 * older compaction stays in the projection but sends nothing once a newer one keeps it. The
 * `skipped` entries' messages are left out.
 */
function messageKeysOf(
  entries: readonly ProjectedSessionEntry[],
  skipped: ReadonlySet<string> = new Set(),
): Set<string> {
  const keys = new Set<string>()
  for (const { sourceEntry, messages } of entries) {
    if (skipped.has(sourceEntry.id)) continue
    for (const messageIndex of messages.keys()) keys.add(`${sourceEntry.id}#${messageIndex}`)
  }
  return keys
}

interface Projector {
  /** The context at a leaf, as pi projects it. */
  readonly contextAt: (leafId: string | null) => ProjectedContext
  /** An entry's elements, computed once per key (below). */
  readonly itemsOf: (projected: ProjectedSessionEntry, editId?: string) => readonly ContextItem[]
}

/**
 * The context at a leaf, with every entry's elements computed once per walk: an entry prices the
 * same in every request it is in — unless an edit reached it in between, or it projects to other
 * messages there; both are in the key. ⚠ A compaction projects by POSITION (#362 review): pi
 * sends the latest one's summary, and an older one inside the latest's kept range sends nothing
 * (`buildSessionProjection`) — keyed by id alone, the walk replayed the older summary into every
 * later request. The prompt is folded per context: which system messages it replays is the context's.
 */
function createProjector(branch: readonly SessionEntry[]): Projector {
  const entries = [...branch]
  const byId = new Map(branch.map((branchEntry) => [branchEntry.id, branchEntry]))
  const itemsByKey = new Map<string, readonly ContextItem[]>()
  const itemsOf = (projected: ProjectedSessionEntry, editId = ''): readonly ContextItem[] => {
    const key = `${projected.sourceEntry.id} ${editId} ${projected.messages.length}`
    const entryItems = itemsByKey.get(key) ?? contextItems(projected)
    itemsByKey.set(key, entryItems)
    return entryItems
  }
  const contextAt = (leafId: string | null): ProjectedContext => {
    if (leafId === null) return EMPTY_CONTEXT
    const projection = buildSessionProjection(entries, leafId, byId)
    const editOf = new Map<string, string>()
    for (const { sourceEntry } of projection.entries) {
      if (sourceEntry.type === 'context_edit') editOf.set(sourceEntry.targetId, sourceEntry.id)
    }
    return {
      entries: projection.entries,
      system: foldSystem(systemSources(projection.entries)),
      items: projection.entries.map((projected) => itemsOf(projected, editOf.get(projected.sourceEntry.id))),
    }
  }
  return { contextAt, itemsOf }
}

/** Walk a context's messages but its system ones (the fold's) in order, with the calls made so far. */
function eachMessage(
  entries: readonly ProjectedSessionEntry[],
  visit: (projected: ProjectedSessionEntry, messageIndex: number, calls: CallIndex) => void,
): CallIndex {
  const calls = emptyCallIndex()
  for (const projected of entries) {
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
function systemAdditions(previous: readonly SystemItem[], current: readonly SystemItem[]): EnsoContextAddition[] {
  if (current.length === 0) return []
  if (previous.length === 0) return [{ category: 'system', label: 'system prompt', key: SYSTEM_KEY }]
  return current.filter((folded) => !heldUnchanged(previous, folded.item)).map((folded) => systemLine(folded.item))
}

/**
 * The context as the branch's one forward walk has reached it (#739): pi's projection at the
 * entry just walked, EXTENDED entry by entry, so a request reads its makeup and what entered off
 * running sums instead of projecting, keying and pricing the whole branch again — that was
 * turns², 23.7 s for 5,000 turns. An entry pi projects as itself, at the end
 * (`sessionEntryToContextMessages`), is appended; a context edit re-projects its one target
 * (`reproject`). ⚠ A compaction rewrites everything before it — the kept range, the summary in
 * front, an older compaction silenced — so there the walk RESETS to pi's projection at that entry
 * (`rewrite`), the one place it pays for the whole branch. It assumes the branch is one path,
 * root to leaf (`getBranch`): each entry's context is the one before's, extended.
 */
interface ContextWalk {
  readonly projector: Projector
  entries: ProjectedSessionEntry[]
  /** Per entry, its elements but its system messages (`Projector.itemsOf`). */
  items: (readonly ContextItem[])[]
  /** Each entry's place in `entries`, by id — what an edit finds its target by. */
  indexOf: Map<string, number>
  /** The system messages the fold replays, in order. */
  sources: SystemSource[]
  system: readonly SystemItem[]
  /** The folded prompt's makeup, refolded only when a system message enters or leaves. */
  systemMakeup: EnsoContextMakeup
  /** Every other element's makeup, summed as entries enter. */
  makeup: EnsoContextMakeup
  /** The calls the context's replies made, in order — what names a tool result's line. */
  calls: CallIndex
  /** The prompt the request before was sent. */
  previousSystem: readonly SystemItem[]
  /** The entries appended since the request before. */
  readonly appended: Set<string>
  /** The messages an edit removed since the request before, of entries it held. */
  pruned: string[]
  /** The lines appended messages make the brief, read as they entered — while `heldBefore` is undefined. */
  entered: EnsoContextAddition[]
  /**
   * The messages the request before held, kept once something since could make a message enter
   * out of order (`heldAtRequest`); undefined while the context only grew at its end.
   */
  heldBefore: ReadonlySet<string> | undefined
}

function refold(walk: ContextWalk): void {
  walk.system = foldSystem(walk.sources)
  walk.systemMakeup = makeupOf(walk.system.map((folded) => folded.item))
}

/** What the request before held: the context now but what was appended since, and what an edit pruned since. */
function heldAtRequest(walk: ContextWalk): Set<string> {
  const held = messageKeysOf(walk.entries, walk.appended)
  for (const key of walk.pruned) held.add(key)
  return held
}

/**
 * An entry pi projects as itself, at the end: its elements counted, each message's brief line
 * read with the calls before it — what the request after reads as entered, unless `heldBefore`
 * is kept first.
 */
function append(walk: ContextWalk, sessionEntry: SessionEntry): void {
  const projected = { sourceEntry: sessionEntry, messages: sessionEntryToContextMessages(sessionEntry) }
  const entryItems = walk.projector.itemsOf(projected)
  walk.indexOf.set(sessionEntry.id, walk.entries.length)
  walk.entries.push(projected)
  walk.items.push(entryItems)
  walk.appended.add(sessionEntry.id)
  for (const contextItem of entryItems) walk.makeup[contextItem.category] += contextItem.tokens
  const sourcesBefore = walk.sources.length
  for (const [messageIndex, message] of projected.messages.entries()) {
    if (message.role === 'system') {
      walk.sources.push({ message, at: sessionEntry.timestamp })
      continue
    }
    noteCalls(message, walk.calls)
    if (message.role !== 'assistant' && walk.heldBefore === undefined)
      walk.entered.push(messageLine(message, walk.calls, `${sessionEntry.id}#${messageIndex}`))
  }
  if (walk.sources.length > sourcesBefore) refold(walk)
}

/**
 * pi's projection of one entry under an edit. ⚠ pi does not export `projectContextEntry`, so
 * this runs pi's projection over a two-entry path — the target as root, the edit its child —
 * rather than copy how an edit rewrites a message.
 */
function editedMessages(target: SessionEntry, edit: ContextEditEntry): ProjectedSessionEntry['messages'] {
  const root = { ...target, parentId: null }
  const leaf = { ...edit, parentId: target.id }
  const byId = new Map<string, SessionEntry>([
    [root.id, root],
    [leaf.id, leaf],
  ])
  return buildSessionProjection([root, leaf], leaf.id, byId).entries[0]?.messages ?? []
}

/**
 * A context edit's target, re-projected in place: pi applies the latest edit of an entry to the
 * entry as stored (`buildSessionProjection`), and an older compaction inside the kept range still
 * sends nothing (`createProjector`). ⚠ What the request before held is kept FIRST when the edit
 * could make a message enter out of order: a pruned message restored, a reply's calls rewritten
 * (they name later results), a line already read off the target's old content.
 */
function reproject(walk: ContextWalk, edit: ContextEditEntry): void {
  const index = walk.indexOf.get(edit.targetId)
  const held = index === undefined ? undefined : walk.entries[index]
  if (index === undefined || held === undefined) return
  const { sourceEntry } = held
  const messages = sourceEntry.type === 'compaction' && index > 0 ? [] : editedMessages(sourceEntry, edit)
  const touched = [...held.messages, ...messages]
  const outOfOrder =
    walk.appended.has(sourceEntry.id) ||
    messages.length > held.messages.length ||
    touched.some((message) => message.role === 'assistant')
  if (outOfOrder) walk.heldBefore ??= heldAtRequest(walk)
  for (const messageIndex of held.messages.keys())
    if (messageIndex >= messages.length) walk.pruned.push(`${sourceEntry.id}#${messageIndex}`)
  const projected = { sourceEntry, messages }
  const entryItems = walk.projector.itemsOf(projected, edit.id)
  for (const contextItem of walk.items[index] ?? []) walk.makeup[contextItem.category] -= contextItem.tokens
  for (const contextItem of entryItems) walk.makeup[contextItem.category] += contextItem.tokens
  walk.entries[index] = projected
  walk.items[index] = entryItems
  if (!touched.some((message) => message.role === 'system')) return
  walk.sources = systemSources(walk.entries)
  refold(walk)
}

/** A compaction (header): pi's projection at it, taken afresh — what the request before held kept first. */
function rewrite(walk: ContextWalk, leafId: string): void {
  walk.heldBefore ??= heldAtRequest(walk)
  const context = walk.projector.contextAt(leafId)
  walk.entries = [...context.entries]
  walk.items = [...context.items]
  walk.indexOf = new Map(context.entries.map((projected, index) => [projected.sourceEntry.id, index]))
  walk.sources = systemSources(context.entries)
  walk.system = context.system
  walk.systemMakeup = makeupOf(context.system.map((folded) => folded.item))
  walk.makeup = makeupOf(context.items.flat())
}

function extend(walk: ContextWalk, sessionEntry: SessionEntry): void {
  if (sessionEntry.type === 'compaction') {
    rewrite(walk, sessionEntry.id)
    return
  }
  // The edit itself enters as an entry that sends nothing, after its target is re-projected.
  if (sessionEntry.type === 'context_edit') reproject(walk, sessionEntry)
  append(walk, sessionEntry)
}

/** The context's makeup now: the folded prompt's, then every other element's. */
function makeupNow(walk: ContextWalk): EnsoContextMakeup {
  const makeup = emptyMakeup()
  for (const category of Object.keys(makeup) as EnsoContextCategory[])
    makeup[category] = walk.systemMakeup[category] + walk.makeup[category]
  return makeup
}

/**
 * What entered since the request before, but the prompt: the lines read as entries were
 * appended; once `heldBefore` is kept, every message the request before did not hold, read in
 * order — the calls read again with them, since an edit may have rewritten a reply's.
 */
function messageAdditions(walk: ContextWalk): EnsoContextAddition[] {
  const { heldBefore } = walk
  if (heldBefore === undefined) return walk.entered
  const additions: EnsoContextAddition[] = []
  walk.calls = eachMessage(walk.entries, (projected, messageIndex, calls) => {
    const message = projected.messages[messageIndex]
    const key = `${projected.sourceEntry.id}#${messageIndex}`
    if (message === undefined || message.role === 'assistant' || heldBefore.has(key)) return
    additions.push(messageLine(message, calls, key))
  })
  return additions
}

/** A request at the context the walk has reached — the brief's "In" row against the request before — and the walk starts the next. */
function sendRequest(walk: ContextWalk): { estimated: EnsoContextMakeup; additions: EnsoContextAddition[] } {
  const additions = [...systemAdditions(walk.previousSystem, walk.system), ...messageAdditions(walk)]
  walk.previousSystem = walk.system
  walk.appended.clear()
  walk.pruned = []
  walk.entered = []
  walk.heldBefore = undefined
  return { estimated: makeupNow(walk), additions }
}

function replyOf(message: AssistantMessage): { reply: string; toolCalls: string[] } {
  const toolCalls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : []))
  return { reply: replyText(message), toolCalls }
}

/** Where a request sits on the branch: its turn, its prompt, and the compaction just before it. */
interface RequestPlace {
  readonly turn: number
  readonly prompt: number
  readonly promptText: string
  readonly compaction: { tokensBefore: number } | undefined
}

function contextRequest(
  walk: ContextWalk,
  sessionEntry: MessageEntry,
  message: AssistantMessage,
  place: RequestPlace,
): EnsoContextRequest {
  const { estimated, additions } = sendRequest(walk)
  const { usage } = message
  return {
    turn: place.turn,
    prompt: place.prompt,
    at: sessionEntry.timestamp,
    model: message.model,
    estimated,
    actual: {
      prompt: usage.input + usage.cacheRead + usage.cacheWrite,
      output: usage.output,
      cacheRead: usage.cacheRead,
    },
    ...(place.compaction === undefined ? {} : { compaction: place.compaction }),
    brief: {
      prompt: place.promptText,
      added: additions.slice(0, ENSO_CONTEXT_ADDITIONS_SHOWN),
      moreAdded: Math.max(0, additions.length - ENSO_CONTEXT_ADDITIONS_SHOWN),
      ...replyOf(message),
    },
  }
}

/** Walk one branch, root to leaf, once (`ContextWalk`): a request reads the context before its reply. */
export function branchContext(branch: readonly SessionEntry[]): BranchContext {
  const walk: ContextWalk = {
    projector: createProjector(branch),
    entries: [],
    items: [],
    indexOf: new Map(),
    sources: [],
    system: [],
    systemMakeup: emptyMakeup(),
    makeup: emptyMakeup(),
    calls: emptyCallIndex(),
    previousSystem: [],
    appended: new Set(),
    pruned: [],
    entered: [],
    heldBefore: undefined,
  }
  const requests: EnsoContextRequest[] = []
  // Each entry's context total, as the walk passes it — the events' measure (`context-history.ts`).
  const totals = new Map<string, number>()
  let total = 0
  let prompt = 0
  let promptTextNow = ''
  let turn = 0
  let compaction: { tokensBefore: number } | undefined
  for (const sessionEntry of branch) {
    if (sessionEntry.type === 'compaction') compaction = { tokensBefore: sessionEntry.tokensBefore }
    if (sessionEntry.type === 'message') {
      const { message } = sessionEntry
      if (message.role === 'user') {
        prompt += 1
        promptTextNow = promptText(message.content)
      }
      if (message.role === 'assistant') {
        turn += 1
        requests.push(
          contextRequest(walk, sessionEntry, message, { turn, prompt, promptText: promptTextNow, compaction }),
        )
        compaction = undefined
      }
    }
    extend(walk, sessionEntry)
    total = Object.values(makeupNow(walk)).reduce((sum, tokens) => sum + tokens, 0)
    totals.set(sessionEntry.id, total)
  }
  // pi reads a leaf it cannot find as the branch's last entry (`buildSessionPath`): the walk's end.
  const totalAt = (leafId: string | null): number => (leafId === null ? 0 : (totals.get(leafId) ?? total))
  return {
    next: makeupNow(walk),
    requests,
    events: contextEvents(branch, totalAt),
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
  const { contextAt } = createProjector(branch)
  const current = contextAt(leaves.leaf)
  const before = contextAt(leaves.before)
  const heldNow = messageKeysOf(current.entries)
  const heldBefore = messageKeysOf(before.entries)
  const calls = eachMessage(current.entries, () => undefined)
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
      elements.push({ ...describeItem(contextItem, calls), at, entered: !heldBefore.has(contextItem.key) })
  }
  // What left: a prompt element the fold no longer holds (a section deleted, a tool removed),
  // then every message no longer in the context.
  const currentKeys = new Set(current.system.map(({ item }) => item.key))
  const left: EnsoContextAddition[] = before.system
    .filter(({ item }) => !currentKeys.has(item.key))
    .map(({ item }) => systemLine(item))
  eachMessage(before.entries, (projected, messageIndex, beforeCalls) => {
    const message = projected.messages[messageIndex]
    const key = `${projected.sourceEntry.id}#${messageIndex}`
    if (message === undefined || heldNow.has(key)) return
    left.push(messageLine(message, beforeCalls, key))
  })
  return { elements, left }
}
