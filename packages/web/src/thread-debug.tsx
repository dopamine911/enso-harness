import {
  browserSection,
  describeEntry,
  describeThreadEvent,
  persistedPermissionMode,
  type ZenLogLine,
  type ZenThreadEvent,
  ZenThreadEvents,
  ZenThreadInspection,
} from '@zen/core'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import type { RecordedCustomEvent } from './custom-event-router.ts'
import { type PermissionModeState, usePermissionMode } from './permission-mode.tsx'
import {
  ZEN_CUSTOM_EVENT_DIALOG_SETTLED,
  ZEN_CUSTOM_EVENT_ENTRY,
  ZEN_CUSTOM_EVENT_FOLLOW_ENDED,
  ZEN_CUSTOM_EVENT_RUN,
} from './rpc/custom-event-names.ts'
import { type Store, useStore, useThreadStores } from './store.ts'
import { boundedFailureDetail } from './stored-threads.ts'
import type { ThreadStats } from './thread-stats.tsx'
import { browserLogging } from './thread-stores.ts'

const NO_LINES: readonly ZenLogLine[] = []
/** A page mounted without `configureBrowserLogging` (tests) has no ring: nothing to subscribe to, nothing logged. */
function useRing(ring: Store<readonly ZenLogLine[]> | undefined): readonly ZenLogLine[] {
  return useSyncExternalStore(
    ring?.subscribe ?? (() => () => undefined),
    ring?.get ?? (() => NO_LINES),
    ring?.get ?? (() => NO_LINES),
  )
}

/**
 * The session debug drawer (#86): what the BROWSER believes next to what pi's SESSION
 * actually contains, for the current thread, with any disagreement named.
 *
 * Every readout on this surface is derived from the event stream. When one of them was
 * questioned ("how do I know plan mode is enabled?") the honest answer was "you have to
 * assume" — there was no way to see the thing it derived from without reading vendored
 * source and grepping a session file that, for a thread that had only run slash commands,
 * did not exist yet. This drawer is that answer. It reads `GET /api/threads/:threadId`
 * (the in-memory branch, which is what pi acts on — the file is a lagging copy) and puts
 * it beside the module stores and the last chunks the router received.
 *
 * ⚠ Refreshed on demand, not polled: a debugging surface, not a live meter, and a poll
 * would put a request in every trace a human is trying to read.
 *
 * Three modes can disagree, and each disagreement points somewhere different:
 *   • browser store ≠ host        → the stream or the store dropped a receipt;
 *   • host ≠ branch's last entry  → the host's walk is wrong (a picc shape change).
 * Both are named as MISMATCH in text, not colour alone, so a test — and a screen reader —
 * can see them.
 */

export interface BrowserBelief {
  readonly mode: PermissionModeState
  readonly stats: ThreadStats
  readonly recentChunks: readonly RecordedCustomEvent[]
  /** The acquisition this page's last run held (`zen.run`, #109); undefined before a run. */
  readonly generation: number | undefined
  /** This thread's records from the page's ring (#132): what the browser LOGGED, newest last. */
  readonly logged: readonly ZenLogLine[]
}

/**
 * What a difference between the two run numbers means, in words — or undefined when they
 * agree or cannot be compared yet (#109). The server's number moves on every acquisition
 * of the thread; this page's moves only with its own runs. So a server ahead of the page
 * is a run made elsewhere; a page ahead of the server can only be a server that restarted
 * (its count begins again) — and either is the wrong-session class of bug made visible.
 */
export function describeGenerationDrift(browser: number | undefined, server: number | undefined): string | undefined {
  if (browser === undefined || server === undefined || browser === server) return undefined
  if (server > browser) {
    const runs = server - browser
    return `server is at run #${server} — ${runs} run${runs === 1 ? '' : 's'} this page did not make (another tab or client)`
  }
  return `server is at run #${server}, behind this page — the server restarted since this page's last run`
}

/**
 * The server holds no session for a thread this page ran on (#103 receipt, step 8): the
 * server restarted, or evicted the thread. Undefined when the page never ran here (a
 * fresh thread's 404 is information, not a disagreement) or while the server still
 * answers for the thread.
 */
