import { afterEach, expect, test } from 'bun:test'
import { EventType } from '@ag-ui/core'
import {
  ENSO_TOOL_REFUSAL_KEY,
  ENSO_PROJECT_HEADER,
  type EnsoFollowFrame,
  type EnsoProject,
  type EnsoStoredThread,
  NO_SESSION_INCIDENTS,
} from '@enso/core'
import type { StreamChunk } from '@tanstack/ai'
import type { UIMessage } from '@tanstack/ai-client'
import { renderToStaticMarkup } from 'react-dom/server'
import { pageClock } from '../page-clock.ts'
import {
  adoptThread,
  clearThreadsForTest,
  mintThread,
  reviveHistoryMessages,
  TITLE_MAX_CHARS,
  type ThreadStores,
  type ThreadSummary,
  threadListStore,
  titleFromMessages,
  TORN_TAIL_CONTINUED,
  TORN_TAIL_SUPERSEDED,
  updateThreadSummary,
} from '../thread-stores.ts'
import {
  forkParentTitles,
  groupByProject,
  relativeAge,
  STORED_ROWS_SHOWN,
  ThreadsRail,
  UNLISTED_PARENT,
  UNTITLED_THREAD,
} from '../threads-rail.tsx'
import { createScriptedFetch, SNAPSHOT_IDLE } from './scripted-server.ts'

/**
 * #90 PR 3: the sessions rail and the page's thread list behind it. The rail is rendered
 * statically — where nothing subscribes to `pageClock`, so every age is computed once
 * against its snapshot, which is what the dates below are relative to; that the ages MOVE
 * is `page-clock.test.tsx`, which has to mount. The list is driven through `mintThread` and
 * `updateThreadSummary`, the two calls the page makes.
 */

afterEach(() => clearThreadsForTest())

const noop = (): void => {
  // Static markup runs no handlers; the callbacks exist only to satisfy the props.
}

// ── relative age ─────────────────────────────────────────────────────────────

test("relative age is one unit in deepseek's form, and never negative", () => {
  const now = new Date('2026-09-08T12:00:00Z')
  const ago = (seconds: number): Date => new Date(now.getTime() - seconds * 1000)
  expect(relativeAge(ago(0), now)).toBe('now')
  expect(relativeAge(ago(4), now)).toBe('now')
  expect(relativeAge(ago(12), now)).toBe('12s')
  expect(relativeAge(ago(3 * 60 + 5), now)).toBe('3m')
  expect(relativeAge(ago(2 * 3600), now)).toBe('2h')
  expect(relativeAge(ago(6 * 86_400 + 1), now)).toBe('6d')
  // A clock skewed into the future reads as now, not as a negative number.
  expect(relativeAge(new Date(now.getTime() + 60_000), now)).toBe('now')
})

// ── the title ────────────────────────────────────────────────────────────────

const user = (content: string): UIMessage => ({ id: 'u', role: 'user', parts: [{ type: 'text', content }] })

test('the title is the FIRST user message, one line, clipped', () => {
  const messages: UIMessage[] = [
    user('  fix the   login\nbug '),
    { id: 'a', role: 'assistant', parts: [{ type: 'text', content: 'sure' }] },
    user('second question'),
  ]
  expect(titleFromMessages(messages)).toBe('fix the login bug')
  expect(titleFromMessages([user('x'.repeat(TITLE_MAX_CHARS + 10))])).toBe(`${'x'.repeat(TITLE_MAX_CHARS)}…`)
  expect(titleFromMessages([])).toBeUndefined()
  // A user message with no text (an image only) titles nothing rather than an empty string.
  expect(
    titleFromMessages([{ id: 'u', role: 'user', parts: [{ type: 'image', source: { type: 'url', value: 'x.png' } }] }]),
  ).toBeUndefined()
})

