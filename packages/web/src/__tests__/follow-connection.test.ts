import { expect, test } from 'bun:test'
import { EventType } from '@ag-ui/core'
import type { EnsoFollowFrame } from '@enso/core'
import { type FlowTrace, flowTrace } from '@enso/core/flow-trace'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { StreamChunk } from '@tanstack/ai'
import { FOLLOW_ENDED_CUSTOM_EVENT } from '../custom-event-router.ts'
import { createFollowConnection, type FollowConnection } from '../follow-connection.ts'
import { pageLeaving } from '../page-leaving.ts'
import { createScriptedFetch, type ScriptedFetch, SNAPSHOT_IDLE } from './scripted-server.ts'

/**
 * The adapter is the ONLY place AG-UI is made (#112). These drive it with a scripted server
 * — an SSE body the test writes frames into, a prompt route the test answers — and read the
 * chunks TanStack would see. Event-driven: every assertion waits for the chunk it names.
 */

interface ScriptedServer extends ScriptedFetch {
  readonly connection: FollowConnection
  readonly problems: string[]
  /** What TanStack would see, in order. */
  readonly chunks: StreamChunk[]
  /** Resolves once at least `count` chunks have arrived. */
  readonly untilChunks: (count: number) => Promise<void>
  /** Abort the subscription — the client's own leaving. */
  readonly abort: () => void
  /** Draw the wire into a flow trace from here on: frames written, POSTs made, chunks yielded. */
  readonly traceInto: (trace: FlowTrace) => void
  /** A step the test itself takes, drawn when a trace is on. */
  readonly step: (from: string, to: string, label: string) => void
}

/** A frame as one arrow's label: its type and the fields a reader follows. */
function frameLabel(frame: EnsoFollowFrame): string {
  if (frame.type === 'status')
    return `status {live: ${frame.live}, busy: ${frame.busy}, generation: ${frame.generation}}`
  if (frame.type === 'observation') return `observation ${frame.seq}: ${frame.observation.kind}`
  return frame.type
}

/** A chunk as TanStack receives it: the event type, the run it names, a custom event's name. */
function chunkLabel(chunk: StreamChunk): string {
  const run = 'runId' in chunk ? ` ${chunk.runId}` : ''
  const name = chunk.type === EventType.CUSTOM && 'name' in chunk ? ` ${chunk.name}` : ''
  const delta = 'delta' in chunk && typeof chunk.delta === 'string' ? ` "${chunk.delta}"` : ''
  return `${chunk.type}${run}${name}${delta}`
}

/** The adapter subscribed to a scripted server (`scripted-server.ts`), with its chunks collected. */
function scripted(
  promptStatus?: { status: number; body: unknown },
  dialogStatus?: number,
  abortStatus?: number,
  queued?: string[],
): ScriptedServer {
  const server = createScriptedFetch({
    ...(promptStatus === undefined ? {} : { promptStatus }),
    ...(dialogStatus === undefined ? {} : { dialogStatus }),
    ...(abortStatus === undefined ? {} : { abortStatus }),
    ...(queued === undefined ? {} : { queued }),
  })
  const problems: string[] = []
  let trace: FlowTrace | undefined
  const connection = createFollowConnection({
    threadId: 't1',
    fetch: async (input, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') return await server.fetch(input, init)
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      trace?.request('A', 'S', `${method} ${new URL(input, 'http://enso.test').pathname}`, body)
      const response = await server.fetch(input, init)
      trace?.respond(
        'S',
        'A',
        response.status,
        await response
          .clone()
          .json()
          .catch((): undefined => undefined),
      )
      return response
    },
    onProblem: (problem: unknown) => problems.push(String(problem)),
  })
  const chunks: StreamChunk[] = []
  const waiters: Array<() => void> = []
  const controller = new AbortController()
  void (async () => {
    for await (const chunk of connection.subscribe(controller.signal)) {
      trace?.send('A', 'U', chunkLabel(chunk))
      chunks.push(chunk)
      for (const waiter of waiters.splice(0)) waiter()
    }
    for (const waiter of waiters.splice(0)) waiter()
  })()
  return {
    ...server,
    frame: (frame: EnsoFollowFrame) => {
      trace?.send('S', 'A', frameLabel(frame))
      server.frame(frame)
    },
    connection,
    problems,
    chunks,
    untilChunks: (count: number) => {
      if (chunks.length >= count) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers<void>()
      const check = (): void => {
        if (chunks.length >= count) resolve()
        else waiters.push(check)
      }
      waiters.push(check)
      return promise
    },
    abort: () => controller.abort(),
    traceInto: (into: FlowTrace) => {
      trace = into
    },
    step: (from: string, to: string, label: string) => trace?.send(from, to, label),
  }
}

// @pins prompt-run-settle/two-endings
test('⚠ a released status ends the run — the slash-command case, which never settles', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, '/mode')
  await server.untilChunks(3)
  server.frame({ type: 'status', live: true, busy: true, generation: 1 })
  server.frame({ type: 'status', live: true, busy: false, generation: 1 })
  await server.untilChunks(6)
  expect(server.chunks[5]).toEqual({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' })
  server.abort()
})