export function describeLostSession(browser: number | undefined, sessionMissing: boolean): string | undefined {
  // #0 is the snapshot's "no acquisition yet" — a fresh thread's receipt, not a run this page made.
  if (browser === undefined || browser === 0 || !sessionMissing) return undefined
  return `this page ran #${browser} here, and the server holds no session for the thread — it restarted, or evicted the thread`
}

export interface ThreadDebugViewProps {
  readonly threadId: string
  readonly browser: BrowserBelief
  /** The server's answer, or undefined before the first refresh. */
  readonly inspection: ZenThreadInspection | undefined
  /** The thread's two event tails (#97), fetched alongside the inspection; undefined before the first refresh. */
  readonly events: ZenThreadEvents | undefined
  /** Why the last refresh produced nothing — a 404 for a thread that has not run yet, a down server. */
  readonly error: string | undefined
  /** The last copy's outcome; the label beside the button says which. */
  readonly copyState: CopyState
  /** The last bundle's outcome (#132 item 5); "failed" names why. */
  readonly bundleState: BundleState
  readonly onRefresh: () => void
  readonly onCopy: () => void
  readonly onBundle: () => void
}

/**
 * A chunk's name, plus the inner `type` its value carries when there is one. The case that
 * needs it is `zen.unmapped` — pi's raw event, and a model turn produces a run of them (tool
 * starts, thinking, message ends) that read as identical rows without it. It is not special-
 * cased to that name: a `zen.entry` value is a session entry with a `type` too, and reads as
 * `zen.entry (custom)`, which is just as useful.
 */
export function describeChunk(chunk: RecordedCustomEvent): string {
  const value = chunk.value
  if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') {
    return chunk.name
  }
  return `${chunk.name} (${value.type})`
}

/**
 * pi guarantees every session entry an `id`; read defensively. A malformed entry without one
 * keys by its position in the branch — two such entries in the same second with the same type
 * would otherwise collide on the description and React would reuse the wrong row (PR #87 review).
 */
