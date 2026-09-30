import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { readEnsoGuardDenial } from './guard.ts'
import { ENSO_LOG_EVENTS } from './log-stats.ts'
import type { EnsoLogLine } from './log.ts'
import { readRecordedMode } from './permission-modes.ts'
import {
  ENSO_RISK_LEVELS,
  type EnsoRiskLevel,
  readEnsoPermissionDenial,
  readRecordedOperatorDenial,
  sessionRiskOfTranscript,
} from './session-risk.ts'
import type { EnsoTurnStats } from './thread-stats.ts'
import type { EnsoTranscriptEntry, EnsoTranscriptMessage, EnsoTranscriptToolResult } from './transcript.ts'

/**
 * A thread's session eval (#441): a mechanical event timeline and a scorecard, computed from what the
 * session recorded and nothing else.
 *
 * Ported from `session-timeline.py` (the script attached to #441, which scores Claude Code session
 * logs), keeping its two founding rules and its edge cases as named tests:
 *   1. MECHANICAL, NEVER AGENT-JUDGED. Every number traces to something the harness recorded — a
 *      message, an admission, a mode change, a tool call, a refusal. Nothing is a reading of the
 *      transcript, so two threads are comparable and a claim about one is checkable by re-running.
 *   2. NO COMPOSITE SCORE. The scorecard is a set of named metrics; a composite hides which
 *      dimension moved. The agent-side signals are reported per kind and UNWEIGHTED — the catalog
 *      they come from weights them into a struggle score and says its weights are guesses pending
 *      calibration against 78 sessions; this project has far fewer, so no weight is adopted.
 *
 * What changed in the port:
 *   - Inputs are Enso's own types, not Claude Code's log: the branch as `EnsoTranscriptEntry` (leak
 *     L2), the turns' usage as `EnsoTurnStats`, and the thread's Enso log records for what only the
 *     server observed. A `custom`-role message pi stores for an extension's injection is `other` in
 *     the transcript, so harness-injected text is never a human message by construction.
 *   - A queued prompt and an interrupt are LOG facts (`prompt … queued`, `run … told to abort`);
 *     the branch cannot say them. The log keeps 14 days, so both are `null` — unknown, never `0` —
 *     when no log day was read.
 *   - A gate run records its outcome: pi's bash tool throws on a non-zero exit (`bash.js`,
 *     `Command exited with code N`), so the result's `isError` is a structured boolean, not the text
 *     the script refused to parse. `refused` when a guard or the permission engine refused the run;
 *     `unknown` while pending.
 *   - Refusals are four counts that never mix: a guard's (policy, `enso-guard-denial`), a rule's
 *     (the permission engine — a rule you wrote or `auto`'s classifier, `enso-permission-denial`,
 *     #464), the operator's (a person: a No on a prompt, and a declined ask) and the provider's
 *     (#381). None is a tool failure (#407).
 *   - The security signals are the session risk's (#464): replayed from the branch with the same
 *     fold the live guard runs, placed at the call they were observed on. Observed, never a verdict.
 *   - Dropped, and said so on the scorecard: S6 plan mode, S7 task reminders, subagent spawns,
 *     verify scripts, `mcp-mutate` (pi has no MCP; an outward-facing extension tool list starts empty).
 *   - The bash classifier carries this repo's commands (`bun run check`, `bun test`).
 */

/**
 * The timeline's event kinds — the script's, minus the ones pi has no fact for.
 *
 * @group Session eval
 */
export const EVAL_EVENT_KINDS = [
  'human',
  'human-correction',
  'human-confusion',
  'prompt-queued',
  'interrupt',
  'permission-mode',
  'write',
  'ask-options',
  'ask-answered',
  'ask-rejected',
  'tool-denied',
  'guard-refused',
  'rule-refused',
  'provider-refused',
  'security-signal',
  'commit',
  'push',
  'pr-create',
  'pr-edit',
  'branch',
  'gate',
  'destructive',
  'outward',
] as const
/** @group Session eval */
export type EvalEventKind = (typeof EVAL_EVENT_KINDS)[number]

/**
 * The timeline's glyphs: two characters that say an event's kind at a glance — the CLI's column,
 * padded to two; the Stats tab shows them trimmed. One table, so a new kind is marked once.
 *
 * @group Session eval
 */
export const EVAL_KIND_GLYPHS: Readonly<Record<EvalEventKind, string>> = {
  human: '  ',
  'human-correction': '!!',
  'human-confusion': '? ',
  'prompt-queued': '><',
  interrupt: 'XX',
  'permission-mode': ' P',
  write: ' w',
  'ask-options': ' ?',
  'ask-answered': ' a',
  'ask-rejected': '!?',
  'tool-denied': '!D',
  'guard-refused': '!G',
  'rule-refused': '!P',
  'provider-refused': '!R',
  'security-signal': '!S',
  commit: ' c',
  push: ' ^',
  'pr-create': 'PR',
  'pr-edit': 'pr',
  branch: ' b',
  gate: ' g',
  destructive: ' !',
  outward: 'MP',
}

/**
 * One mechanically detected event. `index` is the transcript position for a branch fact and absent
 * for a log fact; `at` orders the two together.
 *
 * @group Session eval
 */
