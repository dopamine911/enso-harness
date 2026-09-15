import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { LogRecorder } from '@logtape/testing/recorder'
import { recordZenLogs, releaseZenLogs } from '@zen/core/log-recorder'
import type { HostedThread } from '../../host/agent-host.ts'
import { createThreadRegistry, type ThreadRegistry } from '../thread-registry.ts'
import { createFakeHostedThread, type FakeHostedThread, type FakeThreadParts, takeQueue } from './fake-hosted-thread.ts'

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordZenLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseZenLogs)

function ignore(): void {
  // The lifecycle tests never prompt, answer, or subscribe — only acquire/release/stop/dispose matter.
}

/** The one fake, plus the two knobs the lifecycle races need. */
interface FakeHosted extends FakeHostedThread {
  /** Set by a test to make the next `clearQueue` throw — pi emits to listeners inside it. */
  readonly failClear: { with: Error | undefined }
  /** Resolve the abort this fake left pending. */
  readonly finishAbort: () => void
}

/**
 * `abort` resolves only when the test says so — the disconnect-then-prompt race is about
 * the gap between abort and idle.
 */
function fakeHosted(): FakeHosted {
  const failClear = { with: undefined as Error | undefined }
  let finishAbort: () => void = ignore
  const fake = createFakeHostedThread({
    runtime: ({ record }: FakeThreadParts) => ({
      abort: () => {
        record.aborts += 1
        return new Promise<void>((resolve) => {
          finishAbort = resolve
        })
      },
      clearQueue: () => {
        record.queueClears += 1
        if (failClear.with !== undefined) throw failClear.with
        return takeQueue(record)
      },
    }),
  })
  return { ...fake, failClear, finishAbort: (): void => finishAbort() }
}

