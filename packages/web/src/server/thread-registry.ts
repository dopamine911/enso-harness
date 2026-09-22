/**
 * One pi session per chat THREAD, held across runs (#69 PR 2 — closes #43).
 *
 * Before this module the server created a session per HTTP run and disposed it in the
 * handler's `finally`. picc keys its permission mode to the session, so `/mode` answered
 * on prompt 1 was gone by prompt 2 (#43), the read-before-write tracker never saw a read
 * from an earlier prompt, and every prompt paid a fresh extension load. Here a thread's
 * session survives the run and is disposed only after `idleTimeoutMs` with no run, or at
 * server shutdown.
 *
 * ⚠ RUN vs SESSION LIFETIME. `abort` ABORTS the run in flight; it never disposes. `release`
 * arms the idle timer; `acquire` cancels it. Disposal is therefore only ever reached with
 * no run in flight, which is what makes the host's dispose ordering (unsubscribe, then
 * `session.dispose()`) safe: there is no `agent_settled` left to swallow.
 *
 * ⚠ THE ABORT-THEN-PROMPT RACE. An operator aborts (#116) → pi's `abort()` resolves only
 * when the agent is idle again (agent-session.js `abort` → `waitForIdle`). If they prompt
 * before that, pi's `prompt()` would refuse ("Agent is already processing"). So `abort`
 * stores the in-flight abort and `acquire` awaits it first — the new run starts against an
 * idle session. (Before #113 the same race came from a tab closing mid-run.)
 *
 * ⓘ Named non-coverage: the map is unbounded, and a client that omits `threadId` gets a
 * fresh session per request that lives for the idle window. Loopback-only, dev-only server.
 */
import {
  ENSO_LOG_EVENTS,
  type EnsoObservation,
  type EnsoThreadInspection,
  ensoLogger,
  type RuntimeCommand,
  type ThreadRuntime,
} from '@enso/core'
import type { HostedThread } from '../host/agent-host.ts'
import { createEventTail, type EventTail } from '../host/event-tail.ts'
import { recordObservation } from './observation-log.ts'

/**
 * One frame of a thread's feed (SPIKE #109 — the `follow` half of deepseek-harness's
 * prompt/follow split).
 *
 * An `observation` is a pi event through the mapper with the feed's own monotonic `seq`; a
 * `status` is the thread's lifecycle as this registry sees it — built, taken by a run,
 * released, disposed. The feed exists whether or not a run does: that independence is the whole
 * experiment.
 */
export type ThreadFeedFrame =
  | { readonly kind: 'observation'; readonly seq: number; readonly observation: EnsoObservation }
  | { readonly kind: 'status'; readonly live: boolean; readonly busy: boolean; readonly generation: number }

export type ThreadFeedListener = (frame: ThreadFeedFrame) => void

/** A thread's observers and their attachment to whichever session the thread currently has. */
interface ThreadFeed {
  readonly threadId: string
  readonly listeners: Set<ThreadFeedListener>
  seq: number
  /** The session subscription while the thread is live; undefined while it is not. */
  detach: (() => void) | undefined
  /**
   * Frames raised by a listener DURING a publish (a `settled` observation releasing the
   * thread, which publishes a status). Delivered after the current frame reaches every
   * listener, so no follower sees the consequence before its cause.
   */
  readonly queued: ThreadFeedFrame[]
  publishing: boolean
}

/**
 * How long a thread's session outlives its last run. Long enough for a human to read a
 * reply and type the next prompt without losing mode or read-tracker state; short enough
 * that an abandoned tab does not hold extension instances for the rest of the day.
 */
const THREAD_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** A scheduled idle disposal. `cancel` is idempotent and safe once it has fired. */
interface IdleDisposal {
  cancel: () => void
}

