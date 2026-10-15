import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoObservation } from '@enso/core'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/test-support/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import { ChatClient, type UIMessage } from '@tanstack/ai-client'
import { routeEnsoCustomEvent } from '../../custom-event-router.ts'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../../thread-stores.ts'
import { startEnsoServer } from '../index.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * A page following a run, end to end (#915): the real follow route over a real socket, read by the
 * page's own follow adapter and applied by TanStack's real chat client with the page's own router —
 * the path a tab stopped on, silently, after a 68 KB `write`, while the run went on for 20 minutes.
 *
 * Only the runtime is scripted (`fake-hosted-thread.ts`): each test emits the observations a run
 * produces and waits for what the page shows. Every wait is a condition the chat client or the
 * page's stores announce, never a guessed delay; a page that stops updating fails on the test's
 * timeout, naming what never arrived.
 */

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordEnsoLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseEnsoLogs)

const servers: Array<{ close: () => Promise<void> }> = []
const clients: ChatClient[] = []
/** Each test's temporary directories: the harness, the agent's and the logs'. */
const scratch: string[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  clearThreadsForTest()
  for (const server of servers.splice(0)) await server.close()
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(directory)
  return directory
}

/** The scripted runtime's `emit`, and the server the page follows. */
interface Served {
  readonly url: string
  readonly emit: (observation: EnsoObservation) => void
  /** Resolves once the runtime has been handed the run's prompt. */
  readonly prompted: Promise<void>
}

async function serve(): Promise<Served> {
  let emit: (observation: EnsoObservation) => void = () => undefined
  const prompted = Promise.withResolvers<void>()
  const host = createFakeAgentHost(() => {
    const fake = createFakeHostedThread({ runtime: () => ({ prompt: () => prompted.resolve() }) })
    emit = fake.emit
    return Promise.resolve(fake.hosted)
  })
  const harness = scratchDirectory('enso-follow-page-harness-')
  writeFileSync(join(harness, 'package.json'), JSON.stringify({ name: 'fake-harness', pi: {} }))
  const started = startEnsoServer({
    cwd: tmpdir(),
    harnessPackageDir: harness,
    agentDir: scratchDirectory('enso-follow-page-agent-'),
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: scratchDirectory('enso-follow-page-logs-'),
    port: 0,
    host: () => host,
  })
  servers.push(started)
  const url = await started.listening
  return { url, emit: (observation) => emit(observation), prompted: prompted.promise }
}

/** What the page's `fetch` did with its follow: whether it has let the socket go. */
interface FollowSocket {
  closed: boolean
}

/**
 * The page: a thread's stores over the server (`mintThread`, as New thread makes one), and the chat
 * client a pane builds over them (`thread-pane.tsx#threadChatOptions`). `onCustomEvent` is the
 * router, unless a test puts something in front of it. Every state change re-checks the waits.
 */
interface Page {
  readonly stores: ThreadStores
  readonly client: ChatClient
  readonly socket: FollowSocket
  /** Resolves once `holds` reads true off the page; the test's timeout reports one that never does. */
  readonly until: (holds: () => boolean) => Promise<void>
}

function openPage(
  served: Served,
  onCustomEvent: (stores: ThreadStores, name: string, value: unknown) => void = routeEnsoCustomEvent,
): Page {
  const socket: FollowSocket = { closed: false }
  const toServer = async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(new URL(input, served.url), init)
    if (!input.endsWith('/follow') || response.body === null) return response
    const upstream = response.body.getReader()
    // The follow's body, passed through, so the test sees the page let go of it: a cancel, or the
    // abort that fails the read.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await upstream.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          socket.closed = true
          controller.error(error)
        }
      },
      cancel(reason) {
        socket.closed = true
        return upstream.cancel(reason)
      },
    })
    return new Response(body, { status: response.status, headers: response.headers })
  }
  const stores = mintThread(toServer)
  const checks = new Set<() => void>()
  const recheck = (): void => {
    for (const check of checks) check()
  }
  stores.notifications.subscribe(recheck)
  const client = new ChatClient({
    threadId: stores.threadId,
    connection: stores.connection,
    onCustomEvent: (name: string, value: unknown) => onCustomEvent(stores, name, value),
    onMessagesChange: recheck,
    onSessionGeneratingChange: recheck,
    onConnectionStatusChange: recheck,
    onErrorChange: recheck,
  })
  clients.push(client)
  client.subscribe()
  return {
    stores,
    client,
    socket,
    until: (holds: () => boolean) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      const check = (): void => {
        if (!holds()) return
        checks.delete(check)
        resolve()
      }
      checks.add(check)
      check()
      return promise
    },
  }
}

