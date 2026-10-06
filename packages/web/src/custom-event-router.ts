import {
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_NOTICE_SOURCE,
  EnsoFollowSnapshot,
  EnsoFollowStatus,
  EnsoObservation,
  EnsoOpenDialog,
  type EnsoPermissionModeState,
  type EnsoProviderRefused,
  type EnsoProviderRetryEnded,
  type EnsoProviderRetrying,
  providerReasonOf,
  providerRefusalClass,
  readEnsoSessionRiskChange,
  sessionIncidentsStep,
  toolRefusalOf,
} from '@enso/core'
import { Compile } from 'typebox/compile'
import { Check } from 'typebox/value'
import { providerRefusalLine, providerRefusalSource, trailingRefusalOf } from './refused-attempt.tsx'
import { createStore, type Store } from './store.ts'
import type { ThreadStores } from './thread-stores.ts'

/**
 * The one chunk that is neither an observation nor a frame: the follow ended without this
 * page leaving it (#103 receipt) — the server closed, restarted, or dropped the connection.
 *
 * The adapter (`follow-connection.ts`) says it; this router, its only reader, names it. Value:
 * `{ threadId }`.
 */
export const FOLLOW_ENDED_CUSTOM_EVENT = 'follow-ended'

/**
 * JIT validators, compiled once at module load — the `@enso/core` convention
 * (`config.ts`, `dialog.ts`, `thread-runtime.ts`, `tool-result.ts`).
 *
 * `Compile` rather than `Check` because these run per CHUNK on the browser's main thread,
 * and `Check` re-walks the schema on every call: measured 6.77 µs interpreted against
 * 0.042 µs compiled for a `text-delta` against the 19-member `EnsoObservation` union (once
 * per streamed token), 2.93 µs against 0.012 µs for a status, and 44.6 µs against 0.51 µs
 * for a 50-message snapshot — 138 µs against 1.84 µs at 500 messages (#281).
 *
 * `EnsoOpenDialog` in `routeUiRequest` stays interpreted on purpose: it is checked once per
 * BLOCKING QUESTION — once per human decision, against a per-token union here — so its
 * 5.20 µs buys nothing worth a fourth validator, and compiling it would imply the dialog
 * path was hot. If that check ever becomes frequent, something is re-asking, which is a bug
 * and not a validator's cost.
 */
const snapshotValidator = Compile(EnsoFollowSnapshot)
const statusValidator = Compile(EnsoFollowStatus)
const observationValidator = Compile(EnsoObservation)

/**
 * The browser's ONE path from an AG-UI CUSTOM chunk to a thread's stores (mode lines,
 * current mode, session stats, notifications, the debug record).
 *
 * TanStack's `onCustomEvent` fires this with `(chunk.name, chunk.value)` for every CUSTOM chunk
 * — verified against its stream processor (#29).
 *
 * ONE VOCABULARY (#162 workstream 5). A chunk's name is a discriminator a type of ours
 * already declares, and its value is that whole thing:
 *
 *   `EnsoObservation.kind`     value: the observation — what the adapter derives from the
 *                             follow's `observation` frames (`to-agui.ts#custom`)
 *   `EnsoFollowFrame.type`     `snapshot` | `status` — value: the frame, as it came off the
 *                             wire; the run-start receipts (mode, open questions, generation)
 *                             are read off the snapshot itself, not re-shaped into names
 *   `FOLLOW_ENDED_CUSTOM_EVENT`      the adapter's own fact, above
 *
 * Before this the adapter emitted a parallel `enso.*` vocabulary — `enso.mode` for a
 * `permission-mode`, `enso.notify` for an `extension-ui-request`, a forged notify for a
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
 * where a throw would end the run. Kinds this surface does not render (`unmapped`, a
 * `custom-entry` that is not a guard refusal) are recorded and fall through — see the mapper
 * for why they exist at all.
 */
