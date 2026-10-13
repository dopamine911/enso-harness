import { ENSO_NOTICE_SOURCE } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { useVirtualizer } from '@tanstack/react-virtual'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { ConversationEmptyState } from './components/ai-elements/conversation.tsx'
import { Button } from './components/ui/button.tsx'
import { EnsoSmile } from './enso-mark.tsx'
import {
  IncidentCards,
  type IncidentPointer,
  IncidentRevealContext,
  OpenIncidentPointer,
  type PlacedIncidents,
  placeIncidents,
} from './incident-card.tsx'
import {
  TranscriptSelectionContext,
  PlacedLinesContext,
  PlacedIncidentsContext,
  ChatMessageRow,
} from './message-row.tsx'
import { NotificationLines, type PlacedLines, placeLines } from './notifications.tsx'
import { useStore, useThreadStores } from './store.ts'
import { loadEarlierMessages } from './thread-stores.ts'
import { revealElement } from './transcript-reveal.ts'
import { createTranscriptSelector, type TranscriptSelection } from './transcript-selection.ts'
import { estimatedTranscriptRow, windowedRowStyle } from './transcript-window.ts'

/**
 * A thread's transcript (#280, #739): selected once per pane, windowed, with pi's lines and the
 * incident cards placed where they happened.
 */

/** What `TranscriptRevealBridge` hands the layout: the pane's transcript and its scroll lock. */
export interface TranscriptScroller {
  readonly content: () => HTMLElement | null
  readonly stopScroll: () => void
}

/**
 * Lends the layout what only `<Conversation>`'s children can reach (#359): its content element,
 * the root a stats target is looked for under (one pane's, never a hidden pane's), and
 * `stopScroll`. Stick-to-bottom pulls a streaming transcript back down on every resize; a jump to
 * turn 3 has to let go of that lock first, or the next token undoes it.
 */
export function TranscriptRevealBridge({ into }: { into: React.RefObject<TranscriptScroller | null> }): null {
  const { contentRef, stopScroll } = useStickToBottomContext()
  useEffect(() => {
    into.current = { content: () => contentRef.current, stopScroll }
    return () => {
      into.current = null
    }
  }, [into, contentRef, stopScroll])
  return null
}

/** The tail pointer's reveal of an incident card, and what it waits on — `useIncidentReveal`. */
interface IncidentReveal {
  readonly pendingReveal: React.RefObject<string | undefined>
  readonly rowScroll: React.RefObject<((row: number) => void) | null>
  readonly reveal: (pointer: IncidentPointer) => void
}

/**
 * The tail pointer's reveal of a halted thread's open incident (#588). A card the list has drawn is
 * scrolled to and ringed as a stats target is (#359). ⚠ The list is WINDOWED (#739): a card on a
 * row out of the window is not in the DOM to find, so the incident is left pending and the list
 * scrolls to its row; the card rings itself as it mounts (`IncidentRevealContext`).
 */
export function useIncidentReveal(scroller: React.RefObject<TranscriptScroller | null>): IncidentReveal {
  const pendingReveal = useRef<string | undefined>(undefined)
  const rowScroll = useRef<((row: number) => void) | null>(null)
  const reveal = useCallback(
    (pointer: IncidentPointer) => {
      const bridge = scroller.current
      const content = bridge?.content() ?? null
      if (bridge === null || content === null) return
      bridge.stopScroll()
      const card = content.querySelector(`[data-incident-id="${CSS.escape(pointer.incidentId)}"]`)
      if (card !== null) {
        revealElement(card)
        return
      }
      pendingReveal.current = pointer.incidentId
      rowScroll.current?.(pointer.row)
    },
    [scroller],
  )
  return useMemo(() => ({ pendingReveal, rowScroll, reveal }), [reveal])
}

/**
 * Brings a row of the windowed list into view by its position (#588): `TranscriptRows` lends its
 * virtualizer's scroll here for a reveal whose target is on a row out of the window, and so not drawn.
 */
const RowScrollContext = createContext<React.RefObject<((row: number) => void) | null> | null>(null)

/**
 * The thread's lines by where they read (#382), for the transcript the selection is. Also hands the
 * store the transcript's last message: a line the page raises between runs follows it — as
 * rendered, which is what a reader saw when they acted. Grouped again when the lines change or a
 * message is added or removed — not per streamed chunk (#739): the selection's id set is the same
 * object until then. A line whose message is on a page not loaded yet waits for it (`earlier`).
 */
