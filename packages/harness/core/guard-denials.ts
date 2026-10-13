import {
  ASK_USER_TOOL_NAME,
  ENSO_FAMILY_TOOLS,
  ENSO_GUARD_RULE_KINDS,
  ENSO_INCIDENT_REPORT_TOOL_NAME,
  type EnsoGuardRule,
  type EnsoGuardRuleKind,
  type EnsoSessionIncidents,
  type GuardPolicy,
  openIncidentOf,
  reportOwedOf,
  toolFamilyOf,
  WEB_FETCH_TOOL_NAME,
} from '@enso/core'
import { findEnvironmentDump } from './environment-dump.ts'
import { findDeniedNetworkEgress } from './network-egress.ts'
import { findDirectoryWord, findSecretPathWord } from './shell-secret-paths.ts'

/**
 * The guard's refusals (#861): the policy's tool names, a refusal's shape and its ask line, and the
 * denies that read no session state — an incident's suspension and the shell route's five. Runtime
 * free: `guard-session.ts` calls them, and a runtime's glue never does.
 */

// The tools this policy names, each declared ONCE in canonical (lowercase) form. Every
// set below and every literal comparison in the dispatch uses these constants, and the
// session_start check iterates GUARD_POLICY_TOOL_NAMES — derived from the same constants,
// never a copy, so the check cannot drift from the policy it verifies (#4).
/** @group Guard predicates */
export const TOOL_READ = 'read'
/** @group Guard predicates */
export const TOOL_WRITE = 'write'
/** @group Guard predicates */
export const TOOL_EDIT = 'edit'
/** @group Guard predicates */
export const TOOL_BASH = 'bash'
/** @group Guard predicates */
export const TOOL_POWERSHELL = 'powershell'

/**
 * Every tool name the guard's policy references — the policy/tool-list check's input.
 *
 * ⚠ Deliberately NOT the full tool surface: the reader gate (`grep`, `find`, `ls`, and any
 * future path-bearing tool) works by EXCLUSION, so a renamed or newly registered reader is
 * still gated without being named here — only the tools matched BY NAME can silently un-gate on
 * a rename, and those are exactly the names this list carries.
 *
 * @group Guard predicates
 */
export const GUARD_POLICY_TOOL_NAMES: readonly string[] = [TOOL_READ, TOOL_WRITE, TOOL_EDIT, TOOL_BASH, TOOL_POWERSHELL]

/**
 * Tools whose `path` argument mutates the filesystem.
 *
 * ⚠ This is the ONLY inclusion list here, and it is deliberate: mutation is a small
 * closed set worth naming, and a tool wrongly treated as a reader gets the weaker
 * check. Everything else carrying a `path` is treated as a READER by exclusion — see
 * the dispatch below for why that direction is the safe one.
 *
 * @group Guard predicates
 */
export const MUTATING_PATH_TOOLS = new Set([TOOL_WRITE, TOOL_EDIT])

/**
 * The tool's arguments as a plain record, whatever actually arrived. A runtime's contract says
 * `input` is an object, but a guard hook must never throw (a throwing pi hook wedges print mode;
 * in-process it yields a session with the guard half-set-up — see the pi glue's header), so a
 * missing or non-object `input` reads as "no arguments" rather than as a TypeError.
 *
 * @group Guard predicates
 */
export function inputRecordOf(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return {}
  return input as Record<string, unknown>
}

/**
 * The call's `path` argument, when it carries a non-empty one.
 *
 * @group Guard predicates
 */
