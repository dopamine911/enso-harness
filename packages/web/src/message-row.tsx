import type { EnsoProviderRefusal } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { GitForkIcon, HistoryIcon } from 'lucide-react'
import { createContext, memo, useContext, useState } from 'react'
import { Message, MessageContent } from './components/ai-elements/message.tsx'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'
import { EnsoRing } from './enso-mark.tsx'
import type { EnsoRendererMap } from './EnsoToolResult.tsx'
import { ForkContext, RestoreContext } from './fork-thread.ts'
import { IncidentCards, type PlacedIncidents } from './incident-card.tsx'
import { NotificationLines, type PlacedLines } from './notifications.tsx'
import { providerRefusalLine, providerRefusalSource, RefusedAttemptLine, refusalOfMessage } from './refused-attempt.tsx'
import { SelectedMessagePart } from './selected-message-part.tsx'
import { useStore, useThreadStores } from './store.ts'
import type { KeyedPart, TranscriptSelection } from './transcript-selection.ts'

/**
 * One transcript row (#280): a message's bubble, its prompt's actions, and the incident cards and
 * lines that follow it.
 */

/**
 * Renderers keyed by descriptor `kind` (#18).
 *
 * ⚠ Empty on purpose. Every tool result falls through to the mandatory textual form, which
 * is exactly what the contract promises for an unknown kind — so empty is the honest
 * default, not a gap. A renderer is added when a tool earns one.
 */
const descriptorRenderers: EnsoRendererMap = {}

/**
 * The transcript's selection for the rows (#280, #739): built in `ChatLayout`, where the chat is
 * already read, by the pane's `createTranscriptSelector` — which selects again only what a chunk
 * changed. With it here no row calls `useChatContext`, and a row hands what it draws to a memo
 * (`MessageBody`).
 */
export const TranscriptSelectionContext = createContext<TranscriptSelection>({
  rowOf: (): undefined => undefined,
  openRunMessageIds: new Set(),
  messageIds: new Set(),
})

/** The thread's lines by where they read (#382), grouped once in `ChatLayout` for every row. */
export const PlacedLinesContext = createContext<PlacedLines>({ head: [], after: new Map(), tail: [] })

/** The thread's incident cards by the message they follow (#588), placed once in `ChatLayout` for every row. */
export const PlacedIncidentsContext = createContext<PlacedIncidents['after']>(new Map())

/**
 * The roles a bubble is drawn for. TanStack's `UIMessage` also has `activity` (AG-UI activity messages,
 * `@tanstack/ai-client` 0.39), which Enso's follow adapter never emits; one that ever arrived is left out.
 */
type DrawnRole = Exclude<UIMessage['role'], 'activity'>

interface MessageBodyProps {
  readonly messageId: string
  readonly role: DrawnRole
  readonly parts: KeyedPart[]
  /** This message's run is in flight: a tool call with no result reads `running…` (#130). */
  readonly runOpen: boolean
  /** The provider refused this attempt (#381): said in the bubble, after whatever parts it has. */
  readonly refusal: EnsoProviderRefusal | undefined
  /** Whether the speaker line is drawn — not when the message before it is the same speaker's. */
  readonly speaker: boolean
  /** A user prompt's name for its fork and restore (#651): `prompt 2: “…”` (`TranscriptRow.promptName`). */
  readonly promptName: string | undefined
}

/**
 * Who a message is from, above it (the design direction's speaker line): `you`, or pi beside its
 * ring. Ledger drops the ring and prints the user's prompt as a receipt line, `› you`.
 */
