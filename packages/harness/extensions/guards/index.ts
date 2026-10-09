import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  TruncationResult,
} from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_TOOL_NAME,
  type CommandJudge,
  commandJudgementOf,
  DEFAULT_GUARD_POLICY,
  ENSO_COMMAND_JUDGEMENT_ENTRY,
  ENSO_FAMILY_TOOLS,
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_GUARD_RULE_KINDS,
  ENSO_INCIDENT_OPENED_CHANNEL,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_REPORT_CHANNEL,
  ENSO_INCIDENT_REPORT_TOOL_NAME,
  ENSO_INCIDENT_RESOLVED_CHANNEL,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_LOG_EVENTS,
  ENSO_PERMISSION_DENIAL_ENTRY,
  ENSO_PERMISSION_DENIAL_RESOLUTIONS,
  ENSO_SECURITY_SIGNAL_ENTRY,
  ENSO_SESSION_RISK_ENTRY,
  ENSO_TOOL_FAMILIES,
  type EnsoCommandJudgement,
  type EnsoGuardDenial,
  type EnsoGuardRule,
  type EnsoGuardRuleKind,
  type EnsoIncidentOpened,
  type EnsoIncidentPolicy,
  type EnsoJudgeContext,
  type EnsoJudgeOutcome,
  type EnsoJudgeState,
  type EnsoPermissionDenial,
  type EnsoPermissionDenialResolution,
  type EnsoRiskEvent,
  type EnsoRiskState,
  type EnsoSessionIncidents,
  type EnsoSessionRiskChange,
  type EnsoTranscriptEntry,
  ensoLogger,
  customEntriesOf,
  foldSessionRisk,
  type GuardPolicy,
  INITIAL_SESSION_RISK,
  judgeContextOf,
  NO_SESSION_INCIDENTS,
  transcriptOf,
  openIncidentOf,
  readEnsoIncidentResolved,
  reportOwedOf,
  riskCallOf,
  riskEventsOfTranscript,
  sessionIncidentsOf,
  sessionIncidentsStep,
  sessionRiskStep,
  toolFamilyOf,
  WEB_FETCH_TOOL_NAME,
} from '@enso/core'
import { judgeStateOf } from '@enso/core/judge'
import { ensoHome, ensoLogsDir, ensoProjectsDir, findRepoRoot, threadTreeRoot } from '@enso/core/paths'
import { knownSecretValuesTracking, readSecret } from '@enso/core/secrets'
import { PERMISSIONS_DECISION_CHANNEL } from '@gotgenes/pi-permission-system'
import { type CheckCommandResult, checkCommand } from 'cc-safety-net/api'
import {
  canonicalToolName,
  type CredentialPlaces,
  createSessionReadTracker,
  findDeniedNetworkEgress,
  findEnvironmentDump,
  findDirectoryWord,
  findSecretPathWord,
  isInsideAnyRoot,
  isPersistenceWriteTarget,
  isProtectedForWrite,
  looksLikeSecret,
  resolveAgainstCwd,
  secretLocationBeneath,
  userIncidentPolicy,
  userJudgeConfig,
} from '../../core/index.ts'
import { createJevJudge, createLocalJudge, JEV_KEY_NAME } from './judge-backends.ts'

/**
 * Tier 0 guards — see `docs/concepts/pi-immediate-needs.md`.
 *
 * WHY A `tool_call` HANDLER RATHER THAN A TOOL OVERRIDE
 * pi resolves tools first-wins (`registerTool` -> `getAllRegisteredTools`), so a guard
 * implemented as an override of `write` is only safe while this package loads first.
 * Handlers are additive instead — `on()` pushes onto a list, every extension's handlers
 * run, and `emitToolCall` returns immediately on the first `block`. So a block here is
 * final and cannot be un-blocked by a later extension, whatever the load order.
 *
 * WHAT IT COVERS, AND HOW THE TOOL SET IS CHOSEN
 * `write` and `edit` are an inclusion list — mutation is a small closed set worth naming.
 * Every OTHER tool carrying a `path` is gated as a reader by EXCLUSION. That asymmetry is
 * deliberate and it is the correct direction for a boundary: an over-broad reader set
 * blocks something harmless and says so, while a too-narrow one permits a credential read
 * in silence. pi ships `read`, `grep`, `find` and `ls` with a `path` today, and an
 * inclusion list naming only `read` left `grep` over ~/.aws returning the credential line.
 *
 * BASH POLICY (#9) — two layers inside this one handler, and the boundary stated honestly:
 * 1. `cc-safety-net@2.4.6` (exact pin, declared `./api` export, MIT) analyzes every bash
 *    command: destructive git (`reset --hard`, `push --force`, `checkout --`), `rm -rf`
 *    on protected paths, and — the half that closes "every other guard is bypassable via
 *    bash" — SECRET ACCESS through the shell (`cat ~/.aws/credentials`, `.env` even as a
 *    curl data argument). Adopted as a LIBRARY, not a registered extension, so the
 *    tool_call participant count stays at two and #4's arbiter trigger stays unfired.
 *    Its contract: a throw means the command must not run — so a throw IS a deny.
 *    A contract test pins the verdict matrix; a vendor bump that shifts the boundary
 *    goes red instead of silently moving it.
 * 2. The network deny — ad-hoc HTTP/TCP clients at command position per shell segment,
 *    `/dev/tcp|udp` anywhere (`core/network-egress.ts`).
 *
 * ⚠ WHAT BASH POLICY STILL DOES NOT COVER, deliberately, so it never reads as confinement:
 * `git` remotes (push is this harness's job — the largest egress stays open), interpreters
 * (`python -c` / `node -e` can open sockets — the unbounded long tail), and persistence
 * writes through the shell (`echo x >> ~/.bashrc` — cc-safety-net allows it; #21's denial
 * gates only write/edit). Full path-confinement of bash remains #9's option-4 non-goal:
 * a parser that claimed it would read as coverage and not be coverage.
 *
 * TOOL IDENTITY (#4, gap 2): every tool-name comparison goes through `canonicalToolName`
 * on both sides, so a Claude-Code-style capitalised registration (`Write`, `Grep`, `Bash`)
 * can never skip a branch by case. And on
 * `session_start` the policy's tool names are checked against pi's live `getAllTools()`:
 * a policy naming a tool pi no longer registers (a rename upstream) would otherwise turn
 * this guard into a silent no-op with nothing anywhere reporting it. ⚠ The check FAILS
 * CLOSED by denying every subsequent tool call — it must never throw, because a throwing
 * `session_start` handler WEDGES print mode outright (probed 2026-09-04: 120s hang, zero
 * output), which is a hang, not a refusal. In-process (#69, the web host) a throw does the
 * opposite and is no better: pi routes it to `onError` and `bindExtensions` RESOLVES
 * (pinned by `agent-host.test.ts`), so the session comes up usable with this guard's setup
 * incomplete. Deny-all-via-variable is the one shape that fails closed on both hosts.
 *
 * ⚠ Shell-init and agent-config PERSISTENCE paths (`~/.bashrc`, `~/.gitconfig`,
 * `~/.claude.json`, `.mcp.json`, …) were gap 2 here until #21: they are not secrets —
 * nothing is exfiltrated, something is installed — so `looksLikeSecret` never caught
 * them. `isPersistenceWriteTarget` now denies `write`/`edit` on them UNCONDITIONALLY —
 * every mode, every surface, including print runs where the permission engine is absent
 * entirely (#20). The engine reaches at most "ask" for the same set, and an ask is
 * mode-shaped (auto's classifier may approve one, #496); this layer is the always-on floor
 * beneath that.
 *
 * READ-BEFORE-WRITE (#10, Tier 1 item 5): `write` to an EXISTING file requires that this
 * session has seen its content — a successful `read` (or its own successful `write`; see
 * KNOWLEDGE_CONFERRING_TOOLS for why `edit` does not count). Creation is untouched. The
 * state lives in a session-scoped tracker reset on `session_start`. ⚠ Known limit, accepted:
 * the tracker survives context compaction, the model's memory of the file may not — the
 * SESSION has seen the file even when the model no longer has the bytes in context.
 *
 * STALE-WRITE DETECTION (#11, Tier 1 item 6): each observation also stamps the file's
 * `{mtimeMs, size}`, and a `write` OR `edit` whose target no longer matches its stamp is
 * refused as "changed underneath us" — distinct from #10's "never read", because the
 * remedy differs: the on-disk content is newer than the session's picture, so re-applying
 * the old intent unchanged may itself be the mistake. ⚠ The `edit` asymmetry is deliberate
 * and easy to misread, and it has THREE legs: `edit` on an UNKNOWN file passes (its
 * exact-match is its own guard against blindness) and confers no knowledge; `edit` on a
 * STALE file is refused — an exact-match can succeed against a fragment that survived the
 * external change and then silently clobber everything around it; and a successful `edit`
 * on a KNOWN file REFRESHES the stamp without conferring knowledge, or the session's own
 * read → edit → edit would refuse the second edit as changed-underneath (found live).
 * The incident this closes: a concurrent agent in this checkout restored a
 * tracked-but-unstaged file from the index, and the unstaged work vanished with no error
 * anywhere.
 */