/**
 * How the idle window is TIMED (#235) — the default is a real `setTimeout`, and the lifecycle
 * tests pass a hand-advanced clock instead.
 *
 * ⚠ Those tests assert a NEGATIVE: "the idle timer has not fired yet". Against wall time that is
 * a 5–15 ms margin on a 20 ms timer, and on a loaded runner it loses the race and reports a
 * lifecycle bug that does not exist — the worst red a ratcheted gate can print, the one
 * reviewers learn to re-run rather than read. With the clock injected, "not yet" is a fact:
 * nothing is due until the test says the time has passed.
 */
export type ScheduleIdleDisposal = (dispose: () => void, afterMs: number) => IdleDisposal

const wallClock: ScheduleIdleDisposal = (dispose: () => void, afterMs: number): IdleDisposal => {
  const timer = setTimeout(dispose, afterMs)
  // A pending disposal must never hold the process open on shutdown.
  timer.unref?.()
  return { cancel: (): void => clearTimeout(timer) }
}

const log = ensoLogger('server', 'threads')

export interface ThreadRegistryOptions {
  /** Builds a hosted session for a thread — `AgentHost.createSession`. Injected so tests need no pi. */
  createSession: (threadId: string) => Promise<HostedThread>
  /** Injectable for tests — the default is minutes. */
  idleTimeoutMs?: number
  /** How the idle window is timed; the lifecycle tests advance it by hand (#235). */
  scheduleIdleDisposal?: ScheduleIdleDisposal
}

export interface ThreadRegistry {
  /**
   * Take the thread for a run: the session, created on first use, held through a lease.
   * Cancels a pending idle disposal and waits for an in-flight abort so the run always
   * starts against an idle session.
   *
   * ⚠ A `createSession` failure is thrown to the caller and leaves NO entry behind, so the
   * next request on that thread retries the build instead of finding a poisoned slot.
   */
  acquire(threadId: string): Promise<ThreadLease>
  /**
   * Follow the thread's feed (SPIKE #109): every observation and status change from now
   * on, whether or not a run is in flight, whether or not the thread is even built yet.
   * Observation only — never creates a session. `asOfSeq` is the feed's position at
   * subscription: a snapshot taken in the same tick is exact as of it, and every
   * observation delivered afterwards carries a greater `seq`.
   */
  observe(threadId: string, listener: ThreadFeedListener): ThreadFollow
  /**
   * Put a SERVER-synthesised observation on the thread's feed, in sequence with pi's —
   * a prompt pi refused after its receipt went out (`prompt-rejected`). No feed (nobody
   * following): nothing to tell, and the problem channel already has it.
   */
  announce(threadId: string, observation: EnsoObservation): void
  /**
   * Abort the run in flight on a thread (#116) — the operator's stop, addressed by thread
   * because the lease that took the run lives in the prompt route's closure and a later
   * request cannot reach it. `aborted`: pi was told; the run ends on the feed as any run
   * does, and `restored` holds the prompts that were waiting behind it (#75,
   * clear-and-restore). `idle`: nothing in flight. `unknown`: no live thread.
   */
  abort(threadId: string): AbortResult
  /**
   * The thread's hosted session IF it is live — never creates one (#86). Looking must
   * not be the thing that spins pi up; `acquire` is for runs.
   */
  peek(threadId: string): ThreadView | undefined
  /**
   * The thread's `sent` tail if it is live — the ONE field the follow writer needs, per
   * frame. `peek` builds a whole `ThreadView` to hand it over, which is an object per
   * token for a field read (#285); the routes that want the view keep using `peek`.
   * Never creates.
   */
  sentTail(threadId: string): EventTail | undefined
  /** Every live thread, for the inspection listing. Never creates. */
  list(): ThreadView[]
  /**
   * The slash commands the most recently built session registered (#338), for a thread that
   * has none yet. Every session registers the same set — the manifest is fixed — so the last
   * one's answer is the next one's, and asking it builds nothing (#86). `undefined` before
   * any session has been built in this process.
   */
  rememberedCommands(): readonly RuntimeCommand[] | undefined
  /** Dispose every session — server shutdown. */
  shutdown(): void
  /** Observable state for tests. */
  liveThreadCount(): number
}

