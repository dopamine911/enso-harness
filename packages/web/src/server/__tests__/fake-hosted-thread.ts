import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import type {
  DialogAnswer,
  EnsoDialogSpec,
  EnsoForkPoint,
  EnsoHostCommandRun,
  EnsoIncidentResolution,
  EnsoIncidentResolved,
  EnsoModelChoice,
  EnsoModelState,
  EnsoObservation,
  EnsoPermissionModeState,
  EnsoRecordedModel,
  EnsoSessionUsage,
  EnsoSystemPromptChoice,
  EnsoSystemPromptSection,
  EnsoThreadModelRole,
  EnsoTranscriptEntry,
  EnsoTreesListing,
  HostFlowOutcome,
  PromptOutcome,
  PromptRequest,
  RuntimeCommand,
  ThreadRuntime,
} from '@enso/core'
import {
  ENSO_INCIDENT_RESOLVED_ENTRY,
  estimateTextTokens,
  incidentResolutionRefusal,
  incidentResolvedOf,
  sessionIncidentsOf,
} from '@enso/core'
import type { AgentHost } from '../../host/agent-host.ts'
import type { BranchContext, BranchRequestDetail } from '../../host/branch-context.ts'
import type { BranchStats } from '../../host/branch-stats.ts'
import { createEventTail, describeObservation } from '../../host/event-tail.ts'
import {
  catalogueRows,
  decideHostCommand,
  HOST_VIEW_ROWS,
  HostCommandRefused,
  hostCommandRows,
  type ModelOffer,
  type ModelThinking,
} from '../../host/host-commands.ts'
import { compactDoneText, decideHostFlow, hostFlowRows, loginDoneText, logoutDoneText } from '../../host/host-flows.ts'
import { sameModelRole } from '../../host/hosted-thread.ts'
import type { HostedThread, HostedThreadInspection, SystemPromptPreviewOutcome } from '../../host/live-thread.ts'
import type { HostProviderFacts, HostProviders } from '../../host/provider-settings.ts'
import { decideSystemPrompt } from '../../host/system-prompt.ts'
import type { ThreadDeleteOutcome } from '../../host/thread-delete.ts'
import type { ThreadRenameOutcome, ThreadRestoreOutcome } from '../../host/thread-log-edits.ts'

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
/** What the fake lists (#880): its two models, logged in, under the provider's readable name. */
const FAKE_OFFER: ModelOffer<EnsoModelChoice> = {
  available: FAKE_MODELS,
  loggedOut: [],
  providerName: (providerId: string): string => (providerId === 'fake' ? 'Fake' : providerId),
}

/**
 * The fake's per-model effort (#391): model one reasons, model two does not — as a real catalogue
 * mixes them. Chosen with no level, each runs at pi's `medium` clamped to its levels (#852).
 */
const FAKE_THINKING: ModelThinking<EnsoModelChoice> = {
  levelsOf: (model: EnsoModelChoice): readonly string[] =>
    model.id === FAKE_MODEL_TWO.id ? ['off'] : ['off', 'low', 'medium', 'high'],
  onChoosing: (model: EnsoModelChoice): string => (model.id === FAKE_MODEL_TWO.id ? 'off' : 'medium'),
}

/** The fake's ways in and its one stored credential (#338 slice 3). */
const FAKE_LOGIN_OPTIONS = [
  { id: 'fake/oauth', label: 'Fake · subscription', detail: 'via stored' },
  { id: 'fake/api_key', label: 'Fake · API key', detail: 'via stored' },
]
const FAKE_LOGOUT_OPTIONS = [{ id: 'fake', label: 'Fake', detail: 'stored subscription' }]

/** The fake's host rows — `/model`, `/thinking`, `/login`, `/logout`, `/compact`, `/context` — in the real host's order; a test that replaces `listCommands` puts pi's rows before these. */
export function fakeHostRows(record: Pick<FakeThreadRecord, 'modelState'>): RuntimeCommand[] {
  return [
    ...hostCommandRows(record.modelState, FAKE_OFFER, FAKE_THINKING),
    ...hostFlowRows(FAKE_LOGIN_OPTIONS, FAKE_LOGOUT_OPTIONS),
    ...HOST_VIEW_ROWS,
  ]
}

