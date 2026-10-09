import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import type { HostedThread } from '../../host/hosted-thread.ts'
import {
  createThreadRegistry,
  type ScheduleIdleDisposal,
  type ThreadLease,
  type ThreadRegistry,
} from '../thread-registry.ts'
import { createFakeHostedThread, type FakeHostedThread, type FakeThreadParts, takeQueue } from './fake-hosted-thread.ts'

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordEnsoLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseEnsoLogs)

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

/**
 * The registry's idle clock, advanced by hand (#235).
 *
 * ⚠ The idle-window tests assert a NEGATIVE — "the disposal has not fired yet". Against wall
 * time that was a 5–15 ms margin on a 20 ms timer: it passed here and would lose the race on a
 * loaded runner, reporting the #43 regression as broken when it is not. Advancing the clock by
 * hand makes both halves facts, and pins the WINDOW itself: measured 2026-09-18, a registry
 * that disposed 5 ms early passed all 14 wall-clock tests five times over.
 */
interface ManualIdleClock {
  /** The seam the registry is built with. */
  schedule: ScheduleIdleDisposal
  /** Let `ms` of the registry's idle time pass, firing whatever fell due. */
  advance: (ms: number) => void
  /** How many disposals are armed — 0 once they are cancelled or fired. */
  pending: () => number
}

function manualIdleClock(): ManualIdleClock {
  let elapsedMs = 0
  let scheduled: { dueAtMs: number; dispose: () => void }[] = []
  return {
    schedule: (dispose: () => void, afterMs: number) => {
      const entry = { dueAtMs: elapsedMs + afterMs, dispose }
      scheduled.push(entry)
      return {
        cancel: (): void => {
          scheduled = scheduled.filter((other) => other !== entry)
        },
      }
    },
    advance: (ms: number): void => {
      elapsedMs += ms
      const due = scheduled.filter((entry) => entry.dueAtMs <= elapsedMs)
      scheduled = scheduled.filter((entry) => entry.dueAtMs > elapsedMs)
      for (const entry of due) entry.dispose()
    },
    pending: (): number => scheduled.length,
  }
}