function entryKey(entry: unknown, position: number): string {
  if (typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string') return entry.id
  return `${position}:${describeEntry(entry)}`
}

function Mismatch({ when, says }: { when: boolean; says: string }): React.ReactNode {
  if (!when) return null
  return (
    <span className="ml-2 rounded bg-destructive px-1 font-semibold text-destructive-foreground">MISMATCH: {says}</span>
  )
}

function EventTailList({ events }: { events: readonly ZenThreadEvent[] }): React.ReactNode {
  if (events.length === 0) return <div>nothing yet</div>
  return (
    <ol>
      {events.map((event) => (
        <li key={event.sequence} className={event.provenance === 'dropped' ? 'text-destructive' : ''}>
          {describeThreadEvent(event)}
        </li>
      ))}
    </ol>
  )
}

export function ThreadDebugView({
  threadId,
  browser,
  inspection: session,
  events,
  error,
  copyState,
  bundleState,
  onRefresh,
  onCopy,
  onBundle,
}: ThreadDebugViewProps): React.ReactNode {
  const browserMode = browser.mode.mode ?? 'unknown'
  const hostMode = session?.permissionMode.mode
  const branchMode = session === undefined ? undefined : persistedPermissionMode(session.entries)
  const sessionMissing = error === NO_SESSION_YET
  const generationDrift =
    describeGenerationDrift(browser.generation, session?.generation) ??
    describeLostSession(browser.generation, sessionMissing)
  return (
    <aside aria-label="session debug" className="flex flex-col gap-3 p-3 font-mono text-muted-foreground text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">session debug</span>
        <span className="flex gap-1">
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
            refresh
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onCopy}>
            copy as JSON
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onBundle} disabled={bundleState === 'building'}>
            download log bundle
          </Button>
          {copyState === 'copied' ? <span role="status">copied</span> : null}
          {copyState === 'failed' ? (
            <span role="status" className="text-destructive">
              copy failed — clipboard needs a secure context or permission
            </span>
          ) : null}
          {bundleState === 'building' ? <span role="status">building the bundle…</span> : null}
          {bundleState === 'saved' ? <span role="status">bundle saved — open it before you attach it</span> : null}
          {typeof bundleState === 'object' ? (
            <span role="status" className="text-destructive">
              bundle failed — {bundleState.failed}
            </span>
          ) : null}
        </span>
        <span className="w-full break-all">thread {threadId}</span>
      </div>
      <div className="flex flex-col gap-3">
        <section>
          <h3 className="font-semibold text-foreground">browser believes</h3>
          <div>
            mode: {browserMode}
            <Mismatch when={hostMode !== undefined && hostMode !== browserMode} says={`host says ${hostMode}`} />
          </div>
          <div>available: {browser.mode.available.join(', ') || '(none yet)'}</div>
          <div>
            last run: {browser.generation === undefined ? 'none from this page' : `#${browser.generation}`}
            <Mismatch when={generationDrift !== undefined} says={generationDrift ?? ''} />
          </div>
          <div>
            stats: {browser.stats.countedMessages} counted, cost ${browser.stats.totalCost.toFixed(4)}
          </div>
          <h4 className="mt-1 text-foreground">last {browser.recentChunks.length} CUSTOM chunks</h4>
          <ol>
            {browser.recentChunks.map((chunk) => (
              <li key={chunk.sequence}>
                {chunk.receivedAt.slice(11, 19)} {describeChunk(chunk)}
              </li>
            ))}
          </ol>
          {/* The page's own records for this thread (#132): the ring, not the server — what
					    the adapter said as it happened, including what the server never heard. */}
          <h4 className="mt-1 text-foreground">browser logged ({browser.logged.length})</h4>
          <ol aria-label="browser log">
            {browser.logged.map((line) => (
              <li
                key={String(line.properties?.pageSequence ?? line['@timestamp'])}
                className={line.level === 'WARN' || line.level === 'ERROR' ? 'text-destructive' : ''}
              >
                {line['@timestamp'].slice(11, 23)} {line.level.toLowerCase()}{' '}
                {line.logger.replace(/^zen\.browser\.?/, '')} {line.message}
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h3 className="font-semibold text-foreground">pi's session has</h3>
          {error !== undefined ? <div className="text-destructive">{error}</div> : null}
          {session === undefined ? (
            <div>{error === undefined ? 'not fetched yet — press refresh' : null}</div>
          ) : (
            <>
              <div className="break-all">session {session.sessionId}</div>
              <div className="break-all">cwd {session.cwd}</div>
              <div className="break-all">dir {session.sessionDir}</div>
              <div className="break-all">
                file{' '}
                {session.sessionFile ?? (
                  <span title="pi flushes a session to disk only after its first assistant message; until then the branch below is the only copy">
                    in memory, not flushed yet
                  </span>
                )}
              </div>
              <div>
                host mode: {hostMode}
                <Mismatch when={branchMode !== hostMode} says={`branch says ${branchMode}`} />
              </div>
              <div>branch mode: {branchMode}</div>
              <div>
                {session.busy ? 'busy' : 'idle'}, run #{session.generation}, last activity{' '}
                {session.lastActivityAt.slice(11, 19)}
              </div>
              <div>commands: {session.commands.map((command) => `/${command}`).join(' ')}</div>
              <h4 className="mt-1 text-foreground">branch ({session.entries.length} entries)</h4>
              <ol>
                {session.entries.map((entry, position) => (
                  <li key={entryKey(entry, position)}>{describeEntry(entry)}</li>
                ))}
              </ol>
            </>
          )}
        </section>
        {/* The event tails (#97): the ordering view. `emitted` is what the host's funnel saw,
				    with how each was delivered; `sent` is what the server wrote to this browser.
				    A disagreement with the two sections above names the layer a bug lives in. */}
        <section>
          <h3 className="font-semibold text-foreground">the host emitted</h3>
          {events === undefined ? <div>not fetched yet</div> : <EventTailList events={events.emitted} />}
          <h3 className="mt-2 font-semibold text-foreground">the server sent</h3>
          {events === undefined ? <div>not fetched yet</div> : <EventTailList events={events.sent} />}
        </section>
      </div>
    </aside>
  )
}

/** A non-2xx from the inspection endpoint, with the status as data — not a prefix to parse out of a message. */
export class InspectionFetchError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`${status} ${detail}`)
    this.name = 'InspectionFetchError'
  }
}

