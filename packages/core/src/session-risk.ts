import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { commandConstructOf } from './command-constructs.ts'
import { ENSO_GUARD_RULES, type EnsoGuardRule, readEnsoGuardDenial } from './guard.ts'
import { readEnsoThreadTree } from './thread-tree-record.ts'
import type { EnsoTranscriptEntry } from './transcript.ts'

/**
 * A session's security risk (#464, phase 1 of #189): the refusals it met and what the agent did
 * next, folded into observed signals and a level. **Observe only**: nothing here blocks, and no
 * tool outcome changes because of it (halting is #466).
 *
 * ⚠ ONE FOLD, LIVE AND REPLAYED. `sessionRiskStep` is the only place a signal is decided. The
 * guards extension feeds it as calls arrive; `riskEventsOfTranscript` rebuilds the same events from
 * the stored branch as our transcript, for a resumed session, the session eval and the thread's snapshot. A test
 * drives the guard over fixtures and replays the branch it wrote: same signals, same level. So a
 * threshold tuned on replays (#468) is the threshold the live guard runs.
 *
 * ⚠ SIGNALS NAME WHAT WAS OBSERVED, never intent: "a bash call used `python -c` two calls after a
 * shell refusal", not "the agent tried to evade". Every detector but two needs an earlier refusal in
 * the window, so no single command, however odd, is a signal on its own — except one that reaches
 * the records an incident rests on (`protected-record-touch`, #466) or a config tier
 * (`config-tier-touch`, #753): reaching them is the observation.
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
 * Who refused a tool call (#523), the one vocabulary the page draws a refusal by — the guard's
 * `enso-guard-denial` and the engine's `enso-permission-denial` both resolve to it: Enso's guard
 * with the rule that refused, a permission rule the user wrote (`policy_deny`), `auto`'s
 * classifier (`authorizer_denied`), or the person (`user_denied`).
 *
 * @group Session risk
 */
export const ENSO_TOOL_REFUSERS = ['guard', 'rule', 'auto', 'operator'] as const

/** @group Session risk */
export type EnsoToolRefuser = (typeof ENSO_TOOL_REFUSERS)[number]

/**
 * A refusal as a tool result carries it, under {@link ENSO_TOOL_REFUSAL_KEY}: who refused, and the
 * guard's rule when it was the guard. The reason is the result's own text, as before (#387).
 *
 * @group Session risk
 */