// #283: the title is derived over a 120-character window instead of the whole prompt, which
// re-derived per streamed token (14.9 µs for a 20 KB paste). The window is an optimisation
// only while it cannot change the answer — these are the three shapes that could.
test('⚠ a title bounded to a window reads the same as one derived from the whole prompt', () => {
  const paste = 'fix the login bug in auth.ts — here is the whole file:\n'.repeat(400)
  const unbounded = paste.replace(/\s+/g, ' ').trim()
  expect(titleFromMessages([user(paste)])).toBe(`${unbounded.slice(0, TITLE_MAX_CHARS)}…`)
  // The window collapses to LESS than the cap — a prompt that opens with more whitespace
  // than text. Slicing to the window and stopping there would title it `fix the login`.
  const indented = `${'\n   '.repeat(60)}fix the login bug in the auth module, please`
  expect(titleFromMessages([user(indented)])).toBe('fix the login bug in the auth module, please')
  // Several text parts are one line, joined by a single space.
  expect(
    titleFromMessages([
      {
        id: 'u',
        role: 'user',
        parts: [
          { type: 'text', content: 'fix the login bug  ' },
          { type: 'image', source: { type: 'url', value: 'x.png' } },
          { type: 'text', content: '\nin auth.ts' },
        ],
      },
    ]),
  ).toBe('fix the login bug in auth.ts')
})

// ── the page's list ──────────────────────────────────────────────────────────

test('minting lists the thread at once, newest first, untitled and idle', () => {
  const first = mintThread()
  const second = mintThread()
  const listed = threadListStore.get()
  expect(listed.map((thread) => thread.threadId)).toEqual([second.threadId, first.threadId])
  expect(listed[0]).toMatchObject({ title: undefined, busy: false })
})

test("a summary update reaches the list and moves the thread's activity clock; a no-change update does not", () => {
  const thread = mintThread()
  const before = threadListStore.get()[0]
  updateThreadSummary(thread.threadId, { title: 'hello', busy: true, waiting: false })
  const after = threadListStore.get()[0]
  expect(after).toMatchObject({ title: 'hello', busy: true })
  expect(after?.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before?.lastActivityAt.getTime() ?? 0)
  // Same values again: the snapshot is not replaced, so subscribers are not woken for nothing.
  updateThreadSummary(thread.threadId, { title: 'hello', busy: true, waiting: false })
  expect(threadListStore.get()[0]).toBe(after)
  // An id this page never minted is ignored, not created.
  updateThreadSummary('not-minted', { title: 'x', busy: false, waiting: false })
  expect(threadListStore.get()).toHaveLength(1)
})

// @pins resume/one-id
test('adopting stored history restores dates, title and mode under the stored thread id exactly once, and never asks to start a session (#391)', () => {
  const history = {
    threadId: 'stored-1',
    projectId: 'p-launch',
    messages: [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', content: 'resume this work' }],
        createdAt: '2026-09-08T10:00:00.000Z',
      },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', content: 'continuing' }] },
    ],
    permissionMode: { mode: 'plan', available: ['default', 'plan'] },
    sessionRisk: { level: 'low', signals: 0 } as const,
    incidents: NO_SESSION_INCIDENTS,
  }
  const adopted = adoptThread(history)
  expect(adopted.threadId).toBe('stored-1')
  expect(adopted.history[0]?.createdAt).toBeInstanceOf(Date)
  expect(adopted.history[0]?.createdAt?.toISOString()).toBe('2026-09-08T10:00:00.000Z')
  expect(adopted.permissionMode.get()).toEqual({ mode: 'plan', available: ['default', 'plan'] })
  // A resumed thread has its session's settings already; only a minted one opens the dialog.
  expect(adopted.startSession.get()).toBe(false)
  expect(threadListStore.get()).toMatchObject([{ threadId: 'stored-1', title: 'resume this work', busy: false }])
  expect(adoptThread({ ...history, messages: [] })).toBe(adopted)
  expect(threadListStore.get()).toHaveLength(1)
})

// #387 after a reload: the server joined the guard's entry onto the stored result; adopting
// the history puts it where the live chunk would have — the thread's denials, by call id.
test('adopting a history seeds the refused calls from its results, with who refused; a failed result is not one (#387, #523)', () => {
  const errored = (toolCallId: string, metadata?: Record<string, unknown>): UIMessage['parts'][number] => ({
    type: 'tool-result',
    toolCallId,
    content: 'no',
    state: 'error',
    error: 'no',
    ...(metadata === undefined ? {} : { metadata }),
  })
  const adopted = adoptThread({
    threadId: 'refused-1',
    projectId: 'p-launch',
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          errored('c1', { [ENSO_TOOL_REFUSAL_KEY]: { by: 'guard', rule: 'secret-read' } }),
          errored('c2'),
          errored('c3', { [ENSO_TOOL_REFUSAL_KEY]: { by: 'operator' } }),
        ],
      },
    ],
    permissionMode: { mode: 'default', available: [] },
    sessionRisk: { level: 'low', signals: 0 },
    incidents: NO_SESSION_INCIDENTS,
  })
  expect([...adopted.refusals.get()]).toEqual([
    ['c1', { by: 'guard', rule: 'secret-read' }],
    ['c3', { by: 'operator' }],
  ])
})