// @pins prompt-run-settle/generation-fence
test("⚠ an earlier run's ending frames cannot close a run whose receipt is still pending; the receipt closes it if the server already moved past it", async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  const release = server.holdPrompt()
  const sending = send(server, '/mode')
  await server.untilChunks(3) // RUN_STARTED r1 at admission, receipt still out
  // The server took and released generation 1 before the receipt came back.
  server.frame({ type: 'status', live: true, busy: true, generation: 1 })
  server.frame({ type: 'status', live: true, busy: false, generation: 1 })
  await server.untilChunks(4)
  expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false)
  release()
  await sending
  await server.untilChunks(6)
  expect(server.chunks[5]).toEqual({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' })
  server.abort()
})

const send = (server: ScriptedServer, message: string, runId = 'r1'): Promise<void> =>
  server.connection.send(
    [{ id: 'u1', role: 'user', parts: [{ type: 'text', content: message }] }],
    undefined,
    undefined,
    {
      threadId: 't1',
      runId,
      clientTools: [],
      forwardedProps: {},
    },
  )

// ── images on a prompt (#68) ───────────────────────────────────────────────────────

const PNG_BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test("send posts the user's image parts as inline bytes + kind, with the text; a text-only message has NO images key", async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await server.connection.send(
    [
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', content: 'what does this say?' },
          { type: 'image', source: { type: 'data', value: PNG_BYTES, mimeType: 'image/png' } },
          // A `data:` URL is bytes already — the form's own shape — so it crosses as bytes too.
          { type: 'image', source: { type: 'url', value: `data:image/webp;base64,${PNG_BYTES}` } },
        ],
      },
    ],
    undefined,
    undefined,
    { threadId: 't1', runId: 'r1', clientTools: [], forwardedProps: {} },
  )
  expect(server.prompts).toEqual([
    {
      message: 'what does this say?',
      images: [
        { mimeType: 'image/png', data: PNG_BYTES },
        { mimeType: 'image/webp', data: PNG_BYTES },
      ],
    },
  ])
  await send(server, 'plain', 'r2')
  expect(server.prompts[1]).toEqual({ message: 'plain' })
  expect(server.prompts[1]).not.toHaveProperty('images')
  server.abort()
})

test('[WARN] an image by URL is refused on THIS side, by name, before anything is posted — the server never sees a URL (#68)', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await server.connection.send(
    [
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', content: 'look' },
          { type: 'image', source: { type: 'url', value: 'https://example.com/secret-internal.png' } },
        ],
      },
    ],
    undefined,
    undefined,
    { threadId: 't1', runId: 'r1', clientTools: [], forwardedProps: {} },
  )
  // The run opened (RUN_STARTED, TEXT_MESSAGE_START) and ended with the reason — like a 400, minus the POST.
  await server.untilChunks(4)
  expect(server.prompts).toEqual([])
  expect(server.chunks[3]).toEqual({
    type: EventType.RUN_ERROR,
    runId: 'r1',
    message:
      'image not sent: https://example.com/secret-internal.png: an image by URL is not sent — attach the file itself',
  })
  server.abort()
})

test('[WARN] a kind the wire does not take is refused on this side by name, not sent for the server to refuse', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await server.connection.send(
    [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'image', source: { type: 'data', value: PNG_BYTES, mimeType: 'image/svg+xml' } }],
      },
    ],
    undefined,
    undefined,
    { threadId: 't1', runId: 'r1', clientTools: [], forwardedProps: {} },
  )
  await server.untilChunks(4)
  expect(server.prompts).toEqual([])
  expect(server.chunks[3]).toMatchObject({
    type: EventType.RUN_ERROR,
    message: 'image not sent: image/svg+xml: not a kind this wire takes (image/png, image/jpeg, image/gif, image/webp)',
  })
  server.abort()
})

test('prompt() during a run carries the images beside the text, enqueued (#68, #75)', async () => {
  const server = scripted(QUEUED_RECEIPT)
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 2 })
  await server.untilChunks(3)
  expect(await server.connection.prompt('and this', [{ mimeType: 'image/png' as const, data: PNG_BYTES }])).toBe(
    'queued',
  )
  expect(server.prompts).toEqual([
    { message: 'and this', admission: 'enqueue', images: [{ mimeType: 'image/png', data: PNG_BYTES }] },
  ])
  server.abort()
})

test('the snapshot becomes the mode, open-question and run receipts the stores already read', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  // The frame crosses WHOLE, named by its type (#162 workstream 5): the router reads the
  // mode, the open questions and the generation off it.
  expect(server.chunks).toEqual([{ type: EventType.CUSTOM, name: 'snapshot', value: SNAPSHOT_IDLE }])
  server.abort()
})