/** The page's transcript as a reader would list it: each part of each message, by what it is. */
function transcript(page: Page): string[] {
  return page.client.getMessages().flatMap((message: UIMessage) =>
    message.parts.map((part) => {
      if (part.type === 'text') return `${message.role}: ${part.content}`
      if (part.type === 'tool-call') return `tool ${part.name} ${part.output === undefined ? 'running' : 'done'}`
      return part.type
    }),
  )
}

/** What the page warned about: its warnings and errors, not the run's own info lines (`Mode: default`). */
const notices = (page: Page): string[] =>
  page.stores.notifications
    .get()
    .filter((line) => line.notifyType === 'warning' || line.notifyType === 'error')
    .map((line) => line.message)

/** A file the size of the incident's `arcade.html` (68 KB), with quotes, newlines and non-ASCII. */
const ARCADE = Array.from(
  { length: 1400 },
  (_unused, line) => `  ctx.fillText("score ✓ ${line}", ${line % 320}, 8) // «game ${line % 5}»\n`,
).join('')

/** pi's `input_json_delta` size in the incident: how many characters of the arguments one delta carries. */
const ARGUMENT_DELTA_CHARACTERS = 14

/** pi's streamed arguments, as the follow carries them: one `toolcall_delta` per few characters. */
function composedArguments(args: Record<string, unknown>): EnsoObservation[] {
  const json = JSON.stringify(args)
  const deltas: EnsoObservation[] = []
  for (let at = 0; at < json.length; at += ARGUMENT_DELTA_CHARACTERS) {
    deltas.push({
      kind: 'unmapped',
      event: {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 1,
          delta: json.slice(at, at + ARGUMENT_DELTA_CHARACTERS),
        },
      },
    })
  }
  return deltas
}

/** One model turn that composes a tool call over the follow, then runs it. */
function composedTurn(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  said: string,
): EnsoObservation[] {
  return [
    { kind: 'turn-start' },
    { kind: 'message-start', role: 'assistant' },
    { kind: 'text-delta', contentIndex: 0, delta: said },
    {
      kind: 'unmapped',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: toolCallId, toolName },
      },
    },
    ...composedArguments(args),
    { kind: 'message-end', role: 'assistant', usage: { input: 2, output: 18_000, cacheRead: 0, cacheWrite: 0 } },
    { kind: 'tool-call', toolCallId, toolName, args },
    { kind: 'tool-result', toolCallId, toolName, text: `${toolName} done`, complete: true, isError: false },
    { kind: 'turn-end', toolResults: 1 },
    { kind: 'session-usage', cost: 1, input: 2, output: 18_000, cacheRead: 0, cacheWrite: 0, context: null },
  ]
}

/** The page sends its prompt; resolves once the runtime has it and the page shows a run going. */
async function startRun(served: Served, page: Page): Promise<void> {
  await page.until(() => page.client.getConnectionStatus() === 'connected')
  void page.client.sendMessage('build the arcade in one html file')
  await served.prompted
  await page.until(() => page.client.getSessionGenerating())
}