export function pathArgumentOf(input: unknown): string | undefined {
  const value = inputRecordOf(input).path
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * A refusal as this guard produces it: the runtime's `{ block, reason, terminate? }` plus two of
 * ours: the RULE that refused (#144 slice 4), which the denial record carries and a day's stats count
 * by, and the CAUSE, the refusal without the ask line addressed to the model, which a person reads
 * (#881). The reason is prose for the model. Both of ours are stripped back to the runtime's shape by
 * its glue, so the runtime is handed exactly the contract it published and nothing of ours rides on it.
 *
 * @group Guard predicates
 */
export interface GuardDenial {
  readonly block: true
  /** What the model is told: the cause, then the ask line its rule's kind adds, if any. */
  readonly reason: string
  /** The refusal itself, without the ask line addressed to the model: what a person reads (#881). */
  readonly cause: string
  readonly rule: EnsoGuardRule
  /** An authorization refusal ends the turn (#465): pi stops once every call of the batch set it. */
  readonly terminate?: true
  /** A network-egress refusal's class (#464): how the deny matched, and what. */
  readonly egress?: { readonly via: string; readonly matched: string }
}

/**
 * The way out a refusal only the user can lift names (#465): asking, not another route. Said once,
 * here, so every such rule says it the same way.
 */
const ASK_ROUTE =
  `This needs the user's authorization. Do not try another way to the same effect: if the task still ` +
  `needs it, ask the user with ${ASK_USER_TOOL_NAME} — say what you want to do and why — and let them decide.`

/** The line a redirect adds after its sanctioned route: asking, for when that route cannot do it. */
const ASK_WHEN_THE_ROUTE_CANNOT =
  `If the route above cannot do what the task needs, do not try another way to the same effect: ask ` +
  `the user with ${ASK_USER_TOOL_NAME} — say what you want to do and why — and let them decide.`

/** The ask line each kind adds to its reason — none where asking cannot unblock the refusal. */
const ASK_LINE_BY_KIND: Readonly<Record<EnsoGuardRuleKind, string | undefined>> = {
  authorization: ASK_ROUTE,
  redirect: ASK_WHEN_THE_ROUTE_CANNOT,
  procedure: undefined,
  configuration: undefined,
  // The suspension's reason says who lifts it (the user's resolution), not "ask".
  suspension: undefined,
}

/**
 * The refusal for `rule`, by its kind (`ENSO_GUARD_RULE_KINDS`). ⚠ #465, #189: asking must be
 * cheaper than working around a refusal, or a halt for working around one is not fair friction.
 * - An authorization refusal names the ask and ENDS THE TURN: pi ends the run once every call of the
 *   batch set `terminate`; a batch where something else ran goes on, and the model reads the line
 *   on its next turn.
 * - A redirect keeps the turn, so the agent can take the sanctioned route its reason names
 *   (`curl` → `web_fetch`), and names the ask for when that route cannot do it.
 * - A procedural refusal (read the file first) and the configuration floor carry neither: asking
 *   cannot unblock them.
 * - A suspension (#466) ends the turn and names no ask: only the user's resolution lifts it.
 *
 * @group Guard predicates
 */
export function deny(rule: EnsoGuardRule, reason: string, egress?: GuardDenial['egress']): GuardDenial {
  const kind = ENSO_GUARD_RULE_KINDS[rule]
  const askLine = ASK_LINE_BY_KIND[kind]
  return {
    block: true,
    reason: askLine === undefined ? reason : `${reason}\n\n${askLine}`,
    cause: reason,
    rule,
    ...(kind === 'authorization' || kind === 'suspension' ? { terminate: true } : {}),
    ...(egress === undefined ? {} : { egress }),
  }
}

/**
 * The refusal of a call to a suspended family (#466), or undefined when its family is not suspended.
 * The reason names the incident, the family and its tools, what still works, and that only the
 * user lifts it — no "ask": an answer to `ask_user` cannot, only a resolution in Enso can.
 *
 * @group Guard predicates
 */
export function suspensionDenial(toolName: string, incidents: EnsoSessionIncidents): GuardDenial | undefined {
  // ⚠ While a report is owed (#467), the report tool is the only one that runs — reads and ask_user
  // included: the report turn is bounded, and anything else would let it become another run.
  const owed = reportOwedOf(incidents)
  if (owed !== undefined) {
    if (toolName === ENSO_INCIDENT_REPORT_TOOL_NAME) return undefined
    return deny(
      'incident-suspension',
      `${toolName} is not available: security incident ${owed.opened.incidentId} is open and its report is ` +
        `owed (#467). File it with ${ENSO_INCIDENT_REPORT_TOOL_NAME} — nothing else runs until it is filed.`,
    )
  }
  const family = toolFamilyOf(toolName)
  if (family === undefined || !incidents.suspended.includes(family)) return undefined
  return deny(
    'incident-suspension',
    `${toolName} is suspended: ${whySuspended(incidents)} (#466). The ${family} tools (${ENSO_FAMILY_TOOLS[family].join(', ')}) ` +
      `stay suspended until the user resolves it in Enso; reading and searching still work. Do not try ` +
      `another way to the same effect. Stop, and tell the user what you were doing and why.`,
  )
}

/** Why the thread's tools are suspended: an ended thread, an open incident, or a kept restriction. */
function whySuspended(incidents: EnsoSessionIncidents): string {
  if (incidents.ended) return 'the user ended this thread when resolving its security incident'
  const open = openIncidentOf(incidents)
  if (open !== undefined) return `security incident ${open.opened.incidentId} is open`
  const last = incidents.incidents.at(-1)
  return `the user kept it suspended when resolving security incident ${last?.opened.incidentId ?? '(unknown)'}`
}

/**
 * The bash analyzer's refusal of a command (#9), in the guard's words: the rule it is recorded under
 * and the reason the model reads. The glue that wires a library under the guard produces it,
 * applying that library's own contract (the pi glue's analyzer reads a throw as a deny), so the
 * policy here never names the library.
 *
 * @group Guard predicates
 */
export interface ShellAnalyzerDenial {
  readonly rule: EnsoGuardRule
  readonly reason: string
}

/**
 * The shell-command denies, in order — a denied command must never have had its input
 * mutated, so the timeout patch stays in the handler, after this returns undefined.
 *
 * 1. The bash analyzer (destructive commands + secret access THROUGH bash) — as a LIBRARY
 *    inside the one handler, so the tool_call participant count stays at two and #4's
 *    third-participant trigger stays unfired. bash only: the analyzer parses POSIX shell,
 *    and feeding it PowerShell would produce verdicts about a command it misread in
 *    either direction. Its refusal arrives already in our words (`ShellAnalyzerDenial`).
 * 2. The network deny (#9) — a bar, not a boundary; `network-egress.ts` states the
 *    non-coverage (git remotes, interpreters). PowerShell always takes the coarse raw
 *    scan: the segmenter speaks POSIX, not PS.
 * 3. The environment-dump deny (#89) — depth behind the quarantine, which is the fix:
 *    secrets are already out of the environment before a session exists. This makes a
 *    regression there LOUD: the listing is refused with a reason, instead of quietly
 *    printing a key into the transcript again. `environment-dump.ts` states its
 *    non-coverage (the interpreters), the same as the egress deny.
 * 4. The records deny (#466) — a word naming this project's session directory or the log
 *    directory, resolved and through its realpath (`findDirectoryWord`): the records an
 *    incident rests on. BEFORE the secret-path deny, which refuses a literal `/.enso/` too,
 *    so a touch of the records is named as one and raises its own signal.
 * 5. The secret-path deny (#204) — the READER GATE'S OWN POLICY on this route. Measured
 *    before it existed: `read .enso/secrets.env` was refused and `cat .enso/secrets.env`
 *    was allowed, because nothing on the bash route resolved a path and cc-safety-net's
 *    corpus is `~/.aws`, `~/.ssh`, `.env`-basename — its "secret access THROUGH bash"
 *    half does not know this harness's own credential dir. LAST of the five: a command
 *    that is destructive, exfiltrating or dumping is refused for that first, which keeps
 *    the older reasons' wording stable. `shell-secret-paths.ts` states its non-coverage.
 *
 * @invariant guarded-tool-call/shell-deny-first Shell: deny first, patch last; the analyzer is a library.
 * For `bash` the analyzer's verdict is read first (a throw is a deny, per its contract), then
 * the network deny by name at command position per segment, with a *cannot vouch* refusal for a
 * construct it cannot resolve, then the environment-dump deny, then the records deny, then the
 * secret-path deny. `powershell` skips the analyzer for the coarse raw scan. Only a command that
 * passed them all gets `defaultBashTimeoutSeconds`, so no denied command has mutated input. What
 * the analyzer allows (a redirect into its own config dir) is our layers' job: the division of
 * labour its contract test pins against defaults.
 *
 * @group Guard predicates
 */
export function shellCommandDenial(
  call: {
    toolName: string
    command: string
    cwd: string
    recordDirectories: readonly string[]
    readonly ownTree: string | undefined
  },
  analyzeShell: (input: { command: string; cwd: string }) => ShellAnalyzerDenial | undefined,
  policy: GuardPolicy,
): GuardDenial | undefined {
  const { toolName, command, cwd } = call
  if (toolName === TOOL_BASH && command.length > 0) {
    const analyzed = analyzeShell({ command, cwd })
    if (analyzed !== undefined) return deny(analyzed.rule, analyzed.reason)
  }

  const coarse = toolName === TOOL_POWERSHELL
  const egress = findDeniedNetworkEgress(command, policy.deniedNetworkBinaries, { coarse })
  if (egress?.via === 'unresolvable') {
    // The floor (#57): not a name the guard saw, but a construct it cannot see through.
    // The refusal names the construct so the rewrite is obvious — and says why "cannot
    // vouch" is a denial here rather than a question.
    return deny(
      'network-egress',
      `${toolName} command refused: ${egress.matched} — the network deny (#9) cannot vouch for what it ` +
        `cannot resolve, so it refuses rather than guesses. Rewrite without the nesting, the substitution, ` +
        `or the stream: name the command directly. Fetching is ${WEB_FETCH_TOOL_NAME} (#54), never a shell client.`,
      { via: egress.via, matched: egress.matched },
    )
  }
  if (egress !== undefined) {
    return deny(
      'network-egress',
      `${toolName} network egress is blocked: "${egress.matched}" (matched by ${egress.via}). ` +
        `Ad-hoc network clients are denied in shell commands (#9) — use the ${WEB_FETCH_TOOL_NAME} ` +
        `tool instead (#54): it fetches http(s) URLs from hosts on the allowlist in the user config. ` +
        `web_fetch and web_search (#63) are the only sanctioned web access. ` +
        `Do not try to work around the deny.`,
      { via: egress.via, matched: egress.matched },
    )
  }

  const dump = findEnvironmentDump(command, { coarse })
  if (dump !== undefined) {
    return deny(
      'environment-dump',
      `${toolName} environment listing is blocked: "${dump.matched}" (matched by ${dump.via}). ` +
        `Secrets are kept out of the tool environment (#89), so an environment dump or a ` +
        `secret-shaped variable expansion is refused rather than trusted to be empty. ` +
        `If a command needs a value from the environment, name a non-secret variable; ` +
        `API keys are read by the harness's own tools from its secrets file (ENSO_HOME/secrets.env, ` +
        `~/.enso by default), never the root .env.`,
    )
  }

  // Before the secret-path deny, which already refuses a literal `/.enso/`: the records are named
  // for what they are, so a touch is its own signal (#466), and a custom ENSO_HOME (outside any
  // `.enso` spelling) is covered too.
  const records = findDirectoryWord(command, call.recordDirectories, cwd, { coarse })
  if (records !== undefined) {
    return deny(
      'protected-records',
      `${toolName} command refused: "${records.matched}" names the session or log directory ` +
        `(matched by ${records.via}) — the records a security incident rests on (#466). They are ` +
        `not the agent's to read or change with a tool; the log-reading path is "bun run logs", a ` +
        `human command and not a tool call.`,
    )
  }

  const secret = findSecretPathWord(command, policy.secretPathFragments, cwd, { coarse, ownTree: call.ownTree })
  if (secret !== undefined) {
    return deny(
      'secret-path',
      `${toolName} command refused: "${secret.matched}" names credential material ` +
        `(matched by ${secret.via}). The read gate refuses that path for read/grep/find/ls, ` +
        `so this route refuses it too (#204) — one policy, both routes, because a secret ` +
        `read is the precondition for exfiltration. This gates the WORD, not the read, so a ` +
        `mention counts: if the word is prose or a search pattern rather than a path, spell ` +
        `it so it is not one (an escaped dot, '/\\.enso/', passes). The harness's own ` +
        `credential dir (ENSO_HOME, ~/.enso by default) is off limits for inspection either way; the log-reading ` +
        `path is "bun run logs", a human command and not a tool call.`,
    )
  }
  return undefined
}