// @pins prompt-run-settle/admission
test("send opens TanStack's own run at admission; the thread's settle closes it", async () => {
  const logs = await recordEnsoLogs()
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  // The browser's side of `docs/flows/prompt-run-settle.md` (#482), from the snapshot on.
  const trace = flowTrace({
    participants: { U: 'TanStack (useChat)', A: 'adapter (follow-connection.ts)', S: 'server (scripted)' },
    categories: { 'enso.browser.follow': 'A' },
    logs,
  })
  server.traceInto(trace)

  server.step('U', 'A', 'send "hello" (run r1)')
  await send(server, 'hello')
  expect(server.prompts).toEqual([{ message: 'hello' }])
  await server.untilChunks(3)
  expect(server.chunks.slice(1)).toEqual([
    { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
    { type: EventType.TEXT_MESSAGE_START, messageId: expect.any(String), role: 'assistant' },
  ])
  const opened = server.chunks[2]
  const messageId = opened !== undefined && 'messageId' in opened ? opened.messageId : ''

  // The server's status for OUR generation is not a second run.
  server.frame({ type: 'status', live: true, busy: true, generation: 1 })
  server.frame({ type: 'observation', seq: 1, observation: { kind: 'text-delta', contentIndex: 0, delta: 'hi' } })
  server.frame({ type: 'observation', seq: 2, observation: { kind: 'settled' } })
  server.frame({ type: 'status', live: true, busy: false, generation: 1 })
  await server.untilChunks(7)
  expect(server.chunks.slice(3)).toEqual([
    { type: EventType.CUSTOM, name: 'status', value: { type: 'status', live: true, busy: true, generation: 1 } },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'hi' },
    { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    { type: EventType.CUSTOM, name: 'status', value: { type: 'status', live: true, busy: false, generation: 1 } },
  ])
  expect(trace.diagram()).toMatchSnapshot('flow prompt-run-settle: the browser')
  server.abort()
  await releaseEnsoLogs()
})

test('⚠ a run another client started is synthesised so this tab renders what it is watching', async () => {
  const server = scripted()
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 4 })
  await server.untilChunks(3)
  expect(server.chunks.slice(1)).toEqual([
    { type: EventType.RUN_STARTED, threadId: 't1', runId: 'external-4' },
    { type: EventType.TEXT_MESSAGE_START, messageId: expect.any(String), role: 'assistant' },
  ])
  server.frame({ type: 'observation', seq: 1, observation: { kind: 'settled' } })
  await server.untilChunks(4)
  expect(server.chunks[3]).toEqual({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'external-4' })
  server.abort()
})

test("a refused prompt (400) is a run error with the server's reason, and no run stays open", async () => {
  const server = scripted({ status: 400, body: '/settings is not available on this surface' })
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, '/settings')
  await server.untilChunks(4)
  expect(server.chunks[3]).toEqual({
    type: EventType.RUN_ERROR,
    runId: 'r1',
    message: '/settings is not available on this surface',
  })
  server.abort()
})

// @pins prompt-run-settle/refusals
test("⚠ a prompt pi rejects after admission reaches the run as an error, by the receipt's message id", async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, 'hello')
  await server.untilChunks(3)
  server.frame({
    type: 'observation',
    seq: 1,
    observation: { kind: 'prompt-rejected', messageId: 'pm1', reason: 'Agent is already processing' },
  })
  await server.untilChunks(4)
  expect(server.chunks[3]).toEqual({ type: EventType.RUN_ERROR, runId: 'r1', message: 'Agent is already processing' })
  server.abort()
})

// PR #113 review: the queued-prompt path rejects the instant `session.prompt` runs, before
// the 202 body is written — the follow can deliver the rejection before the receipt names the run.
// @pins prompt-run-settle/refusals
test('⚠ a rejection that beats its own receipt is held and still ends the run with its reason', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  const release = server.holdPrompt()
  const sending = send(server, 'hello')
  await server.untilChunks(3)
  server.frame({
    type: 'observation',
    seq: 1,
    observation: { kind: 'prompt-rejected', messageId: 'pm1', reason: 'Agent is already processing' },
  })
  // Nothing yet: no run is named pm1 until the receipt lands.
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(server.chunks).toHaveLength(3)
  release()
  await sending
  await server.untilChunks(4)
  expect(server.chunks[3]).toEqual({ type: EventType.RUN_ERROR, runId: 'r1', message: 'Agent is already processing' })
  server.abort()
})

test('answerDialog names what the server did: answered (204), gone (404), refused (422)', async () => {
  expect(await scripted(undefined, 204).connection.answerDialog({ id: 'd1', value: 'a' })).toBe('answered')
  const gone = scripted(undefined, 404)
  expect(await gone.connection.answerDialog({ id: 'd1', value: 'a' })).toBe('gone')
  const refused = scripted(undefined, 422)
  expect(await refused.connection.answerDialog({ id: 'd1', value: 'zzz' })).toBe('refused')
  expect(refused.problems).toEqual([expect.stringContaining('refused: 422')])
})

