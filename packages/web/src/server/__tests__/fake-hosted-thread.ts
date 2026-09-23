import type {
  DialogAnswer,
  EnsoDialogSpec,
  EnsoHostCommandRun,
  EnsoModelChoice,
  EnsoModelState,
  EnsoObservation,
  EnsoPermissionModeState,
  EnsoTranscriptEntry,
  PromptOutcome,
  PromptRequest,
  RuntimeCommand,
  ThreadRuntime,
} from '@enso/core'
import type { AgentHost, HostedThread, HostedThreadInspection } from '../../host/agent-host.ts'
import { createEventTail, describeObservation } from '../../host/event-tail.ts'
import { decideHostCommand, HostCommandRefused, hostCommandRows } from '../../host/host-commands.ts'
import { decideHostFlow, hostFlowRows, loginDoneText } from '../../host/host-flows.ts'

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

/** The models the fake "could run" (#338 slice 2): two, so a `/model` switch has somewhere to go. */
const FAKE_MODEL_ONE: EnsoModelChoice = { provider: 'fake', id: 'fake-1', name: 'Fake One' }
const FAKE_MODEL_TWO: EnsoModelChoice = { provider: 'fake', id: 'fake-2', name: 'Fake Two' }
const FAKE_MODELS: readonly EnsoModelChoice[] = [FAKE_MODEL_ONE, FAKE_MODEL_TWO]

/** The fake's ways in and its one stored credential (#338 slice 3). */
const FAKE_LOGIN_OPTIONS = [
  { id: 'fake/oauth', label: 'Fake · subscription', detail: 'via stored' },
  { id: 'fake/api_key', label: 'Fake · API key', detail: 'via stored' },
]
const FAKE_LOGOUT_OPTIONS = [{ id: 'fake', label: 'Fake', detail: 'stored subscription' }]

/** The fake's host rows — `/model`, `/thinking`, `/login`, `/logout` — in the real host's order; a test that replaces `listCommands` puts pi's rows before these. */
export function fakeHostRows(record: Pick<FakeThreadRecord, 'modelState'>): RuntimeCommand[] {
  return [...hostCommandRows(record.modelState, FAKE_MODELS), ...hostFlowRows(FAKE_LOGIN_OPTIONS, FAKE_LOGOUT_OPTIONS)]
}

/** What the fake starts on: the first fake model, thinking `medium` of four levels. */
function freshFakeModelState(): EnsoModelState {
  return {
    model: { ...FAKE_MODEL_ONE },
    thinkingLevel: 'medium',
    availableThinkingLevels: ['off', 'low', 'medium', 'high'],
  }
}

export interface FakeThreadRecord {
  readonly prompts: PromptRequest[]
  readonly answers: DialogAnswer[]
  /** Every mode the server asked for, in order (L3 step C). */
  readonly modeChanges: string[]
  /** Every host command the server ran, in order — accepted or refused (#338 slice 2). */
  readonly hostCommands: EnsoHostCommandRun[]
  /** Every flow the server started (#338 slice 3), and the hand that ends each: a test settles it when it chooses. */
  readonly flows: Array<{ readonly run: EnsoHostCommandRun; settled: boolean; readonly settle: () => void }>
  /** The model state `modelState()` reads and `runHostCommand` writes; a test sets it to start elsewhere. */
  modelState: EnsoModelState
  aborts: number
  queueClears: number
  disposed: number
  /** What pi holds behind the run — a test fills it to see a stop hand it back (#75). */
  queue: { interrupting: string[]; enqueued: string[] }
}