test('⚠ adopting a branch that ends inside a turn opens with a warning that says so; a settled one opens clean (#109)', () => {
  const torn = adoptThread({
    threadId: 'torn-1',
    projectId: 'p-launch',
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', content: 'never answered' }] }],
    permissionMode: { mode: 'default', available: [] },
    sessionRisk: { level: 'low', signals: 0 },
    incidents: NO_SESSION_INCIDENTS,
    interrupted: 'unanswered-prompt',
  })
  expect(torn.notifications.get()).toMatchObject([
    { message: expect.stringContaining('last prompt was never answered'), notifyType: 'warning', origin: 'run' },
  ])
  const settled = adoptThread({
    threadId: 'settled-1',
    projectId: 'p-launch',
    messages: [],
    permissionMode: { mode: 'default', available: [] },
    sessionRisk: { level: 'low', signals: 0 },
    incidents: NO_SESSION_INCIDENTS,
  })
  expect(settled.notifications.get()).toEqual([])
})

test('⚠ the torn-tail notice offers Continue once: pressing it posts …/continue, and a refusal is said as a line (#436)', async () => {
  const posted: string[] = []
  const torn = adoptThread(
    {
      threadId: 'torn-2',
      projectId: 'p-launch',
      messages: [],
      permissionMode: { mode: 'default', available: [] },
      sessionRisk: { level: 'low', signals: 0 },
      incidents: NO_SESSION_INCIDENTS,
      interrupted: 'tool-call-without-result',
    },
    (input: string, init?: RequestInit) => {
      posted.push(`${init?.method} ${input}`)
      return Promise.resolve(new Response('nothing to continue: the thread ends on a reply', { status: 422 }))
    },
  )
  const [notice] = torn.notifications.get()
  const action = torn.notifications.takeAction(notice?.id ?? -1)
  expect(action?.label).toBe('Continue')
  // One-shot: taken off the line, so a second press has nothing to run.
  expect(torn.notifications.takeAction(notice?.id ?? -1)).toBeUndefined()
  expect(torn.notifications.get()[0]?.action).toBeUndefined()

  const said = Promise.withResolvers<void>()
  torn.notifications.subscribe(() => {
    if (torn.notifications.get().length > 1) said.resolve()
  })
  action?.run()
  await said.promise
  expect(posted).toEqual(['POST /api/threads/torn-2/continue'])
  expect(torn.notifications.get()[1]).toMatchObject({
    message: expect.stringContaining('nothing to continue: the thread ends on a reply'),
    notifyType: 'warning',
  })
})

/**
 * A torn thread's stores following a scripted server, whose `…/continue` answers `continueStatus`
 * once `answered` resolves (at once by default) — `0` for no answer at all, a dropped connection.
 */
function followedTornThread(
  threadId: string,
  continueStatus: number,
  answered: Promise<void> = Promise.resolve(),
): {
  stores: ThreadStores
  frame: (frame: EnsoFollowFrame) => Promise<void>
  stop: () => void
  continues: () => number
} {
  const server = createScriptedFetch()
  let continues = 0
  const stores = adoptThread(
    {
      threadId,
      projectId: 'p-launch',
      messages: [],
      permissionMode: { mode: 'default', available: [] },
      sessionRisk: { level: 'low', signals: 0 },
      incidents: NO_SESSION_INCIDENTS,
      interrupted: 'unanswered-prompt',
    },
    (input: string, init?: RequestInit) => {
      if (!input.endsWith('/continue')) return server.fetch(input, init)
      continues += 1
      return answered.then(() => {
        if (continueStatus === 0) throw new TypeError('Failed to fetch')
        return new Response(continueStatus === 202 ? null : 'refused here', { status: continueStatus })
      })
    },
  )
  let waiter: ((chunk: StreamChunk) => void) | undefined
  const controller = new AbortController()
  void (async () => {
    for await (const chunk of stores.connection.subscribe(controller.signal)) waiter?.(chunk)
  })()
  return {
    continues: () => continues,
    stores,
    // Resolves once the frame's OWN first chunk reached the page — a status or snapshot as its
    // CUSTOM, a turn as its STEP_STARTED — never on a straggler from the frame before.
    frame: (frame: EnsoFollowFrame): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>()
      waiter = (chunk: StreamChunk) => {
        const own =
          frame.type === 'observation'
            ? chunk.type === EventType.STEP_STARTED
            : chunk.type === EventType.CUSTOM && chunk.name === frame.type
        if (own) resolve()
      }
      server.frame(frame)
      return promise
    },
    stop: () => controller.abort(),
  }
}

