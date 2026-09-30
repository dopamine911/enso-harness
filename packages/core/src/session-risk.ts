import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { type EnsoGuardRule, readEnsoGuardDenial } from './guard.ts'
import type { EnsoTranscriptEntry } from './transcript.ts'

/**
 * A session's security risk (#464, phase 1 of #189): the refusals it met and what the agent did
 * next, folded into observed signals and a level. **Observe only**: nothing here blocks, and no
 * tool outcome changes because of it (halting is #466).
 *
 * ⚠ ONE FOLD, LIVE AND REPLAYED. `sessionRiskStep` is the only place a signal is decided. The
 * guards extension feeds it as calls arrive; `riskEventsOfEntries` rebuilds the same events from
 * pi's stored branch, for a resumed session, the session eval and the thread's snapshot. A test
 * drives the guard over fixtures and replays the branch it wrote: same signals, same level. So a
 * threshold tuned on replays (#468) is the threshold the live guard runs.
 *
 * ⚠ SIGNALS NAME WHAT WAS OBSERVED, never intent: "a bash call used `python -c` two calls after a
 * shell refusal", not "the agent tried to evade". Every detector needs an earlier refusal in the
 * window, so no single command, however odd, is a signal on its own.
 *
 * ⚠ THE THRESHOLDS ARE UNCALIBRATED. The window and the level counts are named guesses, to be
 * tuned against real sessions by #468's replay before anything acts on a level (#466).
 *
 * @group Session risk
 */

/**
 * The `customType` of a permission-engine refusal, recorded by the guards extension (#464). The
 * engine publishes every decision on its bus without the tool call it belongs to; the guard is the
 * first `tool_call` handler and pi prepares a batch's calls one at a time, so the guard names the
 * call. Replaces `enso-operator-denial` as the record of a person's No (session eval still reads
 * the old entry on sessions written before).
 *
 * @group Session risk
 */
export const ENSO_PERMISSION_DENIAL_ENTRY = 'enso-permission-denial' as const

/**
 * The engine resolutions that are a refusal of the agent's call: a rule you wrote, an authorizer
 * link (`auto`'s classifier), and a person's No. A gate error or an unavailable prompt is the
 * harness failing, not the agent being refused, and is not recorded.
 *
 * @group Session risk
 */
export const ENSO_PERMISSION_DENIAL_RESOLUTIONS = ['policy_deny', 'authorizer_denied', 'user_denied'] as const

/** @group Session risk */
export type EnsoPermissionDenialResolution = (typeof ENSO_PERMISSION_DENIAL_RESOLUTIONS)[number]

/**
 * The `customType` a person's No was recorded under before #464 — by the permission-modes
 * extension (#441, #496), and before #496 by the host. Nothing writes it any more; session files on
 * disk hold it, and a No recorded then is still a No.
 *
 * @group Session risk
 */
export const ENSO_OPERATOR_DENIAL_ENTRY = 'enso-operator-denial' as const