function fakeHost(): { threads: ThreadRegistry; built: FakeHosted[]; clock: ManualIdleClock } {
  const built: FakeHosted[] = []
  const clock = manualIdleClock()
  const threads = createThreadRegistry({
    createSession: () => {
      const next = fakeHosted()
      built.push(next)
      return Promise.resolve(next.hosted)
    },
    idleTimeoutMs: 20,
    scheduleIdleDisposal: clock.schedule,
  })
  return { threads, built, clock }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A lease the test expects to get; `'busy'` fails the test by name. */
async function take(threads: ThreadRegistry, threadId: string): Promise<ThreadLease> {
  const lease = await threads.acquire(threadId)
  if (lease === 'busy') throw new Error(`${threadId} was busy`)
  return lease
}

test('the same thread acquired again gets ONE session; two threads get two', async () => {
  const { threads, built } = fakeHost()
  const first = await take(threads, 't1')
  first.release()
  const again = await take(threads, 't1')
  expect(again.runtime).toBe(first.runtime)
  expect(built).toHaveLength(1)
  await threads.acquire('t2')
  expect(built).toHaveLength(2)
  expect(threads.liveThreadCount()).toBe(2)
})

// #444, PR #438 review: two requests on a cold thread both passed the route's busy peek and both
// got leases; the newer one's refusal released the thread under the older one's run.
test('⚠ two concurrent first requests on one thread share one build, and only one takes it: the other is told busy', async () => {
  const { threads, built } = fakeHost()
  const [first, second] = await Promise.all([threads.acquire('t1'), threads.acquire('t1')])
  expect(built).toHaveLength(1)
  expect([first, second].filter((taken) => taken === 'busy')).toHaveLength(1)
  expect(threads.peek('t1')).toMatchObject({ busy: true, generation: 1 })
})

test('a held thread is refused, not taken again; released, it is taken by the next acquire', async () => {
  const { threads } = fakeHost()
  const held = await take(threads, 't1')
  expect(await threads.acquire('t1')).toBe('busy')
  expect(threads.peek('t1')?.generation).toBe(held.generation)
  held.release()
  expect((await take(threads, 't1')).generation).toBe(held.generation + 1)
})

test('release starts the idle clock; the session is disposed after the window, and a later acquire rebuilds', async () => {
  const { threads, built, clock } = fakeHost()
  const lease = await take(threads, 't1')
  lease.release()
  // One millisecond short of the window, and then on it: the edge itself, not a margin.
  clock.advance(19)
  expect(built[0]?.record.disposed).toBe(0)
  clock.advance(1)
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
  const { threads, built, clock } = fakeHost()
  const first = await take(threads, 't1')
  first.release()
  clock.advance(19)
  const second = await take(threads, 't1')
  // Cancelled, not deferred: nothing is armed, so no amount of idle time disposes it.
  expect(clock.pending()).toBe(0)
  clock.advance(1000)
  expect(second.runtime).toBe(first.runtime)
  expect(built[0]?.record.disposed).toBe(0)
  expect(built).toHaveLength(1)
})

// @pins abort-clear-restore/one-abort-by-thread abort-clear-restore/settle-ends-run
test('abort stops the run and never disposes; a repeat while it is pending is the same answer, not a second call; the next acquire waits for it (#116)', async () => {
  const { threads, built } = fakeHost()
  const run = await take(threads, 't1')
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  const hosted = built[0]
  if (hosted === undefined) throw new Error('no session built')
  expect(hosted.record.aborts).toBe(1)
  expect(hosted.record.disposed).toBe(0)
  // The double click (PR #120 review): busy until pi's settle, so only the in-flight abort tells.
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  expect(hosted.record.aborts).toBe(1)

  // The run's settle released it; pi's abort has not resolved yet.
  run.release()
  let acquired = false
  const pending = take(threads, 't1').then(() => {
    acquired = true
  })
  // No timer is in play here: nothing but `finishAbort` can resolve that acquire, so one turn of
  // the microtask queue is the whole wait — there is no margin to lose.
  await Promise.resolve()
  expect(acquired).toBe(false)
  hosted.finishAbort()
  await pending
  expect(acquired).toBe(true)
})

// @pins abort-clear-restore/one-abort-by-thread
test('abort on an idle thread or an unknown one touches nothing, and says which (#116)', async () => {
  const { threads, built } = fakeHost()
  expect(threads.abort('never')).toEqual({ outcome: 'unknown', restored: [] })
  const lease = await take(threads, 't1')
  lease.release()
  expect(threads.abort('t1')).toEqual({ outcome: 'idle', restored: [] })
  expect(built[0]?.record.aborts).toBe(0)
  expect(built[0]?.record.queueClears).toBe(0)
})

// #75, clear-and-restore: what waited behind the stopped run comes back, interrupting first, and
// pi's queue is emptied BEFORE pi is told — so nothing rides into the next prompt unasked.
// @pins abort-clear-restore/queue-cleared-first abort-clear-restore/one-abort-by-thread
test("⚠ abort hands back the queued prompts in order and clears pi's queue; a repeat restores nothing", async () => {
  const { threads, built } = fakeHost()
  await threads.acquire('t1')
  const hosted = built[0]
  if (hosted === undefined) throw new Error('no session built')
  hosted.record.queue.enqueued.push('and then this', 'and this last')
  hosted.record.queue.interrupting.push('actually, stop at the tests')
  expect(threads.abort('t1')).toEqual({
    outcome: 'aborted',
    restored: ['actually, stop at the tests', 'and then this', 'and this last'],
  })
  expect(hosted.record.queueClears).toBe(1)
  expect(hosted.record.queue).toEqual({ interrupting: [], enqueued: [] })
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

// @pins abort-clear-restore/stop-must-stop
test('⚠ a stop must stop: if clearing the queue throws, pi is still told to abort and the loss is said (PR #129 review)', async () => {
  const { threads, built } = fakeHost()
  await threads.acquire('t1')
  const hosted = built[0]
  if (hosted === undefined) throw new Error('no session built')
  hosted.record.queue.enqueued.push('would have been restored')
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
  const first = await take(threads, 't1')
  first.release()
  const second = await take(threads, 't1')
  expect(second.generation).toBe(first.generation + 1)

  // A's late release — a parked dialog's, ten minutes on — while B holds the thread.
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
  const { threads, built, clock } = fakeHost()
  const before = await take(threads, 't1')
  before.release()
  clock.advance(20) // the idle window: disposed
  expect(threads.liveThreadCount()).toBe(0)
  before.release()
  logs.assertLogged({
    level: 'warning',
    properties: { threadId: 't1', operation: 'release', because: 'the thread was disposed' },
  })

  const after = await take(threads, 't1')
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
  const { threads, built, clock } = fakeHost()
  const t1 = await take(threads, 't1')
  await threads.acquire('t2')
  t1.release()
  expect(clock.pending()).toBe(1)
  threads.shutdown()
  expect(built.map((hosted) => hosted.record.disposed)).toEqual([1, 1])
  expect(threads.liveThreadCount()).toBe(0)
  // The idle timer for t1 was cleared, so it cannot fire a second dispose — ever, not just soon.
  expect(clock.pending()).toBe(0)
  clock.advance(1000)
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

// ⚠ #390: a person's explicit ask (the `/` palette, the model picker, a typed command) builds the
// thread's session, but it is NOT a run: no generation counted, not busy, and a session nobody
// prompts idles out like a released one. A later run reuses what the ask built.
test('⚠ ensure builds a session without taking a run; it idles out, and a later acquire reuses it (#390)', async () => {
  const { threads, built, clock } = fakeHost()
  const view = await threads.ensure('t1')
  expect(built).toHaveLength(1)
  expect(view).toMatchObject({ threadId: 't1', busy: false, generation: 0 })
  clock.advance(19)
  const lease = await take(threads, 't1')
  expect(lease.runtime).toBe(view.hosted.runtime)
  expect(lease.generation).toBe(1)
  expect(built).toHaveLength(1)
  lease.release()

  const { threads: other, built: otherBuilt, clock: otherClock } = fakeHost()
  await other.ensure('t2')
  otherClock.advance(19)
  expect(otherBuilt[0]?.record.disposed).toBe(0)
  otherClock.advance(1)
  expect(otherBuilt[0]?.record.disposed).toBe(1)
  expect(other.liveThreadCount()).toBe(0)
})

// ⚠ Opening the palette while a run is stopping must answer at once: `ensure` never waits on the
// run's abort, never marks the thread busy, never counts a generation, never arms the idle clock
// under a held lease. An `ensure` that waited would hang here — nothing finishes the abort.
test('⚠ ensure on a live thread whose run is stopping answers at once and touches nothing (#390)', async () => {
  const { threads, clock } = fakeHost()
  await threads.acquire('t1')
  expect(threads.abort('t1')).toEqual({ outcome: 'aborted', restored: [] })
  const view = await threads.ensure('t1')
  expect(view).toMatchObject({ busy: true, generation: 1 })
  expect(clock.pending()).toBe(0)
})

test('an ask and a run arriving together share ONE build, and the run holds it (#390)', async () => {
  const { threads, built, clock } = fakeHost()
  const [view, lease] = await Promise.all([threads.ensure('t1'), take(threads, 't1')])
  expect(built).toHaveLength(1)
  expect(lease.runtime).toBe(view.hosted.runtime)
  // The run holds the thread: no idle disposal is armed under its lease.
  expect(clock.pending()).toBe(0)
})