function fakeHost(): { threads: ThreadRegistry; built: FakeHosted[] } {
  const built: FakeHosted[] = []
  const threads = createThreadRegistry({
    createSession: () => {
      const next = fakeHosted()
      built.push(next)
      return Promise.resolve(next.hosted)
    },
    idleTimeoutMs: 20,
  })
  return { threads, built }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('the same thread acquired twice gets ONE session; two threads get two', async () => {
  const { threads, built } = fakeHost()
  const first = await threads.acquire('t1')
  const again = await threads.acquire('t1')
  expect(again.runtime).toBe(first.runtime)
  expect(built).toHaveLength(1)
  await threads.acquire('t2')
  expect(built).toHaveLength(2)
  expect(threads.liveThreadCount()).toBe(2)
})

test('two concurrent first requests on one thread share one build', async () => {
  const { threads, built } = fakeHost()
  const [first, second] = await Promise.all([threads.acquire('t1'), threads.acquire('t1')])
  expect(second.runtime).toBe(first.runtime)
  expect(built).toHaveLength(1)
})

test('release starts the idle clock; the session is disposed after the window, and a later acquire rebuilds', async () => {
  const { threads, built } = fakeHost()
  const lease = await threads.acquire('t1')
  lease.release()
  await sleep(5)
  expect(built[0]?.record.disposed).toBe(0)
  await sleep(30)
  expect(built[0]?.record.disposed).toBe(1)
  expect(threads.liveThreadCount()).toBe(0)
  // The disposal is a record that says why (#132) — the idle window, by its length.
  logs.assertLogged({
    level: 'info',
    rawMessage: 'thread disposed: {why}',
    properties: { threadId: 't1', generation: 1, why: '20ms idle' },
  })
  // The next acquire on that thread builds a fresh session.
  await threads.acquire('t1')
  expect(built).toHaveLength(2)
})

test("acquire within the idle window cancels the disposal — #43's fix in one assertion", async () => {
  const { threads, built } = fakeHost()
  const first = await threads.acquire('t1')
  first.release()
  await sleep(10)
  const second = await threads.acquire('t1')
  await sleep(30)
  expect(second.runtime).toBe(first.runtime)
  expect(built[0]?.record.disposed).toBe(0)
  expect(built).toHaveLength(1)
})

test('abort stops the run and never disposes; a repeat while it is pending is the same answer, not a second call; the next acquire waits for it (#116)', async () => {
  const { threads, built } = fakeHost()
  await threads.acquire('t1')
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  const hosted = built[0]
  if (hosted === undefined) throw new Error('no session built')
  expect(hosted.record.aborts).toBe(1)
  expect(hosted.record.disposed).toBe(0)
  // The double click (PR #120 review): busy until pi's settle, so only the in-flight abort tells.
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  expect(hosted.record.aborts).toBe(1)

  let acquired = false
  const pending = threads.acquire('t1').then(() => {
    acquired = true
  })
  await sleep(5)
  expect(acquired).toBe(false)
  hosted.finishAbort()
  await pending
  expect(acquired).toBe(true)
})

test('abort on an idle thread or an unknown one touches nothing, and says which (#116)', async () => {
  const { threads, built } = fakeHost()
  expect(threads.abort('never')).toEqual({ outcome: 'unknown', restored: [] })
  const lease = await threads.acquire('t1')
  lease.release()
  expect(threads.abort('t1')).toEqual({ outcome: 'idle', restored: [] })
  expect(built[0]?.record.aborts).toBe(0)
  expect(built[0]?.record.queueClears).toBe(0)
})

// #75, clear-and-restore: what waited behind the stopped run comes back, steering first, and
// pi's queue is emptied BEFORE pi is told — so nothing rides into the next prompt unasked.
test("⚠ abort hands back the queued prompts in order and clears pi's queue; a repeat restores nothing", async () => {
  const { threads, built } = fakeHost()
  await threads.acquire('t1')
  const hosted = built[0]
  if (hosted === undefined) throw new Error('no session built')
  hosted.record.queue.followUp.push('and then this', 'and this last')
  hosted.record.queue.steering.push('actually, stop at the tests')
  expect(threads.abort('t1')).toEqual({
    outcome: 'aborted',
    restored: ['actually, stop at the tests', 'and then this', 'and this last'],
  })
  expect(hosted.record.queueClears).toBe(1)
  expect(hosted.record.queue).toEqual({ steering: [], followUp: [] })
  // The stop is a record with the COUNT it handed back (#132) — never the texts.
  logs.assertLogged({
    level: 'info',
    rawMessage: /^run \{generation\} told to abort/,
    properties: { threadId: 't1', generation: 1, restored: 3 },
  })
  expect(JSON.stringify(logs.records.map((record) => record.properties))).not.toContain('stop at the tests')
  // The second click: same answer, the queue was already taken.
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  expect(hosted.record.queueClears).toBe(1)
})

test('⚠ a stop must stop: if clearing the queue throws, pi is still told to abort and the loss is said (PR #129 review)', async () => {
  const { threads, built } = fakeHost()
  await threads.acquire('t1')
  const hosted = built[0]
  if (hosted === undefined) throw new Error('no session built')
  hosted.record.queue.followUp.push('would have been restored')
  hosted.failClear.with = new Error('a queue listener threw')
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  expect(hosted.record.aborts).toBe(1)
  logs.assertLogged({
    level: 'error',
    rawMessage: 'clearing the queue failed, queued prompts lost: {error}',
    properties: (properties: Readonly<Record<string, unknown>>) =>
      properties.threadId === 't1' && String(properties.error).includes('a queue listener threw'),
  })
})

// ── the lease fence (#109) ─────────────────────────────────────────────────────
// The displaced-park case: run A parks a dialog, run B takes the same thread, and A's late
// release lands ten minutes later. Addressed by thread id, it released B. (A's late STOP was the
// other half; since #116 abort is the operator's, by thread, on purpose — see below.)

test('⚠ a lease superseded by a later acquire is stale: its release touches nothing, and says so', async () => {
  const { threads, built } = fakeHost()
  const first = await threads.acquire('t1')
  const second = await threads.acquire('t1')
  expect(second.generation).toBe(first.generation + 1)

  first.release()
  expect(threads.peek('t1')?.busy).toBe(true)
  logs.assertLogged({
    level: 'warning',
    rawMessage: '{operation} from run {generation} ignored: {because}',
    properties: {
      threadId: 't1',
      generation: first.generation,
      operation: 'release',
      because: `run ${second.generation} holds it now`,
    },
  })

  // An operator's abort is by thread, not by lease: it stops whatever runs NOW (#116).
  expect(threads.abort('t1').outcome).toBe('aborted')
  expect(built[0]?.record.aborts).toBe(1)
})

test('⚠ a lease from before a rebuild is stale, and the rebuilt thread continues the count', async () => {
  const { threads, built } = fakeHost()
  const before = await threads.acquire('t1')
  before.release()
  await sleep(30) // idle window: disposed
  expect(threads.liveThreadCount()).toBe(0)
  before.release()
  logs.assertLogged({
    level: 'warning',
    properties: { threadId: 't1', operation: 'release', because: 'the thread was disposed' },
  })

  const after = await threads.acquire('t1')
  expect(after.generation).toBe(before.generation + 1)
  expect(built).toHaveLength(2)
  expect(threads.peek('t1')?.generation).toBe(after.generation)
})

test('a failed build leaves no entry, so the next request retries', async () => {
  let attempts = 0
  const threads = createThreadRegistry({
    createSession: () => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('loader exploded'))
      return Promise.resolve(fakeHosted().hosted)
    },
    idleTimeoutMs: 20,
  })
  await expect(threads.acquire('t1')).rejects.toThrow('loader exploded')
  expect(threads.liveThreadCount()).toBe(0)
  await threads.acquire('t1')
  expect(attempts).toBe(2)
  expect(threads.liveThreadCount()).toBe(1)
})

