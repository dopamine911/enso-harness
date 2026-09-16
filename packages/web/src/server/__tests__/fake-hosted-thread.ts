import {
  type DialogAnswer,
  type EventDelivery,
  isZenDialogSpec,
  type PromptOutcome,
  type PromptRequest,
  type RuntimeEvent,
  type ThreadRuntime,
  type ZenDialogSpec,
  type ZenPermissionModeState,
} from '@zen/core'
import type { AgentHost, HostedThread, HostedThreadInspection } from '../../host/agent-host.ts'
import { createEventTail, describeRuntimeEvent } from '../../host/event-tail.ts'

/**
 * The one fake of the thread-runtime seam (#178; `docs/seams/thread-runtime.md`): a
 * `ThreadRuntime` from plain closures that records every call, so the server, the registry
 * and the routes are driven over it and asserted through what it recorded. Before this file
 * four tests each built the nine methods, and a change to the contract was five edits that
 * could disagree about what the contract was.
 *
 * The defaults are the union of what those four recorded — prompts, answers, aborts, queue
 * hand-back, the open-dialog map, the real event tail. A test that needs one method to
 * behave differently (an abort that stays pending, a clear that throws, a scripted prompt)
 * replaces that method over the fake's own parts and keeps the rest.
 */

export interface FakeThreadRecord {
  readonly prompts: PromptRequest[]
  readonly answers: DialogAnswer[]
  /** Every mode the server asked for, in order (L3 step C). */
  readonly modeChanges: string[]
  aborts: number
  queueClears: number
  disposed: number
  /** What pi holds behind the run — a test fills it to see a stop hand it back (#75). */
  queue: { steering: string[]; followUp: string[] }
}

/** The fake's own state, handed to an override so a scripted method can record and emit through it. */
export interface FakeThreadParts {
  readonly record: FakeThreadRecord
  /** Push one runtime event at every subscriber, live, and into the tail the events route reads. */
  readonly emit: (event: RuntimeEvent) => void
  /** Every blocking question emitted and not yet answered — what the real host's `openDialogs` reads. */
  readonly open: Map<string, ZenDialogSpec>
}

export interface FakeHostedThread extends FakeThreadParts {
  readonly hosted: HostedThread
}

export interface FakeHostedThreadOptions {
  /** Methods to replace, built over the fake's parts; every other method keeps its recording default. */
  readonly runtime?: (parts: FakeThreadParts) => Partial<ThreadRuntime>
  readonly inspect?: Partial<HostedThreadInspection>
}

/** Hand the queue back the way pi does — a copy out, the queue emptied. */
export function takeQueue(record: FakeThreadRecord): { steering: string[]; followUp: string[] } {
  const cleared = { steering: [...record.queue.steering], followUp: [...record.queue.followUp] }
  record.queue = { steering: [], followUp: [] }
  return cleared
}