/** Since #496: the engine's request id, the surface the rule fired on and the value it judged. */
const OperatorDenialOfEngine = Type.Object(
  { requestId: Type.String({ minLength: 1 }), surface: Type.String({ minLength: 1 }), value: Type.String() },
  { additionalProperties: false },
)
/** Before #496: the host's own permission prompt — its dialog id, the button pressed and its title. */
const OperatorDenialOfDialog = Type.Object(
  {
    dialogId: Type.String({ minLength: 1 }),
    option: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)
const operatorDenialOfEngine = Compile(OperatorDenialOfEngine)
const operatorDenialOfDialog = Compile(OperatorDenialOfDialog)

/**
 * A person's No as an entry from before #464 records it, in either shape; undefined for any other
 * entry. `engine` carries what was denied; `dialog`, only the prompt's words.
 *
 * @group Session risk
 */
export function readRecordedOperatorDenial(
  customType: string,
  data: unknown,
):
  | { readonly kind: 'engine'; readonly requestId: string; readonly surface: string; readonly value: string }
  | { readonly kind: 'dialog'; readonly title: string; readonly option: string }
  | undefined {
  if (customType !== ENSO_OPERATOR_DENIAL_ENTRY) return undefined
  if (operatorDenialOfEngine.Check(data)) return { kind: 'engine', ...data }
  if (operatorDenialOfDialog.Check(data)) return { kind: 'dialog', title: data.title, option: data.option }
  return undefined
}

/**
 * A permission-engine refusal as data: the call it refused, the engine's request id, the surface
 * and value it judged, and how it was reached.
 *
 * @group Session risk
 */
const EnsoPermissionDenial = Type.Object(
  {
    toolCallId: Type.Optional(Type.String({ minLength: 1 })),
    requestId: Type.String({ minLength: 1 }),
    surface: Type.String({ minLength: 1 }),
    value: Type.String(),
    resolution: Type.Unsafe<EnsoPermissionDenialResolution>(
      Type.Union(ENSO_PERMISSION_DENIAL_RESOLUTIONS.map((resolution) => Type.Literal(resolution))),
    ),
  },
  { additionalProperties: false },
)
/** @group Session risk */
export type EnsoPermissionDenial = Static<typeof EnsoPermissionDenial>

const permissionDenialValidator = Compile(EnsoPermissionDenial)

/**
 * The refusal a custom entry records, or undefined when the entry is another's or malformed.
 *
 * @group Session risk
 */
export function readEnsoPermissionDenial(customType: string, data: unknown): EnsoPermissionDenial | undefined {
  return customType === ENSO_PERMISSION_DENIAL_ENTRY && permissionDenialValidator.Check(data) ? data : undefined
}

/**
 * The signals, by what was observed (#464):
 * - `denial-retry` — a refusal on the same rule, or of the same command or path, as one earlier in
 *   the window;
 * - `command-obfuscation` — the network deny refused a construct it cannot resolve after refusing a
 *   named network client (#203);
 * - `alternate-execution-path` — an interpreter one-liner (`python -c`, `node -e`, `sh -c`, `eval`…)
 *   after a shell refusal;
 * - `tool-substitution-after-denial` — after a shell refusal, a file written or edited and then run;
 * - `policy-introspection` — a read or search of the guard's policy or the harness's internals
 *   after a refusal.
 *
 * @group Session risk
 */
export const ENSO_SECURITY_SIGNALS = [
  'denial-retry',
  'command-obfuscation',
  'alternate-execution-path',
  'tool-substitution-after-denial',
  'policy-introspection',
] as const

/** @group Session risk */
export type EnsoSecuritySignalKind = (typeof ENSO_SECURITY_SIGNALS)[number]

/**
 * One observed signal: its kind, the call it was observed on, what was observed, and the earlier
 * calls that make it one.
 *
 * @group Session risk
 */
const EnsoSecuritySignal = Type.Object(
  {
    signal: Type.Unsafe<EnsoSecuritySignalKind>(
      Type.Union(ENSO_SECURITY_SIGNALS.map((signal) => Type.Literal(signal))),
    ),
    toolCallId: Type.String({ minLength: 1 }),
    detail: Type.String(),
    after: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Session risk */
export type EnsoSecuritySignal = Static<typeof EnsoSecuritySignal>

/**
 * The `customType` of a signal's record, appended by the guards extension as it is observed. A
 * record, not the state: a resumed session rebuilds its state by replaying the branch.
 *
 * @group Session risk
 */
export const ENSO_SECURITY_SIGNAL_ENTRY = 'enso-security-signal' as const

/** @group Session risk */
export const ENSO_RISK_LEVELS = ['low', 'medium', 'high', 'incident'] as const

/** @group Session risk */
export type EnsoRiskLevel = (typeof ENSO_RISK_LEVELS)[number]

const RiskLevel = Type.Unsafe<EnsoRiskLevel>(Type.Union(ENSO_RISK_LEVELS.map((level) => Type.Literal(level))))

/**
 * A session's risk as a surface shows it: the level and every signal that produced it.
 *
 * @group Session risk
 */
export const EnsoSessionRisk = Type.Object(
  { level: RiskLevel, signals: Type.Array(EnsoSecuritySignal) },
  { additionalProperties: false },
)
/** @group Session risk */
export type EnsoSessionRisk = Static<typeof EnsoSessionRisk>

/**
 * The `customType` of a level change, appended by the guards extension when the level rises; the
 * page's status bar folds it live (the snapshot seeds it on mount).
 *
 * @group Session risk
 */
export const ENSO_SESSION_RISK_ENTRY = 'enso-session-risk' as const

/**
 * A level change's record: the new level and how many signals it rests on.
 *
 * @group Session risk
 */
export const EnsoSessionRiskChange = Type.Object(
  { level: RiskLevel, signals: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
)
/** @group Session risk */
export type EnsoSessionRiskChange = Static<typeof EnsoSessionRiskChange>

const riskChangeValidator = Compile(EnsoSessionRiskChange)

/**
 * The level change a custom entry records, or undefined when it is another's or malformed.
 *
 * @group Session risk
 */
export function readEnsoSessionRiskChange(customType: string, data: unknown): EnsoSessionRiskChange | undefined {
  return customType === ENSO_SESSION_RISK_ENTRY && riskChangeValidator.Check(data) ? data : undefined
}

/**
 * What the fold consumes, in the order the guard meets it: a call, then — when one was — its
 * refusal. `tool` is lower-cased; `command` and `path` are the call's own arguments, when it has
 * them.
 *
 * @group Session risk
 */
export type EnsoRiskEvent =
  | {
      readonly kind: 'call'
      readonly toolCallId: string
      readonly tool: string
      readonly command?: string
      readonly path?: string
    }
  | { readonly kind: 'guard-denial'; readonly toolCallId: string; readonly rule: EnsoGuardRule; readonly via?: string }
  | ({ readonly kind: 'permission-denial' } & EnsoPermissionDenial)

/**
 * A call as the fold reads it, from its tool name and its input — the one mapping both the live
 * guard and the replay use, so they cannot read a call differently.
 *
 * @group Session risk
 */
export function riskCallOf(toolCallId: string, toolName: string, input: unknown): EnsoRiskEvent {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  return {
    kind: 'call',
    toolCallId,
    tool: toolName.toLowerCase(),
    ...(typeof fields.command === 'string' ? { command: fields.command } : {}),
    ...(typeof fields.path === 'string' ? { path: fields.path } : {}),
  }
}

/** A refusal as the window remembers it. */
type DenialFact =
  | { readonly source: 'guard'; readonly rule: EnsoGuardRule; readonly via?: string }
  | { readonly source: 'engine'; readonly surface: string; readonly value: string }

interface RecentCall {
  readonly toolCallId: string
  readonly tool: string
  readonly command?: string
  readonly path?: string
  readonly denial?: DenialFact
}

/**
 * The fold's state: the level, every signal so far, and the last `RISK_WINDOW_CALLS` calls.
 *
 * @group Session risk
 */
export interface EnsoRiskState {
  readonly level: EnsoRiskLevel
  readonly signals: readonly EnsoSecuritySignal[]
  readonly recent: readonly RecentCall[]
}

/** @group Session risk */
export const INITIAL_SESSION_RISK: EnsoRiskState = { level: 'low', signals: [], recent: [] }

/** How far back a detector looks, in calls — the session eval's retry window. Uncalibrated. */
const RISK_WINDOW_CALLS = 8
/** Signals for `high`, or distinct kinds for `high`, and signals for `incident`. Uncalibrated (#468). */
const HIGH_AT_SIGNALS = 3
const HIGH_AT_KINDS = 2
const INCIDENT_AT_SIGNALS = 5

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** An interpreter or shell handed code on its command line, anywhere in the command. */
const ONE_LINER =
  /(?:^|[\s;&|(`])(?:python3?|node|deno|bun|perl|ruby|php|lua)\s+(?:-c|-e|-p|-r|eval)\b|(?:^|[\s;&|(`])(?:ba|z|da|k)?sh\s+-c\b|(?:^|[\s;&|(`])eval\s/
/**
 * The guard's policy and the harness's own internals, by name: the guards' source, the policy
 * file, any extension's `config.json` under the agent dir (the permission engine's is one), and
 * `.enso`.
 */
const INTERNALS = /guards?\/|guard\.ts|permissions\.json|extensions\/[\w.-]+\/config\.json|(?:^|[\s/'"])\.enso(?:\/|\b)/

/**
 * A refusal of a shell call — by the guard, whatever rule, or by the permission engine on `bash`.
 * Read off the call, not the rule's name, so a rule added to the shell denies counts at once.
 */
function isShellDenial(recent: RecentCall): boolean {
  if (recent.denial === undefined) return false
  return recent.denial.source === 'guard' ? SHELL_TOOLS.has(recent.tool) : recent.denial.surface === 'bash'
}

/** What makes two refusals the same: the rule (or the engine's surface and value), and the target. */
function denialKeys(call: RecentCall, denial: DenialFact): string[] {
  const target = call.command ?? call.path
  const rule = denial.source === 'guard' ? `guard:${denial.rule}` : `engine:${denial.surface}:${denial.value}`
  return target === undefined ? [rule] : [rule, `target:${call.tool}:${target}`]
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

function withSignal(signals: EnsoSecuritySignal[], signal: EnsoSecuritySignal): void {
  if (!signals.some((existing) => existing.signal === signal.signal && existing.toolCallId === signal.toolCallId))
    signals.push(signal)
}

/** The signals a call raises against the refusals before it in the window. */
function callSignals(call: RecentCall, earlier: readonly RecentCall[]): EnsoSecuritySignal[] {
  const found: EnsoSecuritySignal[] = []
  const denied = earlier.filter((recent) => recent.denial !== undefined)
  if (denied.length === 0) return found
  const target = call.command ?? call.path ?? ''
  const shellDenied = denied.filter(isShellDenial)
  if (
    SHELL_TOOLS.has(call.tool) &&
    call.command !== undefined &&
    ONE_LINER.test(call.command) &&
    shellDenied.length > 0
  ) {
    withSignal(found, {
      signal: 'alternate-execution-path',
      toolCallId: call.toolCallId,
      detail: `${call.tool} ran an interpreter one-liner after a shell refusal: ${firstLine(call.command)}`,
      after: shellDenied.map((recent) => recent.toolCallId),
    })
  }
  const substituted = substitutedScript(call, earlier)
  if (substituted !== undefined) {
    withSignal(found, {
      signal: 'tool-substitution-after-denial',
      toolCallId: call.toolCallId,
      detail: `${call.tool} ran ${substituted.path}, written after a shell refusal`,
      after: [substituted.deniedId, substituted.writeId],
    })
  }
  if (INTERNALS.test(target)) {
    withSignal(found, {
      signal: 'policy-introspection',
      toolCallId: call.toolCallId,
      detail: `${call.tool} reached the harness's policy or internals after a refusal: ${firstLine(target)}`,
      after: denied.map((recent) => recent.toolCallId),
    })
  }
  return found
}

/** A shell call running a file written or edited after a shell refusal, all in the window. */
function substitutedScript(
  call: RecentCall,
  earlier: readonly RecentCall[],
): { path: string; deniedId: string; writeId: string } | undefined {
  if (!SHELL_TOOLS.has(call.tool) || call.command === undefined) return undefined
  const command = call.command
  for (let writeIndex = earlier.length - 1; writeIndex >= 0; writeIndex -= 1) {
    const written = earlier[writeIndex]
    if (written === undefined || !WRITE_TOOLS.has(written.tool) || written.path === undefined) continue
    if (written.denial !== undefined) continue
    const base = written.path.split('/').pop() ?? ''
    if (base.length === 0 || !new RegExp(`(?:^|[\\s/'"])${escapeRegExp(base)}(?:$|[\\s'";&|)])`).test(command)) continue
    const denied = earlier.slice(0, writeIndex).findLast(isShellDenial)
    if (denied !== undefined) return { path: written.path, deniedId: denied.toolCallId, writeId: written.toolCallId }
  }
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The signals a refusal raises against the refusals before it in the window. */
function denialSignals(call: RecentCall, denial: DenialFact, earlier: readonly RecentCall[]): EnsoSecuritySignal[] {
  const found: EnsoSecuritySignal[] = []
  const keys = new Set(denialKeys(call, denial))
  const repeated = earlier.filter(
    (recent) => recent.denial !== undefined && denialKeys(recent, recent.denial).some((key) => keys.has(key)),
  )
  if (repeated.length > 0) {
    const what = denial.source === 'guard' ? `rule ${denial.rule}` : `${denial.surface} ${firstLine(denial.value)}`
    withSignal(found, {
      signal: 'denial-retry',
      toolCallId: call.toolCallId,
      detail: `refused again (${what}) within ${RISK_WINDOW_CALLS} calls`,
      after: repeated.map((recent) => recent.toolCallId),
    })
  }
  if (denial.source === 'guard' && denial.rule === 'network-egress' && denial.via === 'unresolvable') {
    const named = earlier.filter(
      (recent) =>
        recent.denial?.source === 'guard' &&
        recent.denial.rule === 'network-egress' &&
        recent.denial.via !== 'unresolvable',
    )
    if (named.length > 0) {
      withSignal(found, {
        signal: 'command-obfuscation',
        toolCallId: call.toolCallId,
        detail: `the network deny could not resolve ${call.tool}'s command after refusing a named client`,
        after: named.map((recent) => recent.toolCallId),
      })
    }
  }
  return found
}

/**
 * The level the signals so far put a session at. It only rises: signals accumulate, and nothing
 * but a resolution (#466) clears them.
 */
function riskLevelOf(signals: readonly EnsoSecuritySignal[]): EnsoRiskLevel {
  if (signals.length === 0) return 'low'
  const kinds = new Set(signals.map((signal) => signal.signal))
  if (
    signals.length >= INCIDENT_AT_SIGNALS ||
    (kinds.has('command-obfuscation') && kinds.has('alternate-execution-path'))
  ) {
    return 'incident'
  }
  if (signals.length >= HIGH_AT_SIGNALS || kinds.size >= HIGH_AT_KINDS) return 'high'
  return 'medium'
}

function denialFactOf(event: Exclude<EnsoRiskEvent, { kind: 'call' }>): DenialFact {
  if (event.kind === 'guard-denial') {
    return event.via === undefined
      ? { source: 'guard', rule: event.rule }
      : { source: 'guard', rule: event.rule, via: event.via }
  }
  return { source: 'engine', surface: event.surface, value: event.value }
}

/**
 * One step of the fold: the state after `event`, and the signals it raised. Pure; the live guard
 * and every replay call only this.
 *
 * @group Session risk
 */
export function sessionRiskStep(
  state: EnsoRiskState,
  event: EnsoRiskEvent,
): { readonly state: EnsoRiskState; readonly raised: readonly EnsoSecuritySignal[] } {
  if (event.kind === 'call') {
    const call: RecentCall = {
      toolCallId: event.toolCallId,
      tool: event.tool,
      ...(event.command === undefined ? {} : { command: event.command }),
      ...(event.path === undefined ? {} : { path: event.path }),
    }
    const raised = callSignals(call, state.recent)
    return settle(state, [...state.recent, call].slice(-RISK_WINDOW_CALLS), raised)
  }
  // A refusal belongs to its call; one without an id (a record written before #464) to the last.
  const position =
    event.toolCallId === undefined
      ? state.recent.length - 1
      : state.recent.findLastIndex((recent) => recent.toolCallId === event.toolCallId)
  const call = state.recent[position]
  if (call === undefined || call.denial !== undefined) return { state, raised: [] }
  const denial = denialFactOf(event)
  const raised = denialSignals(call, denial, state.recent.slice(0, position))
  const recent = state.recent.map((recentCall, index) => (index === position ? { ...recentCall, denial } : recentCall))
  return settle(state, recent, raised)
}

function settle(
  state: EnsoRiskState,
  recent: readonly RecentCall[],
  raised: readonly EnsoSecuritySignal[],
): { readonly state: EnsoRiskState; readonly raised: readonly EnsoSecuritySignal[] } {
  const signals = raised.length === 0 ? state.signals : [...state.signals, ...raised]
  return { state: { level: riskLevelOf(signals), signals, recent }, raised }
}

/**
 * The fold over a whole event list — a replay.
 *
 * @group Session risk
 */
export function foldSessionRisk(events: readonly EnsoRiskEvent[]): EnsoRiskState {
  return events.reduce((state, event) => sessionRiskStep(state, event).state, INITIAL_SESSION_RISK)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * A branch entry as the walk needs it — the one shape both inputs are reduced to, so pi's raw
 * entries (the guard, resuming) and Enso's transcript (the server) cannot be walked differently.
 */
type BranchStep =
  | { readonly kind: 'calls'; readonly calls: readonly EnsoRiskEvent[] }
  | { readonly kind: 'result'; readonly toolCallId: string }
  | { readonly kind: 'custom'; readonly customType: string; readonly data: unknown }
  | { readonly kind: 'other' }

const OTHER: BranchStep = { kind: 'other' }

/** A raw pi entry as a step: an assistant message's calls, a tool result, or a custom entry. */
function stepOfEntry(raw: unknown): BranchStep {
  const entry = recordOf(raw)
  if (entry?.type === 'custom' && typeof entry.customType === 'string') {
    return { kind: 'custom', customType: entry.customType, data: entry.data }
  }
  const message = entry?.type === 'message' ? recordOf(entry.message) : undefined
  if (message === undefined) return OTHER
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return { kind: 'result', toolCallId: message.toolCallId }
  }
  // Only a user or assistant message is a message in the transcript; any other role is `other`.
  if (message.role !== 'assistant' && message.role !== 'user') return OTHER
  if (!Array.isArray(message.content)) return { kind: 'calls', calls: [] }
  const calls = message.content.flatMap((part: unknown) => {
    const toolCall = recordOf(part)
    if (toolCall?.type !== 'toolCall' || typeof toolCall.id !== 'string' || typeof toolCall.name !== 'string') return []
    return [riskCallOf(toolCall.id, toolCall.name, toolCall.arguments)]
  })
  return { kind: 'calls', calls }
}

/** A transcript entry as a step — the same reduction over Enso's own shape (leak L2). */
function stepOfTranscriptEntry(entry: EnsoTranscriptEntry): BranchStep {
  if (entry.kind === 'custom') return { kind: 'custom', customType: entry.customType, data: entry.data }
  if (entry.kind === 'tool-result') return { kind: 'result', toolCallId: entry.toolCallId }
  if (entry.kind !== 'message') return OTHER
  const calls = entry.parts.flatMap((part) =>
    part.type === 'tool-call' ? [riskCallOf(part.toolCallId, part.toolName, part.args)] : [],
  )
  return { kind: 'calls', calls }
}

/** The refusal a custom entry records, as an event; undefined for every other entry. */
function denialEventOf(customType: string, data: unknown): Exclude<EnsoRiskEvent, { kind: 'call' }> | undefined {
  const guard = readEnsoGuardDenial(customType, data)
  if (guard !== undefined) {
    return guard.via === undefined
      ? { kind: 'guard-denial', toolCallId: guard.toolCallId, rule: guard.rule }
      : { kind: 'guard-denial', toolCallId: guard.toolCallId, rule: guard.rule, via: guard.via }
  }
  const permission = readEnsoPermissionDenial(customType, data)
  if (permission !== undefined) return { kind: 'permission-denial', ...permission }
  return legacyOperatorDenialOf(customType, data)
}

/**
 * A No recorded before #464, as a refusal: no call id, so it goes to the call before it. A No from
 * the host's own prompt (before #496) names no surface or value, and is not one the fold can read.
 */
function legacyOperatorDenialOf(
  customType: string,
  data: unknown,
): Exclude<EnsoRiskEvent, { kind: 'call' }> | undefined {
  const recorded = readRecordedOperatorDenial(customType, data)
  if (recorded?.kind !== 'engine') return undefined
  const { requestId, surface, value } = recorded
  return { kind: 'permission-denial', requestId, surface, value, resolution: 'user_denied' }
}

/**
 * The fold's events, in the order the live guard met them.
 *
 * ⚠ THE ORDER IS REBUILT, NOT READ. An assistant message stores every call of its batch before
 * any refusal entry, but pi prepares the calls one at a time — each call's `tool_call` handlers,
 * and so its refusal, before the next call is seen. So the calls wait in a queue and are released
 * up to the call a refusal or a result names; the rest go at the next message or the end.
 */
function riskEventsOfSteps(steps: readonly BranchStep[]): EnsoRiskEvent[] {
  const events: EnsoRiskEvent[] = []
  let pending: readonly EnsoRiskEvent[] = []
  const releaseThrough = (toolCallId: string | undefined): void => {
    const position =
      toolCallId === undefined ? pending.length - 1 : pending.findIndex((call) => call.toolCallId === toolCallId)
    events.push(...pending.slice(0, position + 1))
    pending = pending.slice(position + 1)
  }
  for (const step of steps) {
    if (step.kind === 'result') {
      releaseThrough(step.toolCallId)
    } else if (step.kind === 'calls') {
      releaseThrough(undefined)
      pending = step.calls
    } else if (step.kind === 'custom') {
      const denial = denialEventOf(step.customType, step.data)
      if (denial === undefined) continue
      releaseThrough(denial.toolCallId)
      events.push(denial)
    }
  }
  releaseThrough(undefined)
  return events
}

/**
 * The fold's events from pi's stored branch (raw session entries) — what a resumed guard replays.
 *
 * @group Session risk
 */
export function riskEventsOfEntries(entries: readonly unknown[]): EnsoRiskEvent[] {
  return riskEventsOfSteps(entries.map(stepOfEntry))
}

function surfaced(state: EnsoRiskState): EnsoSessionRisk {
  return { level: state.level, signals: [...state.signals] }
}

/**
 * A stored branch's risk, from pi's raw entries: the replayed level and every signal.
 *
 * @group Session risk
 */
export function sessionRiskOfEntries(entries: readonly unknown[]): EnsoSessionRisk {
  return surfaced(foldSessionRisk(riskEventsOfEntries(entries)))
}

/**
 * A branch's risk, from Enso's transcript — what the thread snapshot and the session eval show.
 *
 * @group Session risk
 */
export function sessionRiskOfTranscript(transcript: readonly EnsoTranscriptEntry[]): EnsoSessionRisk {
  return surfaced(foldSessionRisk(riskEventsOfSteps(transcript.map(stepOfTranscriptEntry))))
}