// ── the mode route (L3 step C) ──────────────────────────────────────────────────────
test('changeMode is one POST to …/mode carrying a MODE, never a command; the store moves only when the feed says so', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  expect(await server.connection.changeMode('plan')).toBe('told')
  expect(server.modeChanges).toEqual([{ mode: 'plan' }])
  expect(server.prompts).toEqual([])
  // Nothing in the stream yet: the click moved no store. The host's receipt does.
  expect(
    server.chunks.some(
      (chunk) =>
        chunk.type === EventType.CUSTOM &&
        chunk.name === 'permission-mode' &&
        (chunk.value as { mode?: string }).mode === 'plan',
    ),
  ).toBe(false)
  server.frame({
    type: 'observation',
    seq: 1,
    observation: { kind: 'permission-mode', mode: 'plan', available: ['default', 'plan'] },
  })
  await server.untilChunks(2)
  expect(server.chunks.at(-1)).toMatchObject({
    type: EventType.CUSTOM,
    name: 'permission-mode',
    value: { kind: 'permission-mode', mode: 'plan' },
  })
  expect(server.problems).toEqual([])
  server.abort()
})

test('a refused mode change names the outcome and is reported — busy is not a failure of this page', async () => {
  const busy = createScriptedFetch({ modeStatus: 409 })
  const busyProblems: string[] = []
  const busyConnection = createFollowConnection({
    threadId: 't1',
    fetch: busy.fetch,
    onProblem: (p: unknown) => busyProblems.push(String(p)),
  })
  expect(await busyConnection.changeMode('plan')).toBe('busy')
  expect(busyProblems).toHaveLength(1)
  const refused = createScriptedFetch({ modeStatus: 422 })
  const refusedConnection = createFollowConnection({ threadId: 't1', fetch: refused.fetch, onProblem: () => undefined })
  expect(await refusedConnection.changeMode('nope')).toBe('refused')
})

// ── the configure route (#391) ──────────────────────────────────────────────────────
test('configure: only the 422 naming its step is a refusal; a fault is `failed` with its status, never its body (PR #393 review)', async () => {
  const answering = (status: number, body: string): FollowConnection =>
    createFollowConnection({
      threadId: 't1',
      fetch: () => Promise.resolve(new Response(body, { status })),
      onProblem: () => undefined,
    })
  const refusal = JSON.stringify({ step: 'thinking', reason: 'thinking level high is not offered' })
  expect(await answering(422, refusal).configure({ thinking: 'high' })).toEqual({
    outcome: 'refused',
    step: 'thinking',
    reason: 'thinking level high is not offered',
  })
  // The fault text answers every route; shown as a reason it read "the session listing failed".
  expect(await answering(500, 'the request failed — see the server log').configure({ mode: 'plan' })).toEqual({
    outcome: 'failed',
    status: 500,
  })
  expect(await answering(400, 'configure body takes only …').configure({ mode: 'plan' })).toEqual({
    outcome: 'failed',
    status: 400,
  })
})

// ── the host-command route (#338 slice 2) — the mode route's shape, the mode route's failure path ──
test('runHostCommand is one JSON POST to …/command; told on 204; the store moves only when the feed says so', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  expect(await server.connection.runHostCommand({ name: 'thinking', value: 'high' })).toBe('told')
  expect(server.hostCommands).toEqual([{ name: 'thinking', value: 'high' }])
  expect(server.prompts).toEqual([])
  expect(server.modeChanges).toEqual([])
  expect(server.chunks.some((chunk) => chunk.type === EventType.CUSTOM && chunk.name === 'model')).toBe(false)
  server.frame({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'model',
      model: { provider: 'fake', id: 'one', name: 'Fake One' },
      thinkingLevel: 'high',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
  })
  await server.untilChunks(2)
  expect(server.chunks.at(-1)).toMatchObject({
    type: EventType.CUSTOM,
    name: 'model',
    value: { thinkingLevel: 'high' },
  })
  expect(server.problems).toEqual([])
  server.abort()
})

test('a refused host command names the outcome and is RECORDED — the same path a refused mode change takes (PR #344 review)', async () => {
  const busy = createScriptedFetch({
    commandStatus: 409,
    commandBody: 'thread t1 is running; change thinking when it settles',
  })
  const busyProblems: string[] = []
  const busyConnection = createFollowConnection({
    threadId: 't1',
    fetch: busy.fetch,
    onProblem: (reported: unknown) => busyProblems.push(String(reported)),
  })
  expect(await busyConnection.runHostCommand({ name: 'thinking', value: 'low' })).toBe('busy')
  expect(busyProblems).toEqual(['thread t1: /thinking busy: 409 thread t1 is running; change thinking when it settles'])
  const refused = createScriptedFetch({ commandStatus: 422, commandBody: 'model nope/x is not available here' })
  const refusedProblems: string[] = []
  const refusedConnection = createFollowConnection({
    threadId: 't1',
    fetch: refused.fetch,
    onProblem: (reported: unknown) => refusedProblems.push(String(reported)),
  })
  expect(await refusedConnection.runHostCommand({ name: 'model', value: 'nope/x' })).toBe('refused')
  expect(refusedProblems).toEqual(['thread t1: /model refused: 422 model nope/x is not available here'])
})