export function createFakeHostedThread(options: FakeHostedThreadOptions = {}): FakeHostedThread {
  const listeners = new Set<(event: RuntimeEvent, delivery: EventDelivery) => void>()
  const record: FakeThreadRecord = {
    prompts: [],
    answers: [],
    modeChanges: [],
    aborts: 0,
    queueClears: 0,
    disposed: 0,
    queue: { steering: [], followUp: [] },
  }
  const open = new Map<string, ZenDialogSpec>()
  // Records into the same tail the real host does, so the events route sees the real shape
  // (coalesced rows); delivers only live, so every row is `live`. The real host's
  // held/replayed/dropped provenance is pinned in agent-host.test.ts.
  const emitted = createEventTail()
  const emit = (event: RuntimeEvent): void => {
    if (event.type === 'extension_ui_request' && typeof event.id === 'string') {
      const { type: _type, id: _id, ...request } = event
      if (isZenDialogSpec(request)) open.set(event.id, request)
    }
    const described = describeRuntimeEvent(event)
    emitted.record(described.type, described.name, 'live')
    for (const listener of listeners) listener(event, 'live')
  }
  const parts: FakeThreadParts = { record, emit, open }
  const runtime: ThreadRuntime = {
    prompt: (request: PromptRequest) => {
      record.prompts.push(request)
    },
    answerDialog: (response: DialogAnswer) => {
      record.answers.push(response)
      // What the real host does at `finish` (#114): the settle is a record on the stream.
      if (open.delete(response.id)) {
        emit({
          type: 'extension_ui_settled',
          id: response.id,
          outcome: 'cancelled' in response ? 'cancelled' : 'answered',
        })
      }
    },
    openDialogs: () => [...open].map(([id, dialog]) => ({ id, dialog })),
    listCommands: () => [],
    permissionModeState: () => ({ mode: 'default', available: ['default'] }),
    setPermissionMode: (mode: string, outcome: PromptOutcome) => {
      // What the real host does: the vendor's command is accepted (an extension command's
      // acceptance is its completion) and the change comes back as `permission_mode`.
      record.modeChanges.push(mode)
      outcome.onAccepted()
      emit({ type: 'permission_mode', mode, available: runtime.permissionModeState().available })
    },
    subscribe: (onEvent: (event: RuntimeEvent, delivery: EventDelivery) => void) => {
      listeners.add(onEvent)
      return () => {
        listeners.delete(onEvent)
      }
    },
    abort: () => {
      record.aborts += 1
      return Promise.resolve()
    },
    clearQueue: () => {
      record.queueClears += 1
      const cleared = takeQueue(record)
      // pi emits the emptied queue to every follower.
      emit({ type: 'queue_update', steering: [], followUp: [] })
      return cleared
    },
    dispose: () => {
      record.disposed += 1
    },
    ...options.runtime?.(parts),
  }
  const inspection: HostedThreadInspection = {
    sessionId: 'session-1',
    cwd: '/fake/cwd',
    sessionDir: '/fake/sessions',
    sessionFile: null,
    entries: [],
    commands: [],
    ...options.inspect,
  }
  const hosted: HostedThread = {
    runtime,
    loadedExtensionPaths: [],
    inspect: () => inspection,
    emittedEvents: emitted.recent,
  }
  return { hosted, record, emit, open }
}

/** pi's branch entries are carried as `unknown`; a message is the one kind the listing counts. */
function isMessageEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'message'
}

/** What a fake host "has on disk" (#95): a stored thread by id, with its branch and the mode it was left in. */
export interface FakeStoredThread {
  readonly branch: unknown[]
  readonly modified: Date
  readonly firstMessage: string
  /** The mode the fake reports for this thread's branch; the fresh mode when absent. */
  readonly mode?: string
}

const FAKE_FRESH_MODE: ZenPermissionModeState = { mode: 'default', available: ['default'] }

/**
 * The one fake of the storage seam (`docs/seams/storage.md`): an `AgentHost` whose listing
 * and branch reads come from `stored`, and whose `createSession` is the caller's — that is
 * where a test counts what was built and hands out a `createFakeHostedThread`. Its mode
 * answers are declared, not computed (L3): `fresh` is what a new thread starts in, and a
 * stored thread's mode is the one written beside its branch.
 */
export function createFakeAgentHost(
  createSession: AgentHost['createSession'],
  stored: Record<string, FakeStoredThread> = {},
  fresh: ZenPermissionModeState = FAKE_FRESH_MODE,
): AgentHost {
  return {
    createSession,
    freshPermissionMode: () => fresh,
    storedPermissionMode: (branch: readonly unknown[]): ZenPermissionModeState => {
      const storedThread = Object.values(stored).find((candidate) => candidate.branch === branch)
      return { mode: storedThread?.mode ?? fresh.mode, available: fresh.available }
    },
    listSessions: () =>
      Promise.resolve(
        Object.entries(stored).map(([id, storedThread]) => ({
          id,
          path: `/stored/${id}.jsonl`,
          modified: storedThread.modified,
          messageCount: storedThread.branch.filter(isMessageEntry).length,
          firstMessage: storedThread.firstMessage,
        })),
      ),
    readBranch: (threadId: string) => Promise.resolve(stored[threadId]?.branch),
  }
}
