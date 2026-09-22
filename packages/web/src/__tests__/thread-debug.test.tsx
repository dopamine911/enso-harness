import { afterEach, beforeEach, expect, test } from 'bun:test'
import type {
  EnsoLogLine,
  EnsoThreadEvent,
  EnsoThreadEvents,
  EnsoThreadInspection,
  EnsoTranscriptEntry,
} from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FOLLOW_ENDED_CUSTOM_EVENT,
  RECENT_CUSTOM_CHUNK_CAPACITY,
  routeEnsoCustomEvent,
} from '../custom-event-router.ts'
import {
  type BrowserBelief,
  type BundleState,
  type CopyState,
  describeChunk,
  fetchThreadBundle,
  InspectionFetchError,
  latestServerStateSequence,
  latestWins,
  NO_SESSION_YET,
  ThreadDebugView,
} from '../thread-debug.tsx'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'

/**
 * #86: the drawer's one job is to NAME a disagreement between what the browser believes
 * and what pi's session holds. These render it statically with each disagreement injected
 * and assert the word MISMATCH appears — or does not — as text, the way a human or a
 * screen reader would see it. The fetch wiring is covered by the live receipt.
 */

let stores: ThreadStores
beforeEach(() => {
  stores = mintThread()
})
afterEach(() => clearThreadsForTest())

const noop = (): void => {
  // Static markup runs no handlers; the callbacks exist only to satisfy the props.
}

const piccEntry = (mode: string, id: string): EnsoTranscriptEntry => ({
  kind: 'custom',
  customType: 'modes',
  data: { mode },
  id,
  at: '2026-09-08T10:00:00.000Z',
})

function inspection(overrides: Partial<EnsoThreadInspection> = {}): EnsoThreadInspection {
  return {
    threadId: 't1',
    sessionId: 'session-1',
    cwd: '/repo',
    sessionDir: '/agent/sessions/--repo--',
    sessionFile: null,
    permissionMode: { mode: 'plan', available: ['default', 'plan'] },
    commands: ['mode', 'plan'],
    busy: false,
    generation: 1,
    lastActivityAt: '2026-09-08T10:00:05.000Z',
    entries: [{ kind: 'other', type: 'session', id: 'root', at: '2026-09-08T10:00:00.000Z' }, piccEntry('plan', 'm1')],
    ...overrides,
  }
}

function believing(mode: string | undefined, generation: number | undefined = 1): BrowserBelief {
  return {
    mode: { mode, available: ['default', 'plan'] },
    stats: { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 },
    recentChunks: [],
    generation,
    logged: [],
  }
}

const render = (
  browser: BrowserBelief,
  session: EnsoThreadInspection | undefined,
  error?: string,
  copyState: CopyState = 'idle',
): string => renderWith({ browser, inspection: session, error, copyState })

interface RenderOverrides {
  readonly browser: BrowserBelief
  readonly inspection: EnsoThreadInspection | undefined
  readonly error?: string | undefined
  readonly copyState?: CopyState
  readonly bundleState?: BundleState
  readonly events?: EnsoThreadEvents
}

const renderWith = ({
  browser,
  inspection: session,
  error,
  copyState = 'idle',
  bundleState = 'idle',
  events,
}: RenderOverrides): string =>
  renderToStaticMarkup(
    <ThreadDebugView
      threadId="t1"
      browser={browser}
      inspection={session}
      events={events}
      error={error}
      copyState={copyState}
      bundleState={bundleState}
      onRefresh={noop}
      onCopy={noop}
      onBundle={noop}
    />,
  )

// ── the mismatch highlight ───────────────────────────────────────────────────

test('agreement everywhere renders no MISMATCH', () => {
  const rendered = render(believing('plan'), inspection())
  expect(rendered).not.toContain('MISMATCH')
  expect(rendered).toContain('host mode: plan')
})

// ⚠ THE FEATURE. Browser store ≠ host means the stream or the store dropped a receipt.
test('⚠ browser store disagreeing with the host is named as a MISMATCH', () => {
  const rendered = render(believing('default'), inspection())
  expect(rendered).toContain('MISMATCH: host says plan')
})