test('shutdown disposes every live session and clears pending idle timers', async () => {
  const { threads, built } = fakeHost()
  const t1 = await threads.acquire('t1')
  await threads.acquire('t2')
  t1.release()
  threads.shutdown()
  expect(built.map((hosted) => hosted.record.disposed)).toEqual([1, 1])
  expect(threads.liveThreadCount()).toBe(0)
  await sleep(30)
  // The idle timer for t1 must not fire a second dispose.
  expect(built[0]?.record.disposed).toBe(1)
})

test('⚠ a build in flight at shutdown is disposed on arrival, never published; a later acquire is refused', async () => {
  let finishBuild: () => void = ignore
  const hosted = fakeHosted()
  const threads = createThreadRegistry({
    createSession: () =>
      new Promise<HostedThread>((resolve) => {
        finishBuild = () => resolve(hosted.hosted)
      }),
    idleTimeoutMs: 20,
  })
  const pending = threads.acquire('t1')
  await sleep(1)
  threads.shutdown()
  finishBuild()
  await expect(pending).rejects.toThrow('shut down while its session was being built')
  expect(hosted.record.disposed).toBe(1)
  expect(threads.liveThreadCount()).toBe(0)
  await expect(threads.acquire('t2')).rejects.toThrow('has shut down')
})

test('a dispose that throws is reported, not thrown', async () => {
  const broken = fakeHosted()
  broken.hosted.runtime.dispose = (): void => {
    throw new Error('already gone')
  }
  const threads = createThreadRegistry({
    createSession: () => Promise.resolve(broken.hosted),
    idleTimeoutMs: 20,
  })
  await threads.acquire('t1')
  threads.shutdown()
  expect(logs.filter({ level: 'error' })).toHaveLength(1)
  logs.assertLogged({
    level: 'error',
    rawMessage: 'dispose after {why} failed: {error}',
    properties: (properties: Readonly<Record<string, unknown>>) =>
      properties.threadId === 't1' &&
      properties.why === 'server shutdown' &&
      String(properties.error).includes('already gone'),
  })
})
