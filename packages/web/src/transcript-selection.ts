import type { MessagePart, UIMessage } from '@tanstack/ai-client'
import { automaticPartsForMessage, type ChatUISelectedPart, selectChatUI } from '@tanstack/ai-client/ui'
import { refusalOfMessage } from './refused-attempt.tsx'
import { titleFromMessage } from './thread-stores.ts'

/**
 * THE TRANSCRIPT'S SELECTION, KEPT RATHER THAN REBUILT (#739).
 *
 * What each row of the transcript draws — its selected parts, whether its speaker line shows,
 * whether it is hidden, its prompt's name — used to be rebuilt over EVERY message on every
 * streamed chunk (#280 made it once per chunk instead of once per row per chunk): 0.69 ms at
 * 985 messages and 3.65 ms at 5,319, per token, for the life of the thread. TanStack replaces the
 * one message a chunk changed and keeps every other object, so the selection is kept between
 * chunks and only what a chunk changed is selected again: the messages whose parts changed, and
 * the messages they pair with across — a call whose result arrived in a later message, a result
 * whose call appeared. The positional facts (speaker, hidden, the prompt's number) are carried
 * forward from the first row that moved.
 *
 * ⚠ The pairing is still the vendor's: a message is selected by `selectChatUI` over itself and
 * the parts it pairs with elsewhere, so a result stamped onto a later message pairs exactly as
 * the whole-list selection paired it. Anything the incremental index cannot account for — a
 * message removed or replaced by another id, a call id held by two messages, the prompt count
 * before the page moving — selects the whole list again, as before.
 */

/** One selected part paired with the React key that identifies it. */
export interface KeyedPart {
  /** Stable across re-renders AND position changes — see `keyedParts` for why that matters. */
  partKey: string
  selected: ChatUISelectedPart
  isTrailingPart: boolean
}

/**
 * Pairs each selected part with a React key that is an IDENTITY, not a position.
 *
 * ⚠ Tool parts MOVE. The selection pairs across the whole message list, so a result the server
 * stamps onto a different message re-pairs its call and shifts that call's index. A key carrying
 * the array index therefore changes identity for a part that did not change — React remounts it
 * and the rendered tool block loses its state. `noArrayIndexKey` is right to refuse it, and this
 * is the fix rather than a suppression: tool parts already carry a real id (`id` on tool-call,
 * `toolCallId` on tool-result), so key by that. Text/thinking/image parts carry no id, but they
 * are append-only within one message, so a per-KIND occurrence counter identifies them without
 * borrowing the position of the whole list.
 *
 * `isTrailingPart` rides along so the caller needs no index either — see its use in `MessageBody`.
 */
export function keyedParts(parts: ChatUISelectedPart[]): KeyedPart[] {
  const seenPerKind = new Map<string, number>()
  return parts.map((selected, position) => {
    const identity = partIdentity(selected)
    if (identity !== undefined) {
      return { partKey: `${selected.key}-${identity}`, selected, isTrailingPart: position === parts.length - 1 }
    }
    const seen = seenPerKind.get(selected.key) ?? 0
    seenPerKind.set(selected.key, seen + 1)
    return { partKey: `${selected.key}#${seen}`, selected, isTrailingPart: position === parts.length - 1 }
  })
}

/** The part's own stable id, or undefined for the kinds that carry none. */
function partIdentity(selected: ChatUISelectedPart): string | undefined {
  if (selected.key === 'toolCall') return selected.part.id
  if (selected.key === 'toolResult') return selected.part.toolCallId
  return undefined
}

/** One message as its row draws it. */
export interface TranscriptRow {
  readonly message: UIMessage
  readonly parts: KeyedPart[]
  /**
   * An assistant message with nothing to draw that a later message has superseded (#382): a refused
   * attempt the provider turned down before any token. Its bubble would be a bare speaker line; the
   * lines said about it (`refused: …`, `retrying in …`) still read in its place. The last message is
   * never hidden — it is the one a run is about to stream into.
   */
  readonly hidden: boolean
  /**
   * Whether the speaker line is drawn: not when the message CONTINUES the one drawn before it — one
   * pi turn is several assistant messages (each tool round is one), and "pi" says it once. Counted
   * over the drawn messages: a hidden one neither continues nor is continued.
   */
  readonly speaker: boolean
  /**
   * A user prompt's name for its fork and restore (#651): its number among the BRANCH's prompts —
   * counted from the prompts before the page (#739) — and its words as the rail shortens them,
   * `prompt 3: “continue”`. Numbered (PR #654 review): two prompts with the same words would share
   * a name again.
   */
  readonly promptName: string | undefined
}