/** The fake's catalogue (#484): the real host's rule over the same fake models and credentials. */
function fakeCatalogue(): RuntimeCommand[] {
  return catalogueRows(FAKE_OFFER, FAKE_THINKING, hostFlowRows(FAKE_LOGIN_OPTIONS, FAKE_LOGOUT_OPTIONS))
}

/** The sentence the fake's flow says when a test settles it — the real host's words, by flow. */
function fakeFlowDoneText(flowName: string): string {
  if (flowName === 'logout') return logoutDoneText('Fake', 'oauth')
  if (flowName === 'compact') return compactDoneText(84_000, 12_000)
  return loginDoneText('Fake', 'oauth', undefined)
}

/** What the fake starts on: the first fake model, thinking `medium` of four levels. */
function freshFakeModelState(): EnsoModelState {
  return {
    model: { ...FAKE_MODEL_ONE },
    thinkingLevel: 'medium',
    availableThinkingLevels: ['off', 'low', 'medium', 'high'],
  }
}

/** A session that has spent nothing — no context, as a file or a fresh fake reports it. */
const FAKE_NO_USAGE: EnsoSessionUsage = {
  cost: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  context: null,
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
  /** What `sessionUsage()` reads (#45); a test sets it to what pi would have summed. */
  sessionUsage: EnsoSessionUsage
  /** How many continues the server asked for (#436); the default accepts each and runs nothing. */
  continues: number
  /** The system prompt the server fixed (#443); `undefined` is pi's default. */
  systemPrompt: EnsoSystemPromptChoice | undefined
  /** Every resolution the server recorded (#466), in order; the real host appends each to the branch. */
  readonly incidentResolutions: EnsoIncidentResolved[]
  /** Every role record the server appended (#904), in order; `null` ends one. */
  readonly modelRoles: (EnsoThreadModelRole | null)[]
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
  /** Told of every runtime call before it runs, by method name: how a flow trace draws what the double received (#482). */
  readonly onCall?: (method: string, args: readonly unknown[]) => void
  /** What `branchStats()` answers (#45 phase 2); an empty branch when absent. */
  readonly branch?: BranchStats
  /** What `branchContext()` answers (#361); no request when absent. */
  readonly context?: BranchContext
  /** What `branchRequestDetail(request)` answers, by `String(request)`; undefined when absent. */
  readonly details?: Readonly<Record<string, BranchRequestDetail>>
  readonly inspect?: Partial<HostedThreadInspection>
  /** What `forkPoint()` answers (#435); the inspection's session with no recorded conditions when absent. */
  readonly forkPoint?: EnsoForkPoint
  /** What `previewSystemPrompt` answers (#443); {@link fakeSystemPromptPreview} when absent. */
  readonly previewSystemPrompt?: (candidate: EnsoSystemPromptChoice | null) => SystemPromptPreviewOutcome
  /** Whether `projectTrust()` answers trusted (#470); untrusted when absent, as a project nobody decided is. */
  readonly projectTrusted?: boolean
}

/** The fake model's context window, as a preview reports it. */
const FAKE_CONTEXT_WINDOW = 200_000

/** The fake's pi preamble — pi's own, shortened; a candidate's `system` text replaces it. */
export const FAKE_PI_PREAMBLE = 'You are an expert coding assistant operating inside pi.'

/**
 * A preview as the real host shapes one (#443): the preamble (the candidate's, or pi's), the addendum
 * an `append` candidate joins, and the cwd — each priced as the Context tab prices it; no tools.
 */
function fakeSystemPromptPreview(candidate: EnsoSystemPromptChoice | null): SystemPromptPreviewOutcome {
  const section = (name: string, text: string, library: boolean): EnsoSystemPromptSection => ({
    name,
    origin: library ? 'library' : 'pi',
    text,
    tokens: estimateTextTokens(text),
  })
  const sections = [
    candidate?.mode === 'system'
      ? section('preamble', candidate.text, true)
      : section('preamble', FAKE_PI_PREAMBLE, false),
    ...(candidate?.mode === 'append' ? [section('addendum', `<addendum>\n${candidate.text}\n</addendum>`, true)] : []),
    section('cwd', `<cwd>\n${FAKE_PROJECT_DIRECTORY}\n</cwd>`, false),
  ]
  const prompt = candidate === null ? null : { id: candidate.id, name: candidate.name, mode: candidate.mode }
  const totalTokens = sections.reduce((sum, section) => sum + section.tokens, 0)
  return { kind: 'preview', preview: { prompt, sections, tools: [], totalTokens, contextWindow: FAKE_CONTEXT_WINDOW } }
}