/** The fake's own state, handed to an override so a scripted method can record and emit through it. */
export interface FakeThreadParts {
  readonly record: FakeThreadRecord
  /** Push one observation at every subscriber, live, and into the tail the events route reads (L2: the seam speaks observations). */
  readonly emit: (observation: EnsoObservation) => void
  /** Every blocking question emitted and not yet answered — what the real host's `openDialogs` reads. */
  readonly open: Map<string, EnsoDialogSpec>
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
export function takeQueue(record: FakeThreadRecord): { interrupting: string[]; enqueued: string[] } {
  const cleared = { interrupting: [...record.queue.interrupting], enqueued: [...record.queue.enqueued] }
  record.queue = { interrupting: [], enqueued: [] }
  return cleared
}

export function createFakeHostedThread(options: FakeHostedThreadOptions = {}): FakeHostedThread {
  const listeners = new Set<(observation: EnsoObservation) => void>()
  const record: FakeThreadRecord = {
    prompts: [],
    answers: [],
    modeChanges: [],
    hostCommands: [],
    flows: [],
    modelState: freshFakeModelState(),
    aborts: 0,
    queueClears: 0,
    disposed: 0,
    queue: { interrupting: [], enqueued: [] },
  }
  const open = new Map<string, EnsoDialogSpec>()
  // Records into the same tail the real host does, so the events route sees the real shape
  // (coalesced rows); delivers only live, so every row is `live`. The real host's
  // held/replayed/dropped provenance is pinned in agent-host.test.ts.
  const emitted = createEventTail()
  const emit = (observation: EnsoObservation): void => {
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
        emit({
          kind: 'dialog-settled',
          id: response.id,
          outcome: response.cancelled === true ? 'cancelled' : 'answered',
        })
      }
    },
    openDialogs: () => [...open].map(([id, dialog]) => ({ id, dialog })),
    // pi's rows first (none by default; a test's override supplies its own), then the host's two
    // over the fake's models — the real host's order.
    listCommands: () => fakeHostRows(record),
    modelState: () => record.modelState,
    runHostCommand: (run: EnsoHostCommandRun) => {
      // What the real host does: the shared decision, the set, then the state said as `model`.
      record.hostCommands.push(run)
      const decision = decideHostCommand(run, record.modelState, FAKE_MODELS)
      if (decision.kind === 'refused') return Promise.reject(new HostCommandRefused(decision.reason))
      record.modelState =
        decision.kind === 'model'
          ? { ...record.modelState, model: { ...decision.model } }
          : { ...record.modelState, thinkingLevel: decision.level }
      emit({ kind: 'model', ...record.modelState })
      return Promise.resolve()
    },
    startHostFlow: (run: EnsoHostCommandRun, outcome: PromptOutcome) => {
      // What the real host does: decide before accepting; then the flow runs on its own clock —
      // here, until the test settles it — and ends with a notify and the model state said. The
      // lease is the route's to release, on acceptance; the fake holds nothing.
      try {
        const pending = record.flows.find((flow) => !flow.settled)
        if (pending !== undefined) throw new HostCommandRefused(`/${pending.run.name} is already in progress here`)
        decideHostFlow(run, FAKE_LOGIN_OPTIONS, FAKE_LOGOUT_OPTIONS)
      } catch (error) {
        outcome.onRejected(error instanceof Error ? error.message : String(error))
        return
      }
      outcome.onAccepted()
      const entry = {
        run,
        settled: false,
        settle: (): void => {
          entry.settled = true
          emit({
            kind: 'extension-ui-request',
            id: `flow-${record.flows.length}`,
            method: 'notify',
            blocking: false,
            origin: 'run',
            message: loginDoneText('Fake', 'oauth', undefined),
            notifyType: 'info',
          })
          emit({ kind: 'model', ...record.modelState })
        },
      }
      record.flows.push(entry)
    },
    permissionModeState: () => ({ mode: 'default', available: ['default'] }),
    setPermissionMode: (mode: string, outcome: PromptOutcome) => {
      // What the real host does: the vendor's command is accepted (an extension command's
      // acceptance is its completion) and the change comes back as `permission_mode`.
      record.modeChanges.push(mode)
      outcome.onAccepted()
      emit({ kind: 'permission-mode', mode, available: runtime.permissionModeState().available })
    },
    subscribe: (onObservation: (observation: EnsoObservation) => void) => {
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
      emit({ kind: 'queue', interrupting: [], enqueued: [] })
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
  readonly transcript: EnsoTranscriptEntry[]
  readonly modified: Date
  readonly firstMessage: string
  /** The mode the fake reports for this thread's branch; the fresh mode when absent. */
  readonly mode?: string
}

const FAKE_FRESH_MODE: EnsoPermissionModeState = { mode: 'default', available: ['default'] }

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
  fresh: EnsoPermissionModeState = FAKE_FRESH_MODE,
): AgentHost {
  return {
    createSession,
    freshPermissionMode: () => fresh,
    storedPermissionMode: (transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState => {
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