// The run fence (#109): the page's last run number against the server's current one.
test("⚠ a server ahead of this page's last run is named as a MISMATCH — a run this page did not make", () => {
  const rendered = render(believing('plan', 1), inspection({ generation: 3 }))
  expect(rendered).toContain('last run: #1')
  expect(rendered).toContain('MISMATCH: server is at run #3 — 2 runs this page did not make')
  expect(rendered).toContain('run #3')
})

test("⚠ a server BEHIND this page's last run is named as a restart", () => {
  const rendered = render(believing('plan', 4), inspection({ generation: 2 }))
  expect(rendered).toContain('MISMATCH: server is at run #2, behind this page — the server restarted')
})

test('no run yet on this page compares nothing: no MISMATCH, and it says so', () => {
  const rendered = render({ ...believing('plan'), generation: undefined }, inspection({ generation: 2 }))
  expect(rendered).toContain('last run: none from this page')
  expect(rendered).not.toContain('MISMATCH')
})

// #103 receipt, step 8: the server restarted under a run. The pane must name the boundary,
// not show a fresh thread's "nothing has run" as if the page had never run here.
test('⚠ a 404 on a thread this page ran on is named as a lost session; on a fresh thread it is not a MISMATCH', () => {
  const lost = render(believing('plan', 3), undefined, NO_SESSION_YET)
  expect(lost).toContain('MISMATCH: this page ran #3 here, and the server holds no session')
  const fresh = render({ ...believing('plan'), generation: undefined }, undefined, NO_SESSION_YET)
  expect(fresh).not.toContain('MISMATCH')
  expect(fresh).toContain('no live session on this server')
  // A fresh thread's snapshot receipt is #0 — "no acquisition yet", not a run this page made.
  expect(render(believing('plan', 0), undefined, NO_SESSION_YET)).not.toContain('MISMATCH')
})

test('an unflushed session says so instead of showing a path', () => {
  expect(render(believing('plan'), inspection({ sessionFile: null }))).toContain('in memory, not flushed yet')
  expect(render(believing('plan'), inspection({ sessionFile: '/agent/sessions/x.jsonl' }))).toContain(
    '/agent/sessions/x.jsonl',
  )
})

test('before the first fetch, and on a failed one, the session column says why', () => {
  expect(render(believing(undefined), undefined)).toContain('not fetched yet')
  // A fresh thread's 404 is information, not a failure — the drawer words it that way.
  expect(render(believing(undefined), undefined, NO_SESSION_YET)).toContain('nothing has run on this thread')
  expect(render(believing(undefined), undefined, 'TypeError: fetch failed')).toContain('fetch failed')
})

// ── the router's record ──────────────────────────────────────────────────────

test('every CUSTOM chunk the router sees is recorded, oldest first, with a stable identity', () => {
  routeEnsoCustomEvent(stores, 'permission-mode', { kind: 'permission-mode', mode: 'default', available: [] })
  routeEnsoCustomEvent(stores, 'unmapped', { kind: 'unmapped', event: { type: 'some_future_event' } })
  const recorded = stores.recentChunks.get()
  expect(recorded.map((chunk) => chunk.name)).toEqual(['permission-mode', 'unmapped'])
  expect(recorded[0]?.sequence).toBeLessThan(recorded[1]?.sequence ?? 0)
})