export const EnsoEvalEvent = Type.Object(
  {
    kind: Type.Unsafe<EvalEventKind>(Type.Union(EVAL_EVENT_KINDS.map((kind) => Type.Literal(kind)))),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    at: Type.Optional(Type.String()),
    detail: Type.String(),
    /** A human message's length, the one count the 002 write-up got wrong by eye. */
    words: Type.Optional(Type.Integer({ minimum: 0 })),
    /** A gate run's result: pass, fail, refused by a guard, or unknown (pending, aborted). */
    outcome: Type.Optional(
      Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('refused'), Type.Literal('unknown')]),
    ),
  },
  { additionalProperties: false },
)
/** @group Session eval */
export type EnsoEvalEvent = Static<typeof EnsoEvalEvent>

/** A count the log alone can give; `null` when no log day was read for the thread. */
const LogCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])

/**
 * One S21 fire: a mutating call after an observe-class instruction with no act-class one between.
 *
 * @group Session eval
 */
const EnsoAuthorizationDrift = Type.Object(
  {
    eventIndex: Type.Integer({ minimum: 0 }),
    humanIndex: Type.Integer({ minimum: 0 }),
    humanText: Type.String(),
    action: Type.String(),
    /** Assistant turns between the instruction and the call — how long the run went unattended. */
    unattendedRun: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
type EnsoAuthorizationDrift = Static<typeof EnsoAuthorizationDrift>

/**
 * The scorecard: named metrics, no composite. Operator-side counts what the human typed or clicked;
 * `signals` is the agent side, per kind, unweighted.
 *
 * @group Session eval
 */
export const EnsoEvalScorecard = Type.Object(
  {
    entries: Type.Integer({ minimum: 0 }),
    span: Type.Union([Type.Tuple([Type.String(), Type.String()]), Type.Null()]),
    humanMessages: Type.Integer({ minimum: 0 }),
    /** From the log: prompts admitted `queued` — typed while the agent held the turn. */
    queuedMessages: LogCount,
    /** The longest run of consecutive queued admissions; three in a row preceded the 002 collapse. */
    longestQueuedRun: LogCount,
    corrections: Type.Integer({ minimum: 0 }),
    confusionMessages: Type.Integer({ minimum: 0 }),
    /** From the log: aborts the operator asked for. */
    interrupts: LogCount,
    assistantMessages: Type.Integer({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
    assistantPerHuman: Type.Number({ minimum: 0 }),
    toolCallsPerHuman: Type.Number({ minimum: 0 }),
    writes: Type.Integer({ minimum: 0 }),
    writesPerHuman: Type.Number({ minimum: 0 }),
    askCalls: Type.Integer({ minimum: 0 }),
    askAnswered: Type.Integer({ minimum: 0 }),
    askRejected: Type.Integer({ minimum: 0 }),
    askRejectionRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    /** The operator pressed No on a permission prompt. */
    operatorDenials: Type.Integer({ minimum: 0 }),
    /** A guard refused a call: policy, not a person. */
    guardRefusals: Type.Integer({ minimum: 0 }),
    /** The permission engine refused a call (#464): a rule you wrote, or `auto`'s classifier — not a person. */
    ruleRefusals: Type.Integer({ minimum: 0 }),
    /** The provider refused a request (#381). */
    providerRefusals: Type.Integer({ minimum: 0 }),
    /** What the operator CLICKED: declined asks plus denied prompts — the `r=` counter. */
    refusalsTotal: Type.Integer({ minimum: 0 }),
    gateRuns: Type.Integer({ minimum: 0 }),
    gatePassed: Type.Integer({ minimum: 0 }),
    gateFailed: Type.Integer({ minimum: 0 }),
    permissionModes: Type.Array(Type.String()),
    firstCorrectionAt: Type.Union([Type.String(), Type.Null()]),
    toolHistogram: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    /** Tri-state: present, absent, or not checked (`null`). Absent is never a negative. */
    canary: Type.Union([Type.String(), Type.Null()]),
    canaryPresent: Type.Union([Type.Boolean(), Type.Null()]),
    signals: Type.Object(
      {
        S1_duplicateToolClusters: Type.Integer({ minimum: 0 }),
        S3_retryAfterErrorFires: Type.Integer({ minimum: 0 }),
        toolErrors: Type.Integer({ minimum: 0 }),
        S5_outputCollapseSpans: Type.Integer({ minimum: 0 }),
        S19_timeGaps: Type.Integer({ minimum: 0 }),
        S20_rareCommandMatches: Type.Integer({ minimum: 0 }),
        S20_families: Type.Array(Type.String()),
        S20_fires: Type.Integer({ minimum: 0, maximum: 1 }),
        S21_authorizationDriftFires: Type.Integer({ minimum: 0 }),
        S21_events: Type.Array(EnsoAuthorizationDrift),
      },
      { additionalProperties: false },
    ),
    /** What the script measured and pi records no fact for — absent by decision, not by omission. */
    dropped: Type.Array(Type.String()),
    /**
     * The session risk (#464): the level the replayed signals put it at, and how many there are.
     * Observed evidence, not a verdict; the thresholds are uncalibrated (#468).
     */
    riskLevel: Type.Unsafe<EnsoRiskLevel>(Type.Union(ENSO_RISK_LEVELS.map((level) => Type.Literal(level)))),
    securitySignals: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
/** @group Session eval */
export type EnsoEvalScorecard = Static<typeof EnsoEvalScorecard>

/**
 * What `GET /api/threads/:threadId/eval` answers: the events in order and the scorecard over them.
 *
 * @group Session eval
 */
export const EnsoSessionEval = Type.Object(
  {
    threadId: Type.String(),
    live: Type.Boolean(),
    events: Type.Array(EnsoEvalEvent),
    scorecard: EnsoEvalScorecard,
    /** The log days read for the log-side counts; none means those counts are unknown. */
    logDays: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Session eval */
export type EnsoSessionEval = Static<typeof EnsoSessionEval>

const sessionEvalValidator = Compile(EnsoSessionEval)

/**
 * A payload read as an eval — what the CLI takes from the route; `undefined` for any other shape.
 *
 * @group Session eval
 */
export function readEnsoSessionEval(value: unknown): EnsoSessionEval | undefined {
  return sessionEvalValidator.Check(value) ? value : undefined
}

// ── pattern lists — literal, never semantic ─────────────────────────────────────────────────────

/**
 * The script's correction patterns (adapted there from check-yo-self's signal F, the one signal an
 * agent cannot produce for itself). English, tuned to one operator; a literal list on purpose.
 */
const USER_CORRECTION_PATTERNS = [
  String.raw`\bno\b[,.]`,
  String.raw`\bthat'?s (not|wrong|incorrect)\b`,
  String.raw`\bwhy (are|did|would) you\b`,
  String.raw`\bi (did ?n[o']?t|never) (ask|say|want)\b`,
  String.raw`\bstop\b`,
  String.raw`\bnot what i\b`,
  String.raw`\bpoor judgement\b`,
  String.raw`\byou (ignored|missed|glossed)\b`,
  String.raw`\bi thought we\b`,
  String.raw`\bwe (decided|agreed)\b`,
  String.raw`\bcorrection\b`,
  String.raw`\bactually,?\b`,
  String.raw`\byou (just )?(made|built|added)\b.*\b(never|didn'?t) ask`,
  String.raw`\bcannot be trusted\b`,
  String.raw`\bdishonest\b`,
  String.raw`\bcalled out\b`,
]
const CORRECTION_RE = new RegExp(USER_CORRECTION_PATTERNS.join('|'), 'i')
const CONFUSION_RE = /\bi(?: a|')?m confused\b|\bi don'?t understand\b|\bexplain\b/i

/** Ordered: the first match wins, so the specific patterns sit above the general ones. */
const BASH_EVENT_PATTERNS: ReadonlyArray<readonly [EvalEventKind, RegExp]> = [
  ['pr-create', /gh pr create/],
  ['pr-edit', /gh pr (edit|comment)/],
  ['push', /git push/],
  ['commit', /git commit/],
  ['branch', /git (checkout -b|switch -c)/],
  ['gate', /bun run (check|test|typecheck|lint)\b|\bbun test\b|\btsc\b|\boxlint\b|\bvitest\b/],
  ['destructive', /\brm -|git reset --hard|git checkout --/],
]

/** S20: acting on state fires, inspecting it does not — `git stash list` is a read. */
const RARE_COMMAND_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['history-archaeology', /git reflog(?! show)|git fsck|git bisect/],
  ['history-rewrite', /git reset --hard|git push --force|git rebase -i|filter-branch/],
  ['stash-churn', /git stash(?! (list|show))/],
  ['revert', /git revert|git checkout -- |git restore /],
  ['process-kill', /kill -9|pkill |killall /],
  ['dependency-thrash', /--force-reinstall|--legacy-peer-deps|rm -rf node_modules|npm cache clean|bun pm cache rm/],
  ['blunt-delete', /rm -rf /],
  ['tracing', /\bstrace\b|\bltrace\b|\bdtruss\b/],
]

/**
 * S21's verb classes. OBSERVE carries its suffixes because a trailing `\b` on a bare `check` does not
 * match `checking` — found against a real incident. ACT stays bare-stem on purpose: an operator's
 * `released` is a status report, not a grant, and widening ACT would clear a standing instruction on it.
 */
const OBSERVE_VERB_RE =
  /\b(check(?:ing|ed|s)?|look(?:ing|ed)? at|review(?:ing|ed|s)?|investigat(?:e|es|ing|ed)?|verif(?:y|ies|ying|ied)|see(?:ing)? (?:if|what|whether)|audit(?:ing|ed|s)?)\b/i
const ACT_VERB_RE = /\b(fix|ship|build|merge|push|commit|create|implement|deploy|release|open a p(?:r|ull request))\b/i
/** `commit` excluded: a local, unpushed commit is not outward-facing on its own. */
const MUTATING_EVENT_KINDS: ReadonlySet<EvalEventKind> = new Set(['push', 'pr-create', 'outward'])

/**
 * The timeline's two running counters (#441), kept apart on purpose: `f=` is what the operator
 * TYPES against the run, `r=` what the operator CLICKS. They move at different times — in the run
 * the script was built to measure, `r=` reached 4 seventy-four minutes before `f=` left 1.
 *
 * @group Session eval
 */
export const FRICTION_KINDS: ReadonlySet<EvalEventKind> = new Set([
  'human-correction',
  'prompt-queued',
  'human-confusion',
  'interrupt',
])
/** @group Session eval */
export const REFUSAL_KINDS: ReadonlySet<EvalEventKind> = new Set(['ask-rejected', 'tool-denied'])

/**
 * Each event with the counters as they stood after it — what a timeline row shows beside the event.
 *
 * @group Session eval
 */
export function runningCounters(
  events: readonly EnsoEvalEvent[],
): ReadonlyArray<{ readonly event: EnsoEvalEvent; readonly friction: number; readonly refusals: number }> {
  let friction = 0
  let refusals = 0
  return events.map((event) => {
    if (FRICTION_KINDS.has(event.kind)) friction += 1
    if (REFUSAL_KINDS.has(event.kind)) refusals += 1
    return { event, friction, refusals }
  })
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])
const ASK_TOOL = 'ask_user'
const BASH_TOOL = 'bash'
/** The ask tool's own refusal text (`ask-user/index.ts` `toolResultText`): the operator chose to talk instead. */
const ASK_DECLINED_TEXT = 'The user declined to answer and chose nothing.'

const DUPLICATE_TOOL_WINDOW_CALLS = 20
const RETRY_WINDOW_CALLS = 8
const OUTPUT_COLLAPSE_TOKEN_THRESHOLD = 50
const OUTPUT_COLLAPSE_MIN_RUN = 3
const TIME_GAP_THRESHOLD_MS = 30_000
const RARE_COMMAND_MIN_MATCHES = 2

/**
 * What the script measured that pi records no fact for.
 *
 * @group Session eval
 */
export const EVAL_DROPPED = [
  'S6 plan mode entries and exits: pi has no plan mode attachment',
  'S7 task reminders: pi has no task_reminder attachment',
  'subagent spawns: pi has no Agent tool',
  'verify scripts: this repo has none',
  'mcp-mutate: pi has no MCP; the outward-facing extension tool list starts empty',
] as const

/**
 * Extension tools classified as outward-facing (the script's `mcp-mutate`). Empty until one exists.
 *
 * @group Session eval
 */
export const OUTWARD_TOOLS: ReadonlySet<string> = new Set()

// ── the walk ────────────────────────────────────────────────────────────────────────────────────

/**
 * What the eval reads: the branch as ours, the turns' usage, and the thread's log records.
 *
 * @group Session eval
 */
export interface SessionEvalInput {
  readonly transcript: readonly EnsoTranscriptEntry[]
  readonly turnStats: readonly EnsoTurnStats[]
  /** This thread's log records, any day; empty when none was read. */
  readonly log: readonly EnsoLogLine[]
  /** The log days that were read; `[]` makes every log-side count `null`. */
  readonly logDays: readonly string[]
  /** A token whose presence in the transcript proves a prompt loaded; unchecked when absent. */
  readonly canary?: string
}

function textOf(message: EnsoTranscriptMessage): string {
  return message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
}

function wordCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\s+/).length
}

function humanKindOf(text: string): EvalEventKind {
  if (CORRECTION_RE.test(text)) return 'human-correction'
  if (CONFUSION_RE.test(text)) return 'human-confusion'
  return 'human'
}

function classifyBash(command: string): EvalEventKind | undefined {
  return BASH_EVENT_PATTERNS.find(([, pattern]) => pattern.test(command))?.[0]
}

function firstLine(text: string, max = 90): string {
  return (text.split('\n')[0] ?? '').slice(0, max)
}

/** A field of an unknown object, narrowed with `in` — no shape is asserted. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function commandOf(args: unknown): string {
  const command = fieldOf(args, 'command')
  return typeof command === 'string' ? command : ''
}

function pathOf(args: unknown): string {
  const path = fieldOf(args, 'path')
  return typeof path === 'string' ? path : '?'
}

function askDetail(args: unknown): string {
  const questions = fieldOf(args, 'questions')
  if (!Array.isArray(questions)) return '? question(s)'
  const counts = questions.map((question: unknown) => {
    const options = fieldOf(question, 'options')
    return Array.isArray(options) ? options.length : 0
  })
  return `${questions.length} question(s), options: [${counts.join(',')}]`
}

/** The walk's state across entries: results are joined to their calls by id. */
interface Walk {
  readonly events: EnsoEvalEvent[]
  /** Calls a guard or the permission engine refused: their error results are refusals, not failures. */
  readonly refused: Set<string>
  /** A gate event by its call id, so the result can set its outcome. */
  readonly gateByCall: Map<string, EnsoEvalEvent>
  /** An ask call's transcript index by its id, for the answer's detail. */
  readonly askByCall: Map<string, number>
  lastMode: string | undefined
}

function walkToolCall(
  walk: Walk,
  index: number,
  at: string | undefined,
  part: Extract<EnsoTranscriptMessage['parts'][number], { type: 'tool-call' }>,
): void {
  const name = part.toolName.toLowerCase()
  const stamp = at === undefined ? {} : { at }
  if (WRITE_TOOLS.has(name)) {
    walk.events.push({ kind: 'write', index, ...stamp, detail: `${name} ${pathOf(part.args)}` })
    return
  }
  if (name === ASK_TOOL) {
    walk.askByCall.set(part.toolCallId, index)
    walk.events.push({ kind: 'ask-options', index, ...stamp, detail: askDetail(part.args) })
    return
  }
  if (name === BASH_TOOL) {
    const command = commandOf(part.args)
    const kind = classifyBash(command)
    if (kind === undefined) return
    const event: EnsoEvalEvent = { kind, index, ...stamp, detail: firstLine(command) }
    if (kind === 'gate') {
      event.outcome = 'unknown'
      walk.gateByCall.set(part.toolCallId, event)
    }
    walk.events.push(event)
    return
  }
  if (OUTWARD_TOOLS.has(name)) walk.events.push({ kind: 'outward', index, ...stamp, detail: name })
}

function walkMessage(walk: Walk, index: number, entry: EnsoTranscriptMessage): void {
  const stamp = entry.at === undefined ? {} : { at: entry.at }
  if (entry.role === 'user') {
    const text = textOf(entry)
    if (text.length === 0) return
    walk.events.push({ kind: humanKindOf(text), index, ...stamp, detail: text, words: wordCount(text) })
    return
  }
  if (entry.refusal !== undefined) {
    walk.events.push({ kind: 'provider-refused', index, ...stamp, detail: entry.refusal.message })
  }
  for (const part of entry.parts) if (part.type === 'tool-call') walkToolCall(walk, index, entry.at, part)
}

function walkToolResult(walk: Walk, index: number, entry: EnsoTranscriptToolResult): void {
  const stamp = entry.at === undefined ? {} : { at: entry.at }
  const askIndex = walk.askByCall.get(entry.toolCallId)
  if (askIndex !== undefined) {
    walk.askByCall.delete(entry.toolCallId)
    const rejected = entry.text.startsWith(ASK_DECLINED_TEXT)
    walk.events.push({
      kind: rejected ? 'ask-rejected' : 'ask-answered',
      index,
      ...stamp,
      detail: rejected
        ? `menu at [${askIndex}] DECLINED — operator chose to talk instead`
        : `menu at [${askIndex}] answered`,
    })
    return
  }
  const gate = walk.gateByCall.get(entry.toolCallId)
  if (gate === undefined) return
  walk.gateByCall.delete(entry.toolCallId)
  if (walk.refused.has(entry.toolCallId)) gate.outcome = 'refused'
  else gate.outcome = entry.isError ? 'fail' : 'pass'
}

function walkCustom(walk: Walk, index: number, entry: Extract<EnsoTranscriptEntry, { kind: 'custom' }>): void {
  const stamp = entry.at === undefined ? {} : { at: entry.at }
  const recordedMode = readRecordedMode(entry)
  if (recordedMode !== undefined) {
    if (recordedMode === walk.lastMode) return
    walk.lastMode = recordedMode
    walk.events.push({ kind: 'permission-mode', index, ...stamp, detail: recordedMode })
    return
  }
  const guard = readEnsoGuardDenial(entry.customType, entry.data)
  if (guard !== undefined) {
    walk.refused.add(guard.toolCallId)
    walk.events.push({
      kind: 'guard-refused',
      index,
      ...stamp,
      detail: `guard refused ${guard.toolCallId}: ${guard.rule}`,
    })
    return
  }
  const permission = readEnsoPermissionDenial(entry.customType, entry.data)
  if (permission !== undefined) {
    if (permission.toolCallId !== undefined) walk.refused.add(permission.toolCallId)
    walk.events.push({ index, ...stamp, ...permissionRefusalEvent(permission) })
    return
  }
  const operator = readRecordedOperatorDenial(entry.customType, entry.data)
  if (operator === undefined) return
  walk.events.push({
    kind: 'tool-denied',
    index,
    ...stamp,
    detail:
      operator.kind === 'engine'
        ? `operator denied ${operator.surface}: ${operator.value}`
        : `operator denied ${operator.title}: ${operator.option}`,
  })
}

/** An engine refusal as a timeline event: a person's No, or a rule's (a rule you wrote, `auto`'s classifier). */
function permissionRefusalEvent(
  denial: NonNullable<ReturnType<typeof readEnsoPermissionDenial>>,
): Pick<EnsoEvalEvent, 'kind' | 'detail'> {
  const what = `${denial.surface}: ${firstLine(denial.value)}`
  if (denial.resolution === 'user_denied') return { kind: 'tool-denied', detail: `operator denied ${what}` }
  const who = denial.resolution === 'policy_deny' ? 'a rule' : "auto's classifier"
  return { kind: 'rule-refused', detail: `${who} refused ${what}` }
}

/** Every branch fact, in branch order. */
function branchEvents(transcript: readonly EnsoTranscriptEntry[]): {
  events: EnsoEvalEvent[]
  refused: Set<string>
} {
  const walk: Walk = {
    events: [],
    refused: new Set(),
    gateByCall: new Map(),
    askByCall: new Map(),
    lastMode: undefined,
  }
  transcript.forEach((entry, index) => {
    if (entry.kind === 'message') walkMessage(walk, index, entry)
    else if (entry.kind === 'tool-result') walkToolResult(walk, index, entry)
    else if (entry.kind === 'custom') walkCustom(walk, index, entry)
  })
  return { events: walk.events, refused: walk.refused }
}

/** The signals a refusal raises, rather than a call: they read after the refusal, not the call. */
const REFUSAL_SIGNALS: ReadonlySet<string> = new Set(['denial-retry', 'command-obfuscation'])

/**
 * The session risk's signals as timeline events, merged into the branch's events in transcript
 * order (#464): a signal a call raised at the message that made the call, one a refusal raised at
 * that refusal's entry — so `guard refused c2` reads before `denial-retry` on c2, not after.
 */
function withSignalEvents(
  events: readonly EnsoEvalEvent[],
  transcript: readonly EnsoTranscriptEntry[],
  signals: ReturnType<typeof sessionRiskOfTranscript>['signals'],
): EnsoEvalEvent[] {
  const messageOfCall = new Map<string, number>()
  const refusalOfCall = new Map<string, number>()
  transcript.forEach((entry, index) => {
    if (entry.kind === 'custom') {
      const toolCallId =
        readEnsoGuardDenial(entry.customType, entry.data)?.toolCallId ??
        readEnsoPermissionDenial(entry.customType, entry.data)?.toolCallId
      if (toolCallId !== undefined) refusalOfCall.set(toolCallId, index)
      return
    }
    if (entry.kind !== 'message') return
    for (const part of entry.parts) if (part.type === 'tool-call') messageOfCall.set(part.toolCallId, index)
  })
  const placed = signals.flatMap((signal): EnsoEvalEvent[] => {
    const refusal = REFUSAL_SIGNALS.has(signal.signal) ? refusalOfCall.get(signal.toolCallId) : undefined
    const index = refusal ?? messageOfCall.get(signal.toolCallId)
    if (index === undefined) return []
    const at = transcript[index]?.at
    return [
      {
        kind: 'security-signal',
        index,
        ...(at === undefined ? {} : { at }),
        detail: `${signal.signal}: ${signal.detail}`,
      },
    ]
  })
  // Stable: a signal goes after every branch event at or before its place.
  return [...events, ...placed].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
}

/**
 * The log's facts: queued admissions and aborts. Only the server's own record counts — the browser
 * re-logs the admission line a second later (`log-stats.ts` `foldAdmission`).
 */
function logEvents(log: readonly EnsoLogLine[]): EnsoEvalEvent[] {
  const events: EnsoEvalEvent[] = []
  for (const line of log) {
    if (!line.logger.startsWith('enso.server')) continue
    const properties = line.properties ?? {}
    if (line.message === ENSO_LOG_EVENTS.promptAdmitted && properties.admission === 'queued') {
      events.push({
        kind: 'prompt-queued',
        at: line['@timestamp'],
        detail: `queued on run ${String(properties.generation)}`,
      })
    } else if (line.message === ENSO_LOG_EVENTS.runAborted) {
      events.push({
        kind: 'interrupt',
        at: line['@timestamp'],
        detail: `run ${String(properties.generation)} told to abort`,
      })
    }
  }
  return events
}

/** Branch events keep their order; a log event lands before the first branch event stamped after it. */
function mergeByTime(branch: readonly EnsoEvalEvent[], fromLog: readonly EnsoEvalEvent[]): EnsoEvalEvent[] {
  const merged: EnsoEvalEvent[] = []
  let logIndex = 0
  const logInstant = (event: EnsoEvalEvent): number => Date.parse(event.at ?? '')
  for (const event of branch) {
    const instant = Date.parse(event.at ?? '')
    while (
      logIndex < fromLog.length &&
      !Number.isNaN(instant) &&
      logInstant(fromLog[logIndex] as EnsoEvalEvent) <= instant
    ) {
      merged.push(fromLog[logIndex] as EnsoEvalEvent)
      logIndex += 1
    }
    merged.push(event)
  }
  return merged.concat(fromLog.slice(logIndex))
}

// ── agent-side signals ──────────────────────────────────────────────────────────────────────────

interface ToolCallRow {
  readonly position: number
  readonly toolCallId: string
  readonly name: string
  readonly payload: string
  readonly at: number
}

function canonicalArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return JSON.stringify(args) ?? 'null'
  const keys = Object.keys(args).sort((first, second) => (first < second ? -1 : 1))
  return JSON.stringify(args, keys)
}

function toolCallRows(transcript: readonly EnsoTranscriptEntry[]): ToolCallRow[] {
  const rows: ToolCallRow[] = []
  for (const entry of transcript) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue
    for (const part of entry.parts) {
      if (part.type !== 'tool-call') continue
      rows.push({
        position: rows.length,
        toolCallId: part.toolCallId,
        name: part.toolName.toLowerCase(),
        payload: canonicalArgs(part.args),
        at: Date.parse(entry.at ?? ''),
      })
    }
  }
  return rows
}

/** S1: the same tool with the same input inside a rolling window; one fire per cluster. */
function duplicateToolClusters(calls: readonly ToolCallRow[]): number {
  let fires = 0
  const lastSeen = new Map<string, number>()
  const open = new Set<string>()
  for (const call of calls) {
    const key = `${call.name}|${call.payload}`
    const previous = lastSeen.get(key)
    if (previous !== undefined && call.position - previous <= DUPLICATE_TOOL_WINDOW_CALLS) {
      if (!open.has(key)) {
        fires += 1
        open.add(key)
      }
    } else open.delete(key)
    lastSeen.set(key, call.position)
  }
  return fires
}

/** S3: a tool errored and the same tool was called again within the window; one fire per error. */
function retryAfterError(calls: readonly ToolCallRow[], errors: ReadonlyMap<string, string>): number {
  const positionOf = new Map(calls.map((call) => [call.toolCallId, call.position]))
  let fires = 0
  for (const [toolCallId, toolName] of errors) {
    const errorPosition = positionOf.get(toolCallId)
    if (errorPosition === undefined) continue
    const retried = calls.some(
      (call) =>
        call.position > errorPosition && call.position - errorPosition <= RETRY_WINDOW_CALLS && call.name === toolName,
    )
    if (retried) fires += 1
  }
  return fires
}

/** S5: three or more consecutive turns under the output-token threshold; one fire per span. */
function outputCollapseSpans(turnStats: readonly EnsoTurnStats[]): number {
  let fires = 0
  let run = 0
  for (const turn of turnStats) {
    if (turn.output < OUTPUT_COLLAPSE_TOKEN_THRESHOLD) {
      run += 1
      continue
    }
    if (run >= OUTPUT_COLLAPSE_MIN_RUN) fires += 1
    run = 0
  }
  return run >= OUTPUT_COLLAPSE_MIN_RUN ? fires + 1 : fires
}

/** S19: a tool call whose result arrived the threshold or more later. */
function timeGaps(transcript: readonly EnsoTranscriptEntry[], calls: readonly ToolCallRow[]): number {
  const resultAt = new Map<string, number>()
  for (const entry of transcript) {
    if (entry.kind === 'tool-result') resultAt.set(entry.toolCallId, Date.parse(entry.at ?? ''))
  }
  let fires = 0
  for (const call of calls) {
    const arrived = resultAt.get(call.toolCallId)
    if (arrived === undefined || Number.isNaN(arrived) || Number.isNaN(call.at)) continue
    if (arrived - call.at >= TIME_GAP_THRESHOLD_MS) fires += 1
  }
  return fires
}

/** S20: recovery and archaeology tooling; each command counted once, its family recorded. */
function rareCommands(calls: readonly ToolCallRow[]): { matches: number; families: string[] } {
  const families = new Set<string>()
  let matches = 0
  for (const call of calls) {
    if (call.name !== BASH_TOOL) continue
    const family = RARE_COMMAND_PATTERNS.find(([, pattern]) => pattern.test(call.payload))?.[0]
    if (family === undefined) continue
    families.add(family)
    matches += 1
  }
  return { matches, families: [...families].sort((first, second) => (first < second ? -1 : 1)) }
}

const HUMAN_KINDS: ReadonlySet<EvalEventKind> = new Set(['human', 'human-correction', 'human-confusion'])

/**
 * S21: a mutating call whose nearest preceding human message was observe-class, with no act-class
 * message between. A message matching NEITHER class leaves a standing instruction in force (the
 * `released` incident). Known false positive: a compound "check X, ship it if broken". Known false
 * negative: an act verb used loosely. Both are named tests, not filters.
 */
function authorizationDrift(
  transcript: readonly EnsoTranscriptEntry[],
  events: readonly EnsoEvalEvent[],
): EnsoAuthorizationDrift[] {
  const fires: EnsoAuthorizationDrift[] = []
  let lastHuman: { text: string; index: number } | undefined
  let actSeen = false
  for (const event of events) {
    if (HUMAN_KINDS.has(event.kind) && event.index !== undefined) {
      if (ACT_VERB_RE.test(event.detail)) {
        lastHuman = { text: event.detail, index: event.index }
        actSeen = true
      } else if (OBSERVE_VERB_RE.test(event.detail)) {
        lastHuman = { text: event.detail, index: event.index }
        actSeen = false
      }
      continue
    }
    if (!MUTATING_EVENT_KINDS.has(event.kind) || event.index === undefined) continue
    if (lastHuman === undefined || actSeen || !OBSERVE_VERB_RE.test(lastHuman.text)) continue
    const unattendedRun = transcript
      .slice(lastHuman.index + 1, event.index)
      .filter((entry) => entry.kind === 'message' && entry.role === 'assistant').length
    fires.push({
      eventIndex: event.index,
      humanIndex: lastHuman.index,
      humanText: lastHuman.text,
      action: `${event.kind}: ${event.detail}`,
      unattendedRun,
    })
  }
  return fires
}

// ── the scorecard ───────────────────────────────────────────────────────────────────────────────

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function count(events: readonly EnsoEvalEvent[], kind: EvalEventKind): number {
  return events.filter((event) => event.kind === kind).length
}

/** The longest run of consecutive queued admissions among the log's admission lines, in order. */
function longestQueuedRun(log: readonly EnsoLogLine[]): number {
  let longest = 0
  let current = 0
  for (const line of log) {
    if (line.message !== ENSO_LOG_EVENTS.promptAdmitted || !line.logger.startsWith('enso.server')) continue
    if (line.properties?.admission === 'queued') {
      current += 1
      longest = Math.max(longest, current)
    } else current = 0
  }
  return longest
}

function spanOf(transcript: readonly EnsoTranscriptEntry[]): [string, string] | null {
  const stamps = transcript.flatMap((entry) => (entry.at === undefined ? [] : [entry.at])).sort()
  const first = stamps[0]
  const last = stamps.at(-1)
  return first === undefined || last === undefined ? null : [first, last]
}

/**
 * What the pure eval answers: the route adds the thread's identity and liveness.
 *
 * @group Session eval
 */
export type SessionEvalResult = Pick<EnsoSessionEval, 'events' | 'scorecard' | 'logDays'>

/**
 * The scorecard over the events: every number a count, never a reading.
 *
 * @group Session eval
 */
export function sessionEvalOf(input: SessionEvalInput): SessionEvalResult {
  const { transcript, turnStats, log, logDays } = input
  const { events: branchOnly, refused } = branchEvents(transcript)
  const risk = sessionRiskOfTranscript(transcript)
  const events = mergeByTime(withSignalEvents(branchOnly, transcript, risk.signals), logEvents(log))
  const calls = toolCallRows(transcript)
  const errors = new Map<string, string>()
  for (const entry of transcript) {
    if (entry.kind === 'tool-result' && entry.isError && !refused.has(entry.toolCallId)) {
      errors.set(entry.toolCallId, entry.toolName.toLowerCase())
    }
  }
  const humans = events.filter((event) => HUMAN_KINDS.has(event.kind))
  const humanDenominator = Math.max(1, humans.length)
  const assistantMessages = transcript.filter((entry) => entry.kind === 'message' && entry.role === 'assistant').length
  const histogram: Record<string, number> = {}
  for (const call of calls) histogram[call.name] = (histogram[call.name] ?? 0) + 1
  const askCalls = count(events, 'ask-options')
  const askRejected = count(events, 'ask-rejected')
  const operatorDenials = count(events, 'tool-denied')
  const gates = events.filter((event) => event.kind === 'gate')
  const rare = rareCommands(calls)
  const drift = authorizationDrift(transcript, events)
  const firstCorrection = events.find((event) => event.kind === 'human-correction')
  const logRead = logDays.length > 0
  const transcriptText = transcript
    .flatMap((entry) => {
      if (entry.kind === 'message') return [textOf(entry)]
      return entry.kind === 'tool-result' ? [entry.text] : []
    })
    .join('\n')
  return {
    events,
    logDays: [...logDays],
    scorecard: {
      entries: transcript.length,
      span: spanOf(transcript),
      humanMessages: humans.length,
      queuedMessages: logRead ? count(events, 'prompt-queued') : null,
      longestQueuedRun: logRead ? longestQueuedRun(log) : null,
      corrections: count(events, 'human-correction'),
      confusionMessages: count(events, 'human-confusion'),
      interrupts: logRead ? count(events, 'interrupt') : null,
      assistantMessages,
      toolCalls: calls.length,
      assistantPerHuman: round(assistantMessages / humanDenominator, 1),
      toolCallsPerHuman: round(calls.length / humanDenominator, 1),
      writes: count(events, 'write'),
      writesPerHuman: round(count(events, 'write') / humanDenominator, 1),
      askCalls,
      askAnswered: count(events, 'ask-answered'),
      askRejected,
      askRejectionRate: askCalls === 0 ? null : round(askRejected / askCalls, 2),
      operatorDenials,
      guardRefusals: count(events, 'guard-refused'),
      ruleRefusals: count(events, 'rule-refused'),
      providerRefusals: count(events, 'provider-refused'),
      refusalsTotal: askRejected + operatorDenials,
      gateRuns: gates.length,
      gatePassed: gates.filter((gate) => gate.outcome === 'pass').length,
      gateFailed: gates.filter((gate) => gate.outcome === 'fail').length,
      permissionModes: events.flatMap((event) => (event.kind === 'permission-mode' ? [event.detail] : [])),
      firstCorrectionAt: firstCorrection?.at ?? null,
      toolHistogram: histogram,
      canary: input.canary ?? null,
      canaryPresent: input.canary === undefined ? null : transcriptText.includes(input.canary),
      signals: {
        S1_duplicateToolClusters: duplicateToolClusters(calls),
        S3_retryAfterErrorFires: retryAfterError(calls, errors),
        toolErrors: errors.size,
        S5_outputCollapseSpans: outputCollapseSpans(turnStats),
        S19_timeGaps: timeGaps(transcript, calls),
        S20_rareCommandMatches: rare.matches,
        S20_families: rare.families,
        S20_fires: rare.matches >= RARE_COMMAND_MIN_MATCHES ? 1 : 0,
        S21_authorizationDriftFires: drift.length,
        S21_events: drift,
      },
      dropped: [...EVAL_DROPPED],
      riskLevel: risk.level,
      securitySignals: risk.signals.length,
    },
  }
}