const TURN_START: EnsoFollowFrame = { type: 'observation', seq: 1, observation: { kind: 'turn-start' } }
const status = (busy: boolean, generation: number): EnsoFollowFrame => ({
  type: 'status',
  live: true,
  busy,
  generation,
})

/** The torn-tail line's words once a run has resolved it — the resolution waits on a pending Continue. */
function resolvedLine(stores: ThreadStores): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>()
  const check = (): void => {
    const [line] = stores.notifications.get()
    if (line?.notifyType === 'info') resolve(line.message)
  }
  stores.notifications.subscribe(check)
  check()
  return promise
}

// PR #442 review: the line and its button outlived the tail. PR #440 review: keyed on `busy`, any
// lease retired it — a mode change, `/model`, a refused Continue. Only a run's first turn does.
test('⚠ the torn-tail line is kept through a lease that starts no run, and superseded by the first turn (#436)', async () => {
  const torn = followedTornThread('torn-leased', 202)
  await torn.frame(SNAPSHOT_IDLE)
  await torn.frame(status(true, 1)) // a mode change's lease: busy, no run
  await torn.frame(status(false, 1))
  expect(torn.stores.notifications.get()[0]?.action?.label).toBe('Continue')
  await torn.frame(TURN_START)
  expect(await resolvedLine(torn.stores)).toBe(TORN_TAIL_SUPERSEDED)
  expect(torn.stores.notifications.get()[0]?.action).toBeUndefined()
  torn.stop()
})

test('⚠ an accepted Continue resolves the line as continued, once; a refused one leaves the next run to supersede it (#436)', async () => {
  const pressContinue = (stores: ThreadStores): void => {
    const [line] = stores.notifications.get()
    stores.notifications.takeAction(line?.id ?? -1)?.run()
  }
  const accepted = followedTornThread('torn-continued', 202)
  await accepted.frame(SNAPSHOT_IDLE)
  pressContinue(accepted.stores)
  await accepted.frame(TURN_START)
  expect(await resolvedLine(accepted.stores)).toBe(TORN_TAIL_CONTINUED)
  // Only the first run: a later turn leaves the resolved line as it is.
  await accepted.frame(TURN_START)
  expect(accepted.stores.notifications.get()[0]?.message).toBe(TORN_TAIL_CONTINUED)
  accepted.stop()

  const refused = followedTornThread('torn-refused', 422)
  await refused.frame(SNAPSHOT_IDLE)
  const refusalSaid = Promise.withResolvers<void>()
  refused.stores.notifications.subscribe(() => {
    if (refused.stores.notifications.get().length > 1) refusalSaid.resolve()
  })
  pressContinue(refused.stores)
  await refusalSaid.promise
  await refused.frame(TURN_START) // the prompt the refusal left the user to send
  expect(await resolvedLine(refused.stores)).toBe(TORN_TAIL_SUPERSEDED)
  refused.stop()

  // PR #439 review: another tab's prompt won the thread a moment before this Continue. Its first
  // turn lands while the Continue is unanswered; the 409 that follows says the run was not ours.
  const answer = Promise.withResolvers<void>()
  const raced = followedTornThread('torn-raced', 409, answer.promise)
  await raced.frame(SNAPSHOT_IDLE)
  pressContinue(raced.stores)
  await raced.frame(TURN_START)
  answer.resolve()
  expect(await resolvedLine(raced.stores)).toBe(TORN_TAIL_SUPERSEDED)
  raced.stop()
})

/** Resolves once the torn-tail line carries its action again — a press that did nothing gave it back. */
function actionBack(stores: ThreadStores): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const check = (): void => {
    if (stores.notifications.get()[0]?.action?.label === 'Continue') resolve()
  }
  stores.notifications.subscribe(check)
  check()
  return promise
}