// #103 receipt: the pane refreshes when the SERVER says the thread changed, not when this
// page's own run flag toggles — a run another tab started never toggles it.
test('⚠ the refresh trigger moves on a status frame, a persisted mode or a settled question — and on nothing else', () => {
  expect(latestServerStateSequence(stores.recentChunks.get())).toBeUndefined()
  routeEnsoCustomEvent(stores, 'permission-mode', { kind: 'permission-mode', mode: 'default', available: [] })
  routeEnsoCustomEvent(stores, 'message-end', { kind: 'message-end', role: 'assistant' })
  expect(latestServerStateSequence(stores.recentChunks.get())).toBeUndefined()
  routeEnsoCustomEvent(stores, 'status', { type: 'status', live: true, busy: false, generation: 1 })
  const afterStatus = latestServerStateSequence(stores.recentChunks.get())
  expect(afterStatus).toBeDefined()
  // Chunks that do not mean "the server changed" leave the trigger where it was.
  routeEnsoCustomEvent(stores, 'unmapped', { kind: 'unmapped', event: { type: 'message_update' } })
  routeEnsoCustomEvent(stores, 'extension-ui-request', {
    kind: 'extension-ui-request',
    id: '',
    method: 'notify',
    blocking: false,
    origin: 'run',
    message: 'm',
  })
  expect(latestServerStateSequence(stores.recentChunks.get())).toBe(afterStatus)
  routeEnsoCustomEvent(stores, 'dialog-settled', { kind: 'dialog-settled', id: 'd1', outcome: 'answered' })
  expect(latestServerStateSequence(stores.recentChunks.get())).toBeGreaterThan(afterStatus ?? 0)
  const afterSettle = latestServerStateSequence(stores.recentChunks.get())
  routeEnsoCustomEvent(stores, 'custom-entry', { kind: 'custom-entry', customType: 'modes', data: { mode: 'plan' } })
  const afterEntry = latestServerStateSequence(stores.recentChunks.get())
  expect(afterEntry).toBeGreaterThan(afterSettle ?? 0)
  // The follow ending under the page (step 8): the last fetch may describe a session that is gone.
  routeEnsoCustomEvent(stores, FOLLOW_ENDED_CUSTOM_EVENT, { threadId: 't1' })
  expect(latestServerStateSequence(stores.recentChunks.get())).toBeGreaterThan(afterEntry ?? 0)
})

test('the record is a ring: beyond capacity the oldest chunks fall off', () => {
  for (let sent = 0; sent < RECENT_CUSTOM_CHUNK_CAPACITY + 5; sent += 1) {
    routeEnsoCustomEvent(stores, 'unmapped', { sent })
  }
  const recorded = stores.recentChunks.get()
  expect(recorded).toHaveLength(RECENT_CUSTOM_CHUNK_CAPACITY)
  expect(recorded[0]?.value).toEqual({ sent: 5 })
})

// A model turn is a run of `unmapped` chunks; without the inner event type they are
// indistinguishable rows, which is the opposite of what a debug list is for.
test('an unmapped chunk is described by the runtime event it carries; every other chunk by its name', () => {
  routeEnsoCustomEvent(stores, 'unmapped', {
    kind: 'unmapped',
    event: { type: 'tool_execution_start', toolName: 'bash' },
  })
  routeEnsoCustomEvent(stores, 'permission-mode', { kind: 'permission-mode', mode: 'plan', available: [] })
  routeEnsoCustomEvent(stores, 'status', { type: 'status', live: true, busy: false, generation: 1 })
  const [unmapped, receipt, statusChunk] = stores.recentChunks.get()
  expect(unmapped && describeChunk(unmapped)).toBe('unmapped (tool_execution_start)')
  expect(receipt && describeChunk(receipt)).toBe('permission-mode')
  // a frame's own `type` field is its name already — not repeated in parentheses
  expect(statusChunk && describeChunk(statusChunk)).toBe('status')
})

// ── the refetch race (PR #87 review) ─────────────────────────────────────────
// The drawer refetches on open AND on every run settle, so two fetches overlap: the
// mount-time 404 for a thread that has not run yet, and the post-run fetch once a fast
// prompt settles. Whichever was ISSUED last must win, not whichever RESOLVES last.

test('⚠ a request superseded by a later one is dropped even when it resolves last', async () => {
  const pending: Array<{ resolve: (value: string) => void }> = []
  const fetchLatest = latestWins(
    () =>
      new Promise<string>((resolve) => {
        pending.push({ resolve })
      }),
  )
  const first = fetchLatest()
  const second = fetchLatest()
  // The LATER request settles first, then the earlier one arrives late.
  pending[1]?.resolve('after the run')
  pending[0]?.resolve('nothing has run yet')
  expect(await second).toBe('after the run')
  expect(await first).toBeUndefined()
})

test("a superseded request's failure is dropped too; the latest request's failure still throws", async () => {
  let calls = 0
  const fetchLatest = latestWins(() => {
    calls += 1
    return calls === 1 ? Promise.reject(new Error('stale failure')) : Promise.resolve('fresh')
  })
  const stale = fetchLatest()
  const fresh = fetchLatest()
  expect(await fresh).toBe('fresh')
  await expect(stale).resolves.toBeUndefined()
  const onlyFailure = latestWins(() => Promise.reject(new Error('real failure')))
  await expect(onlyFailure()).rejects.toThrow('real failure')
})