/** Hand the queue back the way pi does — a copy out, the queue emptied. */
export function takeQueue(record: FakeThreadRecord): { interrupting: string[]; enqueued: string[] } {
  const cleared = { interrupting: [...record.queue.interrupting], enqueued: [...record.queue.enqueued] }
  record.queue = { interrupting: [], enqueued: [] }
  return cleared
}

/** `runtime` with every method reporting its call first; the calls themselves are unchanged. */
function reporting(runtime: ThreadRuntime, onCall: (method: string, args: readonly unknown[]) => void): ThreadRuntime {
  const wrapped: Record<string, unknown> = {}
  for (const [method, member] of Object.entries(runtime)) {
    wrapped[method] =
      typeof member === 'function'
        ? (...args: unknown[]) => {
            onCall(method, args)
            return (member as (...args: unknown[]) => unknown)(...args)
          }
        : member
  }
  return wrapped as unknown as ThreadRuntime
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
    sessionUsage: { ...FAKE_NO_USAGE },
    aborts: 0,
    queueClears: 0,
    continues: 0,
    incidentResolutions: [],
    modelRoles: [],
    systemPrompt: undefined,
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
  // The real host's rule (#904), by its own comparison: a record equal to the current one appends nothing.
  const setModelRole = (role: EnsoThreadModelRole | null): void => {
    if (!sameModelRole(record.modelRoles.at(-1) ?? null, role)) record.modelRoles.push(role)
  }
  const runtime: ThreadRuntime = {
    prompt: (request: PromptRequest) => {
      record.prompts.push(request)
    },
    continueRun: (outcome: PromptOutcome) => {
      record.continues += 1
      outcome.onAccepted()
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
    sessionUsage: () => record.sessionUsage,
    runHostCommand: (run: EnsoHostCommandRun, options?: { readonly byRole?: boolean }) => {
      // What the real host does: the shared decision, the set, then the state said as `model`.
      record.hostCommands.push(run)
      const decision = decideHostCommand(run, record.modelState, FAKE_MODELS)
      if (decision.kind === 'refused') return Promise.reject(new HostCommandRefused(decision.reason))
      record.modelState =
        decision.kind === 'model'
          ? { ...record.modelState, model: { ...decision.model } }
          : { ...record.modelState, thinkingLevel: decision.level }
      // A model or effort chosen by hand ends the role (#904), as the real host's does; a role's own
      // step leaves the record to its caller.
      if (options?.byRole !== true) setModelRole(null)
      emit({ kind: 'model', ...record.modelState })
      return Promise.resolve()
    },
    startHostFlow: (run: EnsoHostCommandRun, outcome: HostFlowOutcome) => {
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
            message: fakeFlowDoneText(run.name),
            notifyType: 'info',
          })
          // What the real host emits at the end, by flow: a login or logout re-announces the model
          // state; a compaction says its line and nothing else (PR #347 review).
          if (run.name !== 'compact') emit({ kind: 'model', ...record.modelState })
          outcome.onSettled()
        },
      }
      record.flows.push(entry)
    },
    // A login is waiting from its acceptance until the test settles it (#348), as the real host's
    // is until pi stores the credential; Stop's cancel settles it.
    loginInProgress: () => {
      const waiting = record.flows.find((flow) => !flow.settled && flow.run.name === 'login')
      return waiting === undefined ? undefined : { provider: waiting.run.value?.split('/')[0] ?? 'provider' }
    },
    cancelLogin: () => {
      const waiting = record.flows.find((flow) => !flow.settled && flow.run.name === 'login')
      waiting?.settle()
      return waiting !== undefined
    },
    permissionModeState: () => ({ mode: 'default', available: ['default'] }),
    setSystemPrompt: (choice: EnsoSystemPromptChoice | null) => {
      // The real host's rule (#443), over the fake's record: a prompt sent is a request sent.
      const decision = decideSystemPrompt(record.systemPrompt, choice, record.prompts.length > 0)
      if (decision.kind === 'refused') return decision.reason
      record.systemPrompt = choice ?? undefined
      return undefined
    },
    setModelRole,
    resolveIncident: (incidentId: string, resolution: EnsoIncidentResolution) => {
      // The real host's rule (#466), over the inspection's branch and what was resolved since.
      const branch = [
        ...inspection.entries.flatMap((inspected) => (inspected.kind === 'custom' ? [inspected] : [])),
        ...record.incidentResolutions.map((resolved) => ({ customType: ENSO_INCIDENT_RESOLVED_ENTRY, data: resolved })),
      ]
      const refusal = incidentResolutionRefusal(sessionIncidentsOf(branch), incidentId, resolution)
      if (refusal !== undefined) return refusal
      record.incidentResolutions.push(incidentResolvedOf(incidentId, resolution))
      return undefined
    },
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
    cwd: FAKE_PROJECT_DIRECTORY,
    sessionDir: '/fake/sessions',
    sessionFile: null,
    entries: [],
    commands: [],
    name: undefined,
    ...options.inspect,
  }
  const hosted: HostedThread = {
    runtime: options.onCall === undefined ? runtime : reporting(runtime, options.onCall),
    loadedExtensionPaths: [],
    inspect: () => inspection,
    emittedEvents: emitted.recent,
    // The fake loads no extensions: every probe is the hook's silence.
    probeToolCall: async (): Promise<undefined> => undefined,
    // …and no permission engine publishes a service for it.
    checkPermission: (): undefined => undefined,
    projectTrust: () => ({ directory: inspection.cwd, trusted: options.projectTrusted ?? false }),
    branchStats: () => options.branch ?? FAKE_EMPTY_BRANCH,
    // The eval reads the transcript the inspection holds and the branch's turns (#441).
    branchEval: () => ({
      transcript: [...inspection.entries],
      turnStats: (options.branch ?? FAKE_EMPTY_BRANCH).turnStats,
    }),
    // A fake thread opens no incident: the history's readings are core's, tested over real guard branches (#468).
    branchIncidentHistory: () => ({ incidents: [], replay: [] }),
    // Nor any judge case: the selection and redaction are core's and the host's, tested there (#469).
    branchJudgeCases: () => ({ cases: [] }),
    branchContext: () => options.context ?? FAKE_EMPTY_CONTEXT,
    previewSystemPrompt: (candidate: EnsoSystemPromptChoice | null) =>
      (options.previewSystemPrompt ?? fakeSystemPromptPreview)(candidate),
    branchRequestDetail: (request: number | 'next') => options.details?.[String(request)],
    forkPoint: () =>
      Promise.resolve(
        options.forkPoint ?? {
          identity: { threadId: inspection.sessionId, leafEntryId: inspection.entries.at(-1)?.id ?? null },
          conditions: {
            model: null,
            thinkingLevel: null,
            mode: 'default',
            cwd: inspection.cwd,
            runContext: null,
            systemPrompt: null,
          },
        },
      ),
  }
  return { hosted, record, emit, open }
}

