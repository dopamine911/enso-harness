import { posix } from 'node:path'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { ACTIVE_AGENT_CUSTOM_TYPE, type EnsoContextEvent, type EnsoFileOperation, readRecordedMode } from '@enso/core'
import { type ContextItem, foldSystem, makeupOf } from './context-elements.ts'
import { contentToText } from './map-events.ts'

/**
 * What happened to a thread's context, and to its files (#361 phase 4) — dsh-context's Context
 * Events and File Activity, read off pi's own entries along the branch.
 *
 * ⚠ AN EVENT'S TOKENS ARE THE CONTEXT'S CHANGE, measured the one way the trend measures: the
 * estimate of the context at the entry, less the estimate just before it (pi's projection both
 * times). So a compaction's figure is what it reclaimed and a prune's what it removed, by the
 * same rule as every bar — not pi's `tokensBefore`, which is a figure of pi's own making.
 */

/** A context's estimated total at a leaf — `branch-context.ts` builds it with pi's projection. */
export type ContextTotalAt = (leafId: string | null) => number

interface EventWalk {
  readonly events: EnsoContextEvent[]
  readonly totalAt: ContextTotalAt
  readonly byId: ReadonlyMap<string, SessionEntry>
  /** The request an entry first reaches: the replies so far, plus one. */
  turn: number
  sawPrompt: boolean
  model: string | undefined
  thinking: string | undefined
  mode: string | undefined
}

/** Records an event at its entry; `key` defaults to the entry's id — one event per entry, but for a prompt's sections. */
function push(
  walk: EventWalk,
  sessionEntry: SessionEntry,
  event: Pick<EnsoContextEvent, 'kind' | 'label' | 'tokens'>,
  key: string = sessionEntry.id,
): void {
  walk.events.push({ key, ...event, turn: walk.turn, at: sessionEntry.timestamp })
}

/** The change an entry made to the context: its estimate at the entry, less just before. */
const changeAt = (walk: EventWalk, sessionEntry: SessionEntry): number =>
  walk.totalAt(sessionEntry.id) - walk.totalAt(sessionEntry.parentId)

type SystemMessage = Extract<Extract<SessionEntry, { type: 'message' }>['message'], { role: 'system' }>

/**
 * What a later system message changed, as one line: its sections by name, its tools (`tools
 * +grep −bash` — pi-agent-core writes a tools-only one whenever the tools it can run differ from
 * the ones the transcript declared, `declareToolChanges`), and its instructions only when it
 * carries text.
 */
function deltaLabel(message: SystemMessage): string {
  const parts = Object.keys(message.sections ?? {})
  const tools = [
    ...(message.toolsAdded ?? []).map((tool) => `+${tool.name}`),
    ...(message.toolsRemoved ?? []).map((tool) => `−${tool.name}`),
  ]
  if (tools.length > 0) parts.push(`tools ${tools.join(' ')}`)
  if (contentToText(message.content).length > 0) parts.push('instructions')
  return `system: ${parts.join(', ') || 'no change'}`
}

/**
 * A system message: the prompt's injected sections, once; a later one as the change it made —
 * signed, because a later system message is a delta pi folds into the prompt
 * (`context-elements.ts`), and one that deletes a section or removes a tool shrinks it.
 */
function systemEvents(walk: EventWalk, sessionEntry: Extract<SessionEntry, { type: 'message' }>): void {
  const { message } = sessionEntry
  if (message.role !== 'system') return
  if (walk.sawPrompt) {
    push(walk, sessionEntry, { kind: 'inject', label: deltaLabel(message), tokens: changeAt(walk, sessionEntry) })
    return
  }
  walk.sawPrompt = true
  // The fold decides what a section is — pi's own, or injected — so this file does not again.
  for (const { item } of foldSystem([{ message, at: sessionEntry.timestamp }])) {
    if (item.source.kind !== 'section' || item.category !== 'injected') continue
    push(
      walk,
      sessionEntry,
      { kind: 'inject', label: item.source.name, tokens: item.tokens },
      `${sessionEntry.id}:${item.key}`,
    )
  }
}