// The tools this policy names, each declared ONCE in canonical (lowercase) form. Every
// set below and every literal comparison in the dispatch uses these constants, and the
// session_start check iterates GUARD_POLICY_TOOL_NAMES — derived from the same constants,
// never a copy, so the check cannot drift from the policy it verifies (#4).
const TOOL_READ = 'read'
const TOOL_WRITE = 'write'
const TOOL_EDIT = 'edit'
const TOOL_BASH = 'bash'
const TOOL_POWERSHELL = 'powershell'

/**
 * Every tool name the guard's policy references — the policy/tool-list check's input.
 *
 * ⚠ Deliberately NOT the full tool surface: the reader gate (`grep`, `find`, `ls`, and any
 * future path-bearing tool) works by EXCLUSION, so a renamed or newly registered reader is
 * still gated without being named here — only the tools matched BY NAME can silently un-gate on
 * a rename, and those are exactly the names this list carries.
 */
export const GUARD_POLICY_TOOL_NAMES: readonly string[] = [TOOL_READ, TOOL_WRITE, TOOL_EDIT, TOOL_BASH, TOOL_POWERSHELL]

/**
 * Tools whose `path` argument mutates the filesystem.
 *
 * ⚠ This is the ONLY inclusion list here, and it is deliberate: mutation is a small
 * closed set worth naming, and a tool wrongly treated as a reader gets the weaker
 * check. Everything else carrying a `path` is treated as a READER by exclusion — see
 * the dispatch below for why that direction is the safe one.
 */
const MUTATING_PATH_TOOLS = new Set([TOOL_WRITE, TOOL_EDIT])

/**
 * Tools whose successful RESULT means the session has seen the target file's content (#10).
 *
 * `read` is the obvious member. `write` is a deliberate widening of the issue's rule
 * ("already read, or does not exist"): after a successful write the session authored every
 * byte, and without it the common create-then-revise flow would block on its own second
 * write. ⚠ `edit` is deliberately NOT a member: a successful edit proves knowledge of one
 * matched fragment (which could have come from grep output), not of the whole file — and
 * whole-file knowledge is exactly what a follow-up `write` claims. The cost is one `read`
 * before a wholesale rewrite of an edited file, which is the rule working.
 */
/**
 * ⚠ `threadId` on these records is INHERITED, never passed: in the web host pi runs
 * in-process, the prompt route binds `{ threadId }` in `AsyncLocalStorage`
 * (`withEnsoLogContext`), and the agent loop that reaches this handler is still inside that
 * async chain — proven by the slice-2 receipt, not designed. Move extensions to a worker or
 * a child (the TUI already runs pi as one) and every verdict loses its thread with no test
 * going red; a record here would then need the id handed to it explicitly.
 */
const log = ensoLogger('extension', 'guards')

const KNOWLEDGE_CONFERRING_TOOLS = new Set([TOOL_READ, TOOL_WRITE])

/**
 * Whether a successful `read` returned the WHOLE file (#57 S2) — the knowledge a whole-file
 * `write` needs. pi's `read` returns part of a file three ways: its own line/byte cut
 * (`details.truncation`, pi's `TruncationResult`, whose `truncated` is set whenever it cut —
 * including a first line over the byte limit, of which it returns nothing), an `offset` past the
 * first line, and a `limit` — which pi reports only in the text, so ANY limit counts as partial.
 * That errs toward "read it again without a limit", never toward a write over lines the session
 * did not see.
 *
 * `truncation` is read as pi's own type, not a shape written here: a rename in
 * pi fails the typecheck. `Partial`, because `details` arrives untyped.
 */
function returnedWholeFile(event: ToolResultEvent): boolean {
  const input = inputRecordOf(event)
  if (typeof input.offset === 'number' && input.offset > 1) return false
  if (input.limit !== undefined) return false
  const details: unknown = event.details
  if (typeof details !== 'object' || details === null || !('truncation' in details)) return true
  const truncation = details.truncation as Partial<TruncationResult> | undefined
  return truncation?.truncated !== true
}

/** Why a `write` over an existing file the session has not wholly seen is refused — never read, or read in part. */
function unseenContentReason(candidate: string, knownState: 'unknown' | 'partial'): string {
  if (knownState === 'partial') {
    return (
      `Writing to "${candidate}" is blocked: this session has read only part of it (a cut read, an ` +
      `offset or a limit), so a whole-file write would replace lines it has never seen. Use edit ` +
      `for a change inside it, or read the whole file first.`
    )
  }
  return (
    `Writing to "${candidate}" is blocked: the file exists and this session has not ` +
    `read it, so a whole-file write would replace content the session has never seen. ` +
    `Read "${candidate}" first, then write.`
  )
}