function MessageSpeaker({ role }: { role: DrawnRole }): React.ReactNode {
  if (role === 'user') {
    return (
      <div className="flex items-center justify-end gap-1 font-mono text-xs text-muted-foreground ledger:justify-start ink:font-heading ink:text-sm ink:italic">
        <span aria-hidden="true" className="hidden text-evidence ledger:inline">
          ›
        </span>
        you
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground ink:font-heading ink:text-sm ink:italic">
      {role === 'assistant' ? (
        <EnsoRing className="size-4.5 text-foreground signal:text-evidence ledger:hidden" />
      ) : null}
      {role === 'assistant' ? 'pi' : role}
    </div>
  )
}

/**
 * One message's bubble, re-rendered only when what it SHOWS changed (#280): a streamed delta into a
 * long thread redraws the one bubble it changed, not every bubble.
 *
 * ⚠ The comparison is over the selected PARTS, not over the message object, and that is the
 * whole subtlety. The selection runs over the WHOLE list precisely so a tool result the server
 * stamps onto a LATER message still pairs with its call (see `ChatMessageRow`), so what an
 * earlier bubble draws is not a function of its own message alone — which is why TanStack's
 * `memo(MessageView)`, comparing the message, is measuring the wrong thing for this row. Nor
 * is it cheaper: on the chunk that pairs such a result, TanStack replaces EVERY message object
 * in the list, so a message-identity memo bails out there for nobody. Part identity is what
 * decides the output, so that is what is compared — the same rule the vendor applies one level
 * down, per part (`selectedPartPropsEqual`).
 */
const MessageBody = memo(function MessageBody({
  messageId,
  role,
  parts,
  runOpen,
  refusal,
  speaker,
  promptName,
}: MessageBodyProps): React.ReactNode {
  return (
    <Message
      from={role}
      data-role={role}
      className="max-w-3xl gap-1 ledger:ml-0 ledger:max-w-none ledger:border-b ledger:py-3"
    >
      {speaker ? <MessageSpeaker role={role} /> : null}
      <MessageContent className="text-base leading-relaxed group-[.is-assistant]:w-full group-[.is-user]:rounded-lg group-[.is-user]:px-3 group-[.is-user]:py-2 signal:group-[.is-user]:rounded-br-sm ledger:group-[.is-user]:ml-0 ledger:group-[.is-user]:bg-transparent ledger:group-[.is-user]:p-0">
        {parts.map(({ partKey, selected, isTrailingPart }) => (
          <SelectedMessagePart
            key={`${messageId}-${partKey}`}
            selected={selected}
            // ⚠ Part-level, not chat-level: true only for the TRAILING part of the TRAILING
            // message while a run is in flight. A chat-level flag (`chat.isLoading`) re-opens
            // EVERY prior thinking block on every later send (the Reasoning shell's auto-close
            // latches after its first close, so they never close again) and overwrites each
            // block's "Thought for N seconds" with the later run's timing.
            isStreaming={runOpen && isTrailingPart}
            runOpen={runOpen}
            renderers={descriptorRenderers}
          />
        ))}
        {/* A refused attempt (#381), from pi's stored message: without it a reload draws an empty
            bubble where the refusal was said live. */}
        {refusal === undefined ? null : <RefusedAttemptLine refusal={refusal} />}
      </MessageContent>
      {role === 'user' ? <PromptActions messageId={messageId} promptName={promptName} /> : null}
    </Message>
  )
}, sameRenderedMessage)

/**
 * A prompt's actions: fork from it (#433) and restore the files to it (#551), each where the page
 * offers it. ⚠ NAMED FOR THEIR PROMPT (#651): every prompt has them, and a name the same on every
 * prompt left a screen reader — and an agent reading the page — unable to tell which prompt a
 * restore would go back to. The visible words stay short; the accessible name starts with them
 * (label in name) and quotes the prompt, and the confirmation names it too.
 */
function PromptActions({
  messageId,
  promptName,
}: {
  readonly messageId: string
  readonly promptName: string | undefined
}): React.ReactNode {
  const named = promptName === undefined ? '' : `, ${promptName}`
  const forkAt = useContext(ForkContext)
  const offeredRestore = useContext(RestoreContext)
  // Restore only where there are files to restore (#561): a thread on a tree of its own.
  const onTree = useStore(useThreadStores().tree)
  const restoreAt = onTree ? offeredRestore : undefined
  const [confirming, setConfirming] = useState(false)
  if (forkAt === undefined && restoreAt === undefined) return null
  return (
    <div className="flex justify-end ledger:justify-start">
      {forkAt === undefined ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          title="a new thread holding everything before this prompt, with its words ready to send again"
          aria-label={`fork from here${named}`}
          onClick={(): void => forkAt(messageId)}
        >
          <GitForkIcon aria-hidden="true" />
          fork from here
        </Button>
      )}
      {restoreAt === undefined ? null : (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            title="put the thread's files back as they were at this prompt"
            aria-label={`Restore files to here${named}`}
            onClick={(): void => setConfirming(true)}
          >
            <HistoryIcon aria-hidden="true" />
            Restore files to here
          </Button>
          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Restore files to here?</DialogTitle>
                <DialogDescription>
                  The thread's files go back to how they were at {promptName ?? 'this prompt'}. The conversation is not
                  changed; pi is told on your next prompt that the files went back (#652). The current files are kept as
                  a safety snapshot: "Undo last restore" on the notice puts them back.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={(): void => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={(): void => {
                    setConfirming(false)
                    restoreAt(messageId)
                  }}
                >
                  Restore files
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}

/** The same refusal line, whether or not the message object behind it was replaced. */
function sameRefusal(before: EnsoProviderRefusal | undefined, after: EnsoProviderRefusal | undefined): boolean {
  if (before === undefined || after === undefined) return before === after
  return (
    providerRefusalLine(before) === providerRefusalLine(after) &&
    providerRefusalSource(before) === providerRefusalSource(after)
  )
}

/**
 * Whether two renders of one row would draw the same thing. `messageId` and `role` are not
 * compared: the list is keyed by message id, so one mounted row is one message for its whole
 * life. `isTrailingPart` is not compared either — it is the part's position, which equal
 * lengths and equal keys already settle.
 */
function sameRenderedMessage(previous: MessageBodyProps, next: MessageBodyProps): boolean {
  if (previous.runOpen !== next.runOpen || previous.speaker !== next.speaker) return false
  if (previous.promptName !== next.promptName) return false
  if (!sameRefusal(previous.refusal, next.refusal)) return false
  if (previous.parts.length !== next.parts.length) return false
  return previous.parts.every((part, index) => {
    const other = next.parts[index]
    if (other === undefined || part.partKey !== other.partKey) return false
    const before = part.selected
    const after = other.selected
    if (before.key !== after.key || before.part !== after.part) return false
    if (before.key === 'toolCall' && after.key === 'toolCall') {
      return before.result === after.result && before.interrupt === after.interrupt
    }
    if (before.key === 'toolResult' && after.key === 'toolResult') return before.matched === after.matched
    return true
  })
}

/**
 * One message's row: its bubble, from the selection's row for it, then the incident cards whose
 * tipping call it holds (#588) and the lines that follow it (#382). The `message` slot TanStack's
 * factory requires, and the row `TranscriptRows` draws for each message in view.
 *
 * ⚠ It runs only for the rows in view, on every chunk (it reads the selection, and React re-renders
 * a context consumer), and all it does is a lookup and hand `MessageBody` its props — that memo is
 * what keeps the redraw to the bubble that changed. The selection pairs across the whole list (a
 * tool result the server stamps onto a DIFFERENT message than its call still pairs; a per-message
 * `selectMessageUI` would show such a call as "running…" forever), which is why it is built once in
 * `ChatLayout` and never here (#280). A hidden message (a refused attempt with nothing drawn) keeps
 * its lines.
 */
export function ChatMessageRow({ message }: { message: UIMessage }): React.ReactNode {
  const { rowOf, openRunMessageIds } = useContext(TranscriptSelectionContext)
  const row = rowOf(message.id)
  const lines = useContext(PlacedLinesContext).after.get(message.id)
  const incidents = useContext(PlacedIncidentsContext).get(message.id)
  return (
    <>
      {row === undefined || row.hidden || message.role === 'activity' ? null : (
        <MessageBody
          messageId={message.id}
          role={message.role}
          parts={row.parts}
          runOpen={openRunMessageIds.has(message.id)}
          refusal={refusalOfMessage(message)}
          speaker={row.speaker}
          promptName={row.promptName}
        />
      )}
      {incidents === undefined ? null : <IncidentCards records={incidents} />}
      {lines === undefined ? null : <NotificationLines lines={lines} />}
    </>
  )
}