// PR #438 review: the press took the action off the line before the outcome was known, so a press
// that started nothing — while disconnected, a 409 with no run behind it, no answer — used up the
// only way to continue.
test('⚠ a Continue that started nothing gives its action back: not sent while disconnected, answered busy, or unanswered (#436)', async () => {
  const press = (stores: ThreadStores): void => {
    const [line] = stores.notifications.get()
    stores.notifications.takeAction(line?.id ?? -1)?.run()
  }

  const offline = followedTornThread('torn-offline', 202)
  await offline.frame(SNAPSHOT_IDLE)
  offline.stores.disconnected.set(true)
  press(offline.stores)
  await actionBack(offline.stores)
  expect(offline.continues()).toBe(0)
  expect(offline.stores.notifications.get()).toHaveLength(2) // and said why
  offline.stop()

  for (const [threadId, status] of [
    ['torn-busy', 409],
    ['torn-unreachable', 0],
  ] as const) {
    const torn = followedTornThread(threadId, status)
    await torn.frame(SNAPSHOT_IDLE)
    press(torn.stores)
    await actionBack(torn.stores)
    expect(torn.continues()).toBe(1)
    torn.stop()
  }
})

test('history revival drops malformed rows and invalid dates instead of handing them to TanStack', () => {
  const revived = reviveHistoryMessages([
    null,
    { id: 3, role: 'user', parts: [] },
    { id: 'x', role: 'tool', parts: [] },
    { id: 'u', role: 'user', parts: [{ type: 'text', content: 'visible' }], createdAt: 'not-a-date' },
  ])
  expect(revived).toEqual([{ id: 'u', role: 'user', parts: [{ type: 'text', content: 'visible' }] }])
})

// ── the rail ─────────────────────────────────────────────────────────────────

test('the rail names the active thread, titles the untitled honestly, and marks a busy or waiting one', () => {
  // The clock a static render reads, so an age of exactly six days reads as six and not as
  // five days and 999 ms.
  const now = pageClock.get()
  const rendered = renderToStaticMarkup(
    <ThreadsRail
      projects={[]}
      threads={[
        { threadId: 't2', title: undefined, lastActivityAt: now, busy: true, waiting: false, projectId: undefined },
        {
          threadId: 't1',
          title: 'fix the login bug',
          lastActivityAt: new Date(now.getTime() - 6 * 86_400_000),
          busy: false,
          waiting: false,
          projectId: undefined,
        },
        // Parked on a question mid-run: waiting on you is what the row says, not running.
        { threadId: 't3', title: 'asks first', lastActivityAt: now, busy: true, waiting: true, projectId: undefined },
      ]}
      activeThreadId="t1"
      earlier={[]}
      earlierError={undefined}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onAddProject={noop}
      onRemoveProject={noop}
      projectNotice={undefined}
    />,
  )
  expect(rendered).toContain('New Thread')
  expect(rendered).toContain(UNTITLED_THREAD)
  expect(rendered).toContain('fix the login bug')
  expect(rendered).toContain('6d')
  // Exactly one row is current, and it is the active one.
  expect(rendered.match(/aria-current="true"/g)).toHaveLength(1)
  const currentRow = rendered.slice(rendered.indexOf('aria-current="true"'))
  expect(currentRow.indexOf('fix the login bug')).toBeLessThan(currentRow.indexOf('</button>'))
  // The busy row says so for assistive tech, not only with a dot; so does the waiting one.
  const rowOf = (title: string): string => {
    const start = rendered.lastIndexOf('<button', rendered.indexOf(title))
    return rendered.slice(start, rendered.indexOf('</button>', start))
  }
  expect(rowOf(UNTITLED_THREAD)).toContain('running')
  expect(rowOf('asks first')).toContain('waiting on you')
  expect(rowOf('asks first')).not.toContain('running')
})

// ── projects (#395) ──────────────────────────────────────────────────────────

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const APP: EnsoProject = { projectId: 'p-app', title: 'app', path: '/code/app', status: 'ok', launch: false }
const GONE: EnsoProject = {
  projectId: 'p-gone',
  title: 'gone',
  path: '/code/gone',
  status: 'missing-dir',
  launch: false,
}

function storedIn(projectId: string, threadId: string, extra: Partial<EnsoStoredThread> = {}): EnsoStoredThread {
  return { threadId, projectId, lastActivityAt: pageClock.get().toISOString(), messageCount: 2, busy: false, ...extra }
}