/** What a context edit touched, as a line: the tool whose result it was, or the message's role. */
function editedLabel(walk: EventWalk, targetId: string): string {
  const target = walk.byId.get(targetId)
  if (target?.type !== 'message') return 'an entry'
  return target.message.role === 'toolResult' ? `${target.message.toolName} result` : `a ${target.message.role} message`
}

/**
 * A switch of model, thinking level or mode. Whatever is set before the first request is where
 * the thread began — the host sets the model and pi the level as a session opens — not a switch.
 */
function settingEvents(walk: EventWalk, sessionEntry: SessionEntry): void {
  const began = walk.turn === 1
  if (sessionEntry.type === 'model_change') {
    const model = `${sessionEntry.provider}/${sessionEntry.modelId}`
    if (!began && walk.model !== model) push(walk, sessionEntry, { kind: 'switch', label: `model ${model}`, tokens: 0 })
    walk.model = model
  } else if (sessionEntry.type === 'thinking_level_change') {
    const level = sessionEntry.thinkingLevel
    if (!began && walk.thinking !== level)
      push(walk, sessionEntry, { kind: 'switch', label: `thinking ${level}`, tokens: 0 })
    walk.thinking = level
  } else if (sessionEntry.type === 'custom' && sessionEntry.customType === ACTIVE_AGENT_CUSTOM_TYPE) {
    // An `active_agent` entry naming no Enso mode (another agent, a malformed one) names no mode, and is skipped.
    const mode = readRecordedMode(sessionEntry)
    if (mode === undefined) return
    if (!began && walk.mode !== mode) push(walk, sessionEntry, { kind: 'mode', label: `mode ${mode}`, tokens: 0 })
    walk.mode = mode
  }
}

function entryEvents(walk: EventWalk, sessionEntry: SessionEntry): void {
  switch (sessionEntry.type) {
    case 'message':
      systemEvents(walk, sessionEntry)
      if (sessionEntry.message.role === 'assistant') {
        // The model that answered is the model in use — pi reads it the same way
        // (`getSessionContextSettings`): a session opening on its default writes no
        // `model_change`, and a later `/model` naming it again is no switch (#362 review).
        walk.model = `${sessionEntry.message.provider}/${sessionEntry.message.model}`
        walk.turn += 1
      }
      return
    case 'custom_message':
      push(walk, sessionEntry, { kind: 'inject', label: sessionEntry.customType, tokens: changeAt(walk, sessionEntry) })
      return
    case 'branch_summary':
      push(walk, sessionEntry, { kind: 'inject', label: 'branch summary', tokens: changeAt(walk, sessionEntry) })
      return
    case 'compaction':
      push(walk, sessionEntry, {
        kind: 'compact',
        label: 'compacted: a summary replaced the context before it',
        tokens: changeAt(walk, sessionEntry),
      })
      return
    case 'context_edit': {
      const verb = sessionEntry.replacement === null ? 'pruned' : 'replaced'
      push(walk, sessionEntry, {
        kind: 'prune',
        label: `${verb} ${editedLabel(walk, sessionEntry.targetId)}`,
        tokens: changeAt(walk, sessionEntry),
      })
      return
    }
    default:
      settingEvents(walk, sessionEntry)
  }
}

/** Every context event on the branch, oldest first. */
export function contextEvents(branch: readonly SessionEntry[], totalAt: ContextTotalAt): EnsoContextEvent[] {
  const walk: EventWalk = {
    events: [],
    totalAt,
    byId: new Map(branch.map((branchEntry) => [branchEntry.id, branchEntry])),
    turn: 1,
    sawPrompt: false,
    model: undefined,
    thinking: undefined,
    mode: undefined,
  }
  for (const sessionEntry of branch) entryEvents(walk, sessionEntry)
  return walk.events
}

// ── file activity ────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS: Readonly<Record<string, true>> = Object.fromEntries(
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'].map((extension) => [extension, true]),
)