/** The transcript as its rows read it, for one render. */
export interface TranscriptSelection {
  /** The row of a message on the transcript; `undefined` for one it does not hold. */
  readonly rowOf: (messageId: string) => TranscriptRow | undefined
  /**
   * The messages whose run is in flight, while the thread generates: every assistant message after
   * the last user message. Not just the last message (#412): joining a run that is already going
   * (a reload) opens a NEW message for what streams next, after the stored one that holds the call
   * pi is still waiting on — and a user message is where a run, or a queued prompt pi took, began,
   * so no call before it is still running.
   */
  readonly openRunMessageIds: ReadonlySet<string>
  /** The transcript's message ids — a new set only when a message is added or removed, never per chunk. */
  readonly messageIds: ReadonlySet<string>
}

/** What a message's own selection says, kept until its parts change. */
interface SelectedMessage {
  /** The object it was selected from — its parts are what the next chunk's are compared with. */
  readonly message: UIMessage
  readonly parts: KeyedPart[]
  /** Nothing to draw: no part survives the selection and it is no refused attempt. */
  readonly empty: boolean
  readonly title: string | undefined
  readonly calls: readonly string[]
  readonly results: readonly string[]
}

/** A row and what it carries to the next: the last drawn role, and the prompts counted so far on the page. */
interface PositionedRow extends TranscriptRow {
  readonly drawnRole: UIMessage['role'] | undefined
  readonly prompts: number
}

/** Selects the transcript for one render: the messages, whether a run is in flight, and the prompts before them. */
type TranscriptSelector = (
  messages: readonly UIMessage[],
  generating: boolean,
  promptsBefore: number,
) => TranscriptSelection

function toolIds(message: UIMessage): Pick<SelectedMessage, 'calls' | 'results'> {
  const calls: string[] = []
  const results: string[] = []
  for (const part of message.parts) {
    if (part.type === 'tool-call') calls.push(part.id)
    else if (part.type === 'tool-result') results.push(part.toolCallId)
  }
  return { calls, results }
}

function selectedMessage(message: UIMessage, parts: KeyedPart[]): SelectedMessage {
  return {
    message,
    parts,
    empty: parts.length === 0 && refusalOfMessage(message) === undefined,
    title: message.role === 'user' ? titleFromMessage(message) : undefined,
    ...toolIds(message),
  }
}

/** Whether a replaced message draws what the one it replaced drew: the same parts, the same metadata. */
function drawsTheSame(next: UIMessage, previous: UIMessage): boolean {
  if (next.parts.length !== previous.parts.length || next.metadata !== previous.metadata) return false
  return next.parts.every((part, position) => part === previous.parts[position])
}

/** The row a selected message is, from the row before it: whether a later message supersedes it, and the prompts before the page. */
function positionedRow(
  selected: SelectedMessage,
  before: PositionedRow | undefined,
  place: { readonly superseded: boolean; readonly promptsBefore: number },
): PositionedRow {
  const { message } = selected
  const carriedRole = before?.drawnRole
  const prompts = (before?.prompts ?? 0) + (message.role === 'user' ? 1 : 0)
  const hidden = place.superseded && selected.empty && message.role === 'assistant'
  const drawn = !hidden && message.role !== 'activity'
  const titled = selected.title === undefined ? '' : `: “${selected.title}”`
  return {
    message,
    parts: selected.parts,
    hidden,
    speaker: carriedRole !== message.role,
    promptName: message.role === 'user' ? `prompt ${place.promptsBefore + prompts}${titled}` : undefined,
    drawnRole: drawn ? message.role : carriedRole,
    prompts,
  }
}