export const EnsoToolRefusal = Type.Union([
  Type.Object(
    {
      by: Type.Literal('guard'),
      rule: Type.Unsafe<EnsoGuardRule>(Type.Union(ENSO_GUARD_RULES.map((rule) => Type.Literal(rule)))),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { by: Type.Union([Type.Literal('rule'), Type.Literal('auto'), Type.Literal('operator')]) },
    { additionalProperties: false },
  ),
])
/** @group Session risk */
export type EnsoToolRefusal = Static<typeof EnsoToolRefusal>

/**
 * The tool-result metadata key a refusal rides under on a stored result — beside
 * `ENSO_TOOL_RESULT_KEY`, namespaced the same way and for the same reason (no dot).
 *
 * @group Session risk
 */
export const ENSO_TOOL_REFUSAL_KEY = 'enso:refusal' as const

const toolRefusalValidator = Compile(EnsoToolRefusal)

/**
 * Who an engine resolution says refused: a rule, `auto`'s classifier, or the person.
 *
 * @group Session risk
 */
export function toolRefuserOf(resolution: EnsoPermissionDenialResolution): Exclude<EnsoToolRefuser, 'guard'> {
  if (resolution === 'policy_deny') return 'rule'
  return resolution === 'authorizer_denied' ? 'auto' : 'operator'
}

/**
 * The refusal a custom entry records — the guard's or the engine's — as the call it refused and
 * who refused it; undefined for another entry, a malformed one, or an engine refusal that names
 * no call (a mode probe's, say).
 *
 * @group Session risk
 */
export function toolRefusalOf(
  customType: string,
  data: unknown,
): { readonly toolCallId: string; readonly refusal: EnsoToolRefusal } | undefined {
  const guard = readEnsoGuardDenial(customType, data)
  if (guard !== undefined) return { toolCallId: guard.toolCallId, refusal: { by: 'guard', rule: guard.rule } }
  const engine = readEnsoPermissionDenial(customType, data)
  if (engine?.toolCallId === undefined) return undefined
  return { toolCallId: engine.toolCallId, refusal: { by: toolRefuserOf(engine.resolution) } }
}

/**
 * The refusal a tool result's metadata carries (see {@link ENSO_TOOL_REFUSAL_KEY}), or undefined.
 *
 * @group Session risk
 */
export function readEnsoToolRefusalMetadata(
  metadata: Record<string, unknown> | undefined,
): EnsoToolRefusal | undefined {
  const candidate = metadata?.[ENSO_TOOL_REFUSAL_KEY]
  return toolRefusalValidator.Check(candidate) ? candidate : undefined
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
 *   after a refusal;
 * - `protected-record-touch` — a shell command naming the session or log directory (#466);
 * - `config-tier-touch` — a write or edit of a config tier file (`.enso/config.json`,
 *   `.enso/config.local.json`), or a shell command naming one (#753).
 *
 * The last two need no refusal before them.
 *
 * @group Session risk
 */
export const ENSO_SECURITY_SIGNALS = [
  'denial-retry',
  'command-obfuscation',
  'alternate-execution-path',
  'tool-substitution-after-denial',
  'policy-introspection',
  'protected-record-touch',
  'config-tier-touch',
] as const

/** @group Session risk */
export type EnsoSecuritySignalKind = (typeof ENSO_SECURITY_SIGNALS)[number]

/**
 * One observed signal: its kind, the call it was observed on, what was observed, and the earlier
 * calls that make it one.
 *
 * @group Session risk
 */
export const EnsoSecuritySignal = Type.Object(
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
 * The `customType` of a human's resolution of an incident (#466), appended by the host through the
 * resolve route. Here, not in `session-incident.ts`, because the risk fold reads it — a resolution
 * is the one thing that resets a session's risk — and that module builds on this one.
 *
 * @group Session risk
 */
export const ENSO_INCIDENT_RESOLVED_ENTRY = 'enso-incident-resolved' as const

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
  /** A human resolved the session's incident (#466): the risk starts over — it resets only here. */
  | { readonly kind: 'incident-resolved' }
  /**
   * The thread's own working tree, as its branch records it (`enso-thread-tree`, #551): a call
   * naming it is the thread's own work, not a reach into the harness's internals (#726).
   */
  | { readonly kind: 'own-tree'; readonly path: string }

/**
 * A call as the fold reads it, from its tool name and its input — the one mapping both the live
 * guard and the replay use, so they cannot read a call differently.
 *
 * @group Session risk
 */
export function riskCallOf(
  toolCallId: string,
  toolName: string,
  input: unknown,
): Extract<EnsoRiskEvent, { kind: 'call' }> {
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
  /** The thread's own tree, from the last `own-tree` event; a resolution does not forget it. */
  readonly ownTree?: string | undefined
}

/** @group Session risk */
export const INITIAL_SESSION_RISK: EnsoRiskState = { level: 'low', signals: [], recent: [] }

/**
 * The fold's thresholds (#466 made them `config.json` knobs, `security.incidents`): how far back a
 * detector looks, in calls, and the signal counts for `high` (or distinct kinds) and `incident`.
 *
 * @group Session risk
 */
export interface EnsoRiskThresholds {
  readonly windowCalls: number
  readonly highAtSignals: number
  readonly highAtKinds: number
  readonly incidentAtSignals: number
}

/**
 * The defaults — named guesses, uncalibrated until #468's replay. The window is the session eval's
 * retry window.
 *
 * @group Session risk
 */
export const DEFAULT_RISK_THRESHOLDS: EnsoRiskThresholds = {
  windowCalls: 8,
  highAtSignals: 3,
  highAtKinds: 2,
  incidentAtSignals: 5,
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** An interpreter or shell handed code on its command line, anywhere in the command. */
const ONE_LINER =
  /(?:^|[\s;&|(`])(?:python3?|node|deno|bun|perl|ruby|php|lua)\s+(?:-c|-e|-p|-r|eval)\b|(?:^|[\s;&|(`])(?:ba|z|da|k)?sh\s+-c\b|(?:^|[\s;&|(`])eval\s/
/**
 * The guard's policy and the harness's own internals, by name: the guards' source, the policy
 * file, any extension's `config.json` under the agent dir (the permission engine's is one), and
 * `.enso` — tested on a target with the thread's own tree taken out (`outsideOwnTree`).
 */
const INTERNALS = /guards?\/|guard\.ts|permissions\.json|extensions\/[\w.-]+\/config\.json|(?:^|[\s/'"])\.enso(?:\/|\b)/

/**
 * A config tier file by name (#753): a project's `.enso/config.json` or `.enso/config.local.json`,
 * and the user's `~/.enso/config.json` — wherever it sits in a path or a command, quoted or not, so
 * an interpreter one-liner that writes it (`open('.enso/config.json', 'w')`) is seen too.
 */
const CONFIG_TIER = /(?:^|[^\w.-])\.enso[/\\]config(?:\.local)?\.json(?![\w.-])/i

/** Where a path segment ends in a command: the end, a separator, a quote or a shell operator. */
const SEGMENT_END = `(?:$|[\\s/'"\`;&|)])`

/**
 * A call's target with every mention of the thread's own tree (#726) written as `.`, the way the
 * same command reads in a checkout. The tree is minted under `ENSO_HOME` (`~/.enso/projects/<id>/
 * trees/<thread>`, #551), so without this every `cd <tree>` or absolute path into it after a
 * refusal matched `.enso` — the risk fold's form of what #615 fixed for the guard's path checks.
 *
 * ⚠ Only that ONE tree, and only as a whole path segment: `<tree>-other`, another thread's tree, the
 * rest of `ENSO_HOME`, and `<tree>/..` stay as written, and so does what follows the tree — a
 * `<tree>/.enso/config.json` is still the project's own `.enso`.
 */
function outsideOwnTree(target: string, ownTree: string | undefined): string {
  const root = ownTree?.replace(/\/+$/, '')
  if (root === undefined || root === '') return target
  const mention = new RegExp(`${escapeRegExp(root)}(?!/\\.\\.${SEGMENT_END})(?=${SEGMENT_END})`, 'g')
  return target.replace(mention, '.')
}

/**
 * A refusal of a shell call (`bash`, `powershell`) — by the guard, whatever rule, or by the
 * permission engine, whose surface is the tool it refused. Read off the call, not the rule's name,
 * so a rule added to the shell denies counts at once.
 */
function isShellDenial(recent: RecentCall): boolean {
  if (recent.denial === undefined) return false
  return SHELL_TOOLS.has(recent.denial.source === 'guard' ? recent.tool : recent.denial.surface)
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

/**
 * ⚠ The call signal that needs no earlier refusal (#753), as `protected-record-touch` needs none: a
 * write or edit of a config tier file, or a shell command naming one, is itself the observation —
 * refused or not, since the guard cannot read every route to the file (an interpreter one-liner).
 */
function configTierTouch(call: RecentCall): EnsoSecuritySignal | undefined {
  let target: string | undefined
  if (WRITE_TOOLS.has(call.tool)) target = call.path
  else if (SHELL_TOOLS.has(call.tool)) target = call.command
  if (target === undefined || !CONFIG_TIER.test(target)) return undefined
  return {
    signal: 'config-tier-touch',
    toolCallId: call.toolCallId,
    detail: `${call.tool} reached a config tier file: ${firstLine(target)}`,
    after: [],
  }
}

/** The signals a call raises: a config tier reached, and what it does against the refusals before it in the window. */
function callSignals(
  call: RecentCall,
  earlier: readonly RecentCall[],
  ownTree: string | undefined,
): EnsoSecuritySignal[] {
  const touch = configTierTouch(call)
  const found: EnsoSecuritySignal[] = touch === undefined ? [] : [touch]
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
  if (INTERNALS.test(outsideOwnTree(target, ownTree))) {
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
function denialSignals(
  call: RecentCall,
  denial: DenialFact,
  earlier: readonly RecentCall[],
  windowCalls: number,
): EnsoSecuritySignal[] {
  const found: EnsoSecuritySignal[] = []
  // ⚠ The one signal that needs no earlier refusal (#466): a shell command naming the session or
  // log directory is itself the observation — the records an incident rests on.
  if (denial.source === 'guard' && denial.rule === 'protected-records') {
    withSignal(found, {
      signal: 'protected-record-touch',
      toolCallId: call.toolCallId,
      detail: `${call.tool} named the session or log directory`,
      after: [],
    })
  }
  const keys = new Set(denialKeys(call, denial))
  const repeated = earlier.filter(
    (recent) => recent.denial !== undefined && denialKeys(recent, recent.denial).some((key) => keys.has(key)),
  )
  if (repeated.length > 0) {
    const what = denial.source === 'guard' ? `rule ${denial.rule}` : `${denial.surface} ${firstLine(denial.value)}`
    withSignal(found, {
      signal: 'denial-retry',
      toolCallId: call.toolCallId,
      detail: `refused again (${what}) within ${windowCalls} calls`,
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
function riskLevelOf(signals: readonly EnsoSecuritySignal[], thresholds: EnsoRiskThresholds): EnsoRiskLevel {
  if (signals.length === 0) return 'low'
  const kinds = new Set(signals.map((signal) => signal.signal))
  if (
    signals.length >= thresholds.incidentAtSignals ||
    (kinds.has('command-obfuscation') && kinds.has('alternate-execution-path'))
  ) {
    return 'incident'
  }
  if (signals.length >= thresholds.highAtSignals || kinds.size >= thresholds.highAtKinds) return 'high'
  return 'medium'
}

function denialFactOf(event: Extract<EnsoRiskEvent, { kind: 'guard-denial' | 'permission-denial' }>): DenialFact {
  if (event.kind === 'guard-denial') {
    return event.via === undefined
      ? { source: 'guard', rule: event.rule }
      : { source: 'guard', rule: event.rule, via: event.via }
  }
  return { source: 'engine', surface: event.surface, value: event.value }
}

/**
 * One step of the fold: the state after `event`, and the signals it raised. Pure; the live guard
 * and every replay call only this, with the same thresholds (`config.json`, `security.incidents`).
 *
 * @group Session risk
 */
export function sessionRiskStep(
  state: EnsoRiskState,
  event: EnsoRiskEvent,
  thresholds: EnsoRiskThresholds = DEFAULT_RISK_THRESHOLDS,
): { readonly state: EnsoRiskState; readonly raised: readonly EnsoSecuritySignal[] } {
  // A resolution is a clean slate (#466): the level, the signals AND the window, so a refusal from
  // before it cannot pair with a call after it. The thread's tree stays: it is where, not what (#726).
  if (event.kind === 'incident-resolved')
    return { state: { ...INITIAL_SESSION_RISK, ownTree: state.ownTree }, raised: [] }
  if (event.kind === 'own-tree') return { state: { ...state, ownTree: event.path }, raised: [] }
  if (event.kind === 'call') {
    const call: RecentCall = {
      toolCallId: event.toolCallId,
      tool: event.tool,
      ...(event.command === undefined ? {} : { command: event.command }),
      ...(event.path === undefined ? {} : { path: event.path }),
    }
    const raised = callSignals(call, state.recent, state.ownTree)
    return settle(state, [...state.recent, call].slice(-thresholds.windowCalls), raised, thresholds)
  }
  // A refusal belongs to its call; one without an id (a record written before #464) to the last.
  const position =
    event.toolCallId === undefined
      ? state.recent.length - 1
      : state.recent.findLastIndex((recent) => recent.toolCallId === event.toolCallId)
  const call = state.recent[position]
  if (call === undefined || call.denial !== undefined) return { state, raised: [] }
  const denial = denialFactOf(event)
  const raised = denialSignals(call, denial, state.recent.slice(0, position), thresholds.windowCalls)
  const recent = state.recent.map((recentCall, index) => (index === position ? { ...recentCall, denial } : recentCall))
  return settle(state, recent, raised, thresholds)
}

function settle(
  state: EnsoRiskState,
  recent: readonly RecentCall[],
  raised: readonly EnsoSecuritySignal[],
  thresholds: EnsoRiskThresholds,
): { readonly state: EnsoRiskState; readonly raised: readonly EnsoSecuritySignal[] } {
  const signals = raised.length === 0 ? state.signals : [...state.signals, ...raised]
  return { state: { ...state, level: riskLevelOf(signals, thresholds), signals, recent }, raised }
}

/**
 * The fold over a whole event list — a replay.
 *
 * @group Session risk
 */
export function foldSessionRisk(
  events: readonly EnsoRiskEvent[],
  thresholds: EnsoRiskThresholds = DEFAULT_RISK_THRESHOLDS,
): EnsoRiskState {
  return events.reduce((state, event) => sessionRiskStep(state, event, thresholds).state, INITIAL_SESSION_RISK)
}

/**
 * Why a call is in the command judge's first scope (#469): it follows a refusal in the risk
 * window, or the guards cannot read it — built at run time, decoded, or handed to another
 * interpreter, where a spelling check has nothing to read — in the text bash would run (#544).
 *
 * @group Session risk
 */
export const ENSO_JUDGE_SCOPE_REASONS = ['after-refusal', 'unreadable'] as const

/** @group Session risk */
export type EnsoJudgeScopeReason = (typeof ENSO_JUDGE_SCOPE_REASONS)[number]

/**
 * Whether the guards' spelling checks cannot read a command: a construct in its LIVE text
 * (`command-constructs.ts`, #544). ⚠ Not the raw text — a backtick in a quoted heredoc's body, a
 * `|` inside double quotes or a comment runs nothing, and the raw reading sent ~3× the calls,
 * mostly message bodies carrying the user's prose. A command the walk cannot read stays in.
 */
const isUnreadable = (command: string): boolean => commandConstructOf(command) !== undefined

/**
 * A call in the judge's scope, with what it is judged against: the refusal before it in the window
 * (`denied`, the most recent), and the calls before it there.
 *
 * @group Session risk
 */
export interface EnsoJudgeContext {
  readonly toolCallId: string
  readonly reason: EnsoJudgeScopeReason
  readonly command: string
  readonly denied?: { readonly command: string; readonly reason: string }
  readonly recentCalls: readonly {
    readonly tool: string
    readonly command?: string
    readonly path?: string
    readonly refused: boolean
  }[]
}

function refusalText(denial: DenialFact): string {
  if (denial.source === 'engine') return `the permission engine denied ${denial.surface} ${denial.value}`
  return `the guard refused it under ${denial.rule}${denial.via === undefined ? '' : ` (${denial.via})`}`
}

/**
 * The judge's context for a `bash` call the fold has just met, or undefined when it is out of
 * scope (#469 scope 1). Read off the fold's own state, so the live guard and every replay choose
 * the same calls and judge them against the same refusal.
 *
 * @group Session risk
 */
export function judgeContextOf(state: EnsoRiskState, toolCallId: string): EnsoJudgeContext | undefined {
  const position = state.recent.findLastIndex((recent) => recent.toolCallId === toolCallId)
  const call = state.recent[position]
  if (call?.tool !== 'bash' || call.command === undefined) return undefined
  const earlier = state.recent.slice(0, position)
  const refused = earlier.findLast((recent) => recent.denial !== undefined)
  const unreadable = isUnreadable(call.command)
  if (refused?.denial === undefined && !unreadable) return undefined
  const denied =
    refused?.denial === undefined
      ? undefined
      : { command: refused.command ?? refused.path ?? refused.tool, reason: refusalText(refused.denial) }
  return {
    toolCallId,
    reason: denied === undefined ? 'unreadable' : 'after-refusal',
    command: call.command,
    ...(denied === undefined ? {} : { denied }),
    recentCalls: earlier.map((recent) => ({
      tool: recent.tool,
      ...(recent.command === undefined ? {} : { command: recent.command }),
      ...(recent.path === undefined ? {} : { path: recent.path }),
      refused: recent.denial !== undefined,
    })),
  }
}

/**
 * Every call a stored branch's live guard would have judged (#469 scope 1), with its context, in
 * order — the replay's cases. The guard judges a `bash` call it let through, right after the fold
 * meets the call and before any refusal of it; so does this, over the events the guard met
 * (`riskEventsOfTranscript`), dropping a call the guard itself refused.
 *
 * @group Session risk
 */
export function judgeContextsOfTranscript(
  transcript: readonly EnsoTranscriptEntry[],
  thresholds: EnsoRiskThresholds = DEFAULT_RISK_THRESHOLDS,
): EnsoJudgeContext[] {
  const events = riskEventsOfTranscript(transcript)
  const refusedByGuard = new Set(events.flatMap((event) => (event.kind === 'guard-denial' ? [event.toolCallId] : [])))
  const contexts: EnsoJudgeContext[] = []
  let state = INITIAL_SESSION_RISK
  for (const event of events) {
    state = sessionRiskStep(state, event, thresholds).state
    if (event.kind !== 'call' || refusedByGuard.has(event.toolCallId)) continue
    const context = judgeContextOf(state, event.toolCallId)
    if (context !== undefined) contexts.push(context)
  }
  return contexts
}

/**
 * A branch entry as the walk needs it: an assistant message's calls, a tool result, or a custom
 * entry — the one reduction, over our transcript, for every reader of the fold.
 */
type BranchStep =
  | { readonly kind: 'calls'; readonly calls: readonly Extract<EnsoRiskEvent, { kind: 'call' }>[] }
  | { readonly kind: 'result'; readonly toolCallId: string }
  | { readonly kind: 'custom'; readonly customType: string; readonly data: unknown }
  | { readonly kind: 'other' }

const OTHER: BranchStep = { kind: 'other' }

/** A transcript entry as a step. */
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
function denialEventOf(
  customType: string,
  data: unknown,
): Extract<EnsoRiskEvent, { kind: 'guard-denial' | 'permission-denial' }> | undefined {
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
): Extract<EnsoRiskEvent, { kind: 'permission-denial' }> | undefined {
  const recorded = readRecordedOperatorDenial(customType, data)
  if (recorded?.kind !== 'engine') return undefined
  const { requestId, surface, value } = recorded
  return { kind: 'permission-denial', requestId, surface, value, resolution: 'user_denied' }
}

/**
 * A custom entry that names no call, as an event: a resolution (#466), or the thread's tree (#726)
 * — the record the host appends before the session on it starts, so a resumed guard folds it as a
 * replay does. Undefined for every other entry.
 */
function markerEventOf(
  customType: string,
  data: unknown,
): Extract<EnsoRiskEvent, { kind: 'incident-resolved' | 'own-tree' }> | undefined {
  if (customType === ENSO_INCIDENT_RESOLVED_ENTRY) return { kind: 'incident-resolved' }
  const tree = readEnsoThreadTree(customType, data)
  return tree === undefined ? undefined : { kind: 'own-tree', path: tree.path }
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
  let pending: readonly Extract<EnsoRiskEvent, { kind: 'call' }>[] = []
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
      const marker = markerEventOf(step.customType, step.data)
      if (marker !== undefined) {
        releaseThrough(undefined)
        events.push(marker)
        continue
      }
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
 * The fold's events from a branch as our transcript (`transcriptOf`) — what a resumed guard
 * replays, what the incident replay and the judge replay walk.
 *
 * @group Session risk
 */
export function riskEventsOfTranscript(transcript: readonly EnsoTranscriptEntry[]): EnsoRiskEvent[] {
  return riskEventsOfSteps(transcript.map(stepOfTranscriptEntry))
}

function surfaced(state: EnsoRiskState): EnsoSessionRisk {
  return { level: state.level, signals: [...state.signals] }
}

/**
 * A branch's risk, from Enso's transcript — what the thread snapshot and the session eval show.
 *
 * @group Session risk
 */
export function sessionRiskOfTranscript(
  transcript: readonly EnsoTranscriptEntry[],
  thresholds: EnsoRiskThresholds = DEFAULT_RISK_THRESHOLDS,
): EnsoSessionRisk {
  return surfaced(foldSessionRisk(riskEventsOfTranscript(transcript), thresholds))
}