/** Fetches one thread's inspection; a non-2xx becomes an `InspectionFetchError`. */
export async function fetchThreadInspection(threadId: string): Promise<ZenThreadInspection> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`)
  if (!response.ok) throw new InspectionFetchError(response.status, boundedFailureDetail(await response.text()))
  const payload: unknown = await response.json()
  if (!Check(ZenThreadInspection, payload)) throw new Error("the server's inspection payload did not match its schema")
  return payload
}

/** Fetches one thread's event tails (#97); the same 404 rule as the inspection. */
export async function fetchThreadEvents(threadId: string): Promise<ZenThreadEvents> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/events`)
  if (!response.ok) throw new InspectionFetchError(response.status, boundedFailureDetail(await response.text()))
  const payload: unknown = await response.json()
  if (!Check(ZenThreadEvents, payload)) throw new Error("the server's events payload did not match its schema")
  return payload
}

/** One refresh = both payloads, so the three columns describe the same moment. */
async function fetchThreadDebug(threadId: string): Promise<{ session: ZenThreadInspection; events: ZenThreadEvents }> {
  const [session, events] = await Promise.all([fetchThreadInspection(threadId), fetchThreadEvents(threadId)])
  return { session, events }
}

/**
 * What a 404 means here: the server holds no session for the thread — nothing has run on
 * it on this server, or the server no longer holds it (restarted, evicted). Which of the
 * two is the page's to say, against its own run count — see {@link describeLostSession}.
 */
export const NO_SESSION_YET =
  'no live session on this server — nothing has run on this thread here, or the server no longer holds it'

/**
 * Only the LATEST request's outcome may be applied (PR #87 review). The drawer refetches
 * on open and on every run settle, so two fetches can be in flight at once — the mount-time
 * 404 for a thread that has not run yet, and the post-run fetch once a fast prompt settles.
 * Without this, whichever resolves LAST wins regardless of which was ISSUED last, and a
 * drawer built to catch inconsistency would briefly show "nothing has run" after a run.
 *
 * Returns a wrapper: each call issues a fresh request and resolves only if no later call has
 * been made by the time it settles; a superseded result resolves `undefined` and is dropped.
 */
export function latestWins<T>(issue: () => Promise<T>): () => Promise<T | undefined> {
  let latest = 0
  return async (): Promise<T | undefined> => {
    latest += 1
    const mine = latest
    const outcome = await issue().then(
      (value) => ({ value, failure: undefined }),
      (failure: unknown) => ({ value: undefined, failure: failure ?? new Error('rejected without a reason') }),
    )
    if (mine !== latest) return undefined
    if (outcome.failure !== undefined) throw outcome.failure
    return outcome.value
  }
}

/**
 * The chunks that mean "the server's view of this thread changed" — the moments the pane's
 * server columns can be stale (#103): a status frame (`zen.run`, sent at every busy
 * transition, this page's run or another tab's), a persisted mode change (`zen.entry`), a
 * question settling (`zen.dialog-settled`), and the follow ending under this page
 * (`zen.follow-ended`) — after which the last fetch describes a session the server may no
 * longer hold.
 */
const SERVER_STATE_CHUNKS: ReadonlySet<string> = new Set([
  ZEN_CUSTOM_EVENT_RUN,
  ZEN_CUSTOM_EVENT_ENTRY,
  ZEN_CUSTOM_EVENT_DIALOG_SETTLED,
  ZEN_CUSTOM_EVENT_FOLLOW_ENDED,
])
/**
 * The sequence of the latest server-state chunk, or undefined before any: the drawer
 * refreshes when this moves. Exported for `__tests__/thread-debug.test.tsx`.
 */
export function latestServerStateSequence(chunks: readonly RecordedCustomEvent[]): number | undefined {
  for (let position = chunks.length - 1; position >= 0; position -= 1) {
    const chunk = chunks[position]
    if (chunk !== undefined && SERVER_STATE_CHUNKS.has(chunk.name)) return chunk.sequence
  }
  return undefined
}

/** The clipboard call's outcome, so a failed copy does not look identical to a successful one. */
export type CopyState = 'idle' | 'copied' | 'failed'
export type BundleState = 'idle' | 'building' | 'saved' | { readonly failed: string }

/**
 * The bundle (#132 item 5): the server's file for this thread — its records, the live
 * inspection, the versions — with the page's own ring appended, since only the page has it.
 * Downloaded, never uploaded: the user opens it and attaches it themselves.
 */