/** Lines a text is — a trailing newline closes its last line, it does not open another. */
function linesOf(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

const stringArgument = (input: Record<string, unknown>, name: string): string | undefined =>
  typeof input[name] === 'string' ? input[name] : undefined

interface ToolResultFacts {
  readonly text: string
  readonly isError: boolean
  readonly key: string
}

interface CallFacts {
  /** The call's place: `<reply entry id>#<part>`. */
  readonly key: string
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly turn: number
  readonly at: string
  readonly result: ToolResultFacts | undefined
}

type Operation = Omit<EnsoFileOperation, 'key' | 'tool' | 'turn' | 'at' | 'isError' | 'resultKey'>

const blank = { subject: '', added: 0, removed: 0, hits: 0, image: false }

function readOperation(input: Record<string, unknown>): Operation[] {
  const path = stringArgument(input, 'path')
  if (path === undefined) return []
  const offset = typeof input.offset === 'number' ? input.offset : undefined
  const limit = typeof input.limit === 'number' ? input.limit : undefined
  const subject =
    offset === undefined && limit === undefined
      ? ''
      : `lines ${offset ?? 1}${limit === undefined ? '' : `–${(offset ?? 1) + limit - 1}`}`
  return [
    { ...blank, path, kind: 'read', subject, image: IMAGE_EXTENSIONS[posix.extname(path).toLowerCase()] === true },
  ]
}

interface EditFacts {
  readonly oldText: string
  readonly newText: string
}

/** pi's `isSingleEditInput` (`tools/edit.js`): one replacement, both texts strings. */
function isEdit(value: unknown): value is EditFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { oldText, newText } = value as Partial<Record<keyof EditFacts, unknown>>
  return typeof oldText === 'string' && typeof newText === 'string'
}