function sameRow(next: PositionedRow, previous: PositionedRow | undefined): boolean {
  return (
    previous !== undefined &&
    previous.message === next.message &&
    previous.parts === next.parts &&
    previous.hidden === next.hidden &&
    previous.speaker === next.speaker &&
    previous.promptName === next.promptName &&
    previous.drawnRole === next.drawnRole &&
    previous.prompts === next.prompts
  )
}

function openRunOf(messages: readonly UIMessage[], generating: boolean): ReadonlySet<string> {
  const open = new Set<string>()
  if (!generating) return open
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const message = messages[position]
    if (message === undefined || message.role !== 'assistant') break
    open.add(message.id)
  }
  return open
}

/**
 * One pane's selector: it keeps the last selection and, given the next list, selects again only
 * what changed (see the module's header). Made once per pane — the state is that pane's transcript.
 */
export function createTranscriptSelector(): TranscriptSelector {
  let held: readonly UIMessage[] = []
  let selected: SelectedMessage[] = []
  let rows: PositionedRow[] = []
  let heldPromptsBefore = 0
  let indexById = new Map<string, number>()
  let messageIds: ReadonlySet<string> = new Set()
  /** Which message holds each call, and each result, by call id — the pairing across messages. */
  let callOwner = new Map<string, number>()
  let resultOwner = new Map<string, number>()
  /**
   * A call or result id two messages hold. The vendor's last-wins pairing then depends on more than
   * one owner, which the index does not keep: every list is selected whole until a rebuild finds none.
   */
  let ambiguous = false

  /** Every message selected again, as the whole-list selection did before #739. */
  function rebuild(messages: readonly UIMessage[], promptsBefore: number): void {
    selected = selectChatUI({ messages: [...messages] }).messages.map((messageSelection) =>
      selectedMessage(messageSelection.message, keyedParts(automaticPartsForMessage(messageSelection))),
    )
    callOwner = new Map()
    resultOwner = new Map()
    ambiguous = false
    selected.forEach((kept, position) => {
      for (const callId of kept.calls) {
        ambiguous ||= callOwner.has(callId)
        callOwner.set(callId, position)
      }
      for (const resultCallId of kept.results) {
        ambiguous ||= resultOwner.has(resultCallId)
        resultOwner.set(resultCallId, position)
      }
    })
    indexById = new Map(messages.map((message, position) => [message.id, position]))
    messageIds = new Set(indexById.keys())
    rows = []
    positionFrom(0, promptsBefore)
    heldPromptsBefore = promptsBefore
  }

  function positionFrom(from: number, promptsBefore: number): void {
    const next = rows.slice(0, from)
    for (let position = from; position < selected.length; position += 1) {
      const kept = selected[position]
      if (kept === undefined) break
      const superseded = position < selected.length - 1
      const row = positionedRow(kept, next[position - 1], { superseded, promptsBefore })
      const previous = rows[position]
      next.push(previous !== undefined && sameRow(row, previous) ? previous : row)
    }
    rows = next
  }

  /** The positions whose parts changed since the held list, or `undefined` when the list is no extension of it. */
  function changedPositions(messages: readonly UIMessage[]): number[] | undefined {
    const changed: number[] = []
    for (let position = 0; position < held.length; position += 1) {
      const next = messages[position]
      const previous = selected[position]
      if (next === undefined || previous === undefined) return undefined
      if (next === held[position]) continue
      if (next.id !== previous.message.id) return undefined
      if (!drawsTheSame(next, previous.message)) changed.push(position)
    }
    for (let position = held.length; position < messages.length; position += 1) changed.push(position)
    return changed
  }

  /**
   * Re-index the changed messages' calls and results; the positions whose pairing moved with them.
   * `undefined` when a call or result id lands on a second message — the whole list is selected then.
   */
  function reindex(messages: readonly UIMessage[], changed: readonly number[]): Set<number> | undefined {
    const touchedCalls = new Set<string>()
    const touchedResults = new Set<string>()
    for (const position of changed) {
      release(callOwner, selected[position]?.calls ?? [], touchedCalls)
      release(resultOwner, selected[position]?.results ?? [], touchedResults)
    }
    for (const position of changed) {
      const message = messages[position]
      if (message === undefined) return undefined
      const { calls, results } = toolIds(message)
      if (!claim(callOwner, calls, position, touchedCalls) || !claim(resultOwner, results, position, touchedResults)) {
        return undefined
      }
    }
    return new Set([...ownersOf(resultOwner, touchedCalls), ...ownersOf(callOwner, touchedResults)])
  }

  /** The parts OTHER messages hold that this message's calls and results pair with, from the owner index. */
  function pairedParts(message: UIMessage, position: number): MessagePart[] {
    const { calls, results } = toolIds(message)
    const parts: MessagePart[] = []
    for (const callId of calls) {
      const owner = resultOwner.get(callId)
      if (owner === undefined || owner === position) continue
      const result = held[owner]?.parts.find((part) => part.type === 'tool-result' && part.toolCallId === callId)
      if (result !== undefined) parts.push(result)
    }
    for (const resultCallId of results) {
      const owner = callOwner.get(resultCallId)
      if (owner === undefined || owner === position) continue
      const call = held[owner]?.parts.find((part) => part.type === 'tool-call' && part.id === resultCallId)
      if (call !== undefined) parts.push(call)
    }
    return parts
  }

  /** One message selected again, against the parts it pairs with in other messages. */
  function reselect(position: number): void {
    const message = held[position]
    if (message === undefined) return
    const paired: UIMessage = { id: '', role: 'assistant', parts: pairedParts(message, position) }
    const [messageSelection] = selectChatUI({ messages: [message, paired] }).messages
    if (messageSelection === undefined) return
    selected[position] = selectedMessage(message, keyedParts(automaticPartsForMessage(messageSelection)))
  }

  /** The held list extended to `messages`, selecting only what changed; false when it must be rebuilt. */
  function extend(messages: readonly UIMessage[]): boolean {
    const changed = changedPositions(messages)
    if (changed === undefined) return false
    const paired = reindex(messages, changed)
    if (paired === undefined) return false
    const grew = messages.length > held.length
    for (let position = held.length; position < messages.length; position += 1) {
      const message = messages[position]
      if (message !== undefined) indexById.set(message.id, position)
    }
    if (grew) messageIds = new Set(indexById.keys())
    const previousLength = held.length
    held = messages
    const reselected = [...new Set([...changed, ...paired])]
    for (const position of reselected) reselect(position)
    // The last message before this list grew is no longer the last: it may now be hidden (#382).
    const from = Math.min(...reselected, grew && previousLength > 0 ? previousLength - 1 : Number.POSITIVE_INFINITY)
    if (Number.isFinite(from)) positionFrom(from, heldPromptsBefore)
    return true
  }

  return (messages, generating, promptsBefore) => {
    if (messages !== held || promptsBefore !== heldPromptsBefore) {
      const extendable =
        !ambiguous && promptsBefore === heldPromptsBefore && held.length > 0 && messages.length >= held.length
      if (!(extendable && extend(messages))) {
        held = messages
        rebuild(messages, promptsBefore)
      }
    }
    const current = rows
    const lookup = indexById
    return {
      rowOf: (messageId: string) => {
        const position = lookup.get(messageId)
        return position === undefined ? undefined : current[position]
      },
      openRunMessageIds: openRunOf(messages, generating),
      messageIds,
    }
  }
}

/** Claim the call ids for the message at `position`; false when another message already holds one. */
function claim(
  owners: Map<string, number>,
  toolCallIds: readonly string[],
  position: number,
  touched: Set<string>,
): boolean {
  for (const toolCallId of toolCallIds) {
    const owner = owners.get(toolCallId)
    if (owner !== undefined && owner !== position) return false
    owners.set(toolCallId, position)
    touched.add(toolCallId)
  }
  return true
}

/** Let go of the call ids a message held, noting each as touched — its pairing is to be read again. */
function release(owners: Map<string, number>, toolCallIds: readonly string[], touched: Set<string>): void {
  for (const toolCallId of toolCallIds) {
    owners.delete(toolCallId)
    touched.add(toolCallId)
  }
}

/** The positions holding the other half of each touched call id — the messages whose pairing moved. */
function ownersOf(owners: ReadonlyMap<string, number>, toolCallIds: ReadonlySet<string>): number[] {
  const positions: number[] = []
  for (const toolCallId of toolCallIds) {
    const owner = owners.get(toolCallId)
    if (owner !== undefined) positions.push(owner)
  }
  return positions
}