/** A live follow: where the feed stood when it began, and how to leave. */
export interface ThreadFollow {
  readonly asOfSeq: number
  readonly unsubscribe: () => void
}

/** What {@link ThreadRegistry.abort} did. */
export type AbortOutcome = 'aborted' | 'idle' | 'unknown'

/** {@link ThreadRegistry.abort}'s answer: the outcome, and the queued prompts handed back (empty unless `aborted`). */
export interface AbortResult {
  readonly outcome: AbortOutcome
  readonly restored: readonly string[]
}

/**
 * One run's hold on a thread (#109, deepseek-harness's `openGeneration` on the server).
 *
 * ⚠ WHY A LEASE AND NOT `release(threadId)`. A thread is held by exactly one run at a
 * time, but handles to it outlive runs: a parked dialog carries its run's stop for the
 * eviction that may come ten minutes later, and by then a NEWER run may hold the same
 * thread. Addressed by id, that late stop aborted and released whatever was running — the
 * displaced-park case `release` used to document as "harmless only because of timing".
 * A lease is bound to the acquisition it came from; once a later `acquire` or a disposal
 * has moved the thread on, its `release` and `stop` are inert and say so.
 */
export interface ThreadLease {
  readonly threadId: string
  readonly runtime: ThreadRuntime
  /**
   * Which acquisition this is, counted per thread id for the server's lifetime — the fence
   * a stale lease is checked against, and the number the browser's `status` frame
   * carries so the two can be compared (`EnsoThreadInspection.generation`).
   */
  readonly generation: number
  /** The run is over and nothing is parked: start the idle clock. Stale: a reported no-op. */
  release(): void
}

/** A live thread as inspection sees it: the session, and whether a run holds it. */
/**
 * A live thread as the wire describes it — `GET /api/threads/:id` and the bundle both
 * say this, from here, so they cannot drift.
 */
export function inspectThread(view: ThreadView): EnsoThreadInspection {
  const inspection = view.hosted.inspect()
  return {
    threadId: view.threadId,
    sessionId: inspection.sessionId,
    cwd: inspection.cwd,
    sessionDir: inspection.sessionDir,
    sessionFile: inspection.sessionFile,
    permissionMode: view.hosted.runtime.permissionModeState(),
    commands: [...inspection.commands],
    busy: view.busy,
    generation: view.generation,
    lastActivityAt: new Date(view.lastActivityAt).toISOString(),
    entries: [...inspection.entries],
  }
}

export interface ThreadView {
  readonly threadId: string
  readonly hosted: HostedThread
  /** Acquired and not yet released — a run in flight, or a dialog parked on it. */
  readonly busy: boolean
  /** The latest acquisition's number — see {@link ThreadLease.generation}. */
  readonly generation: number
  /** The last `acquire` or `release`, epoch milliseconds. */
  readonly lastActivityAt: number
  /**
   * The sent tail (#97): every AG-UI chunk the server wrote to this thread's browser, in
   * the wire's order. The SAME instance as the entry's, so the chat handler records into
   * it through a `peek` — the one server-owned record, beside the host's emitted tail.
   */
  readonly sent: EventTail
}

interface ThreadEntry {
  hosted: HostedThread
  idleTimer: IdleDisposal | undefined
  /** The abort currently running, awaited by the next `acquire`. */
  abortInFlight: Promise<void> | undefined
  /** Set by `acquire`, cleared by `release` — so a parked thread reads busy until its resume releases. */
  busy: boolean
  /** The latest acquisition's number; a lease from an earlier one is stale. */
  generation: number
  lastActivityAt: number
  sent: EventTail
}

function viewOf(threadId: string, thread: ThreadEntry): ThreadView {
  return {
    threadId,
    hosted: thread.hosted,
    busy: thread.busy,
    generation: thread.generation,
    lastActivityAt: thread.lastActivityAt,
    sent: thread.sent,
  }
}