// @pins abort-clear-restore/settle-ends-run
test('abort is one POST to …/abort and names what the server did; it closes no run itself — the feed does (#116)', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, 'hello')
  await server.untilChunks(3)
  expect(await server.connection.abort()).toEqual({ outcome: 'aborted', restored: [] })
  expect(server.abortCount()).toBe(1)
  // Nothing closed here: the run ends when the server's settle arrives, like any run.
  expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false)
  server.frame({ type: 'observation', seq: 1, observation: { kind: 'settled' } })
  server.frame({ type: 'status', live: true, busy: false, generation: 1 })
  await server.untilChunks(5)
  expect(server.chunks).toContainEqual({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' })
  server.abort()

  expect(await scripted(undefined, 204, 409).connection.abort()).toEqual({ outcome: 'idle', restored: [] })
  const gone = scripted(undefined, 204, 404)
  expect(await gone.connection.abort()).toEqual({ outcome: 'gone', restored: [] })
  expect(gone.problems).toEqual([expect.stringContaining('abort gone: 404')])
})

// ── #75: prompts during a run go to pi's queue now; a stop hands them back ─────────────

const QUEUED_RECEIPT = { status: 202, body: { threadId: 't1', messageId: 'pm1', generation: 2, queued: true } }

test('⚠ prompt() during a run is one POST with admission enqueue, and opens no run of its own', async () => {
  const server = scripted(QUEUED_RECEIPT)
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 2 })
  await server.untilChunks(3) // the snapshot, then RUN_STARTED + TEXT_MESSAGE_START (another tab's run)
  const before = server.chunks.length
  expect(await server.connection.prompt('and then this')).toBe('queued')
  expect(server.prompts).toEqual([{ message: 'and then this', admission: 'enqueue' }])
  // No RUN_STARTED, no TEXT_MESSAGE_START: the run in flight is the one it queued behind.
  expect(server.chunks.length).toBe(before)
  server.abort()
})

test('prompt() names what the server did: taken when the run had ended, refused on a non-202 or a rejection, unreachable on no answer', async () => {
  const taken = scripted({ status: 202, body: { threadId: 't1', messageId: 'q1', generation: 3, queued: false } })
  expect(await taken.connection.prompt('late')).toBe('taken')
  taken.abort()
  const refused = scripted({ status: 400, body: 'message must be a string' })
  expect(await refused.connection.prompt('')).toBe('refused')
  expect(refused.problems).toEqual([expect.stringContaining('queued prompt refused: 400')])
  refused.abort()
  // pi's refusal can cross on the follow before the receipt names it.
  const early = scripted({ status: 202, body: { threadId: 't1', messageId: 'q2', generation: 1, queued: true } })
  early.frame(SNAPSHOT_IDLE)
  await early.untilChunks(1)
  early.frame({ type: 'observation', seq: 1, observation: { kind: 'prompt-rejected', messageId: 'q2', reason: 'no' } })
  await early.untilChunks(1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await early.connection.prompt('x')).toBe('refused')
  expect(early.problems).toEqual([expect.stringContaining('queued prompt refused: no')])
  early.abort()
  const problems: string[] = []
  const dead = createFollowConnection({
    threadId: 't1',
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    onProblem: (problem: unknown) => problems.push(String(problem)),
  })
  expect(await dead.prompt('x')).toBe('unreachable')
})

// @pins abort-clear-restore/queued-rejection-said
test('⚠ abort() hands back what pi had queued; a later rejection of a queued prompt is said, not matched to a run', async () => {
  const logs = await recordEnsoLogs()
  const server = scripted(QUEUED_RECEIPT, 204, 200, ['and then this', 'and this'])
  // The browser's side of `docs/flows/abort-clear-restore.md` (#482): queued, stopped, handed back.
  const trace = flowTrace({
    participants: {
      C: 'composer (the test)',
      U: 'TanStack (useChat)',
      A: 'adapter (follow-connection.ts)',
      S: 'server (scripted)',
    },
    categories: { 'enso.browser.follow': 'A' },
    logs,
  })
  server.traceInto(trace)
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 1 })
  await server.untilChunks(2)
  server.step('C', 'A', 'prompt("and then this"), during the run')
  const queued = await server.connection.prompt('and then this')
  trace.reply('A', 'C', queued)
  expect(queued).toBe('queued')
  server.step('C', 'A', 'abort()')
  const stopped = await server.connection.abort()
  trace.reply('A', 'C', `${stopped.outcome}, restored ${stopped.restored.length}`)
  expect(stopped).toEqual({ outcome: 'aborted', restored: ['and then this', 'and this'] })
  server.frame({
    type: 'observation',
    seq: 1,
    observation: { kind: 'prompt-rejected', messageId: 'pm1', reason: 'aborted' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(server.problems).toEqual([expect.stringContaining('queued prompt refused: aborted')])
  expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(false)
  expect(trace.diagram()).toMatchSnapshot('flow abort-clear-restore: the browser')
  server.abort()
  await releaseEnsoLogs()
})

test('⚠ when pi CLAIMS a queued prompt (a user message-start after an assistant one), the view ends the assistant bubble and opens a new one — the reply lands after its question', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, 'first')
  await server.untilChunks(3) // RUN_STARTED, TEXT_MESSAGE_START
  const firstMessageId = (server.chunks[2] as { messageId: string }).messageId
  // The run's OWN prompt: user message-start before any assistant one. Nothing rotates.
  server.frame({ type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'user', text: 'first' } })
  server.frame({ type: 'observation', seq: 2, observation: { kind: 'message-start', role: 'assistant' } })
  server.frame({ type: 'observation', seq: 3, observation: { kind: 'text-delta', contentIndex: 0, delta: 'one' } })
  await server.untilChunks(4)
  expect(server.chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1)
  // pi claims the queued follow-up: user message-start AFTER an assistant message.
  server.frame({ type: 'observation', seq: 4, observation: { kind: 'message-start', role: 'user', text: 'second' } })
  server.frame({ type: 'observation', seq: 5, observation: { kind: 'message-start', role: 'assistant' } })
  server.frame({ type: 'observation', seq: 6, observation: { kind: 'text-delta', contentIndex: 0, delta: 'two' } })
  await server.untilChunks(7)
  const starts = server.chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_START) as Array<{
    messageId: string
  }>
  expect(starts).toHaveLength(2)
  expect(server.chunks).toContainEqual({ type: EventType.TEXT_MESSAGE_END, messageId: firstMessageId })
  const secondMessageId = starts[1]?.messageId
  expect(secondMessageId).not.toBe(firstMessageId)
  // The second answer's text streams into the NEW message.
  const lastDelta = [...server.chunks].toReversed().find((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT) as {
    messageId: string
    delta: string
  }
  expect(lastDelta).toMatchObject({ messageId: secondMessageId, delta: 'two' })
  server.abort()
})