/** What a fake host "has on disk" (#95): a stored thread by id, with its transcript and the mode it was left in. */
export interface FakeStoredThread {
  readonly transcript: EnsoTranscriptEntry[]
  readonly modified: Date
  readonly firstMessage: string
  /** The directory its header records (#395); the launch project's when absent. */
  readonly cwd?: string
  /** The mode the fake reports for this thread's branch; the fresh mode when absent. */
  readonly mode?: string
  /** What pi's rule sums over the file (#45); nothing spent when absent. */
  readonly usage?: EnsoSessionUsage
  /** What the branch records it last ran on (#434); none when absent. */
  readonly recordedModel?: EnsoRecordedModel
  /** The branch analysed (#45 phase 2); an empty branch when absent. */
  readonly branch?: BranchStats
  /** The branch's context (#361); no request when absent. */
  readonly context?: BranchContext
  /** Its requests' details, by `String(request)`. */
  readonly details?: Readonly<Record<string, BranchRequestDetail>>
  /** The thread it was forked from (#433); none when absent. */
  readonly parentThreadId?: string
  /** The name its file holds (#670); none when absent. */
  readonly name?: string
  /** Its fork point (#435); assembled from the fields above, with no run context, when absent. */
  readonly forkPoint?: EnsoForkPoint
  /** What restoring its files answers (#551) once the thread and entry are found; `no-tree` when absent. A promise holds the restore open. */
  readonly restore?: ThreadRestoreOutcome | Promise<ThreadRestoreOutcome>
  /** What its tree's inventory says when a delete is not forced (#571): the work, as the real host words it. Absent: nothing holds it. */
  readonly holdsWork?: string
}