function usePlacedLines(selection: TranscriptSelection, lastMessageId: string | undefined): PlacedLines {
  const { notifications, earlier } = useThreadStores()
  useEffect(() => {
    notifications.setTranscriptTail(lastMessageId)
  }, [notifications, lastMessageId])
  const lines = useStore(notifications)
  const waiting = useStore(earlier)?.anchors
  const { messageIds } = selection
  return useMemo(() => placeLines(lines, messageIds, waiting), [lines, messageIds, waiting])
}

/**
 * "Load earlier" (#739): a long thread opens on its last page, and this reads the page before the
 * first message held and puts it above. The reader is let go of the bottom first — the press is a
 * scroll up — and the list keeps what they were reading where it was (`TranscriptRows`).
 */
function LoadEarlier({
  messages,
  setMessages,
}: {
  messages: readonly UIMessage[]
  setMessages: (messages: UIMessage[]) => void
}): React.ReactNode {
  const stores = useThreadStores()
  const earlier = useStore(stores.earlier)
  const { stopScroll } = useStickToBottomContext()
  const [loading, setLoading] = useState(false)
  // The transcript as of the latest COMMITTED render, for a page that lands after more streamed in
  // (`ChatPromptInput`'s `latestMessages`).
  const latestMessages = useRef(messages)
  useEffect(() => {
    latestMessages.current = messages
  }, [messages])
  if (earlier === undefined) return null
  const load = (): void => {
    stopScroll()
    setLoading(true)
    const held = latestMessages.current
    void loadEarlierMessages(stores, held).then((page) => {
      setLoading(false)
      if (typeof page === 'string') {
        stores.notifications.push(`earlier messages could not be loaded: ${page}`, 'warning', 'run', ENSO_NOTICE_SOURCE)
        return
      }
      // ⚠ A compaction's re-read replaced the transcript meanwhile: the page is of a branch no longer shown.
      if (latestMessages.current[0]?.id !== held[0]?.id) return
      setMessages([...page.messages, ...latestMessages.current])
      stores.earlier.set(page.earlier)
    })
  }
  const count = earlier.messages === 1 ? '1 earlier message' : `${earlier.messages} earlier messages`
  return (
    <div className="flex justify-center">
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={load}>
        {loading ? 'Loading earlier messages…' : `Load earlier · ${count}`}
      </Button>
    </div>
  )
}

// The row estimate and placement, in pixels as a virtualizer needs them: `transcript-window.ts`.

/** Rows drawn past each edge of the viewport, so a fast scroll does not show blank space before they measure. */
const TRANSCRIPT_OVERSCAN_ROWS = 6

/** One row's box: the gap between rows is its padding, since a windowed row is placed, not flowed — the prototype's 24px (#417). */
const TRANSCRIPT_ROW = 'pb-6 ledger:pb-0'

/**
 * The transcript's rows, WINDOWED (#739): only the rows in and near the viewport are in the DOM, so
 * a thread of thousands of messages draws the same few dozen bubbles as a short one. The scroller is
 * `<Conversation>`'s, so stick-to-bottom keeps following a streaming reply: the list's height is the
 * rows' measured total, and it grows as the reply does.
 *
 * ⚠ `anchorTo: 'end'` is what keeps the reader in place when "Load earlier" puts a page above: the
 * virtualizer re-anchors the scroll to the row that was at the top of the view, so the page grows
 * upward out of sight instead of pushing the text down.
 *
 * A viewport with no height has no window to cut — a static render, a DOM without layout — and
 * draws every row in flow.
 */