export function routeEnsoCustomEvent(stores: ThreadStores, eventType: string, data: unknown): void {
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
      ENSO_NOTICE_SOURCE,
    )
    return
  }
  if (eventType === 'snapshot') {
    if (!snapshotValidator.Check(data)) return
    applyPermissionMode(stores, data.permissionMode)
    stores.sessionRisk.set(data.sessionRisk)
    // The incidents as the server folded the branch (#466): the resync, replacing whatever the
    // live fold held — a resolution from another tab lands here too.
    stores.incidents.set(data.incidents)
    // The session's model (#338 slice 2) — `null` when the thread is not live, applied as such:
    // a snapshot is the resync, and a model this page cannot vouch for is no model. A cold
    // thread's recorded model (#434) rides beside it, never as live state.
    stores.model.applySnapshot(data.model, data.recordedModel)
    stores.cwd.set(data.cwd)
    stores.tree.set(data.tree)
    // #659: a session or messages means the routes answer — latched, never cleared by a later resync.
    if (data.model !== null || data.messages.length > 0) stores.readable.set(true)
    stores.usage.set(data.usage)
    // The status bar's refusal word, resynced (#381): set when the branch's last reply is a
    // refused attempt — how a resumed thread still says it — and cleared when it is not. The
    // snapshot's own output is the mark a later reply must grow past.
    const trailing = trailingRefusalOf(data.messages)
    stores.refusal.set(
      trailing === undefined
        ? undefined
        : {
            refusalClass: providerRefusalClass(trailing),
            provider: providerRefusalSource(trailing),
            outputAtRefusal: data.usage.output,
          },
    )
    // @invariant follow-snapshot-frames/snapshot-lists-complete The snapshot's lists are complete, so the browser replaces rather than appends.
    // `openDialogs` is every question the thread is blocked on now (#114): a reconnect's snapshot
    // is the resync, so an empty list is a fact ("nothing is waiting") this page must apply too;
    // it clears a card for a question that settled while the page was away. One card at a time:
    // a second concurrent question shows once the first settles and the next snapshot lists it.
    stores.dialog.set(data.openDialogs[0])
    // A login waiting on its provider (#348) — a page arriving mid-login offers its Stop too.
    stores.login.set(data.login)
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

/**
 * The provider refused a request (#340): a line in the transcript where the reply would have been,
 * and the status bar's class word until a reply gets through. The class comes from the status;
 * the provider's own sentence follows it, verbatim but for the JSON around it.
 */
function applyRefusal(stores: ThreadStores, refusal: EnsoProviderRefused): void {
  stores.notifications.push(providerRefusalLine(refusal), 'error', 'run', providerRefusalSource(refusal))
  // ⚠ The refused attempt's own output is not a reply getting through (#384): a refusal mid-stream
  // comes after the model wrote some, and the turn's `session-usage` — which the host says after
  // this — counts it. So the mark is the output as of now PLUS the attempt's own; only output past
  // both clears the word.
  stores.refusal.set({
    refusalClass: providerRefusalClass(refusal),
    provider: providerRefusalSource(refusal),
    outputAtRefusal: (stores.usage.get()?.output ?? 0) + (refusal.output ?? 0),
  })
}

/** pi is retrying (#340): when, and which attempt of how many — a warning, since a reply may still come. */
function applyRetry(stores: ThreadStores, retry: EnsoProviderRetrying): void {
  const delay = retry.delayMs < 1000 ? `${Math.round(retry.delayMs)} ms` : `${Math.round(retry.delayMs / 1000)} s`
  // pi retries the request the provider just refused (#387): the line names that provider.
  stores.notifications.push(
    `retrying in ${delay} — attempt ${retry.attempt} of ${retry.maxAttempts}`,
    'warning',
    'run',
    stores.refusal.get()?.provider,
  )
}

/**
 * pi stopped retrying (#380 review). When a retry got through the reply says so, and nothing is
 * added; when none did — the retries ran out, or a Stop cancelled the wait — the transcript would
 * otherwise end on `retrying in …`, so it says there will be no reply, and pi's last error.
 */
function applyRetryEnd(stores: ThreadStores, end: EnsoProviderRetryEnded): void {
  if (end.success) return
  const retries = end.attempt === 1 ? '1 retry' : `${end.attempt} retries`
  const reason = end.finalError === undefined ? '' : ` — ${providerReasonOf(end.finalError)}`
  stores.notifications.push(`no reply after ${retries}${reason}`, 'error', 'run', stores.refusal.get()?.provider)
}

/** One receipt, two views (#84, L3): the current-mode store (state) and the transcript line (history). */
function applyPermissionMode(stores: ThreadStores, state: EnsoPermissionModeState): void {
  stores.permissionMode.applyReceipt(state)
  stores.modeLines.apply(state)
}

/** The thread's server-side acquisition (#109); a status frame reaches this page only over a live follow (#119). */
function applyStatus(stores: ThreadStores, generation: number): void {
  stores.generation.set(generation)
  if (stores.disconnected.get()) stores.disconnected.set(false)
}

/**
 * Something refused a call (#387, #523): the guard's entry names the call and the rule, the
 * engine's names the call and how it was refused, and the tool row and the status bar read who
 * refused off the store. The session's risk rose (#464): the status bar reads that too. An
 * incident opened, or a human resolved one (#466): the same fold the server runs, one step per
 * entry — an entry that is neither leaves the state as it was. A resolution also starts the risk
 * over, as the risk fold does on the same entry (`session-risk.ts`). Every other extension's entry
 * is a state receipt rendered by nothing (L3 moved the mode onto its own observation).
 */
function applyGuardEntry(stores: ThreadStores, customType: string, data: unknown): void {
  if (customType === ENSO_INCIDENT_RESOLVED_ENTRY) stores.sessionRisk.set({ level: 'low', signals: 0 })
  const incidents = stores.incidents.get()
  const nextIncidents = sessionIncidentsStep(incidents, customType, data)
  if (nextIncidents !== incidents) {
    stores.incidents.set(nextIncidents)
    return
  }
  const risk = readEnsoSessionRiskChange(customType, data)
  if (risk !== undefined) {
    stores.sessionRisk.set(risk)
    return
  }
  const refused = toolRefusalOf(customType, data)
  if (refused === undefined) return
  const refusals = new Map(stores.refusals.get())
  refusals.set(refused.toolCallId, refused.refusal)
  stores.refusals.set(refusals)
}

function routeObservation(stores: ThreadStores, observation: EnsoObservation): void {
  switch (observation.kind) {
    case 'permission-mode':
      // The run-start receipt and a mid-run change fold into the same two stores.
      applyPermissionMode(stores, { mode: observation.mode, available: observation.available })
      return
    case 'permission-mode-rejected':
      // The click did nothing and the user is told (L3 step C) — a warning, composed here
      // where notices are rendered, not forged upstream as a notify observation.
      stores.notifications.push(
        `mode change to ${observation.mode} rejected: ${observation.reason}`,
        'warning',
        'run',
        ENSO_NOTICE_SOURCE,
      )
      return
    case 'model':
      // The host applied a `/model` or `/thinking` run (#338 slice 2) — the state after, from
      // pi's own event, never the option clicked. One store, the composer chip reads it.
      stores.model.applyObservation(observation)
      stores.readable.set(true)
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
    case 'branch-compacted':
      // The branch was rewritten (#348): counted, and the pane re-reads the thread when idle —
      // never mid-run, so a compaction pi made on overflow waits for the run it rescued.
      stores.branchCompacted.set(stores.branchCompacted.get() + 1)
      return
    case 'login':
      // A login waiting on its provider (#348): what the composer's Stop can end.
      stores.login.set(observation.waiting ? { provider: observation.provider } : undefined)
      return
    case 'session-usage': {
      // The session's totals and context now (#45) — whole, so the latest replaces.
      const { kind: _kind, ...usage } = observation
      stores.usage.set(usage)
      // Output grew past the refusal: a reply got through, and the status bar stops saying it (#340).
      const refusal = stores.refusal.get()
      if (refusal !== undefined && usage.output > refusal.outputAtRefusal) stores.refusal.set(undefined)
      return
    }
    case 'provider-refused':
      applyRefusal(stores, observation)
      return
    case 'provider-retry':
      applyRetry(stores, observation)
      return
    case 'provider-retry-ended':
      applyRetryEnd(stores, observation)
      return
    case 'queue':
      // The whole queue (#75): what cuts in first, then what waits its turn.
      stores.queue.set([...observation.interrupting, ...observation.enqueued])
      return
    case 'custom-entry':
      applyGuardEntry(stores, observation.customType, observation.data)
      return
    default:
      // Recorded above; rendered by nothing. `unmapped` by design.
      return
  }
}

/**
 * A question pi just asked opens the thread's ONE open-question slot (#112, #114); a
 * `notify` is a message meant for a human. The adapter has already dropped what is
 * addressed to a terminal and turned an unreadable blocking request into a run error, so
 * what reaches here is one of those two.
 *
 * ⚠ THE OLDEST QUESTION HOLDS THE SLOT (#271). The host genuinely holds several questions
 * at once (`host/extension-ui-context.ts`'s `Map`, oldest first) and a snapshot — the only
 * thing that replaces the slot wholesale — arrives once, when a follow opens. So a second
 * live ask that overwrote the slot would make the question being read vanish mid-read and,
 * once the newer one was answered, leave the page blank while pi stayed parked on a
 * question it no longer rendered. Holding costs the reverse and less: the newer question
 * waits on the server, unrendered until the next snapshot lists it — which is exactly what
 * `ThreadStores.dialog` says this page does.
 */
function routeUiRequest(stores: ThreadStores, observation: EnsoObservation & { kind: 'extension-ui-request' }): void {
  if (observation.blocking) {
    const open = { id: observation.id, dialog: observation.dialog }
    if (!Check(EnsoOpenDialog, open)) {
      // Said even when a card is up: the unreadable question is parked on the server either way.
      stores.notifications.push(
        'pi asked a question this page could not read; it was left unanswered',
        'error',
        'run',
        ENSO_NOTICE_SOURCE,
      )
      return
    }
    if (stores.dialog.get() === undefined) stores.dialog.set(open)
    return
  }
  // A notify without a message has nothing for a human; the schema already validated the
  // notify type and the origin, so no second literal list is consulted here (#96).
  if (observation.method !== 'notify' || observation.message === undefined) return
  // Who said it (#387): the extension the host tagged, or `Enso` for the host's own — absent when
  // neither is known, never guessed from the words.
  stores.notifications.push(observation.message, observation.notifyType, observation.origin, observation.sender)
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