const FAKE_FRESH_MODE: EnsoPermissionModeState = { mode: 'default', available: ['default'] }

/**
 * Where every fake session runs and every fake stored thread was made: the directory the server
 * tests launch with (`cwd: tmpdir()`), so each is in the launch project (#395). A test about
 * another directory says so on the thread (`FakeStoredThread.cwd`, `inspect.cwd`).
 */
const FAKE_PROJECT_DIRECTORY = tmpdir()

/** A branch with nothing on it: no turn, no prompt, no tool, no first entry. */
const FAKE_EMPTY_BRANCH: BranchStats = {
  branchCost: 0,
  turnStats: [],
  promptStats: [],
  callStats: [],
  firstAt: undefined,
}

/** A branch with no request on it, and nothing in its context. */
const FAKE_EMPTY_CONTEXT: BranchContext = {
  next: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 },
  requests: [],
  events: [],
  files: [],
  systemPrompt: null,
}

/**
 * The fake's providers (#904): `fake`, an API-key provider nobody set up; `faux-sub`, a
 * subscription whose login sends a page and asks for the code; and `other`, whose subscription
 * login asks a region (a `select`) and then a name for the account (`text`), storing `region:name`.
 * A login stores into `stored`, the fake's credential store. A key starting `bad-` is refused by a
 * message that QUOTES it, as a careless provider might: what the route says must not.
 */
/** The fake providers, and the credentials their logins stored. */
export type FakeProviders = HostProviders & { readonly stored: Map<string, string> }

export function createFakeProviders(): FakeProviders {
  const stored = new Map<string, string>()
  const facts = (): HostProviderFacts[] => [
    {
      id: 'fake',
      name: 'Fake AI',
      loggedIn: stored.has('fake'),
      via: stored.has('fake') ? 'api-key' : undefined,
      stored: stored.has('fake'),
      offersOAuth: false,
      offersApiKey: true,
      registered: false,
      models: [{ id: 'fake/one', name: 'Fake One' }],
    },
    {
      id: 'faux-sub',
      name: 'Faux Subscription',
      loggedIn: stored.has('faux-sub'),
      via: stored.has('faux-sub') ? 'subscription' : undefined,
      stored: stored.has('faux-sub'),
      offersOAuth: true,
      offersApiKey: false,
      registered: true,
      models: [{ id: 'faux-sub/two', name: 'Faux Two' }],
    },
    {
      id: 'other',
      name: 'Other',
      loggedIn: false,
      via: undefined,
      stored: false,
      offersOAuth: true,
      offersApiKey: true,
      registered: false,
      models: [],
    },
  ]
  return {
    stored,
    list: () => Promise.resolve(facts()),
    async logIn(providerId, authType, interaction) {
      if (providerId === 'other' && authType === 'oauth') {
        const region = await interaction.ask({
          type: 'select',
          message: 'Choose a region',
          options: [
            { id: 'eu', label: 'Europe' },
            { id: 'us', label: 'United States' },
          ],
        })
        const name = await interaction.ask({ type: 'text', message: 'Name this account', placeholder: 'work' })
        stored.set(providerId, `${region}:${name}`)
        return
      }
      if (providerId === 'faux-sub') {
        interaction.notify({ type: 'auth_url', url: 'https://login.example/authorize' })
        stored.set(providerId, await interaction.ask({ type: 'manual_code', message: 'Paste the code' }))
        return
      }
      const key = await interaction.ask({ type: 'secret', message: 'Enter Fake AI API key' })
      if (key.startsWith('bad-')) throw new Error(`Fake AI rejected the key ${key}`)
      stored.set(providerId, key)
    },
    logOut(providerId) {
      stored.delete(providerId)
      return Promise.resolve()
    },
  }
}

