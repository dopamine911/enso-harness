import { ZenNotifyType, ZenOpenDialog, ZenQueue, ZenUiRequestOrigin } from '@zen/core'
import { Check } from 'typebox/value'
import {
  ZEN_CUSTOM_EVENT_DIALOG,
  ZEN_CUSTOM_EVENT_DIALOG_SETTLED,
  ZEN_CUSTOM_EVENT_ENTRY,
  ZEN_CUSTOM_EVENT_FOLLOW_ENDED,
  ZEN_CUSTOM_EVENT_MODE,
  ZEN_CUSTOM_EVENT_NOTIFY,
  ZEN_CUSTOM_EVENT_OPEN_DIALOGS,
  ZEN_CUSTOM_EVENT_QUEUE,
  ZEN_CUSTOM_EVENT_RUN,
  ZEN_CUSTOM_EVENT_USAGE,
} from './rpc/custom-event-names.ts'
import { createStore, type Store } from './store.ts'
import type { ThreadStores } from './thread-stores.ts'

/**
 * The browser's ONE path from an AG-UI CUSTOM chunk to a thread's stores (mode lines,
 * current mode, session stats, notifications, the debug record). TanStack's
 * `onCustomEvent` fires this with `(chunk.name, chunk.value)` for every CUSTOM chunk —
 * verified against its stream processor (#29).
 *
 * ⚠ THE THREAD COMES FROM THE CALLER, NOT THE CHUNK. TanStack hands `onCustomEvent` only
 * `(name, value, { toolCallId })` — no thread id — and the option is bound per chat
 * factory. So each thread's pane builds its own factory whose `onCustomEvent` closes over
 * that thread's stores (#90 PR 3); a chunk can never be attributed to the wrong thread
 * because the callback that receives it belongs to exactly one.
 *
 * Extracted from `chat-screen.tsx`'s chat options so it can be TESTED (#53 S1.3): as an
 * inline closure on an options object, renaming a chunk name, dropping the notify-type
 * allowlist, or swapping two `apply*` calls all left the suite green. The tests drive this
 * function directly with a fresh set of stores and read their snapshots.
 *
 * ⚠ Every value is read defensively, the way every wire crossing in the browser is: a
 * malformed value renders as nothing rather than throwing inside TanStack's stream loop,
 * where a throw would end the run. Chunk names this surface does not render
 * (`zen.unmapped`) fall through untouched — see the mapper for why they exist at all.
 */
export function routeZenCustomEvent(stores: ThreadStores, eventType: string, data: unknown): void {
  stores.recentChunks.record(eventType, data)
  if (eventType === ZEN_CUSTOM_EVENT_ENTRY) {
    // One persisted entry, two views (#84): the transcript line (history) and the
    // current-mode store (state). Both read picc's shape through the same core helper.
    stores.modeLines.apply(data)
    stores.permissionMode.applyPersistedEntry(data)
    return
  }
  if (eventType === ZEN_CUSTOM_EVENT_MODE) {
    stores.permissionMode.applyReceipt(data)
    return
  }
  if (eventType === ZEN_CUSTOM_EVENT_RUN) {
    const generation = readGeneration(data)
    if (generation !== undefined) stores.generation.set(generation)
    // A status frame reaches this page only over a live follow (#119).
    if (stores.disconnected.get()) stores.disconnected.set(false)
    return
  }
  if (
    eventType === ZEN_CUSTOM_EVENT_DIALOG ||
    eventType === ZEN_CUSTOM_EVENT_DIALOG_SETTLED ||
    eventType === ZEN_CUSTOM_EVENT_OPEN_DIALOGS
  ) {
    routeDialogEvent(stores, eventType, data)
    return
  }
  if (eventType === ZEN_CUSTOM_EVENT_USAGE) {
    stores.stats.applyUsage(data)
    return
  }
  if (eventType === ZEN_CUSTOM_EVENT_QUEUE) {
    // pi's queue, whole (#75): steering first, then follow-ups. A malformed frame leaves the
    // last list standing rather than clearing a real queue.
    if (Check(ZenQueue, data)) stores.queue.set([...data.steering, ...data.followUp])
    return
  }
  if (eventType === ZEN_CUSTOM_EVENT_FOLLOW_ENDED) {
    // The server went away under this page (#103 receipt): said where the human looks —
    // a notice, and the status bar's own state (#119), since with no run open nothing else
    // on the page would change and with one open the run flag would still say so.
    stores.disconnected.set(true)
    stores.notifications.push(
      "the connection to the server ended — the thread's state here is as of that moment; reload and resume it from the rail to reconnect",
      'error',
      'run',
    )
    return
  }
  if (eventType !== ZEN_CUSTOM_EVENT_NOTIFY) return
  if (typeof data !== 'object' || data === null) return
  const observation = data as { message?: unknown; notifyType?: unknown; origin?: unknown }
  if (typeof observation.message !== 'string') return
  // The three declared notify types come from the schema, not a second literal list: an
  // unrecognised value degrades to an untyped notification, never a validation failure.
  const notifyType = Check(ZenNotifyType, observation.notifyType) ? observation.notifyType : undefined
  // An unreadable origin degrades to `run` — the OPEN rendering (#96): when the tag cannot
  // be trusted, a notice is shown, never grouped away.
  const origin = Check(ZenUiRequestOrigin, observation.origin) ? observation.origin : 'run'
  stores.notifications.push(observation.message, notifyType, origin)
}

