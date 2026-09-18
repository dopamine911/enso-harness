import { expect, test } from 'bun:test'
import { EventType } from '@ag-ui/core'
import type { StreamChunk } from '@tanstack/ai'
import type { ZenFollowFrame } from '@zen/core'
import { recordZenLogs, releaseZenLogs } from '@zen/core/log-recorder'
import { FOLLOW_ENDED_CUSTOM_EVENT } from '../custom-event-router.ts'
import { createFollowConnection, type FollowConnection } from '../follow-connection.ts'
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
  const connection = createFollowConnection({
    threadId: 't1',
    fetch: server.fetch,
    onProblem: (problem: unknown) => problems.push(String(problem)),
  })
  const chunks: StreamChunk[] = []
  const waiters: Array<() => void> = []
  const controller = new AbortController()
  void (async () => {
    for await (const chunk of connection.subscribe(controller.signal)) {
      chunks.push(chunk)
      for (const waiter of waiters.splice(0)) waiter()
    }
    for (const waiter of waiters.splice(0)) waiter()
  })()
  return {
    ...server,
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
  }
}

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

test('prompt() during a run carries the images beside the text, as a followUp (#68, #75)', async () => {
  const server = scripted(QUEUED_RECEIPT)
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 2 })
  await server.untilChunks(3)
  expect(await server.connection.prompt('and this', [{ mimeType: 'image/png' as const, data: PNG_BYTES }])).toBe(
    'queued',
  )
  expect(server.prompts).toEqual([
    { message: 'and this', streamingBehavior: 'followUp', images: [{ mimeType: 'image/png', data: PNG_BYTES }] },
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

test("send opens TanStack's own run at admission; the thread's settle closes it", async () => {
  const server = scripted()
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)

  await send(server, 'hello')
  expect(server.prompts).toEqual([{ message: 'hello' }])
  await server.untilChunks(3)
  expect(server.chunks.slice(1)).toEqual([
    { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
    { type: EventType.TEXT_MESSAGE_START, messageId: expect.any(String), role: 'assistant' },
  ])
  const opened = server.chunks[2]
  const messageId = opened !== undefined && 'messageId' in opened ? String(opened.messageId) : ''

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
  server.abort()
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

test('⚠ prompt() during a run is one POST with streamingBehavior followUp, and opens no run of its own', async () => {
  const server = scripted(QUEUED_RECEIPT)
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 2 })
  await server.untilChunks(3) // the snapshot, then RUN_STARTED + TEXT_MESSAGE_START (another tab's run)
  const before = server.chunks.length
  expect(await server.connection.prompt('and then this')).toBe('queued')
  expect(server.prompts).toEqual([{ message: 'and then this', streamingBehavior: 'followUp' }])
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
    fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    onProblem: (problem: unknown) => problems.push(String(problem)),
  })
  expect(await dead.prompt('x')).toBe('unreachable')
})

test('⚠ abort() hands back what pi had queued; a later rejection of a queued prompt is said, not matched to a run', async () => {
  const server = scripted(QUEUED_RECEIPT, 204, 200, ['and then this', 'and this'])
  server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 1 })
  await server.untilChunks(2)
  expect(await server.connection.prompt('and then this')).toBe('queued')
  expect(await server.connection.abort()).toEqual({ outcome: 'aborted', restored: ['and then this', 'and this'] })
  server.frame({
    type: 'observation',
    seq: 1,
    observation: { kind: 'prompt-rejected', messageId: 'pm1', reason: 'aborted' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(server.problems).toEqual([expect.stringContaining('queued prompt refused: aborted')])
  expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(false)
  server.abort()
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
  const lastDelta = [...server.chunks].reverse().find((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT) as {
    messageId: string
    delta: string
  }
  expect(lastDelta).toMatchObject({ messageId: secondMessageId, delta: 'two' })
  server.abort()
})

// PR #120 review: the callers fire-and-forget (`void connection.abort()`), so a network
// failure must be an OUTCOME the adapter reports, never a rejection that escapes them.
test('a unary POST that never gets an answer is `unreachable` — reported once, not thrown (#116); a RECORD and a NOTICE from one site (#132)', async () => {
  const logs = await recordZenLogs()
  try {
    const problems: string[] = []
    const connection = createFollowConnection({
      threadId: 't1',
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
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
      category: ['zen', 'browser', 'follow'],
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
    await releaseZenLogs()
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

test('a frame that fails the wire schema is reported and skipped, never rendered', async () => {
  const server = scripted()
  server.frame({ type: 'status', live: true, busy: 'yes', generation: 1 } as unknown as ZenFollowFrame)
  server.frame(SNAPSHOT_IDLE)
  await server.untilChunks(1)
  expect(server.problems).toEqual([expect.stringContaining('fails ZenFollowFrame')])
  expect(server.chunks[0]).toMatchObject({ name: 'snapshot' })
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
    fetch: fetchImpl as unknown as typeof fetch,
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

test('a fetch that throws is the same fact, and this page leaving is not (#274)', async () => {
  const thrown = await subscribeOverFailingFetch(() => Promise.reject(new Error('network down')))
  expect(thrown.chunks).toEqual([
    { type: EventType.CUSTOM, name: FOLLOW_ENDED_CUSTOM_EVENT, value: { threadId: 't1' } },
  ])
  expect(thrown.problems).toEqual([expect.stringContaining('network down')])

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