/** `edits` sent as JSON text, the way some models send it: parsed, or none when it is not JSON. */
function parsedEdits(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * An edit call's replacements as pi runs them. The branch stores what the model SENT, and pi
 * normalises only at execution (`prepareEditArguments`, `tools/edit.js`): `edits` as JSON text
 * (its comment names Opus 4.6), one replacement in place of the array, the legacy top-level
 * `oldText`/`newText` pair appended. Read raw, all three would count nothing.
 */
function editsOf(input: Record<string, unknown>): EditFacts[] {
  const sent = typeof input.edits === 'string' ? parsedEdits(input.edits) : input.edits
  const edits: unknown[] = Array.isArray(sent) ? [...sent] : [sent]
  if (isEdit(input)) edits.push({ oldText: input.oldText, newText: input.newText })
  return edits.filter(isEdit)
}

function writeOperation(tool: string, input: Record<string, unknown>): Operation[] {
  const path = stringArgument(input, 'path')
  if (path === undefined) return []
  if (tool === 'write')
    return [{ ...blank, path, kind: 'write', added: linesOf(stringArgument(input, 'content') ?? '') }]
  let added = 0
  let removed = 0
  for (const edit of editsOf(input)) {
    added += linesOf(edit.newText)
    removed += linesOf(edit.oldText)
  }
  return [{ ...blank, path, kind: 'write', added, removed }]
}

/**
 * The file a grep line names, or undefined for a line that is not a match. pi writes a match as
 * `file:N: text` and, with `context`, a line around it as `file-N- text` (`tools/grep.js`). A
 * path may hold spaces and a text may hold `:8080:`, so neither pattern alone decides: the
 * separator that comes FIRST does — a context line's `-N- ` sits before any `:N: ` in its text.
 */
function grepFile(line: string): string | undefined {
  const match = /^(.+?):\d+: /.exec(line)
  if (match?.[1] === undefined) return undefined
  const context = /^(.+?)-\d+- /.exec(line)
  return context?.[1] !== undefined && context[1].length < match[1].length ? undefined : match[1]
}

/**
 * Each file a search's result names, with its matches: a grep's match lines (`grepFile`), a
 * find's path per line — both relative to the searched directory (`tools/grep.js`,
 * `tools/find.js`); a notice line (`[…]`) is not a file. `ls` lists, and names nothing it
 * matched.
 */
/** find's answer when nothing matched (`tools/find.js`) — a sentence, not a path; grep's fails `grepFile`. */
const FIND_NO_MATCHES = 'No files found matching pattern'

function searchHits(tool: string, result: ToolResultFacts | undefined): Map<string, number> {
  const hits = new Map<string, number>()
  if (result === undefined || result.isError || tool === 'ls') return hits
  for (const line of result.text.split('\n')) {
    if (line.trim() === '' || line.startsWith('[') || line.trim() === FIND_NO_MATCHES) continue
    const file = tool === 'grep' ? grepFile(line) : line.trim()
    if (file !== undefined) hits.set(file, (hits.get(file) ?? 0) + 1)
  }
  return hits
}

/** A search: the searched path, and each file it matched with its hits. */
function searchOperations(
  tool: string,
  input: Record<string, unknown>,
  result: ToolResultFacts | undefined,
): Operation[] {
  const searched = stringArgument(input, 'path') ?? '.'
  const subject = stringArgument(input, 'pattern') ?? (tool === 'ls' ? 'list' : '')
  const hits = searchHits(tool, result)
  const total = [...hits.values()].reduce((allHits, fileHits) => allHits + fileHits, 0)
  // ⚠ pi names a match by its basename when the searched path is itself a file (grep.js
  // `formatPath`): that one file IS the searched path — the row above — not a file under it.
  const ownFile = hits.size === 1 && hits.has(posix.basename(searched))
  return [
    { ...blank, path: searched, kind: 'search', subject, hits: total },
    ...(ownFile
      ? []
      : [...hits].map(([file, count]) => ({
          ...blank,
          path: posix.join(searched, file),
          kind: 'search' as const,
          subject,
          hits: count,
        }))),
  ]
}

/** The tools File Activity follows, named as one list so the Context browser page reads it from here (#482). */
const FILE_TOOLS: readonly string[] = ['read', 'write', 'edit', 'grep', 'find', 'ls']

function operationsOf(call: CallFacts): Operation[] {
  if (!FILE_TOOLS.includes(call.tool)) return []
  if (call.tool === 'read') return readOperation(call.input)
  if (call.tool === 'write' || call.tool === 'edit') return writeOperation(call.tool, call.input)
  if (call.tool === 'grep' || call.tool === 'find' || call.tool === 'ls')
    return searchOperations(call.tool, call.input, call.result)
  return []
}

/** Every result on the branch, by the call it answers. */
function resultsOf(branch: readonly SessionEntry[]): Map<string, ToolResultFacts> {
  const results = new Map<string, ToolResultFacts>()
  for (const sessionEntry of branch) {
    if (sessionEntry.type !== 'message' || sessionEntry.message.role !== 'toolResult') continue
    const { message } = sessionEntry
    results.set(message.toolCallId, {
      text: contentToText(message.content),
      isError: message.isError,
      key: `${sessionEntry.id}#0`,
    })
  }
  return results
}

/** Every call on the branch with its turn and, when it has landed, its result. */
function callsOf(branch: readonly SessionEntry[]): CallFacts[] {
  const results = resultsOf(branch)
  const calls: CallFacts[] = []
  let turn = 0
  for (const sessionEntry of branch) {
    if (sessionEntry.type !== 'message' || sessionEntry.message.role !== 'assistant') continue
    turn += 1
    for (const [partIndex, part] of sessionEntry.message.content.entries()) {
      if (part.type !== 'toolCall') continue
      const input = typeof part.arguments === 'object' && part.arguments !== null ? part.arguments : {}
      calls.push({
        key: `${sessionEntry.id}#${partIndex}`,
        tool: part.name,
        input,
        turn,
        at: sessionEntry.timestamp,
        result: results.get(part.id),
      })
    }
  }
  return calls
}

/** Every file operation on the branch, oldest first. */
export function fileOperations(branch: readonly SessionEntry[]): EnsoFileOperation[] {
  return callsOf(branch).flatMap((call) =>
    operationsOf(call).map((fileOperation, operationIndex) => ({
      key: `${call.key}.${operationIndex}`,
      ...fileOperation,
      tool: call.tool,
      turn: call.turn,
      at: call.at,
      isError: call.result?.isError === true,
      ...(call.result === undefined ? {} : { resultKey: call.result.key }),
    })),
  )
}

/** Estimated total of a context's elements — the total a bar draws. */
export function totalOfItems(items: Iterable<ContextItem>): number {
  const makeup = makeupOf(items)
  return makeup.system + makeup.tools + makeup.user + makeup.injected + makeup.assistant + makeup.toolResults
}