test('⚠ a page following a run that composes a 70 KB tool call keeps updating through it and after it (#915)', async () => {
  const served = await serve()
  const page = openPage(served)
  await startRun(served, page)

  // The incident's shape: a 68 KB `write` composed as thousands of argument deltas, then the next
  // turn's `edit` and a closing line — the turns the frozen tab never showed.
  for (const observation of composedTurn(
    'call-write',
    'write',
    { path: 'arcade.html', content: ARCADE },
    'Writing it.',
  )) {
    served.emit(observation)
  }
  const edit = { path: 'arcade.html', edits: [{ oldText: 'score', newText: 'Score' }] }
  for (const observation of composedTurn('call-edit', 'edit', edit, 'Cleaning up one line.')) served.emit(observation)
  served.emit({ kind: 'turn-start' })
  served.emit({ kind: 'message-start', role: 'assistant' })
  served.emit({ kind: 'text-delta', contentIndex: 0, delta: 'The arcade is written.' })
  served.emit({ kind: 'settled', aborted: false })

  await page.until(
    () => !page.client.getSessionGenerating() && transcript(page).includes('assistant: The arcade is written.'),
  )
  expect(transcript(page)).toEqual([
    'user: build the arcade in one html file',
    'assistant: Writing it.',
    'tool write done',
    'tool-result',
    'assistant: Cleaning up one line.',
    'tool edit done',
    'tool-result',
    'assistant: The arcade is written.',
  ])
  // The whole file arrived as the call's input, not a truncated prefix.
  const write = page.client
    .getMessages()
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool-call' && part.name === 'write')
  expect(write?.type === 'tool-call' ? JSON.parse(write.arguments) : undefined).toEqual({
    path: 'arcade.html',
    content: ARCADE,
  })
  expect(page.stores.usage.get()?.output).toBe(18_000)
  expect(notices(page)).toEqual([])
  expect(page.client.getConnectionStatus()).toBe('connected')
})

test("⚠ a page that fails handling a chunk mid-run says it stopped and on which chunk, lets the follow go, and TanStack's error carries the exception (#915)", async () => {
  const served = await serve()
  let failed = false
  // A handler that throws once, on the usage after the write — as any of a page's chunk handlers
  // might: a store, a React update, the stream processor.
  const page = openPage(served, (stores, name, value) => {
    if (name === 'session-usage' && !failed) {
      failed = true
      throw new Error('a handler failed')
    }
    routeEnsoCustomEvent(stores, name, value)
  })
  await startRun(served, page)

  for (const observation of composedTurn(
    'call-write',
    'write',
    { path: 'arcade.html', content: ARCADE },
    'Writing it.',
  )) {
    served.emit(observation)
  }
  const edit = { path: 'arcade.html', edits: [{ oldText: 'score', newText: 'Score' }] }
  for (const observation of composedTurn('call-edit', 'edit', edit, 'Cleaning up one line.')) served.emit(observation)

  // Before #915 nothing below ever arrived: the page kept reading the follow and applied nothing more.
  await page.until(
    () => notices(page).length > 0 && page.client.getConnectionStatus() === 'error' && page.socket.closed,
  )
  expect(notices(page)).toEqual([
    `thread ${page.stores.threadId}: this page stopped applying the thread's updates: handling a session-usage chunk failed. What it shows is as of then, and the thread may have moved on — reload the page to catch up`,
  ])
  expect(page.client.getError()?.message).toBe('a handler failed')
  // The record says why, with the thread, for a bundle to find.
  const stopped = logs.filter({ category: ['enso', 'browser', 'follow'], rawMessage: /stopped applying/ })
  expect(stopped.map((record) => ({ level: record.level, properties: record.properties }))).toEqual([
    { level: 'warning', properties: { threadId: page.stores.threadId, chunk: 'session-usage' } },
  ])
  // What came after the failure was never applied: the transcript stops where the page did.
  expect(transcript(page)).not.toContain('assistant: Cleaning up one line.')
})