/**
 * The readers that return NAMES, never contents: pi's `ls` (a readdir) and `find` (fd). They are
 * the one exception to the search-beneath check (#160 §4) — listing `~` shows that `.aws` exists
 * and reads no file in it, and refusing it would block the most ordinary look around there is.
 * An EXCLUSION again, for the reason the reader gate gives: a reader not named here gets the
 * check, so a future recursive tool is refused over home until someone decides it reads names.
 */
const NAME_ONLY_READERS = new Set(['ls', 'find'])

/**
 * The tool's arguments as a plain record, whatever actually arrived. pi's contract says
 * `input` is an object, but this handler must never throw (a throwing hook wedges print
 * mode; in-process it yields a session with the guard half-set-up — see the header), so
 * a missing or non-object `input` reads as "no arguments" rather than as a TypeError.
 */
function inputRecordOf(event: ToolCallEvent | ToolResultEvent): Record<string, unknown> {
  const input: unknown = event.input
  if (typeof input !== 'object' || input === null) return {}
  return input as Record<string, unknown>
}

function pathArgumentOf(event: ToolCallEvent | ToolResultEvent): string | undefined {
  const value = inputRecordOf(event).path
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The guard's seams: the bash analyzer (#9), the harness root (#160 §4), the incident policy
 * and log directory (#466), the projects directory thread trees are minted in (#615), and the
 * command judge with the secret values its state is redacted of (#469).
 *
 * Production wires cc-safety-net's `checkCommand`, this checkout's root, the user's `config.json`
 * and `ENSO_HOME`'s log and projects directories and secrets; tests inject known verdicts, a root
 * they built, a policy, directories and a fake judge — a guard test must never reach the network.
 * `checkCommand` reads LOCAL policy per call, so a guard test that touched the real
 * library would vary with the machine's cc-safety-net config (the contract test alone exercises
 * the real one, and pins defaults explicitly) — and the same holds for the machine's config file.
 */
export interface GuardDependencies {
  analyzeBashCommand: (input: { command: string; cwd: string }) => CheckCommandResult
  /**
   * The harness's own root — one of the places a search over a directory above it is refused for
   * when it holds a credential location (#160 §4, `CredentialPlaces`). Since #421 its `.enso/` is
   * migrated into `ENSO_HOME` (in home, so always a place); what the migration leaves behind — a
   * login `ENSO_HOME` already had — is still here, and still refused.
   */
  harnessRoot: string
  /** Whether an incident halts, and the risk thresholds — read at every `session_start` (#466). */
  incidentPolicy: () => EnsoIncidentPolicy
  /** The log directory `protected-records` refuses a shell command naming (#466). */
  logsDirectory: string
  /**
   * Where thread trees are minted, `ENSO_HOME/projects` (#551): a session whose cwd is a tree there
   * has its own files judged relative to the tree, not as the harness's own directory (#615).
   */
  projectsDirectory: string
  /**
   * The command judge, or undefined when `security.judge.backend` is `off` (the default) — read at
   * every `session_start`, as the incident policy is (#469).
   */
  commandJudge: () => CommandJudge | undefined
  /** The known secret values a judge state is redacted of before it leaves (#469), read per judged call. */
  judgeSecretValues: () => readonly string[]
}

/**
 * The guards extension, over its seams. The bash analyzer is a dependency of this one
 * handler, never an extension of its own.
 *
 * @invariant guarded-tool-call/two-participants Two tool_call participants, structurally.
 * The manifest loads guards before the mode extension (`packages/harness/package.json`,
 * `pi.extensions`), and cc-safety-net is a library under this handler, not a participant, so the
 * count stays at two (#4, #9). The tripwire scans every declared extension tree for a `tool_call`
 * registration and asserts set equality with those two. A third is #4's arbiter trigger, and the
 * test says not to add yourself to the list.
 */
export function createGuards(dependencies: GuardDependencies): (pi: ExtensionAPI) => void {
  return function guards(pi: ExtensionAPI): void {
    guardsWithDependencies(pi, dependencies)
  }
}

/** The user's incident policy; an unreadable `config.json` fails closed and says so (#466). */
function productionIncidentPolicy(): EnsoIncidentPolicy {
  const { policy, problem } = userIncidentPolicy(ensoHome(process.env))
  if (problem !== undefined) {
    log.error('config.json is unreadable, so incidents halt with the default thresholds: {problem}', { problem })
  }
  return policy
}

/**
 * Per attempt, and the live path makes one: a judgement nobody waits for still holds a socket and
 * a session reference until it settles (#469).
 */
const JUDGE_TIMEOUT_MS = 5000

/**
 * Per request for `local` (#532): a llama.cpp model reads the whole state on its first question —
 * measured 23–42 s on this 12-CPU, GPU-less machine with a 0.5B model over 7–11k-token prompts,
 * then ~1 s per question from the prompt cache. Jev's 5 s would leave every local call unjudged.
 * Nobody waits on it (the judge is fire-and-forget), but it still holds a socket until it settles.
 */
const LOCAL_JUDGE_TIMEOUT_MS = 90_000

/**
 * The user's command judge (#469): off unless `security.judge.backend` names one. ⚠ An unreadable
 * `config.json` fails closed, which for the judge is OFF — nothing is sent — and says so.
 */
function productionCommandJudge(): CommandJudge | undefined {
  const home = ensoHome(process.env)
  const config = userJudgeConfig(home)
  if ('problem' in config && config.problem !== undefined) {
    log.error('the command judge is off: {problem}', { problem: config.problem })
  }
  if (config.backend === 'off') return undefined
  if (config.backend === 'local') return createLocalJudge({ ...config.local, timeoutMs: LOCAL_JUDGE_TIMEOUT_MS })
  return createJevJudge({ apiKey: () => readSecret(home, JEV_KEY_NAME), timeoutMs: JUDGE_TIMEOUT_MS })
}

/** The pi entry point — the real analyzer, this checkout's root and the user's config, wired at the composition root. */
export default createGuards({
  analyzeBashCommand: checkCommand,
  harnessRoot: findRepoRoot(import.meta.url),
  incidentPolicy: productionIncidentPolicy,
  logsDirectory: ensoLogsDir(ensoHome(process.env)),
  projectsDirectory: ensoProjectsDir(ensoHome(process.env)),
  commandJudge: productionCommandJudge,
  // The tracking thunk: one `stat` per judged call, re-read only when secrets.env changes (#207).
  judgeSecretValues: knownSecretValuesTracking(ensoHome(process.env)),
})

/**
 * A refusal as this guard produces it: pi's `{ block, reason, terminate? }` plus the RULE that
 * refused (#144 slice 4). The rule is what the denial record carries and what a day's stats count
 * by; the reason is prose for the model. Stripped back to pi's shape at the handler, so the
 * runtime is handed exactly the contract it published and nothing of ours rides on it.
 */
interface GuardDenial {
  readonly block: true
  readonly reason: string
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
 */
function deny(rule: EnsoGuardRule, reason: string, egress?: GuardDenial['egress']): GuardDenial {
  const kind = ENSO_GUARD_RULE_KINDS[rule]
  const askLine = ASK_LINE_BY_KIND[kind]
  return {
    block: true,
    reason: askLine === undefined ? reason : `${reason}\n\n${askLine}`,
    rule,
    ...(kind === 'authorization' || kind === 'suspension' ? { terminate: true } : {}),
    ...(egress === undefined ? {} : { egress }),
  }
}

/** The engine's decision payload, when it refuses the agent's own call: its fields, checked. */
function permissionDenialOf(raw: unknown, toolCallId: string | undefined): EnsoPermissionDenial | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const decision = raw as Record<string, unknown>
  if (decision.result !== 'deny') return undefined
  // A forwarded ask is a subagent's, served by this session: the refusal is not this session's agent's.
  if (decision.forwarding !== undefined && decision.forwarding !== null) return undefined
  const { requestId, surface, value, resolution } = decision
  if (typeof requestId !== 'string' || typeof surface !== 'string' || typeof value !== 'string') return undefined
  if (!(ENSO_PERMISSION_DENIAL_RESOLUTIONS as readonly unknown[]).includes(resolution)) return undefined
  const denial = { requestId, surface, value, resolution: resolution as EnsoPermissionDenialResolution }
  return toolCallId === undefined ? denial : { toolCallId, ...denial }
}

/**
 * The session's security (#464, #466, phases 1 and 3 of #189): every call, every refusal — the
 * guard's and the permission engine's — folded by `@enso/core`'s `sessionRiskStep`, each signal and
 * each level change appended as an entry and logged; and the session's incidents, folded by
 * `sessionIncidentsStep` over the same kind of entries.
 *
 * ⚠ THE RISK FOLD IS OBSERVE ONLY. A throw anywhere in it is logged and swallowed: a bug in risk
 * must not become a refusal, and must not become a pass. What decides a call is the INCIDENT state
 * (`suspension`), which only records change: an opening this observer appends, a resolution the
 * host appends and announces on `ENSO_INCIDENT_RESOLVED_CHANNEL`.
 *
 * ⚠ AN INCIDENT OPENS WHEN THE RISK IS AT `incident` AND NONE IS OPEN — not on the transition
 * alone, so a session that reached `incident` before #466 existed opens one at its next event after
 * a resume. A resolution resets the risk to `low` (it is the only reset), so the same signals never
 * reopen it. With `halt` off (the default) the opening suspends nothing: it is the alert.
 *
 * ⚠ THE ENGINE'S REFUSAL IS ATTRIBUTED HERE. Its decision event names no tool call. This handler
 * is the first `tool_call` participant, and pi prepares a batch's calls one at a time (every
 * handler of a call, the engine's ask included, before the next call is raised), so the call the
 * guard saw last is the call the engine is deciding. The entry the guard writes names it, which is
 * what lets a replay put the refusal back in its place (`riskEventsOfEntries`).
 */
function observeSessionSecurity(
  pi: ExtensionAPI,
  readPolicy: () => EnsoIncidentPolicy,
): {
  resume(branch: () => readonly unknown[]): void
  call(event: ToolCallEvent, signal: AbortSignal | undefined, model: string | undefined): void
  /** Folds the guard's own refusal; true when it opened an incident that halted. */
  guardDenied(denial: EnsoGuardDenial): boolean
  /** The incident state a call is decided against. */
  incidents(): EnsoSessionIncidents
  /** The command judge's context for a call the fold has met, or undefined when out of scope (#469). */
  judgeContext(toolCallId: string): EnsoJudgeContext | undefined
} {
  // ⚠ Read at every `session_start`, AND lazily at the first event if none fired — the floor's
  // reasoning (`verifyPolicyToolNames`): pi's ordering is an assumption, and a policy read as
  // "alert only" until then would fail OPEN through exactly that window.
  let sessionPolicy: EnsoIncidentPolicy | undefined
  const policy = (): EnsoIncidentPolicy => {
    sessionPolicy ??= readPolicy()
    return sessionPolicy
  }
  let risk: EnsoRiskState = INITIAL_SESSION_RISK
  let incidents: EnsoSessionIncidents = NO_SESSION_INCIDENTS
  let currentCall: string | undefined
  let currentSignal: AbortSignal | undefined
  let currentModel: string | undefined

  /** Open an incident when the risk calls for one; true when it halted. */
  const openIfIncident = (): boolean => {
    if (risk.level !== 'incident' || incidents.ended || openIncidentOf(incidents) !== undefined) return false
    const { halt } = policy()
    const opened: EnsoIncidentOpened = {
      incidentId: crypto.randomUUID(),
      signals: [...risk.signals],
      halted: halt,
      suspended: halt ? [...ENSO_TOOL_FAMILIES] : [],
      ...(currentModel === undefined ? {} : { model: currentModel }),
    }
    pi.appendEntry(ENSO_INCIDENT_OPENED_ENTRY, opened)
    incidents = sessionIncidentsStep(incidents, ENSO_INCIDENT_OPENED_ENTRY, opened)
    log.warn(ENSO_LOG_EVENTS.incidentOpened, {
      incidentId: opened.incidentId,
      halted: opened.halted,
      suspended: opened.suspended.join(', ') || 'nothing',
      signals: opened.signals.length,
      model: opened.model ?? '(unknown)',
    })
    // The report extension asks for the report in this same run (#467).
    if (opened.halted) pi.events.emit(ENSO_INCIDENT_OPENED_CHANNEL, opened)
    return opened.halted
  }

  const observe = (event: EnsoRiskEvent): boolean => {
    try {
      const step = sessionRiskStep(risk, event, policy().thresholds)
      for (const signal of step.raised) {
        log.warn(ENSO_LOG_EVENTS.securitySignal, { ...signal })
        pi.appendEntry(ENSO_SECURITY_SIGNAL_ENTRY, signal)
      }
      if (step.state.level !== risk.level) {
        const change: EnsoSessionRiskChange = { level: step.state.level, signals: step.state.signals.length }
        log.warn(ENSO_LOG_EVENTS.sessionRiskChanged, { ...change })
        pi.appendEntry(ENSO_SESSION_RISK_ENTRY, change)
      }
      risk = step.state
      return openIfIncident()
    } catch (error) {
      log.error('the session risk fold failed; no call is decided by it: {error}', { error })
      return false
    }
  }

  pi.events.on(PERMISSIONS_DECISION_CHANNEL, (raw: unknown): void => {
    // Inside the engine's own gate: a throw here must not reach it (observe only, as above).
    try {
      const denial = permissionDenialOf(raw, currentCall)
      if (denial === undefined) return
      // ⚠ A Stop is not a No (#496 review): the engine reads an unanswered prompt as `user_denied`,
      // and the host settles every open prompt unanswered when the run is aborted — which it does
      // after aborting the run's signal. A person's No under an aborted signal was the Stop's.
      if (denial.resolution === 'user_denied' && currentSignal?.aborted === true) return
      pi.appendEntry(ENSO_PERMISSION_DENIAL_ENTRY, denial)
      observe({ kind: 'permission-denial', ...denial })
    } catch (error) {
      log.error('a permission decision could not be recorded: {error}', { error })
    }
  })

  // The host appended the resolution's record and says so here, so the suspension lifts without a
  // reload — the same step, and the same reset, a replay of that entry makes.
  pi.events.on(ENSO_INCIDENT_RESOLVED_CHANNEL, (raw: unknown): void => {
    const resolved = readEnsoIncidentResolved(ENSO_INCIDENT_RESOLVED_ENTRY, raw)
    if (resolved === undefined) {
      log.error('an incident resolution arrived malformed; nothing is lifted: {raw}', { raw })
      return
    }
    incidents = sessionIncidentsStep(incidents, ENSO_INCIDENT_RESOLVED_ENTRY, resolved)
    risk = sessionRiskStep(risk, { kind: 'incident-resolved' }, policy().thresholds).state
    // Debug, not the event: the host's resolve path records the day's one line of it (#468).
    log.debug('security incident {incidentId} resolution applied live', { incidentId: resolved.incidentId })
  })

  // The report extension appended the report, or its absence, and says so here (#467): the report
  // window closes at once, and the suspension stands as before — the same step a replay makes.
  pi.events.on(ENSO_INCIDENT_REPORT_CHANNEL, (raw: unknown): void => {
    const { customType, data } = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      customType?: unknown
      data?: unknown
    }
    if (typeof customType !== 'string') return
    incidents = sessionIncidentsStep(incidents, customType, data)
  })

  return {
    // Rebuilt from the branch, never from stored signals: the same folds over the same entries.
    resume(branch: () => readonly unknown[]): void {
      sessionPolicy = readPolicy()
      currentCall = undefined
      currentSignal = undefined
      // ⚠ Never a throw: this runs in `session_start` (the print-mode wedge, `verifyPolicyToolNames`).
      let transcript: readonly EnsoTranscriptEntry[]
      try {
        transcript = transcriptOf(branch())
      } catch (error) {
        log.error('the branch could not be read; incidents and risk keep their state: {error}', { error })
        return
      }
      incidents = sessionIncidentsOf(customEntriesOf(transcript))
      try {
        risk = foldSessionRisk(riskEventsOfTranscript(transcript), policy().thresholds)
      } catch (error) {
        risk = INITIAL_SESSION_RISK
        log.error('the session risk could not be rebuilt from the branch; it starts low: {error}', { error })
      }
    },
    call(event: ToolCallEvent, signal: AbortSignal | undefined, model: string | undefined): void {
      currentCall = event.toolCallId
      currentSignal = signal
      currentModel = model
      observe(riskCallOf(event.toolCallId, event.toolName, event.input))
    },
    guardDenied(denial: EnsoGuardDenial): boolean {
      return observe(
        denial.via === undefined
          ? { kind: 'guard-denial', toolCallId: denial.toolCallId, rule: denial.rule }
          : { kind: 'guard-denial', toolCallId: denial.toolCallId, rule: denial.rule, via: denial.via },
      )
    },
    incidents: () => incidents,
    // Off the fold's own state, right after the call's step: what `judgeContextsOfEntries` replays.
    judgeContext: (toolCallId) => judgeContextOf(risk, toolCallId),
  }
}

/** The judgement's log properties: each answer as a number when judged, why not when unjudged. */
function judgementProperties(judgement: EnsoCommandJudgement): Record<string, string | number> {
  const { toolCallId, scope, backend, kind, latencyMs } = judgement
  const base = { toolCallId, scope, backend, kind, latencyMs }
  if (judgement.kind === 'unjudged') return { ...base, reason: judgement.reason }
  const answers = Object.entries(judgement.answers).flatMap(([question, answer]) =>
    answer === undefined ? [] : [[question, answer.value] as const],
  )
  return { ...base, ...Object.fromEntries(answers) }
}

/**
 * Ask the judge about a call and record what it answered (#469 PR1: recorded, nothing more).
 *
 * ⚠ NOT AWAITED: the call runs while the judge thinks, so the judge adds no latency to it — and
 * nothing it answers can change the verdict. A rejection (a backend breaking its never-throws
 * contract) is recorded as `unjudged`, never as clean; a record that cannot be written (the
 * session is gone by the time the answer lands) is logged. Neither reaches pi.
 */
function judgeInBackground(
  pi: ExtensionAPI,
  judge: CommandJudge,
  request: {
    readonly context: EnsoJudgeContext
    readonly state: EnsoJudgeState
    readonly signal: AbortSignal | undefined
  },
): void {
  const started = performance.now()
  const record = (outcome: EnsoJudgeOutcome): void => {
    const judgement = commandJudgementOf(request.context, judge.backend, performance.now() - started, outcome)
    pi.appendEntry(ENSO_COMMAND_JUDGEMENT_ENTRY, judgement)
    log.info(ENSO_LOG_EVENTS.commandJudged, judgementProperties(judgement))
  }
  // The executor runs now, so the request leaves now; a synchronous throw becomes a rejection.
  new Promise<EnsoJudgeOutcome>((resolve) => resolve(judge.judge(request.state, request.signal)))
    .then(record, (error: unknown) => record({ kind: 'unjudged', reason: `the judge failed: ${String(error)}` }))
    .catch((error: unknown) => {
      log.error('the judgement of {toolCallId} could not be recorded: {error}', {
        toolCallId: request.context.toolCallId,
        error,
      })
    })
}

/**
 * The refusal of a call to a suspended family (#466), or undefined when its family is not suspended.
 * The reason names the incident, the family and its tools, what still works, and that only the
 * user lifts it — no "ask": an answer to `ask_user` cannot, only a resolution in Enso can.
 */
function suspensionDenial(toolName: string, incidents: EnsoSessionIncidents): GuardDenial | undefined {
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
 * The shell-command denies, in order — a denied command must never have had its input
 * mutated, so the timeout patch stays in the handler, after this returns undefined.
 *
 * 1. cc-safety-net (destructive commands + secret access THROUGH bash) — as a LIBRARY
 *    inside the one handler, so the tool_call participant count stays at two and #4's
 *    third-participant trigger stays unfired. bash only: checkCommand parses POSIX shell,
 *    and feeding it PowerShell would produce verdicts about a command it misread in
 *    either direction. Its own contract: "If this function throws, the caller must not
 *    execute the command" — so a throw IS a deny.
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
 * For `bash` the cc-safety-net verdict is read first (a throw is a deny, per its contract), then
 * the network deny by name at command position per segment, with a *cannot vouch* refusal for a
 * construct it cannot resolve, then the environment-dump deny, then the records deny, then the
 * secret-path deny. `powershell` skips the analyzer for the coarse raw scan. Only a command that
 * passed them all gets `defaultBashTimeoutSeconds`, so no denied command has mutated input. What
 * the analyzer allows (a redirect into its own config dir) is our layers' job: the division of
 * labour its contract test pins against defaults.
 */
function shellCommandDenial(
  call: {
    toolName: string
    command: string
    cwd: string
    recordDirectories: readonly string[]
    readonly ownTree: string | undefined
  },
  dependencies: GuardDependencies,
  policy: GuardPolicy,
): GuardDenial | undefined {
  const { toolName, command, cwd } = call
  if (toolName === TOOL_BASH && command.length > 0) {
    let safetyNetVerdict: CheckCommandResult
    try {
      safetyNetVerdict = dependencies.analyzeBashCommand({ command, cwd })
    } catch (error) {
      log.error('cc-safety-net checkCommand threw — denying per its contract: {error}', { error })
      safetyNetVerdict = {
        kind: 'deny',
        reason: `the safety analyzer failed (${String(error)}), and its contract is that an unanalyzed command must not run`,
      }
    }
    if (safetyNetVerdict.kind === 'deny') {
      const ruleId =
        'ruleId' in safetyNetVerdict && safetyNetVerdict.ruleId !== undefined ? ` (${safetyNetVerdict.ruleId})` : ''
      return deny('cc-safety-net', `Bash command blocked by cc-safety-net${ruleId}: ${safetyNetVerdict.reason}`)
    }
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

/**
 * @flow guarded-tool-call A tool call through the guard: one verdict, first block wins, always a record
 * Before any tool runs, the runtime raises `tool_call` and every extension's handler answers in
 * load order; the first `{ block: true, reason }` ends the call, and nothing after it can
 * un-block. Our guard is one handler with an ordered `decide` inside it: the fail-closed floor
 * and an incident's suspension (`standingDenial`), the shell denies, the write gates, then every
 * other path-bearing tool as a reader. The bash analyzer is a library under that handler, not a
 * participant of its own, so the count stays at two (#4, #9). Every answer is a log record. A
 * refused call reaches the browser as a result flagged `isError` (the runtime's shape for any
 * failure) and beside it the guard's own custom entry naming the call and the rule, which is what
 * the page draws a refusal from, live and on resume (#387).
 * @see docs/seams/guards.md the guards seam: the policy, the dependencies, decide's order and the L5 crossing
 * @see packages/harness/core/network-egress.ts the network bar, and what it does not cover (its header)
 * @see docs/glossary.md the words: guard, verdict, policy, rule, participant, arbiter, boundary vs bar (Permission)
 *
 * @invariant guarded-tool-call/one-verdict The verdict is a denial with its reason, or nothing.
 * `decide` returns a `GuardDenial` or `undefined`, and the handler hands pi its own shape back:
 * every refusal is `{ block: true, reason }`, every pass is `undefined`. Refusing is final:
 * handlers are additive and the runtime returns on the first `block`, whatever loads after (the
 * file header). `HostedThread.probeToolCall` pins this through the runtime's own hook runner,
 * with the real load order and participants: the guards' refusal with its reason, and first
 * block wins, so a later extension cannot un-block and its own block stands.
 */
function guardsWithDependencies(pi: ExtensionAPI, dependencies: GuardDependencies): void {
  const policy: GuardPolicy = DEFAULT_GUARD_POLICY

  // #10: which files this session has seen. Session-scoped twice over: pi tears the
  // extension runtime down on session replacement (fresh closure), and session_start —
  // which also fires for "reload" and "resume", where the runtime survives — resets it.
  const readTracker = createSessionReadTracker()
  // #464, #466: the session's security risk and incidents, observed beside what it has read;
  // rebuilt on every start.
  const security = observeSessionSecurity(pi, dependencies.incidentPolicy)
  // The session and log directories `protected-records` refuses a shell command naming (#466):
  // this project's session directory, read off the session at each start, and the log directory.
  let recordDirectories: readonly string[] = [dependencies.logsDirectory]
  // #469: the command judge, read at every start — and lazily at the first call if none fired, as
  // the incident policy is. `{ judge: undefined }` is a read that found it off.
  let sessionJudge: { readonly judge: CommandJudge | undefined } | undefined
  const readJudge = (): { readonly judge: CommandJudge | undefined } => {
    // ⚠ Never a throw: this runs in `session_start` (the print-mode wedge). Failing, it is off.
    try {
      return { judge: dependencies.commandJudge() }
    } catch (error) {
      log.error('the command judge could not be read; it is off: {error}', { error })
      return { judge: undefined }
    }
  }

  /**
   * Judge a `bash` call the guard let through, when it is in the judge's scope (#469 scope 1, the
   * selection core's `judgeContextOf` makes). Recorded only — it feeds no risk signal and asks
   * nothing — and ⚠ observe only as the risk fold is: a throw here is logged, never a verdict.
   */
  function judgeIfInScope(toolCallId: string, cwd: string, signal: AbortSignal | undefined): void {
    try {
      sessionJudge ??= readJudge()
      const { judge } = sessionJudge
      if (judge === undefined) return
      const context = security.judgeContext(toolCallId)
      if (context === undefined) return
      const state = judgeStateOf(context, {
        cwd,
        secretPathFragments: policy.secretPathFragments,
        secretValues: dependencies.judgeSecretValues(),
      })
      judgeInBackground(pi, judge, { context, state, signal })
    } catch (error) {
      log.error('the command judge could not be asked about {toolCallId}: {error}', { toolCallId, error })
    }
  }

  let policyToolsChecked = false
  let policyToolMismatch: string | undefined

  /**
   * @invariant guarded-tool-call/fail-closed-floor The floor comes first and fails closed.
   * A policy naming a tool the runtime does not register, or a tool list that cannot be read,
   * denies EVERY call with the mismatch in the reason (#4 gap 2): such a policy is otherwise a
   * silent no-op, since the guard compiles, loads and never fires. Checked against the LIVE tool
   * list each `session_start` (extensions can register tools, so the list is per-session state),
   * AND lazily on the first `tool_call` if `session_start` has not fired yet, so the floor never
   * depends on pi's event ordering: a lifecycle that delivered a `tool_call` first would otherwise
   * fail OPEN through this very window. The check cannot run at extension load
   * (pi refuses action methods there: "Extension runtime not initialized"), but by the first
   * `tool_call` the registry is certainly populated.
   *
   * ⚠ Deny-all via a variable, NEVER a throw: a throwing `session_start` handler wedges print mode
   * outright (probed 2026-09-04: 120s hang, zero output). The unreadable-list case fails closed
   * the same way: "could not check" must not render as "checked, fine".
   */
  function verifyPolicyToolNames(): void {
    policyToolsChecked = true
    try {
      const registered = new Set(pi.getAllTools().map((tool) => canonicalToolName(tool.name)))
      const missing = GUARD_POLICY_TOOL_NAMES.filter((policyName) => !registered.has(policyName))
      policyToolMismatch =
        missing.length === 0
          ? undefined
          : `the guard policy names tools pi does not register: ${missing.join(', ')} ` +
            `(registered: ${[...registered].join(', ')})`
    } catch (error) {
      // The denial reason below is for the operator; the raw error (with stack) goes to
      // stderr for whoever has to debug WHY enumeration failed after the fact.
      log.error('getAllTools() failed during the policy check: {error}', { error })
      policyToolMismatch = `the guard could not enumerate pi's tools: ${String(error)}`
    }
  }

  pi.on('session_start', (_event, extensionContext): void => {
    readTracker.reset()
    verifyPolicyToolNames()
    try {
      recordDirectories = [extensionContext.sessionManager.getSessionDir(), dependencies.logsDirectory]
    } catch (error) {
      log.error('the session directory could not be read; protected-records keeps the log directory: {error}', {
        error,
      })
      recordDirectories = [dependencies.logsDirectory]
    }
    security.resume(() => extensionContext.sessionManager.getBranch())
    sessionJudge = readJudge()
  })

  // @invariant guarded-tool-call/knowledge-from-results Knowledge comes from results, never from calls.
  // This handler records a file as seen only when `isError` is false: a blocked call produces
  // no `tool_result` at all (verified in pi's agent-loop: the "immediate" path skips
  // afterToolCall), and a failed one arrives with `isError`, so neither can record.
  pi.on('tool_result', (event, extensionContext): void => {
    if (event.isError) return
    const candidate = pathArgumentOf(event)
    if (candidate === undefined) return
    const target = resolveAgainstCwd(candidate, extensionContext.cwd)
    const toolName = canonicalToolName(event.toolName)
    if (KNOWLEDGE_CONFERRING_TOOLS.has(toolName)) {
      readTracker.recordKnownPath(target, { whole: toolName !== TOOL_READ || returnedWholeFile(event) })
      return
    }
    // ⚠ The session's own successful `edit` moves mtime/size without conferring
    // whole-file knowledge (#10): a KNOWN file's stamp follows the mutation (or the
    // next edit/write refuses the session's own work as "changed underneath us" —
    // found live, read → edit → edit), while an unknown file stays unknown.
    if (toolName === TOOL_EDIT) {
      readTracker.refreshStampIfKnown(target)
    }
  })

  // @invariant guarded-tool-call/every-verdict-recorded Every verdict is a record (#132).
  // A denial at `warn` with the `toolCallId`, the tool, the path it named, the RULE that refused
  // (#144: the word a day's stats count by) and the reason; an allow at `debug`, never silent.
  // The transcript shows the model what was refused; this says WHEN, on which call, in the file
  // beside every other layer's line about it.
  //
  // @invariant guarded-tool-call/denial-entry The guard says it refused, in the log pi keeps (#387).
  // pi is handed its own shape back, `{ block, reason }`, and never our `rule`. pi discards the
  // block marker and turns a block into an error result indistinguishable from a failed command,
  // and a blocked call never reaches a `tool_result` hook, so before returning the verdict the
  // guard appends a custom entry, `ENSO_GUARD_DENIAL_ENTRY` with `{ toolCallId, rule }`: the one
  // thing of ours pi persists beside it. Live it crosses as a `custom-entry` observation into the
  // thread's `refusals` store, as who refused (`EnsoToolRefusal`, #523 — the engine's
  // `enso-permission-denial` resolves to the same shape); on a cold read `transcript-to-messages.ts`
  // joins it onto its result as `enso:refusal` metadata, and adopting the history seeds the same
  // store. The tool row and the status bar read only that store: a refusal is never recognised by
  // its wording.
  // pi's context builder skips `custom` entries, so the model's view is unchanged.
  pi.on('tool_call', (event, extensionContext): ToolCallEventResult | undefined => {
    // The call first, then its refusal: the order the risk fold and every replay of it read (#464).
    security.call(event, extensionContext.signal, extensionContext.model?.id)
    const verdict = decide(event, extensionContext.cwd)
    const path = pathArgumentOf(event)
    const properties = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(path === undefined ? {} : { path }),
    }
    if (verdict === undefined) {
      log.debug('{toolName} allowed', properties)
      judgeIfInScope(event.toolCallId, extensionContext.cwd, extensionContext.signal)
      return undefined
    }
    const denial: EnsoGuardDenial = {
      toolCallId: event.toolCallId,
      rule: verdict.rule,
      ...verdict.egress,
    }
    log.warn(ENSO_LOG_EVENTS.toolDenied, {
      ...properties,
      ...verdict.egress,
      rule: verdict.rule,
      reason: verdict.reason,
    })
    pi.appendEntry(ENSO_GUARD_DENIAL_ENTRY, denial)
    // ⚠ A refusal that tips the session into a halting incident ends the batch (#466), whatever
    // its own rule's kind: a redirect would otherwise leave the model its turn to try the route.
    const halted = security.guardDenied(denial)
    return verdict.terminate === true || halted
      ? { block: verdict.block, reason: verdict.reason, terminate: true }
      : { block: verdict.block, reason: verdict.reason }
  })

  /**
   * What refuses a call whatever it is: #4's fail-closed floor, then an incident's suspension (#466).
   * Out of `decide` so it stays under the complexity pin `.fallowrc.jsonc` holds it to.
   */
  function standingDenial(toolName: string): GuardDenial | undefined {
    // --- #4's fail-closed floor: a policy/tool-list mismatch denies EVERYTHING, first.
    // One reason per denial, so an unattended run's transcript names the mismatch.
    // The lazy leg: an unchecked state here means this call arrived before session_start
    // ever fired, and unchecked must not read as "checked, fine" — verify now.
    if (!policyToolsChecked) {
      verifyPolicyToolNames()
    }
    if (policyToolMismatch !== undefined) {
      return deny(
        'policy-mismatch',
        `All tool calls are blocked until the guard policy matches pi's tools: ${policyToolMismatch}`,
      )
    }
    // --- #466: a family an incident suspended is refused before any other rule — the incident is
    // the thread's state, not a judgement of this call.
    return suspensionDenial(toolName, security.incidents())
  }

  /**
   * @invariant guarded-tool-call/writes-included-readers-excluded Writes are an inclusion list; readers are everything else.
   * `write` and `edit` are claimed before the reader fall-through and checked in order: outside
   * the write roots (the cwd when none are configured), a protected fragment, a persistence
   * target, a credential pattern, then the thread's knowledge of the file. *Stale* refuses both
   * tools; *unknown and existing* refuses `write` only, and so does *partial*: a `read` that
   * returned part of the file (pi's own cut, an `offset`, or any `limit`) stamps it for *stale*
   * but is not the whole-file knowledge a `write` needs (#10, #11, #57 S2). Stale is distinct
   * from unknown: the reason says changed, not never read.
   *
   * Every other tool carrying a `path` is a reader and a credential pattern denies it: exclusion,
   * because an inclusion list naming only `read` once let `grep` over `~/.aws` through, and a tool
   * the guard has never heard of is still a reader. A reader is also refused when its path holds
   * a credential location beneath it (`grep` over `~` or `/` recurses into `~/.aws` the same way:
   * #160 §4, `secretLocationBeneath`), except `ls` and `find`, which return names, never contents.
   * The locations are the fragments placed in home, and, where they exist, in the workspace and
   * the harness's own root (a pre-#421 `.enso/` the migration left behind: a `.gitignore` does not
   * keep ripgrep out, since it is ignored outside a git work tree and the agent may edit it).
   * `~/.enso` is in home, so it is always covered; once the checkout's `.enso/` is migrated,
   * `grep path=.` at the root of the Enso checkout itself passes. Not seen: a fragment's location
   * anywhere else, and a basename-class file (`.env`) beneath the path, which only a walk would
   * find.
   */
  function decide(event: ToolCallEvent, cwd: string): GuardDenial | undefined {
    const toolName = canonicalToolName(event.toolName)
    const standing = standingDenial(toolName)
    if (standing !== undefined) return standing
    // The session's own thread tree, when its cwd is one (#615): judged like a checkout, never as ENSO_HOME.
    const ownTree = threadTreeRoot(dependencies.projectsDirectory, cwd)

    // --- bash/powershell (#9): deny first, patch last — a denied command must never
    // have had its input mutated. The four denies live in `shellCommandDenial` so this
    // handler stays under the complexity pin `.fallowrc.jsonc` holds it to.
    if (toolName === TOOL_BASH || toolName === TOOL_POWERSHELL) {
      const input = inputRecordOf(event)
      const command = typeof input.command === 'string' ? input.command : ''
      const denial = shellCommandDenial({ toolName, command, cwd, recordDirectories, ownTree }, dependencies, policy)
      if (denial !== undefined) return denial

      // Patch, do not block: a missing timeout means a hung command holds the
      // session indefinitely. LAST, so no denied command gets mutated input.
      if (input.timeout === undefined) {
        input.timeout = policy.defaultBashTimeoutSeconds
      }
      return undefined
    }

    const candidate = pathArgumentOf(event)
    if (candidate === undefined) return undefined
    const target = resolveAgainstCwd(candidate, cwd)

    // --- writes first: `write` and `edit` also carry a `path`, so they must be
    // claimed before the reader fallthrough or they would get the weaker check.
    if (MUTATING_PATH_TOOLS.has(toolName)) {
      const roots = policy.writeRoots.length > 0 ? policy.writeRoots : [cwd]

      if (!isInsideAnyRoot(target, roots)) {
        return deny(
          'write-confinement',
          `Writing to "${candidate}" is blocked: it resolves to ${target}, outside the workspace ` +
            `(${roots.join(', ')}). pi resolves paths but does not confine them, so this guard does.`,
        )
      }
      if (isProtectedForWrite(target, policy.protectedWriteFragments)) {
        return deny('protected-internals', `Writing to "${candidate}" is blocked: it targets protected internals.`)
      }
      // ⚠ Checked on the write path ONLY, deliberately: READING ~/.bashrc or .mcp.json is
      // routine and harmless. The danger is installation, not disclosure (#21).
      if (isPersistenceWriteTarget(target, ownTree)) {
        return deny(
          'persistence-write',
          `Writing to "${candidate}" is blocked: it targets a shell-init, git, editor or ` +
            `agent-config persistence path — a write there is harmless now and executes ` +
            `later, outside this session, as the user.`,
        )
      }
      if (looksLikeSecret(target, policy.secretPathFragments, ownTree)) {
        return deny('secret-write', `Writing to "${candidate}" is blocked: it matches a credential pattern.`)
      }
      // --- #10 + #11: the session's knowledge of the target, in two distinct refusals.
      //
      // "stale" (#11) gates BOTH mutating tools: the file changed underneath the session
      // (another agent, a `git checkout --` restore), and an `edit` whose exact-match
      // happens to survive the external change would silently clobber everything AROUND
      // the matched fragment — the exact-match guards against a blind edit, not a moved
      // file. "unknown" (#10) gates `write` only: an edit of a never-read file fails
      // safe on its own, and a write to a path that does not exist is creation — the
      // common case a rule must not fight. The two messages stay distinct because the
      // reader's next move differs: both say re-read, but "changed underneath" warns
      // that the on-disk content is NEWER than the session's picture, so re-applying
      // the old intent unchanged may itself be the mistake.
      const knownState = readTracker.classifyPath(target)
      if (knownState === 'stale') {
        return deny(
          'stale-write',
          `Mutating "${candidate}" is blocked: the file CHANGED on disk after this session ` +
            `last observed it — another agent, a git restore, or this session's own bash ` +
            `command modified it. Read "${candidate}" again to see the current content, ` +
            `then reconsider the change before re-applying it.`,
        )
      }
      if (toolName === TOOL_WRITE && knownState !== 'fresh' && existsSync(target)) {
        return deny('read-before-write', unseenContentReason(candidate, knownState))
      }
      return undefined
    }

    return readerDenial(toolName, candidate, { target, cwd, ownTree })
  }

  /**
   * Every remaining tool carrying a `path` reads the filesystem: deny credential material. This is
   * an EXCLUSION, never an inclusion list, and the asymmetry is the whole point for a boundary: an
   * over-broad reader set blocks something harmless and says so, while a too-narrow one permits a
   * credential read silently. pi ships `read`, `grep`, `find` and `ls` with a `path` today — an
   * inclusion list naming only `read` left `grep` over ~/.aws returning the credential line, past a
   * guard whose own header claimed it denied secret reads.
   *
   * #160 §4: and pi's `grep` is `rg --hidden` over everything beneath its path, so a directory ABOVE
   * a credential directory reads it too — that incident, reached one directory up. A reader that
   * returns names only is exempt from that second check (`NAME_ONLY_READERS`).
   */
  function readerDenial(
    toolName: string,
    candidate: string,
    { target, cwd, ownTree }: { target: string; cwd: string; ownTree: string | undefined },
  ): GuardDenial | undefined {
    if (looksLikeSecret(target, policy.secretPathFragments, ownTree)) {
      return deny(
        'secret-read',
        `Reading "${candidate}" via ${toolName} is blocked: it matches a credential pattern. ` +
          `A secret read is the precondition for exfiltration, so this is denied even for inspection.`,
      )
    }
    if (NAME_ONLY_READERS.has(toolName)) return undefined
    const places: CredentialPlaces = { home: homedir(), existing: [cwd, dependencies.harnessRoot] }
    const reached = secretLocationBeneath(target, policy.secretPathFragments, places)
    if (reached === undefined) return undefined
    return deny(
      'secret-read',
      `Searching "${candidate}" via ${toolName} is blocked: ${reached} is beneath it, and ${toolName} reads ` +
        `every file under its path, hidden ones included — the credential material a direct read of ` +
        `${reached} is refused. Search a directory that does not contain it.`,
    )
  }
}