// PR #120 review: the callers fire-and-forget (`void connection.abort()`), so a network
// failure must be an OUTCOME the adapter reports, never a rejection that escapes them.
test('a unary POST that never gets an answer is `unreachable` — reported once, not thrown (#116); a RECORD and a NOTICE from one site (#132)', async () => {
  const logs = await recordEnsoLogs()
  try {
    const problems: string[] = []
    const connection = createFollowConnection({
      threadId: 't1',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      onProblem: (problem: unknown) => problems.push(String(problem)),
    })
    expect(await connection.abort()).toEqual({ outcome: 'unreachable', restored: [] })
    expect(await connection.answerDialog({ id: 'd1', value: 'a' })).toBe('unreachable')
    // The notice: the template rendered as a sentence, prefixed with the thread.
    expect(problems).toEqual([
      'thread t1: abort unreachable: TypeError: fetch failed',
      'thread t1: dialog d1 unreachable: TypeError: fetch failed',
    ])
    // The record: the event and its properties, under the browser's category, with the thread.
    logs.assertLogged({
      level: 'warning',
      category: ['enso', 'browser', 'follow'],
      rawMessage: '{what} unreachable: {error}',
      properties: { threadId: 't1', what: 'abort', error: 'TypeError: fetch failed' },
    })
    logs.assertLogged({
      level: 'warning',
      rawMessage: '{what} unreachable: {error}',
      properties: { what: 'dialog d1' },
    })
    expect(logs.records).toHaveLength(2)
  } finally {
    await releaseEnsoLogs()
  }
})

test('⚠ a blocking question crosses as its observation — no interrupt, no run boundary — and the answer is one POST', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, '/mode')
  await server.untilChunks(3)
  server.frame({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd1',
      method: 'select',
      blocking: true,
      origin: 'run',
      dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] },
    },
  })
  await server.untilChunks(4)
  expect(server.chunks[3]).toMatchObject({
    type: EventType.CUSTOM,
    name: 'extension-ui-request',
    value: { kind: 'extension-ui-request', id: 'd1', dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] } },
  })
  expect(await server.connection.answerDialog({ id: 'd1', value: 'a' })).toBe('answered')
  expect(server.dialogs).toEqual([{ id: 'd1', value: 'a' }])
  // The run is still open — nothing finished for the question.
  expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false)
  server.abort()
})

test("an unreadable blocking request is declined on pi's behalf and told to the user", async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, '/mode')
  await server.untilChunks(3)
  server.frame({
    type: 'observation',
    seq: 1,
    observation: { kind: 'extension-ui-request', id: 'd9', method: 'custom', blocking: true, origin: 'run' },
  })
  await server.untilChunks(4)
  expect(server.chunks[3]).toMatchObject({ type: EventType.RUN_ERROR, runId: 'r1' })
  // The decline is a real POST, awaited through the same seam.
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(server.dialogs).toEqual([{ id: 'd9', cancelled: true }])
  server.abort()
})

test('⚠ the follow closing under an open run is a run error, then the ending is said as a chunk — not when this page leaves', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  await send(server, 'hello')
  await server.untilChunks(3)
  server.closeFollow()
  await server.untilChunks(5)
  expect(server.chunks[3]).toMatchObject({
    type: EventType.RUN_ERROR,
    runId: 'r1',
    message: expect.stringContaining('closed'),
  })
  // #103 receipt, step 8: the server went away; the page is told even with no run open.
  expect(server.chunks[4]).toEqual({
    type: EventType.CUSTOM,
    name: FOLLOW_ENDED_CUSTOM_EVENT,
    value: { threadId: 't1' },
  })

  // This page leaving (abort) is not the server ending: no chunk.
  const leaving = scripted()
  leaving.frame(SNAPSHOT_IDLE)
  await leaving.untilChunks(1)
  leaving.abort()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(
    leaving.chunks.some((chunk) => chunk.type === EventType.CUSTOM && chunk.name === FOLLOW_ENDED_CUSTOM_EVENT),
  ).toBe(false)
})