export async function fetchThreadBundle(
  threadId: string,
  ring: readonly ZenLogLine[],
  fetchImpl: FetchLike = fetch,
): Promise<{ filename: string; text: string }> {
  const response = await fetchImpl(`/api/logs/bundle?thread=${encodeURIComponent(threadId)}`)
  if (!response.ok) throw new InspectionFetchError(response.status, boundedFailureDetail(await response.text()))
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const named = /filename="([^"]+)"/.exec(disposition)?.[1]
  const text = `${await response.text()}\n${browserSection(ring, typeof window === 'undefined' ? undefined : window.location.href)}`
  return { filename: named ?? `zen-bundle-${threadId.slice(0, 8)}.md`, text }
}

/** Hands the browser a file to save — an object URL for a moment, then released. */
function saveTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * The drawer wired to the stores, the router's record, and the server. Mounted by `?debug`.
 *
 * Refetches on open and each time the SERVER says the thread changed — a status frame, a
 * persisted mode, a settled question — plus on demand. ⚠ Not this page's `isLoading`
 * (#103 receipt): a run another tab started never toggles it, so a pane that followed a
 * `/mode` answered elsewhere sat on its mount-time fetch and showed MISMATCH against a
 * browser belief that was correct — the pane was stale, not the belief. The status frame
 * is the server's own word and arrives for every run, whoever started it. Not polled: a
 * debugging surface should put no request in the trace a human is trying to read. Opening
 * it on a fresh thread reads "nothing has run yet", the honest state, rather than an error.
 */
export function ThreadDebugDrawer(): React.ReactNode {
  const stores = useThreadStores()
  const { threadId } = stores
  const mode = usePermissionMode()
  const stats = useStore(stores.stats)
  const recentChunks = useStore(stores.recentChunks)
  const generation = useStore(stores.generation)
  const logging = useStore(browserLogging)
  const ring = useRing(logging?.ring)
  const logged = useMemo(() => ring.filter((line) => line.properties?.threadId === threadId), [ring, threadId])
  const [session, setSession] = useState<ZenThreadInspection | undefined>(undefined)
  const [events, setEvents] = useState<ZenThreadEvents | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [bundleState, setBundleState] = useState<BundleState>('idle')
  const browser: BrowserBelief = { mode, stats, recentChunks, generation, logged }
  // One sequencer per thread id: a new thread starts a new "latest".
  const fetchLatest = useMemo(() => latestWins(() => fetchThreadDebug(threadId)), [threadId])
  const refresh = useCallback((): void => {
    fetchLatest().then(
      (fetched) => {
        if (fetched === undefined) return // superseded by a later refresh
        setSession(fetched.session)
        setEvents(fetched.events)
        setError(undefined)
      },
      (failure: unknown) => {
        setSession(undefined)
        setEvents(undefined)
        if (failure instanceof InspectionFetchError && failure.status === 404) {
          setError(NO_SESSION_YET)
          return
        }
        setError(failure instanceof Error ? failure.message : String(failure))
      },
    )
  }, [fetchLatest])
  useEffect(() => {
    refresh() // on open, and again for a new thread
    // Then on every server-state chunk: a subscription rather than a render dependency,
    // so a `zen.usage` or an unmapped delta re-renders the list without refetching.
    let seen = latestServerStateSequence(stores.recentChunks.get())
    return stores.recentChunks.subscribe(() => {
      const latest = latestServerStateSequence(stores.recentChunks.get())
      if (latest === seen) return
      seen = latest
      refresh()
    })
  }, [stores, refresh])
  const copy = (): void => {
    navigator.clipboard.writeText(JSON.stringify({ threadId, browser, session, events }, null, 2)).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    )
  }
  const bundle = (): void => {
    setBundleState('building')
    // The page's whole ring, not just this thread's lines: a problem on another tab of the
    // same page, or before the thread had an id, is exactly what a triage wants to see.
    fetchThreadBundle(threadId, ring).then(
      ({ filename, text }) => {
        saveTextFile(filename, text)
        setBundleState('saved')
      },
      (failure: unknown) => setBundleState({ failed: failure instanceof Error ? failure.message : String(failure) }),
    )
  }
  return (
    <ThreadDebugView
      threadId={threadId}
      browser={browser}
      inspection={session}
      events={events}
      error={error}
      copyState={copyState}
      bundleState={bundleState}
      onRefresh={refresh}
      onCopy={copy}
      onBundle={bundle}
    />
  )
}