export function createThreadRegistry(options: ThreadRegistryOptions): ThreadRegistry {
  const { createSession } = options
  const idleTimeoutMs = options.idleTimeoutMs ?? THREAD_IDLE_TIMEOUT_MS
  const scheduleIdleDisposal = options.scheduleIdleDisposal ?? wallClock

  const threads = new Map<string, ThreadEntry>()
  /** Builds in progress, so two concurrent first requests on one thread share one session. */
  const building = new Map<string, Promise<ThreadEntry>>()
  /**
   * Per thread id, surviving disposal: a thread rebuilt after its idle window continues
   * the count, so a lease from before the rebuild can never match the new entry by number.
   * ⓘ Never pruned — one integer per thread id this server has ever run, the same named
   * non-coverage as the thread map itself (header): loopback, dev-only, ids minted by the
   * page. Pruning would reopen the rebuild case for a thread that comes back after it.
   */
  const generations = new Map<string, number>()

  /**
   * Feeds by thread id, independent of the entry: a follower may arrive before the thread
   * is built and stays through a rebuild. Deleted when its last listener leaves.
   */
  const feeds = new Map<string, ThreadFeed>()

  function publish(feed: ThreadFeed, frame: ThreadFeedFrame): void {
    feed.queued.push(frame)
    if (feed.publishing) return
    feed.publishing = true
    try {
      for (let next = feed.queued.shift(); next !== undefined; next = feed.queued.shift()) {
        for (const listener of feed.listeners) {
          try {
            listener(next)
          } catch (error) {
            // One bad follower never breaks the feed for the others, nor the session.
            log.warn('thread feed: a listener threw: {error}', { threadId: feed.threadId, error })
          }
        }
      }
    } finally {
      feed.publishing = false
    }
  }

  function publishStatus(threadId: string, thread: ThreadEntry | undefined): void {
    const feed = feeds.get(threadId)
    if (feed === undefined) return
    publish(feed, {
      kind: 'status',
      live: thread !== undefined,
      busy: thread?.busy ?? false,
      generation: thread?.generation ?? generations.get(threadId) ?? 0,
    })
  }

  /**
   * Subscribe the feed to the thread's session. ⚠ This makes the feed the session's FIRST
   * subscriber when a follower is present at build, so the host's start-up replay
   * (#96) lands here, not in a later `/api/chat` pump — the spike's receipt records it.
   */
  function attachFeed(threadId: string, thread: ThreadEntry): void {
    const feed = feeds.get(threadId)
    if (feed === undefined || feed.detach !== undefined) return
    feed.detach = thread.hosted.runtime.subscribe((observation) => {
      publishObservation(feed, observation)
    })
  }

  function publishObservation(feed: ThreadFeed, observation: EnsoObservation): void {
    feed.seq += 1
    recordObservation(feed.threadId, generations.get(feed.threadId) ?? 0, feed.seq, observation)
    publish(feed, { kind: 'observation', seq: feed.seq, observation })
  }

  function detachFeed(threadId: string): void {
    const feed = feeds.get(threadId)
    if (feed?.detach === undefined) return
    feed.detach()
    feed.detach = undefined
  }

  function disposeThread(threadId: string, why: string): void {
    const thread = threads.get(threadId)
    if (thread === undefined) return
    threads.delete(threadId)
    thread.idleTimer?.cancel()
    // Listeners first, then the kill — a late event from the disposing session must not
    // reach a follower as if the thread were alive.
    detachFeed(threadId)
    try {
      thread.hosted.runtime.dispose()
      log.info('thread disposed: {why}', { threadId, generation: thread.generation, why })
    } catch (error) {
      log.error('dispose after {why} failed: {error}', { threadId, why, error })
    }
    publishStatus(threadId, undefined)
  }

  /** Set by `shutdown`: no build may publish a session into a registry that is being torn down. */
  let shutDown = false
  /** The last built session's `listCommands()` — see `rememberedCommands`. */
  let lastCommands: readonly RuntimeCommand[] | undefined

  async function buildThread(threadId: string): Promise<ThreadEntry> {
    const hosted = await createSession(threadId)
    if (shutDown) {
      // ⚠ Teardown must reach quiescence, not just request it: a build that was in
      // flight when `shutdown` ran would otherwise publish a live pi AFTER every other
      // session was disposed — a leak nothing would ever dispose.
      hosted.runtime.dispose()
      throw new Error(`thread ${threadId}: the server shut down while its session was being built`)
    }
    const thread: ThreadEntry = {
      hosted,
      idleTimer: undefined,
      abortInFlight: undefined,
      busy: false,
      generation: generations.get(threadId) ?? 0,
      lastActivityAt: Date.now(),
      sent: createEventTail(),
    }
    threads.set(threadId, thread)
    attachFeed(threadId, thread)
    publishStatus(threadId, thread)
    lastCommands = hosted.runtime.listCommands()
    // ⚠ ONE inspection, read twice (#285). `inspect()` decodes the whole branch into the
    // transcript and stats the session file; for a thread resumed from a long stored
    // session that is the entire history, and this line is at `info`, so nothing drops it.
    const inspection = hosted.inspect()
    log.info('thread built: session {sessionId} in {sessionDir}', {
      threadId,
      generation: thread.generation,
      sessionId: inspection.sessionId,
      sessionDir: inspection.sessionDir,
      extensions: hosted.loadedExtensionPaths.length,
    })
    return thread
  }

  function release(threadId: string, thread: ThreadEntry): void {
    thread.idleTimer?.cancel()
    thread.idleTimer = scheduleIdleDisposal(() => disposeThread(threadId, `${idleTimeoutMs}ms idle`), idleTimeoutMs)
    thread.busy = false
    thread.lastActivityAt = Date.now()
    publishStatus(threadId, thread)
    log.info(ENSO_LOG_EVENTS.runReleased, {
      threadId,
      generation: thread.generation,
      idleTimeoutMs,
    })
  }

  /**
   * Abort the run in flight on a thread (#116). pi's `abort()` resolves when the agent is
   * idle again; the run still ends through `agent_settled` (pi emits it from a `finally`),
   * so the prompt route's settle observer releases the lease and every follower sees the
   * same `settled` + `status` it would for a natural end. Never disposes.
   *
   * One abort per run: `busy` stays true until that settle lands, so a second click (PR
   * #120 review) would reach pi again. pi's `abort()` is re-entrant (`agent.abort()` +
   * `waitForIdle()`), but the second call is the same answer, so it is not made — and it
   * restores nothing: the first stop already took the queue.
   *
   * The queue is cleared BEFORE pi is told (#75): pi's loop leaves on `aborted` before its
   * follow-up drain, so anything waiting would otherwise ride into the next prompt unasked.
   * `clearQueue()` returns the texts and emits the `queue_update` every follower reads.
   */
  function abort(threadId: string): AbortResult {
    const thread = threads.get(threadId)
    if (thread === undefined) return { outcome: 'unknown', restored: [] }
    if (!thread.busy) return { outcome: 'idle', restored: [] }
    if (thread.abortInFlight !== undefined) return { outcome: 'aborted', restored: [] }
    // A stop must stop (PR #129 review): if clearing the queue throws — pi emits the
    // emptied queue to its listeners inside it — the texts are lost and said, and pi is
    // still told to abort. Never the other way round.
    let cleared: { interrupting: string[]; enqueued: string[] } = { interrupting: [], enqueued: [] }
    try {
      cleared = thread.hosted.runtime.clearQueue()
    } catch (error: unknown) {
      log.error('clearing the queue failed, queued prompts lost: {error}', { threadId, error })
    }
    const inFlight = thread.hosted.runtime
      .abort()
      .catch((error: unknown) => log.error('abort failed: {error}', { threadId, error }))
      .finally(() => {
        if (thread.abortInFlight === inFlight) thread.abortInFlight = undefined
      })
    thread.abortInFlight = inFlight
    log.info('run {generation} told to abort; {restored} queued prompt(s) handed back', {
      threadId,
      generation: thread.generation,
      restored: cleared.interrupting.length + cleared.enqueued.length,
    })
    return { outcome: 'aborted', restored: [...cleared.interrupting, ...cleared.enqueued] }
  }

  function leaseOf(threadId: string, thread: ThreadEntry): ThreadLease {
    const generation = thread.generation
    /** Current: the same entry, and no acquisition since. Stale is information, never a throw. */
    function current(operation: string): boolean {
      if (threads.get(threadId) === thread && thread.generation === generation) return true
      log.warn('{operation} from run {generation} ignored: {because}', {
        threadId,
        generation,
        operation,
        because:
          threads.get(threadId) === undefined ? 'the thread was disposed' : `run ${thread.generation} holds it now`,
      })
      return false
    }
    return {
      threadId,
      runtime: thread.hosted.runtime,
      generation,
      release: () => {
        if (current('release')) release(threadId, thread)
      },
    }
  }

  return {
    async acquire(threadId: string): Promise<ThreadLease> {
      if (shutDown) throw new Error(`thread ${threadId}: the server has shut down`)
      let thread = threads.get(threadId)
      if (thread === undefined) {
        let build = building.get(threadId)
        if (build === undefined) {
          build = buildThread(threadId).finally(() => building.delete(threadId))
          building.set(threadId, build)
        }
        thread = await build
      }
      thread.idleTimer?.cancel()
      thread.idleTimer = undefined
      if (thread.abortInFlight !== undefined) {
        await thread.abortInFlight
      }
      thread.busy = true
      thread.generation += 1
      generations.set(threadId, thread.generation)
      thread.lastActivityAt = Date.now()
      publishStatus(threadId, thread)
      log.info(ENSO_LOG_EVENTS.runAcquired, { threadId, generation: thread.generation })
      return leaseOf(threadId, thread)
    },
    announce(threadId: string, observation: EnsoObservation): void {
      const feed = feeds.get(threadId)
      if (feed !== undefined) publishObservation(feed, observation)
    },
    observe(threadId: string, listener: ThreadFeedListener): ThreadFollow {
      let feed = feeds.get(threadId)
      if (feed === undefined) {
        feed = { threadId, listeners: new Set(), seq: 0, detach: undefined, queued: [], publishing: false }
        feeds.set(threadId, feed)
      }
      feed.listeners.add(listener)
      const thread = threads.get(threadId)
      if (thread !== undefined) attachFeed(threadId, thread)
      const attached = feed
      return {
        asOfSeq: attached.seq,
        unsubscribe: () => {
          attached.listeners.delete(listener)
          if (attached.listeners.size > 0) return
          // The last follower leaves: detach from the session so the next run's pump
          // is the first subscriber again, and forget the feed (its `seq` restarts
          // with the next follower — a new generation, snapshot-first).
          detachFeed(threadId)
          feeds.delete(threadId)
        },
      }
    },
    abort,
    peek(threadId: string): ThreadView | undefined {
      const thread = threads.get(threadId)
      return thread === undefined ? undefined : viewOf(threadId, thread)
    },
    sentTail(threadId: string): EventTail | undefined {
      return threads.get(threadId)?.sent
    },
    rememberedCommands(): readonly RuntimeCommand[] | undefined {
      return lastCommands
    },
    list(): ThreadView[] {
      return [...threads.entries()].map(([threadId, thread]) => viewOf(threadId, thread))
    },
    shutdown(): void {
      shutDown = true
      for (const threadId of [...threads.keys()]) disposeThread(threadId, 'server shutdown')
    },
    liveThreadCount(): number {
      return threads.size
    },
  }
}