// ⚠ PR #355 review: the schemas are closed, so a tab from another version fails EVERY frame of a
// changed kind — and a dropped snapshot applies nothing, leaving a pane that looks connected and
// is stale. So the notice names the fix (reload), comes once per connection however many frames
// fail, and keeps the frame out of the sentence (it is a whole transcript for a snapshot).
test('a frame that fails the wire schema is skipped, and the page is told ONCE to reload — never rendered', async () => {
  const server = scripted()
  server.frame({ type: 'status', live: true, busy: 'yes', generation: 1 } as unknown as EnsoFollowFrame)
  server.frame({ ...SNAPSHOT_IDLE, fromANewerServer: true } as unknown as EnsoFollowFrame)
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  expect(server.problems).toEqual([
    'thread t1: a frame from the server does not match this page — the page and the server are from different versions; reload the page',
  ])
  expect(server.chunks[0]).toMatchObject({ name: 'snapshot' })
  expect(server.chunks).toHaveLength(1)
  server.abort()
})

test('⚠ close() releases the follow and latches it: the page letting a thread go is not the server going away (#272)', async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  server.connection.close()
  // Latched: the thread's pane may remount, but a released connection opens no socket.
  const afterRelease: StreamChunk[] = []
  for await (const chunk of server.connection.subscribe()) afterRelease.push(chunk)
  expect(afterRelease).toEqual([])
  // ⚠ No `follow-ended`, no problem: `disconnected` states a server that dropped this page.
  expect(
    server.chunks.some((chunk) => chunk.type === EventType.CUSTOM && chunk.name === FOLLOW_ENDED_CUSTOM_EVENT),
  ).toBe(false)
  expect(server.problems).toEqual([])
})

// ── #274: the mirror of the case above — a follow that NEVER OPENED ───────────────────────
// The `disconnected` contract (#119) had exactly one arming path: a follow that opened and
// then ended. Measured before this: a 500 on `…/follow` threw out of `subscribe` having
// moved no store, so the page kept saying the thread was live — the composer took prompts,
// the stop button was offered for a run nothing could observe, the status bar said idle.
// ⚠ The chunk is YIELDED, not pushed: the queue is drained by a loop below the open, so a
// pushed chunk would be dropped by the throw that follows it.

/** One subscription over a fetch that fails, with the chunks and the failure it produced. */
async function subscribeOverFailingFetch(
  fetchImpl: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<{ chunks: StreamChunk[]; problems: string[]; failure: unknown }> {
  const problems: string[] = []
  const connection = createFollowConnection({
    threadId: 't1',
    fetch: fetchImpl,
    onProblem: (problem: unknown) => problems.push(String(problem)),
  })
  const chunks: StreamChunk[] = []
  let failure: unknown
  try {
    for await (const chunk of connection.subscribe(signal)) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  return { chunks, problems, failure }
}

test('⚠ a follow the server refuses arms the disconnected contract, like one that ends (#274)', async () => {
  const { chunks, problems, failure } = await subscribeOverFailingFetch(() =>
    Promise.resolve(new Response('upstream is down', { status: 500 })),
  )
  expect(chunks).toEqual([{ type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId: 't1' } }])
  expect(problems).toEqual([expect.stringContaining('the follow could not be opened')])
  // The failure still reaches the caller: the chunk says it to the page, the throw to TanStack.
  expect(String(failure)).toContain('500')
})

// ⚠ The status is the fact, the body is colour (PR #305 review): a refused response whose
// BODY read rejects — truncated, or aborted mid-read — must still arm the contract. Before
// the `.catch`, that rejection threw past the arming and left the page reading "live" for a
// follow the server had just refused, which is the state #274 exists to end.
test('a refusal whose body cannot be read still arms the contract (#274)', async () => {
  const unreadable = new ReadableStream<Uint8Array>({
    start: (controller: ReadableStreamDefaultController<Uint8Array>): void =>
      controller.error(new Error('the body died mid-read')),
  })
  const { chunks, problems, failure } = await subscribeOverFailingFetch(() =>
    Promise.resolve(new Response(unreadable, { status: 503 })),
  )
  expect(chunks).toEqual([{ type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId: 't1' } }])
  expect(problems).toEqual([expect.stringContaining('body unreadable')])
  // …and the caller still learns the status, which is the part that was never in doubt.
  expect(String(failure)).toContain('503')
})

