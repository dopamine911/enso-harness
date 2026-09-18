import {
  ZenFollowSnapshot,
  ZenFollowStatus,
  ZenObservation,
  ZenOpenDialog,
  type ZenPermissionModeState,
} from '@zen/core'
import { Compile } from 'typebox/compile'
import { Check } from 'typebox/value'
import { createStore, type Store } from './store.ts'
import type { ThreadStores } from './thread-stores.ts'

/**
 * The one chunk that is neither an observation nor a frame: the follow ended without this
 * page leaving it (#103 receipt) — the server closed, restarted, or dropped the connection.
 * The adapter (`follow-connection.ts`) says it; this router, its only reader, names it.
 * Value: `{ threadId }`.
 */
export const FOLLOW_ENDED_CUSTOM_EVENT = 'follow-ended'

/**
 * JIT validators, compiled once at module load — the `@zen/core` convention
 * (`config.ts`, `dialog.ts`, `thread-runtime.ts`, `tool-result.ts`).
 *
 * `Compile` rather than `Check` because these run per CHUNK on the browser's main thread,
 * and `Check` re-walks the schema on every call: measured 6.77 µs interpreted against
 * 0.042 µs compiled for a `text-delta` against the 19-member `ZenObservation` union (once
 * per streamed token), 2.93 µs against 0.012 µs for a status, and 44.6 µs against 0.51 µs
 * for a 50-message snapshot — 138 µs against 1.84 µs at 500 messages (#281).
 *
 * `ZenOpenDialog` in `routeUiRequest` stays interpreted on purpose: it is checked once per
 * BLOCKING QUESTION — once per human decision, against a per-token union here — so its
 * 5.20 µs buys nothing worth a fourth validator, and compiling it would imply the dialog
 * path was hot. If that check ever becomes frequent, something is re-asking, which is a bug
 * and not a validator's cost.
 */
const snapshotValidator = Compile(ZenFollowSnapshot)
const statusValidator = Compile(ZenFollowStatus)
const observationValidator = Compile(ZenObservation)

/**
 * The browser's ONE path from an AG-UI CUSTOM chunk to a thread's stores (mode lines,
 * current mode, session stats, notifications, the debug record). TanStack's
 * `onCustomEvent` fires this with `(chunk.name, chunk.value)` for every CUSTOM chunk —
 * verified against its stream processor (#29).
 *
 * ONE VOCABULARY (#162 workstream 5). A chunk's name is a discriminator a type of ours
 * already declares, and its value is that whole thing:
 *
 *   `ZenObservation.kind`     value: the observation — what the adapter derives from the
 *                             follow's `observation` frames (`to-agui.ts#custom`)
 *   `ZenFollowFrame.type`     `snapshot` | `status` — value: the frame, as it came off the
 *                             wire; the run-start receipts (mode, open questions, generation)
 *                             are read off the snapshot itself, not re-shaped into names
 *   `FOLLOW_ENDED_CUSTOM_EVENT`      the adapter's own fact, above
 *
 * Before this the adapter emitted a parallel `zen.*` vocabulary — `zen.mode` for a
 * `permission-mode`, `zen.notify` for an `extension-ui-request`, a forged notify for a
 * `permission-mode-rejected` — and every rename had two sides to land on (#53 S1.3).
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
 * ⚠ Every value is validated against its schema, the way every wire crossing in the browser
 * is: a malformed value moves no store rather than throwing inside TanStack's stream loop,
 * where a throw would end the run. Kinds this surface does not render (`custom-entry`,
 * `unmapped`) are recorded and fall through — see the mapper for why they exist at all.
 */