/**
 * The one fake of the storage seam (`docs/seams/storage.md`): an `AgentHost` whose listing
 * and branch reads come from `stored`, and whose `createSession` is the caller's — that is
 * where a test counts what was built and hands out a `createFakeHostedThread`. Its mode
 * answers are declared, not computed (L3): `fresh` is what a new thread starts in, and a
 * stored thread's mode is the one written beside its branch.
 *
 * `servesDirectory` is the real host's rule (#395), applied as the real host applies it: a
 * stored thread whose directory fails it is not listed and not read, and only
 * `storedThreadDirectory` still finds it (PR #399 review — the fake once read everything, so
 * the suite could not see what a removed project does to a reader). A server started with
 * `host: (servesDirectory) => …` hands the fake its own projects' rule; every other use serves all.
 */
export function createFakeAgentHost(
  createSession: AgentHost['createSession'],
  stored: Record<string, FakeStoredThread> = {},
  fresh: EnsoPermissionModeState = FAKE_FRESH_MODE,
  {
    servesDirectory = () => true,
    trees = { projects: [] },
  }: {
    readonly servesDirectory?: (directory: string) => boolean
    /** What `listTrees` answers (#578): no projects' trees by default — the fake has no disk. */
    readonly trees?: EnsoTreesListing
  } = {},
): AgentHost {
  const directoryOf = (storedThread: FakeStoredThread): string => storedThread.cwd ?? FAKE_PROJECT_DIRECTORY
  /** The stored thread under this id if its directory is served — what the real host reads. */
  const served = (threadId: string): FakeStoredThread | undefined => {
    const storedThread = stored[threadId]
    return storedThread !== undefined && servesDirectory(directoryOf(storedThread)) ? storedThread : undefined
  }
  /** The ids `deleteThread` removed — the real host's tombstone (#571). */
  const deleted = new Set<string>()
  /** Each thread's name (#670), by id — the session_info its file holds: the stored one's, then what `renameThread` gave. */
  const names = new Map<string, string>(
    Object.entries(stored).flatMap(([threadId, storedThread]) =>
      storedThread.name === undefined ? [] : [[threadId, storedThread.name] as const],
    ),
  )
  /**
   * The ids whose restore or undo is in flight. The real host refuses a mode change then
   * (`agent-host.ts#admitRun`), and a mode change on a held thread reaches the runtime (#618).
   */
  const restoring = new Set<string>()
  const whileRestoring = (
    threadId: string,
    outcome: ThreadRestoreOutcome | Promise<ThreadRestoreOutcome>,
  ): Promise<ThreadRestoreOutcome> => {
    restoring.add(threadId)
    return Promise.resolve(outcome).finally(() => restoring.delete(threadId))
  }
  return {
    createSession: async (threadId: string, newSessionDirectory: () => string): Promise<HostedThread> => {
      const hosted = await createSession(threadId, newSessionDirectory)
      const { setPermissionMode } = hosted.runtime
      return {
        ...hosted,
        runtime: {
          ...hosted.runtime,
          setPermissionMode: (mode: string, outcome: PromptOutcome) =>
            restoring.has(threadId)
              ? outcome.onRejected(`thread ${threadId} is restoring its files; prompt again once that is done`)
              : setPermissionMode(mode, outcome),
        },
      }
    },
    freshPermissionMode: () => fresh,
    catalogue: () => Promise.resolve(fakeCatalogue()),
    providers: createFakeProviders(),
    // A project nobody decided is untrusted (#470); a test about a trusted one replaces this.
    projectTrust: (cwd: string) => ({ directory: cwd, trusted: false }),
    storedPermissionMode: (transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState => {
      const storedThread = Object.values(stored).find((candidate) => candidate.transcript === transcript)
      return { mode: storedThread?.mode ?? fresh.mode, available: fresh.available }
    },
    listSessions: () =>
      Promise.resolve(
        Object.entries(stored).flatMap(([threadId, storedThread]) =>
          servesDirectory(directoryOf(storedThread))
            ? [
                {
                  id: threadId,
                  path: `/stored/${threadId}.jsonl`,
                  cwd: directoryOf(storedThread),
                  modified: storedThread.modified,
                  messageCount: storedThread.transcript.filter((transcriptEntry) => transcriptEntry.kind === 'message')
                    .length,
                  firstMessage: storedThread.firstMessage,
                  ...(names.get(threadId) === undefined ? {} : { name: names.get(threadId) ?? '' }),
                  ...(storedThread.parentThreadId === undefined ? {} : { parentThreadId: storedThread.parentThreadId }),
                  // The listing's model is the one the branch records, as the real file's last entry says it (#871).
                  ...(storedThread.recordedModel?.model ? { model: storedThread.recordedModel.model } : {}),
                },
              ]
            : [],
        ),
      ),
    storedThreadDirectory: (threadId: string) => {
      const storedThread = stored[threadId]
      return Promise.resolve(storedThread === undefined ? undefined : directoryOf(storedThread))
    },
    // No thread of the fake runs on a tree of its own (#650): a route test hands in its own.
    threadTree: () => Promise.resolve(undefined),
    readCopyChanges: () => Promise.reject(new Error('the fake host holds no snapshot store')),
    readCopyFileTexts: () => Promise.reject(new Error('the fake host holds no snapshot store')),
    readStoredThread: (threadId: string) => {
      const storedThread = served(threadId)
      return Promise.resolve(
        storedThread === undefined
          ? undefined
          : {
              cwd: directoryOf(storedThread),
              transcript: storedThread.transcript,
              usage: storedThread.usage ?? { ...FAKE_NO_USAGE },
              recordedModel: storedThread.recordedModel,
              name: names.get(threadId),
            },
      )
    },
    readStoredThreadStats: (threadId: string) => {
      const storedThread = served(threadId)
      return Promise.resolve(
        storedThread === undefined
          ? undefined
          : { usage: storedThread.usage ?? { ...FAKE_NO_USAGE }, branch: storedThread.branch ?? FAKE_EMPTY_BRANCH },
      )
    },
    readStoredRequestDetail: (threadId: string, request: number | 'next') =>
      Promise.resolve(served(threadId)?.details?.[String(request)]),
    readStoredThreadContext: (threadId: string) => {
      const storedThread = served(threadId)
      return Promise.resolve(
        storedThread === undefined
          ? undefined
          : { usage: storedThread.usage ?? { ...FAKE_NO_USAGE }, context: storedThread.context ?? FAKE_EMPTY_CONTEXT },
      )
    },
    readStoredThreadEval: (threadId: string) => {
      const storedThread = served(threadId)
      return Promise.resolve(
        storedThread === undefined
          ? undefined
          : {
              transcript: [...storedThread.transcript],
              turnStats: (storedThread.branch ?? FAKE_EMPTY_BRANCH).turnStats,
            },
      )
    },
    readStoredIncidentHistory: (threadId: string) =>
      Promise.resolve(served(threadId) === undefined ? undefined : { incidents: [], replay: [] }),
    readStoredJudgeCases: (threadId: string) =>
      Promise.resolve(served(threadId) === undefined ? undefined : { cases: [] }),
    // The branch's fork point (#435): the one the thread declares, else its facts with no run context.
    readStoredForkPoint: (threadId: string) => {
      const storedThread = served(threadId)
      if (storedThread === undefined) return Promise.resolve(undefined)
      return Promise.resolve(
        storedThread.forkPoint ?? {
          identity: {
            threadId,
            leafEntryId: storedThread.transcript.at(-1)?.id ?? null,
            ...(storedThread.parentThreadId === undefined ? {} : { parentThreadId: storedThread.parentThreadId }),
          },
          conditions: {
            model: storedThread.recordedModel?.model ?? null,
            thinkingLevel: storedThread.recordedModel?.thinkingLevel ?? null,
            mode: storedThread.mode ?? fresh.mode,
            cwd: directoryOf(storedThread),
            runContext: null,
            systemPrompt: null,
          },
        },
      )
    },
    // The real host's refusals, decided over the stored transcript; a fork is `<id>-fork`.
    forkThread: (threadId: string, entryId: string) => {
      const entry = served(threadId)?.transcript.find((candidate) => candidate.id === entryId)
      if (served(threadId) === undefined) return Promise.resolve({ kind: 'no-thread', reason: `no thread ${threadId}` })
      if (entry === undefined) return Promise.resolve({ kind: 'no-entry', reason: `no entry ${entryId}` })
      if (entry.kind !== 'message' || entry.role !== 'user') {
        return Promise.resolve({ kind: 'not-a-user-message', reason: `entry ${entryId} is not a user message` })
      }
      const prefill = entry.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
      return Promise.resolve({ kind: 'forked', threadId: `${threadId}-fork`, prefill })
    },
    // The real host's lookups over the stored transcript; past them, the thread's scripted outcome.
    mintsTreesIn: () => false,
    restoreThreadAt: (threadId: string, entryId: string): Promise<ThreadRestoreOutcome> => {
      const storedThread = served(threadId)
      if (storedThread === undefined) return Promise.resolve({ kind: 'no-thread', reason: `no thread ${threadId}` })
      if (!storedThread.transcript.some((candidate) => candidate.id === entryId)) {
        return Promise.resolve({ kind: 'no-entry', reason: `no entry ${entryId}` })
      }
      return storedThread.restore === undefined
        ? Promise.resolve({ kind: 'no-tree', reason: `thread ${threadId} has no tree` })
        : whileRestoring(threadId, storedThread.restore)
    },
    undoLastRestore: (threadId: string): Promise<ThreadRestoreOutcome> => {
      const storedThread = served(threadId)
      if (storedThread === undefined) return Promise.resolve({ kind: 'no-thread', reason: `no thread ${threadId}` })
      return storedThread.restore === undefined
        ? Promise.resolve({ kind: 'no-tree', reason: `thread ${threadId} has no tree` })
        : whileRestoring(threadId, storedThread.restore)
    },
    // A name lands on the file (#670): the listing and the history read it back from then on.
    renameThread: (threadId: string, name: string): Promise<ThreadRenameOutcome> => {
      if (served(threadId) === undefined) return Promise.resolve({ kind: 'no-thread', reason: `no thread ${threadId}` })
      names.set(threadId, name)
      return Promise.resolve({ kind: 'renamed' })
    },
    // The real host's order (#571): unknown, then the inventory — force takes only the work its
    // digest confirms (PR #572 review) — then the live session's retire; deleted, the thread is
    // gone from the fake's disk.
    deleteThread: (threadId, { force, confirmedWork, retire }): Promise<ThreadDeleteOutcome> => {
      const storedThread = served(threadId)
      if (storedThread === undefined) return Promise.resolve({ kind: 'no-thread', reason: `no thread ${threadId}` })
      const held = storedThread.holdsWork
      if (held !== undefined && !(force && confirmedWork === createHash('sha256').update(held).digest('hex'))) {
        return Promise.resolve({ kind: 'holds-work', reason: held })
      }
      if (!retire()) return Promise.resolve({ kind: 'busy', reason: `thread ${threadId} is running` })
      Reflect.deleteProperty(stored, threadId)
      deleted.add(threadId)
      return Promise.resolve({ kind: 'deleted' })
    },
    threadDeleted: (threadId) => deleted.has(threadId),
    // The real host's preview (#571), as far as the fake's disk goes: no trees, no forks.
    previewThreadDelete: (threadId) => {
      const storedThread = served(threadId)
      if (storedThread === undefined) return Promise.resolve({ kind: 'no-thread', reason: `no thread ${threadId}` })
      return Promise.resolve({
        kind: 'preview',
        preview: { tree: null, size: null, holdsWork: storedThread.holdsWork ?? null, keptFor: [] },
      })
    },
    listTrees: () => Promise.resolve(trees),
  }
}