test('a fetch that throws is the same fact, and this page leaving is not (#274)', async () => {
  const thrown = await subscribeOverFailingFetch(() => Promise.reject(new Error('network down')))
  expect(thrown.chunks).toEqual([
    { type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId: 't1' } },
  ])
  expect(thrown.problems).toEqual([expect.stringContaining('network down')])
  // Symmetrical with the 500 above (PR #305 review): the chunk says it to the page AND the
  // throw still reaches the caller. Asserting only the chunk would pass if the rethrow went.
  expect(String(thrown.failure)).toContain('network down')

  // ⚠ The asymmetry that must hold: an ABORT is this page releasing the thread, not the
  // server dropping it, so it arms nothing — the same rule `close()` follows above.
  const controller = new AbortController()
  controller.abort()
  const leaving = await subscribeOverFailingFetch(
    () => Promise.reject(new DOMException('aborted', 'AbortError')),
    controller.signal,
  )
  expect(leaving.chunks).toEqual([])
  expect(leaving.problems).toEqual([])
})

/** A follow whose open fails or whose stream is cut, as the browser does to both when the page leaves. */
async function followThatEnds(
  leaving: boolean,
  how: 'cut mid-stream' | 'refused open',
): Promise<{ problems: string[]; chunks: StreamChunk[] }> {
  const cut = new ReadableStream<Uint8Array>({
    start: (controller: ReadableStreamDefaultController<Uint8Array>): void =>
      controller.error(new TypeError('network error')),
  })
  const problems: string[] = []
  const connection = createFollowConnection({
    threadId: 't1',
    fetch: () =>
      how === 'cut mid-stream'
        ? Promise.resolve(new Response(cut, { status: 200 }))
        : Promise.reject(new TypeError('Failed to fetch')),
    onProblem: (problem: unknown) => problems.push(String(problem)),
    leaving: () => leaving,
  })
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of connection.subscribe()) chunks.push(chunk)
  } catch {
    // The end reaches the caller either way; what is said about it is the question.
  }
  return { problems, chunks }
}

const FOLLOW_ENDED_CHUNK: StreamChunk = {
  type: EventType.CUSTOM,
  name: FOLLOW_ENDED_CUSTOM_EVENT,
  value: { threadId: 't1' },
}

// ⚠ #664, from an arena run: every reload logged "the follow failed: TypeError: network error" —
// the browser cut the stream because the page was leaving, and nothing had aborted it.
test('⚠ a stream cut because the page is leaving is said nowhere; cut while the page stays, it is a failure (#664)', async () => {
  const staying = await followThatEnds(false, 'cut mid-stream')
  expect(staying.problems).toEqual([expect.stringContaining('the follow failed: TypeError: network error')])
  const leaving = await followThatEnds(true, 'cut mid-stream')
  expect(leaving.problems).toEqual([])
  // ⚠ PR #668 review, a decision pinned: the follow HAS ended either way, and is said so — a page
  // the back/forward cache restores must not look live over a dead follow (#274).
  expect(staying.chunks).toContainEqual(FOLLOW_ENDED_CHUNK)
  expect(leaving.chunks).toContainEqual(FOLLOW_ENDED_CHUNK)
})

test('an open the page cancels by leaving logs nothing, and still says the follow ended (#664)', async () => {
  const staying = await followThatEnds(false, 'refused open')
  expect(staying.problems).toEqual([expect.stringContaining('the follow could not be opened')])
  const leaving = await followThatEnds(true, 'refused open')
  expect(leaving.problems).toEqual([])
  expect(staying.chunks).toEqual([FOLLOW_ENDED_CHUNK])
  expect(leaving.chunks).toEqual([FOLLOW_ENDED_CHUNK])
})

test('the page is leaving from beforeunload or pagehide, and staying again once it is shown (#664)', () => {
  globalThis.dispatchEvent(new Event('pageshow'))
  expect(pageLeaving()).toBe(false)
  globalThis.dispatchEvent(new Event('beforeunload'))
  expect(pageLeaving()).toBe(true)
  globalThis.dispatchEvent(new Event('pageshow'))
  expect(pageLeaving()).toBe(false)
  globalThis.dispatchEvent(new Event('pagehide'))
  expect(pageLeaving()).toBe(true)
  globalThis.dispatchEvent(new Event('pageshow'))
  expect(pageLeaving()).toBe(false)
})

// ⚠ The race the latch does not cover (PR #301 review): released while the socket is still
// OPENING. The abort lands on the fetch itself, and its rejection had nowhere to go but out of
// the generator, at whoever is iterating — a thrown AbortError for the page's own silent close,
// which is exactly what `close()` promises not to produce. Eviction (`thread-stores.ts` drops
// the least recently active thread) closes connections at arbitrary moments, so this is the
// shape the budget makes ordinary rather than exotic.
test('close() during the opening fetch ends the subscription instead of throwing at the consumer (#272)', async () => {
  let socketOpening: (() => void) | undefined
  const opening = new Promise<void>((resolve) => {
    socketOpening = resolve
  })
  const connection = createFollowConnection({
    threadId: 't1',
    fetch: (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        socketOpening?.()
        // The socket never opens; the abort is what settles it, as a real fetch does.
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
  })
  const chunks: StreamChunk[] = []
  const drained = (async () => {
    for await (const chunk of connection.subscribe()) chunks.push(chunk)
  })()
  // Past the latch at the top of `subscribe`: the fetch is in flight, which is the race.
  await opening
  connection.close()
  await drained
  expect(chunks).toEqual([])
})