export function routeZenCustomEvent(stores: ThreadStores, eventType: string, data: unknown): void {
  stores.recentChunks.record(eventType, data)
  if (eventType === FOLLOW_ENDED_CUSTOM_EVENT) {
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
  if (eventType === 'snapshot') {
    if (!snapshotValidator.Check(data)) return
    applyPermissionMode(stores, data.permissionMode)
    // The complete list, every snapshot (#114): a reconnect's snapshot is the resync, so an
    // empty list is a fact ("nothing is waiting") this page must apply too — it clears a
    // card for a question that settled while the page was away. One card at a time: a
    // second concurrent question shows once the first settles and the next snapshot lists it.
    stores.dialog.set(data.openDialogs[0])
    applyStatus(stores, data.generation)
    return
  }
  if (eventType === 'status') {
    if (statusValidator.Check(data)) applyStatus(stores, data.generation)
    return
  }
  if (!observationValidator.Check(data) || data.kind !== eventType) return
  routeObservation(stores, data)
}

/** One receipt, two views (#84, L3): the current-mode store (state) and the transcript line (history). */
function applyPermissionMode(stores: ThreadStores, state: ZenPermissionModeState): void {
  stores.permissionMode.applyReceipt(state)
  stores.modeLines.apply(state)
}

/** The thread's server-side acquisition (#109); a status frame reaches this page only over a live follow (#119). */
function applyStatus(stores: ThreadStores, generation: number): void {
  stores.generation.set(generation)
  if (stores.disconnected.get()) stores.disconnected.set(false)
}

function routeObservation(stores: ThreadStores, observation: ZenObservation): void {
  switch (observation.kind) {
    case 'permission-mode':
      // The run-start receipt and a mid-run change fold into the same two stores.
      applyPermissionMode(stores, { mode: observation.mode, available: observation.available })
      return
    case 'permission-mode-rejected':
      // The click did nothing and the user is told (L3 step C) — a warning, composed here
      // where notices are rendered, not forged upstream as a notify observation.
      stores.notifications.push(`mode change to ${observation.mode} rejected: ${observation.reason}`, 'warning', 'run')
      return
    case 'extension-ui-request':
      routeUiRequest(stores, observation)
      return
    case 'dialog-settled': {
      // The question stopped waiting — drops the card if it is the one shown. Any other id
      // is one this page never showed or already dropped.
      const shown = stores.dialog.get()
      if (shown !== undefined && shown.id === observation.id) stores.dialog.set(undefined)
      return
    }
    case 'message-end':
      if (observation.usage !== undefined) stores.stats.applyUsage(observation)
      return
    case 'queue':
      // pi's queue, whole (#75): steering first, then follow-ups.
      stores.queue.set([...observation.steering, ...observation.followUp])
      return
    default:
      // Recorded above; rendered by nothing. `custom-entry` since L3, `unmapped` by design.
      return
  }
}

/**
 * A question pi just asked opens the thread's ONE open-question slot (#112, #114); a
 * `notify` is a message meant for a human. The adapter has already dropped what is
 * addressed to a terminal and turned an unreadable blocking request into a run error, so
 * what reaches here is one of those two.
 */
function routeUiRequest(stores: ThreadStores, observation: ZenObservation & { kind: 'extension-ui-request' }): void {
  if (observation.blocking) {
    const open = { id: observation.id, dialog: observation.dialog }
    if (Check(ZenOpenDialog, open)) stores.dialog.set(open)
    else
      stores.notifications.push('pi asked a question this page could not read; it was left unanswered', 'error', 'run')
    return
  }
  // A notify without a message has nothing for a human; the schema already validated the
  // notify type and the origin, so no second literal list is consulted here (#96).
  if (observation.method !== 'notify' || observation.message === undefined) return
  stores.notifications.push(observation.message, observation.notifyType, observation.origin)
}

// ── the last N chunks, for the debug drawer (#86) ─────────────────────────────
// The router is the ONE path every CUSTOM chunk crosses, which makes it the honest place
// to keep "what the browser was actually told". A fixed-size ring per thread: old chunks
// fall off the front, and a long session costs nothing extra.

export interface RecordedCustomEvent {
  /** Monotonic per thread — the chunk's identity, since name + time can collide. */
  readonly sequence: number
  readonly name: string
  readonly value: unknown
  /** ISO 8601, when the router saw it. */
  readonly receivedAt: string
}

/** Enough to see a whole run's worth (a receipt, a few entries, usage) without scrolling. */
export const RECENT_CUSTOM_CHUNK_CAPACITY = 50

export interface RecentChunksStore extends Store<readonly RecordedCustomEvent[]> {
  readonly record: (name: string, value: unknown) => void
}

/** Oldest first; the snapshot is a fresh array per record, so a consumer cannot mutate the ring. */
export function createRecentChunksStore(): RecentChunksStore {
  const store = createStore<readonly RecordedCustomEvent[]>([])
  let nextSequence = 0
  return {
    get: store.get,
    subscribe: store.subscribe,
    record: (name: string, value: unknown) => {
      nextSequence += 1
      const appended = [...store.get(), { sequence: nextSequence, name, value, receivedAt: new Date().toISOString() }]
      store.set(appended.slice(-RECENT_CUSTOM_CHUNK_CAPACITY))
    },
  }
}