/** The markup of the section a project's rows are in — from its label to the next section. */
function sectionOf(rendered: string, name: string): string {
  const start = rendered.indexOf(`<section aria-label="${name}"`)
  if (start < 0) throw new Error(`no section ${name}`)
  const end = rendered.indexOf('<section', start + 1)
  return rendered.slice(start, end < 0 ? undefined : end)
}

test("each project is a section with its own threads — the page's open ones, then its stored ones — and a + that starts one there", () => {
  const now = pageClock.get()
  const rendered = renderToStaticMarkup(
    <ThreadsRail
      projects={[LAUNCH, APP, GONE]}
      // A thread minted before the page knew its projects has none: the server built it in the launch directory.
      threads={[
        { threadId: 'here', title: 'current', lastActivityAt: now, busy: false, waiting: false, projectId: undefined },
      ]}
      activeThreadId="here"
      earlier={[
        storedIn('p-launch', 'stored', {
          title: 'resume me',
          lastActivityAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
        }),
        storedIn('p-app', 'elsewhere', { busy: true }),
      ]}
      earlierError={undefined}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onAddProject={noop}
      onRemoveProject={noop}
      projectNotice={undefined}
    />,
  )
  const launch = sectionOf(rendered, 'enso')
  expect(launch.indexOf('current')).toBeLessThan(launch.indexOf('resume me'))
  expect(launch).toContain('2h')
  expect(launch).toContain('title="/code/enso"')
  // Running elsewhere is shown, not locked (#114): the row is how a reloaded page gets back to an open question.
  const app = sectionOf(rendered, 'app')
  expect(app).toContain(UNTITLED_THREAD)
  expect(app).toContain('running')
  expect(app).toContain('aria-label="new thread in app"')
  expect(app).not.toContain('disabled=""')
  // A project whose directory is gone says so, and starts nothing.
  const gone = sectionOf(rendered, 'gone')
  expect(gone).toContain('missing')
  expect(gone).toContain('no threads yet')
  expect(gone).toMatch(
    /aria-label="new thread in gone"[^>]*disabled=""|disabled=""[^>]*aria-label="new thread in gone"/,
  )
})

test('a fork says which thread it came from, by that thread’s title — a stored one’s, an open one’s, or that it is not listed (#433)', () => {
  const now = pageClock.get()
  const stored = [
    storedIn('p-launch', 'parent', { title: 'the original' }),
    storedIn('p-launch', 'fork', { title: 'the original', parentThreadId: 'parent' }),
    // A fork of an open thread the listing has no title for yet: the page's own title names it.
    storedIn('p-launch', 'fork-of-open', { parentThreadId: 'open' }),
    storedIn('p-launch', 'orphan-fork', { title: 'lost parent', parentThreadId: 'elsewhere' }),
  ]
  const threads: ThreadSummary[] = [
    {
      threadId: 'open',
      title: 'asked just now',
      lastActivityAt: now,
      busy: false,
      waiting: false,
      projectId: 'p-launch',
    },
  ]
  const parents = forkParentTitles(stored, threads)
  expect([...parents]).toEqual([
    ['fork', 'the original'],
    ['fork-of-open', 'asked just now'],
    ['orphan-fork', UNLISTED_PARENT],
  ])
  const rendered = renderToStaticMarkup(
    <ThreadsRail
      projects={[LAUNCH]}
      threads={threads}
      activeThreadId="open"
      earlier={stored}
      forkParents={parents}
      earlierError={undefined}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onAddProject={noop}
      onRemoveProject={noop}
      projectNotice={undefined}
    />,
  )
  const rows = rendered.split('</button>')
  const forkLines = rows.flatMap((row) => /forked from ([^<]*)/.exec(row)?.[1] ?? [])
  expect(forkLines).toEqual(['the original', 'asked just now', UNLISTED_PARENT])
})

test('⚠ an open thread whose project is not listed is kept, under "other"; with no projects yet, every thread is still there', () => {
  const now = pageClock.get()
  const orphan = {
    threadId: 'orphan',
    title: 'still open',
    lastActivityAt: now,
    busy: false,
    waiting: false,
    projectId: 'p-removed',
  }
  const grouped = groupByProject([LAUNCH], [orphan], [])
  expect(grouped.map((group) => group.project?.projectId)).toEqual(['p-launch', undefined])
  expect(grouped[1]?.threads).toEqual([orphan])
  expect(groupByProject([], [orphan], [storedIn('p-launch', 'stored')])).toEqual([
    { project: undefined, threads: [orphan], earlier: [storedIn('p-launch', 'stored')] },
  ])
})

