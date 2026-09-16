import type {
  DialogAnswer,
  PromptOutcome,
  PromptRequest,
  ThreadRuntime,
  ZenDialogSpec,
  ZenObservation,
  ZenPermissionModeState,
  ZenTranscriptEntry,
} from '@zen/core'
import type { AgentHost, HostedThread, HostedThreadInspection } from '../../host/agent-host.ts'
import { createEventTail, describeObservation } from '../../host/event-tail.ts'

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
  /** Push one observation at every subscriber, live, and into the tail the events route reads (L2: the seam speaks observations). */
  readonly emit: (observation: ZenObservation) => void
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
  const listeners = new Set<(observation: ZenObservation) => void>()
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
  const emit = (observation: ZenObservation): void => {
    if (observation.kind === 'extension-ui-request' && observation.blocking && observation.dialog !== undefined) {
      open.set(observation.id, observation.dialog)
    }
    const described = describeObservation(observation)
    emitted.record(described.type, described.name, 'live')
    for (const listener of listeners) listener(observation)
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
        emit({ kind: 'dialog-settled', id: response.id, outcome: 'cancelled' in response ? 'cancelled' : 'answered' })
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
      emit({ kind: 'permission-mode', mode, available: runtime.permissionModeState().available })
    },
    subscribe: (onObservation: (observation: ZenObservation) => void) => {
      listeners.add(onObservation)
      return () => {
        listeners.delete(onObservation)
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
      emit({ kind: 'queue', steering: [], followUp: [] })
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
    // The fake loads no extensions: every probe is the hook's silence.
    probeToolCall: async (): Promise<undefined> => undefined,
  }
  return { hosted, record, emit, open }
}

/** What a fake host "has on disk" (#95): a stored thread by id, with its transcript and the mode it was left in. */
export interface FakeStoredThread {
  readonly transcript: ZenTranscriptEntry[]
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
    storedPermissionMode: (transcript: readonly ZenTranscriptEntry[]): ZenPermissionModeState => {
      const storedThread = Object.values(stored).find((candidate) => candidate.transcript === transcript)
      return { mode: storedThread?.mode ?? fresh.mode, available: fresh.available }
    },
    listSessions: () =>
      Promise.resolve(
        Object.entries(stored).map(([threadId, storedThread]) => ({
          id: threadId,
          path: `/stored/${threadId}.jsonl`,
          modified: storedThread.modified,
          messageCount: storedThread.transcript.filter((transcriptEntry) => transcriptEntry.kind === 'message').length,
          firstMessage: storedThread.firstMessage,
        })),
      ),
    readTranscript: (threadId: string) => Promise.resolve(stored[threadId]?.transcript),
  }
}