test('a non-2xx carries its status as data, not as a prefix to parse', () => {
  const notFound = new InspectionFetchError(404, 'no live session for thread t1')
  expect(notFound.status).toBe(404)
  expect(notFound.message).toBe('404 no live session for thread t1')
  expect(notFound).toBeInstanceOf(Error)
})

// A failed copy must not look identical to a successful one.
test('the copy outcome is named beside the button', () => {
  expect(render(believing('plan'), inspection(), undefined, 'copied')).toContain('copied')
  expect(render(believing('plan'), inspection(), undefined, 'failed')).toContain('copy failed')
  expect(render(believing('plan'), inspection(), undefined, 'idle')).not.toContain('copy failed')
})

// A bundle in flight, saved, or failed must each read differently — and "failed" says why.
test('the bundle outcome is named beside the button, and building disables it', () => {
  const building = renderWith({ browser: believing('plan'), inspection: inspection(), bundleState: 'building' })
  expect(building).toContain('building the bundle…')
  expect(building).toMatch(/<button[^>]*disabled[^>]*>download log bundle/)
  expect(renderWith({ browser: believing('plan'), inspection: inspection(), bundleState: 'saved' })).toContain(
    'bundle saved — open it before you attach it',
  )
  expect(
    renderWith({ browser: believing('plan'), inspection: inspection(), bundleState: { failed: '503 no file' } }),
  ).toContain('bundle failed — 503 no file')
  expect(renderWith({ browser: believing('plan'), inspection: inspection() })).not.toContain('bundle failed')
})

test("the bundle is the server's file with the page's ring appended; the name is the header's, or the thread's when the header is missing", async () => {
  const ring: EnsoLogLine[] = [
    {
      '@timestamp': '2026-09-10T01:00:00.000Z',
      level: 'WARN',
      logger: 'enso.browser.follow',
      message: 'follow failed',
      properties: {},
    },
  ]
  const served = (headers: Record<string, string>) => (): Promise<Response> =>
    Promise.resolve(new Response('# Enso log bundle\n\n## log — 0 records\n', { status: 200, headers }))

  const named = await fetchThreadBundle(
    't1',
    ring,
    served({ 'Content-Disposition': 'attachment; filename="enso-bundle-2026-09-10-t1.md"' }),
  )
  expect(named.filename).toBe('enso-bundle-2026-09-10-t1.md')
  expect(named.text.startsWith('# Enso log bundle')).toBe(true)
  expect(named.text).toContain('## browser logged — 1 records')
  expect(named.text).toContain(JSON.stringify(ring[0]))

  const unnamed = await fetchThreadBundle('6923e620-856a-4132-a9c8-1a2ff7d271f9', ring, served({}))
  expect(unnamed.filename).toBe('enso-bundle-6923e620.md')

  // A refused bundle is the server's reason, with its status as data — like the inspection.
  const refused = (): Promise<Response> =>
    Promise.resolve(new Response('thread must be a thread id or a prefix of one', { status: 400 }))
  await expect(fetchThreadBundle('t1', ring, refused)).rejects.toMatchObject({ status: 400 })
})

// ── the event tails (#97): the ordering view ────────────────────────────────────

function threadEvent(overrides: Partial<EnsoThreadEvent>): EnsoThreadEvent {
  return {
    sequence: 1,
    type: 'entry_appended',
    provenance: 'live',
    at: '2026-09-08T12:34:56.000Z',
    count: 1,
    ...overrides,
  }
}

test('both tails render under their own heading; a dropped event is marked as a failure', () => {
  const events: EnsoThreadEvents = {
    threadId: 't1',
    emitted: [threadEvent({ provenance: 'dropped', type: 'notify' })],
    sent: [threadEvent({ provenance: 'sent', type: 'RUN_FINISHED' })],
  }
  const rendered = renderWith({ browser: believing('plan'), inspection: inspection(), events })
  expect(rendered).toContain('the host emitted')
  expect(rendered).toContain('the server sent')
  expect(rendered).toContain('dropped notify')
  expect(rendered).toContain('sent RUN_FINISHED')
  expect(rendered).toMatch(/text-destructive[^>]*>[^<]*dropped notify/)
  // Before the first refresh the tails say so, rather than rendering as an empty thread.
  expect(render(believing('plan'), inspection())).toContain('not fetched yet')
})