// A folded section hides the rows that would say it; its header says it instead — a question
// waiting on you over a run in flight, since a thread parked on a question is still busy (PR #403 review).
test('a folded section says a question is waiting in it, over a run in flight; unfolded, the row says it', () => {
  const now = pageClock.get()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const kept = new Map<string, string>([['enso.rail.folded', JSON.stringify([APP.projectId])]])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
    },
  })
  const rail = (threads: ThreadSummary[]): string =>
    renderToStaticMarkup(
      <ThreadsRail
        projects={[LAUNCH, APP]}
        threads={threads}
        activeThreadId={undefined}
        earlier={[]}
        earlierError={undefined}
        onSelect={noop}
        onResume={noop}
        onNew={noop}
        onAddProject={noop}
        onRemoveProject={noop}
        projectNotice={undefined}
      />,
    )
  const asking = {
    threadId: 'asks',
    title: 'asks first',
    lastActivityAt: now,
    busy: true,
    waiting: true,
    projectId: 'p-app',
  }
  const working = { ...asking, threadId: 'works', title: 'still working', waiting: false }
  try {
    const folded = sectionOf(rail([asking, working]), 'app')
    expect(folded).not.toContain('asks first')
    expect(folded).toContain('waiting on you')
    expect(folded).not.toContain('running')
    // Only a run in flight: the folded header says running.
    const onlyRunning = sectionOf(rail([working]), 'app')
    expect(onlyRunning).toContain('running')
    expect(onlyRunning).not.toContain('waiting on you')
    // Unfolded, the header says nothing; the row does.
    kept.set('enso.rail.folded', '[]')
    const open = sectionOf(rail([asking]), 'app')
    expect(open).toContain('asks first')
    expect(open.match(/waiting on you/g)).toHaveLength(1)
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', original)
  }
})

test('a section shows five stored threads and says how many more there are; a failed listing is an alert, not an empty rail', () => {
  const earlier = Array.from({ length: STORED_ROWS_SHOWN + 2 }, (_, index) => storedIn('p-launch', `s${index}`))
  const props = {
    projects: [LAUNCH],
    threads: [],
    activeThreadId: undefined,
    onSelect: noop,
    onResume: noop,
    onNew: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    projectNotice: undefined,
  }
  const rendered = renderToStaticMarkup(<ThreadsRail {...props} earlier={earlier} earlierError={undefined} />)
  expect(rendered.match(/not open here/g)).toHaveLength(STORED_ROWS_SHOWN)
  expect(rendered).toContain('show 2 more')
  const failed = renderToStaticMarkup(<ThreadsRail {...props} earlier={[]} earlierError="connection refused" />)
  expect(failed).toContain('role="alert"')
  expect(failed).toContain('could not list threads: connection refused')
})

test('⚠ a thread minted in a project names it on every request it makes; one minted with none names nothing', async () => {
  const seen: Array<string | null> = []
  const recording = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push(new Headers(init?.headers).get(ENSO_PROJECT_HEADER))
    return Promise.resolve(new Response(null, { status: 204 }))
  }) as typeof fetch
  await mintThread(recording, 'p-app').connection.configure({ mode: 'plan' })
  await mintThread(recording).connection.configure({ mode: 'plan' })
  // The thread's own fetch too — what its reads go through (the typed-command lookup, the mode seed,
  // the Stats and Context views: PR #405 review).
  await mintThread(recording, 'p-app').fetch('/api/threads/t/commands')
  expect(seen).toEqual(['p-app', null, 'p-app'])
})

test('a registered project can be removed from its section, the launch directory cannot; a refused removal is said', () => {
  const rendered = renderToStaticMarkup(
    <ThreadsRail
      projects={[LAUNCH, APP]}
      threads={[]}
      activeThreadId={undefined}
      earlier={[]}
      earlierError={undefined}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onAddProject={noop}
      onRemoveProject={noop}
      projectNotice="could not remove the project: 409 a thread in this project is running"
    />,
  )
  expect(sectionOf(rendered, 'app')).toContain('aria-label="more for app"')
  expect(sectionOf(rendered, 'enso')).not.toContain('more for')
  expect(rendered).toContain('Add project')
  expect(rendered).toMatch(/role="alert"[^>]*>could not remove the project: 409 a thread in this project is running/)
})