function TranscriptRows({ messages }: { messages: readonly UIMessage[] }): React.ReactNode {
  const { scrollRef } = useStickToBottomContext()
  // Where the list starts inside the scroller: below the lines and the "Load earlier" control. Any of
  // them growing or shrinking resizes the content the list sits in, so that is what is watched.
  const [scrollMargin, setScrollMargin] = useState(0)
  // The list's element, as state: the list is drawn by one of two branches below, so the watch
  // follows whichever element is mounted.
  const [listElement, list] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const content = listElement?.parentElement
    if (listElement === null || content === null || content === undefined) return undefined
    const measure = (): void => setScrollMargin(listElement.offsetTop)
    measure()
    // ⚠ A FRAME LATER, never inside the callback: the new margin moves the rows, which resizes the
    // content this watches, and a resize caused within the same callback is the loop the browser
    // reports as "ResizeObserver loop completed with undelivered notifications" (#739).
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [listElement])
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimatedTranscriptRow,
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: TRANSCRIPT_OVERSCAN_ROWS,
    scrollMargin,
    anchorTo: 'end',
    // Until the scroller is measured, a window the size of the page's — never zero in a browser.
    initialRect: { width: 0, height: typeof window === 'undefined' ? 0 : window.innerHeight },
    // Its row measurements a frame later too, for the same ResizeObserver loop as the margin's: a
    // measured row moves the rows below it inside the observer's own callback otherwise.
    useAnimationFrameWithResizeObserver: true,
  })
  // ⚠ Aligned to the row's END, where an incident card follows its message (#588), and left to the
  // virtualizer alone: it corrects its own scroll as the rows it draws are measured, and a second
  // scroll (the card's `scrollIntoView`) would fight it. The card rings itself as it mounts.
  const rowScroll = useContext(RowScrollContext)
  useEffect(() => {
    if (rowScroll === null) return undefined
    rowScroll.current = (row) => virtualizer.scrollToIndex(row, { align: 'end' })
    return () => {
      rowScroll.current = null
    }
  }, [rowScroll, virtualizer])
  const rows = virtualizer.getVirtualItems()
  if (rows.length === 0) {
    return (
      <div ref={list}>
        {messages.map((message) => (
          <div key={message.id} className={TRANSCRIPT_ROW}>
            <ChatMessageRow message={message} />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div ref={list} style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
      {rows.map((row) => {
        const message = messages[row.index]
        if (message === undefined) return null
        return (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className={TRANSCRIPT_ROW}
            style={windowedRowStyle(row.start - scrollMargin)}
          >
            <ChatMessageRow message={message} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * The transcript's own content: the empty state or the messages, and pi's notify lines (#29), each
 * where it happened (#382) — the startup notices and anything said before the first message head
 * it, the rest follow the message they came after (`ChatMessageRow`), and the lines whose message
 * the transcript no longer holds (a re-read replaced it) close it. Incident cards read the same way
 * (#588): each after the message holding its tipping call, the rest closing it, then a halted
 * thread's pointer to its open incident further up. A long thread's page starts with "Load
 * earlier" (#739).
 */
export function TranscriptContent({
  messages,
  setMessages,
  selection,
  placed,
  incidentReveal,
}: {
  messages: readonly UIMessage[]
  setMessages: (messages: UIMessage[]) => void
  selection: TranscriptSelection
  placed: { readonly lines: PlacedLines; readonly incidents: PlacedIncidents }
  incidentReveal: IncidentReveal
}): React.ReactNode {
  const empty = messages.length === 0
  const { lines, incidents } = placed
  return (
    <IncidentRevealContext.Provider value={incidentReveal.pendingReveal}>
      {empty ? (
        <ConversationEmptyState>
          <EnsoSmile className="size-28" />
          <h2 className="font-heading text-xl font-semibold">Give agents room to work. Keep the receipts.</h2>
          <p className="text-sm text-muted-foreground">ask pi something to get started</p>
        </ConversationEmptyState>
      ) : null}
      <LoadEarlier messages={messages} setMessages={setMessages} />
      <NotificationLines lines={lines.head} />
      {empty ? null : (
        <TranscriptSelectionContext.Provider value={selection}>
          <PlacedLinesContext.Provider value={lines}>
            <PlacedIncidentsContext.Provider value={incidents.after}>
              <RowScrollContext.Provider value={incidentReveal.rowScroll}>
                <TranscriptRows messages={messages} />
              </RowScrollContext.Provider>
            </PlacedIncidentsContext.Provider>
          </PlacedLinesContext.Provider>
        </TranscriptSelectionContext.Provider>
      )}
      <NotificationLines lines={lines.tail} />
      <IncidentCards records={incidents.tail} />
      <OpenIncidentPointer pointer={incidents.pointer} reveal={incidentReveal.reveal} />
    </IncidentRevealContext.Provider>
  )
}

/**
 * The one place the transcript is selected (#280): in `ChatLayout`, where the chat is already read,
 * by the pane's own selector, which selects again only what a chunk changed (#739) — and the lines
 * placed by that selection, and the incident cards by the messages (#588).
 */
export function useTranscriptSelection(
  messages: UIMessage[],
  generating: boolean,
): {
  readonly selection: TranscriptSelection
  readonly placed: { readonly lines: PlacedLines; readonly incidents: PlacedIncidents }
} {
  const stores = useThreadStores()
  const [selectTranscript] = useState(createTranscriptSelector)
  const promptsBefore = useStore(stores.earlier)?.prompts ?? 0
  const selection = useMemo(
    () => selectTranscript(messages, generating, promptsBefore),
    [selectTranscript, messages, generating, promptsBefore],
  )
  const lines = usePlacedLines(selection, messages.at(-1)?.id)
  const incidentState = useStore(stores.incidents)
  const incidents = useMemo(() => placeIncidents(incidentState, messages), [incidentState, messages])
  const placed = useMemo(() => ({ lines, incidents }), [lines, incidents])
  return { selection, placed }
}