/**
 * The thread's ONE open-question slot (#112, #114), and the three chunks that move it:
 *
 *   zen.dialog          a question pi just asked — opens the slot. A malformed value opens
 *                       nothing and SAYS so: a question that vanished silently is the #4 shape.
 *   zen.dialog-settled  the question stopped waiting — drops the card if it is the one shown.
 *                       Any other id is one this page never showed or already dropped.
 *   zen.open-dialogs    a snapshot's COMPLETE list — replaces the slot, so an empty list
 *                       clears a card for a question that settled while the page was away.
 *                       One card at a time: a second concurrent question shows once the
 *                       first settles and the next snapshot lists it. A malformed list is
 *                       left alone rather than clearing a real question.
 */
function routeDialogEvent(stores: ThreadStores, eventType: string, data: unknown): void {
  if (eventType === ZEN_CUSTOM_EVENT_DIALOG) {
    if (Check(ZenOpenDialog, data)) stores.dialog.set(data)
    else
      stores.notifications.push('pi asked a question this page could not read; it was left unanswered', 'error', 'run')
    return
  }
  if (eventType === ZEN_CUSTOM_EVENT_DIALOG_SETTLED) {
    const shown = stores.dialog.get()
    if (shown !== undefined && typeof data === 'object' && data !== null && 'id' in data && data.id === shown.id) {
      stores.dialog.set(undefined)
    }
    return
  }
  if (typeof data !== 'object' || data === null || !('open' in data) || !Array.isArray(data.open)) return
  const first: unknown = data.open[0]
  stores.dialog.set(Check(ZenOpenDialog, first) ? first : undefined)
}

/** The `zen.run` value's number, or undefined for anything that is not a non-negative integer. */
function readGeneration(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || !('generation' in data)) return undefined
  const { generation } = data
  return typeof generation === 'number' && Number.isInteger(generation) && generation >= 0 ? generation : undefined
}

// ── the last N chunks, for the debug drawer (#86) ─────────────────────────────
// The router is the ONE path every CUSTOM chunk crosses, which makes it the honest place
// to keep "what the browser was actually told". A fixed-size ring per thread: old chunks
// fall off the front, and a long session costs nothing extra.

export interface RecordedCustomChunk {
  /** Monotonic per thread — the chunk's identity, since name + time can collide. */
  readonly sequence: number
  readonly name: string
  readonly value: unknown
  /** ISO 8601, when the router saw it. */
  readonly receivedAt: string
}

/** Enough to see a whole run's worth (a receipt, a few entries, usage) without scrolling. */
export const RECENT_CUSTOM_CHUNK_CAPACITY = 50

export interface RecentChunksStore extends Store<readonly RecordedCustomChunk[]> {
  readonly record: (name: string, value: unknown) => void
}

/** Oldest first; the snapshot is a fresh array per record, so a consumer cannot mutate the ring. */
export function createRecentChunksStore(): RecentChunksStore {
  const store = createStore<readonly RecordedCustomChunk[]>([])
  let nextSequence = 0
  return {
    get: store.get,
    subscribe: store.subscribe,
    record: (name, value) => {
      nextSequence += 1
      const appended = [...store.get(), { sequence: nextSequence, name, value, receivedAt: new Date().toISOString() }]
      store.set(appended.slice(-RECENT_CUSTOM_CHUNK_CAPACITY))
    },
  }
}
