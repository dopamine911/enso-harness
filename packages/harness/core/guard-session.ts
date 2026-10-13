import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  type CommandJudge,
  DEFAULT_GUARD_POLICY,
  ENSO_GUARD_CHECK_CHANNEL,
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_LOG_EVENTS,
  type EnsoGuardCheckQuestion,
  type EnsoGuardDenial,
  type EnsoIncidentPolicy,
  type EnsoTranscriptEntry,
  ensoLogger,
  type GuardPolicy,
} from '@enso/core'
import { judgeStateOf } from '@enso/core/judge'
import { threadTreeRoot } from '@enso/core/paths'
import {
  deny,
  GUARD_POLICY_TOOL_NAMES,
  type GuardDenial,
  inputRecordOf,
  MUTATING_PATH_TOOLS,
  pathArgumentOf,
  type ShellAnalyzerDenial,
  shellCommandDenial,
  suspensionDenial,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_POWERSHELL,
  TOOL_READ,
  TOOL_WRITE,
} from './guard-denials.ts'
import {
  type CredentialPlaces,
  isInsideAnyRoot,
  isPersistenceWriteTarget,
  isProtectedForWrite,
  looksLikeSecret,
  resolveAgainstCwd,
  secretLocationBeneath,
} from './paths.ts'
import { createSessionReadTracker } from './read-tracker.ts'
import { judgeInBackground, observeSessionSecurity } from './session-security.ts'
import { canonicalToolName } from './tool-identity.ts'

/**
 * The tier-0 guard, runtime free (#861): one session per thread, which any runtime's tool hooks
 * call. The pi extension (`extensions/guards/index.ts`) is glue over it, and so is any second
 * runtime's; why the pi glue is a `tool_call` handler rather than a tool override is that file's
 * header.
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
 * can never skip a branch by case. And at every start the policy's tool names are checked
 * against the runtime's live tool list (pi's `getAllTools()`): a policy naming a tool the
 * runtime no longer registers (a rename upstream) would otherwise turn
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

/**
 * ⚠ `threadId` on these records is INHERITED, never passed: in the web host pi runs
 * in-process, the prompt route binds `{ threadId }` in `AsyncLocalStorage`
 * (`withEnsoLogContext`), and the agent loop that reaches this handler is still inside that
 * async chain — proven by the slice-2 receipt, not designed. Move extensions to a worker or
 * a child (the TUI already runs pi as one) and every verdict loses its thread with no test
 * going red; a record here would then need the id handed to it explicitly.
 */
const log = ensoLogger('extension', 'guards')

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
const KNOWLEDGE_CONFERRING_TOOLS = new Set([TOOL_READ, TOOL_WRITE])

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
 * What a runtime gives the guard (#861): the runtime's side of the guard seam, in our words. The pi
 * glue fills it from `ExtensionAPI` (`appendEntry`, `events`, `getAllTools`); a second runtime fills
 * it from its own records and bus. Nothing of a runtime's shape crosses it.
 *
 * @group Guards
 */
export interface GuardRuntime {
  /** The runtime's name, as a refusal names it to the model ("…tools pi does not register"). */
  readonly name: string
  /**
   * Append a record of ours to the thread's log, beside the transcript: every record the guard keeps
   * — a denial, a security signal, a risk change, an incident, a permission denial, a judgement.
   */
  append(customType: string, data: unknown): void
  /** Say something on a named channel of the thread's bus. */
  emit(channel: string, data: unknown): void
  /** Listen on a named channel of the thread's bus, for the session's life. */
  on(channel: string, handler: (data: unknown) => void): void
  /** Every tool the runtime registers now, by its own name. May throw: the floor reads a throw as a mismatch. */
  toolNames(): readonly string[]
}

/**
 * The guard's seams that are not the runtime (`GuardDependencies` in the pi glue says what production wires).
 *
 * @group Guards
 */
export interface GuardSessionDependencies {
  /** The bash analyzer's refusal of a command, in our words; never throws (its glue applies the library's contract). */
  analyzeShell: (input: { command: string; cwd: string }) => ShellAnalyzerDenial | undefined
  harnessRoot: string
  incidentPolicy: () => EnsoIncidentPolicy
  logsDirectory: string
  projectsDirectory: string
  commandJudge: () => CommandJudge | undefined
  judgeSecretValues: () => readonly string[]
}

/**
 * What a thread starts with: the directory its log is in, and its branch as our transcript. Both may throw.
 *
 * @group Guards
 */
export interface GuardStart {
  readonly recordDirectory: () => string
  readonly transcript: () => readonly EnsoTranscriptEntry[]
}

/**
 * A tool call as the guard decides it, before it runs.
 *
 * @group Guards
 */
export interface GuardToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
  readonly cwd: string
  readonly signal: AbortSignal | undefined
  readonly model: string | undefined
}

/**
 * The guard's answer to a call: refused, in the runtime's own `{ block, reason, terminate? }` shape,
 * or allowed, with the arguments it adds (`patch`, the bash default timeout) when it adds any. The
 * patch is returned, not written into the call: a runtime may mutate the call's input (pi) or replace
 * it (`{ arguments }`), and that is its glue's choice.
 *
 * @group Guards
 */
export type GuardCallOutcome =
  | { readonly kind: 'refused'; readonly block: true; readonly reason: string; readonly terminate?: true }
  | { readonly kind: 'allowed'; readonly patch?: { readonly timeout: number } }

/**
 * A tool's result, after it ran. `wholeFile`: a successful read returned the whole file — the runtime's result shape says so.
 *
 * @group Guards
 */
export interface GuardToolResult {
  readonly toolName: string
  readonly input: unknown
  readonly isError: boolean
  readonly wholeFile: boolean
  readonly cwd: string
}

/**
 * One thread's guard: what a runtime's hooks call, in the order the runtime raises them.
 *
 * @group Guards
 */
export interface GuardSession {
  start(facts: GuardStart): void
  toolCall(call: GuardToolCall): GuardCallOutcome
  toolResult(result: GuardToolResult): void
  /** A permission engine's decision, as its channel carried it (#496). */
  permissionDecision(raw: unknown): void
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
 * `decide` returns a `GuardDenial` or `undefined`, and the glue hands its runtime its own shape back:
 * every refusal is `{ block: true, reason }`, every pass is `undefined`. Refusing is final:
 * handlers are additive and the runtime returns on the first `block`, whatever loads after (the
 * file header). `HostedThread.probeToolCall` pins this through the runtime's own hook runner,
 * with the real load order and participants: the guards' refusal with its reason, and first
 * block wins, so a later extension cannot un-block and its own block stands.
 *
 * @group Guards
 */
export function createGuardSession(runtime: GuardRuntime, dependencies: GuardSessionDependencies): GuardSession {
  const policy: GuardPolicy = DEFAULT_GUARD_POLICY

  // #10: which files this session has seen. Session-scoped twice over: pi tears the
  // extension runtime down on session replacement (fresh closure), and session_start —
  // which also fires for "reload" and "resume", where the runtime survives — resets it.
  const readTracker = createSessionReadTracker()
  // #464, #466: the session's security risk and incidents, observed beside what it has read;
  // rebuilt on every start.
  const security = observeSessionSecurity(runtime, dependencies.incidentPolicy)
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
      judgeInBackground(runtime, judge, { context, state, signal })
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
      const registered = new Set(runtime.toolNames().map((toolName) => canonicalToolName(toolName)))
      const missing = GUARD_POLICY_TOOL_NAMES.filter((policyName) => !registered.has(policyName))
      policyToolMismatch =
        missing.length === 0
          ? undefined
          : `the guard policy names tools ${runtime.name} does not register: ${missing.join(', ')} ` +
            `(registered: ${[...registered].join(', ')})`
    } catch (error) {
      // The denial reason below is for the operator; the raw error (with stack) goes to
      // stderr for whoever has to debug WHY enumeration failed after the fact.
      log.error('the tool list could not be read during the policy check: {error}', { error })
      policyToolMismatch = `the guard could not enumerate ${runtime.name}'s tools: ${String(error)}`
    }
  }

  function start(facts: GuardStart): void {
    readTracker.reset()
    verifyPolicyToolNames()
    try {
      recordDirectories = [facts.recordDirectory(), dependencies.logsDirectory]
    } catch (error) {
      log.error('the session directory could not be read; protected-records keeps the log directory: {error}', {
        error,
      })
      recordDirectories = [dependencies.logsDirectory]
    }
    security.resume(facts.transcript)
    sessionJudge = readJudge()
  }

  // @invariant guarded-tool-call/knowledge-from-results Knowledge comes from results, never from calls.
  // This handler records a file as seen only when `isError` is false: a blocked call produces
  // no `tool_result` at all (verified in pi's agent-loop: the "immediate" path skips
  // afterToolCall), and a failed one arrives with `isError`, so neither can record.
  function toolResult(result: GuardToolResult): void {
    if (result.isError) return
    const candidate = pathArgumentOf(result.input)
    if (candidate === undefined) return
    const target = resolveAgainstCwd(candidate, result.cwd)
    const toolName = canonicalToolName(result.toolName)
    if (KNOWLEDGE_CONFERRING_TOOLS.has(toolName)) {
      readTracker.recordKnownPath(target, { whole: toolName !== TOOL_READ || result.wholeFile })
      return
    }
    // ⚠ The session's own successful `edit` moves mtime/size without conferring
    // whole-file knowledge (#10): a KNOWN file's stamp follows the mutation (or the
    // next edit/write refuses the session's own work as "changed underneath us" —
    // found live, read → edit → edit), while an unknown file stays unknown.
    if (toolName === TOOL_EDIT) {
      readTracker.refreshStampIfKnown(target)
    }
  }

  // @invariant guarded-tool-call/every-verdict-recorded Every verdict is a record (#132).
  // A denial at `warn` with the `toolCallId`, the tool, the path it named, the RULE that refused
  // (#144: the word a day's stats count by) and the reason; an allow at `debug`, never silent.
  // The transcript shows the model what was refused; this says WHEN, on which call, in the file
  // beside every other layer's line about it.
  //
  // @invariant guarded-tool-call/denial-entry The guard says it refused, in the log the runtime keeps (#387).
  // The runtime is handed its own shape back, `{ block, reason }`, and never our `rule`. pi discards the
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
  function toolCall(call: GuardToolCall): GuardCallOutcome {
    // The call first, then its refusal: the order the risk fold and every replay of it read (#464).
    security.call(call, call.signal, call.model)
    const toolName = canonicalToolName(call.toolName)
    const input = inputRecordOf(call.input)
    const verdict = decide(toolName, input, call.cwd)
    const path = pathArgumentOf(input)
    const properties = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      ...(path === undefined ? {} : { path }),
    }
    if (verdict === undefined) {
      log.debug('{toolName} allowed', properties)
      judgeIfInScope(call.toolCallId, call.cwd, call.signal)
      // Patch, do not block: a missing timeout means a hung command holds the session
      // indefinitely. Only an ALLOWED shell call gets it, so no denied command has patched input.
      const shell = toolName === TOOL_BASH || toolName === TOOL_POWERSHELL
      return shell && input.timeout === undefined
        ? { kind: 'allowed', patch: { timeout: policy.defaultBashTimeoutSeconds } }
        : { kind: 'allowed' }
    }
    const denial: EnsoGuardDenial = {
      toolCallId: call.toolCallId,
      rule: verdict.rule,
      ...verdict.egress,
    }
    log.warn(ENSO_LOG_EVENTS.toolDenied, {
      ...properties,
      ...verdict.egress,
      rule: verdict.rule,
      reason: verdict.reason,
    })
    runtime.append(ENSO_GUARD_DENIAL_ENTRY, denial)
    // ⚠ A refusal that tips the session into a halting incident ends the batch (#466), whatever
    // its own rule's kind: a redirect would otherwise leave the model its turn to try the route.
    const halted = security.guardDenied(denial)
    return verdict.terminate === true || halted
      ? { kind: 'refused', block: verdict.block, reason: verdict.reason, terminate: true }
      : { kind: 'refused', block: verdict.block, reason: verdict.reason }
  }

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
        `All tool calls are blocked until the guard policy matches ${runtime.name}'s tools: ${policyToolMismatch}`,
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
   * returned part of the file (the runtime's own cut, an `offset`, or any `limit`) stamps it for *stale*
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
  function decide(toolName: string, input: Record<string, unknown>, cwd: string): GuardDenial | undefined {
    const standing = standingDenial(toolName)
    if (standing !== undefined) return standing
    // The session's own thread tree, when its cwd is one (#615): judged like a checkout, never as ENSO_HOME.
    const ownTree = threadTreeRoot(dependencies.projectsDirectory, cwd)

    // --- bash/powershell (#9): deny first, patch last — a denied command must never
    // have had its input patched (`toolCall` patches only an allowed one). The denies live
    // in `shellCommandDenial` so this handler stays under the complexity pin `.fallowrc.jsonc`
    // holds it to.
    if (toolName === TOOL_BASH || toolName === TOOL_POWERSHELL) {
      const command = typeof input.command === 'string' ? input.command : ''
      return shellCommandDenial(
        { toolName, command, cwd, recordDirectories, ownTree },
        dependencies.analyzeShell,
        policy,
      )
    }

    const candidate = pathArgumentOf(input)
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
            `(${roots.join(', ')}). ${runtime.name} resolves paths but does not confine them, so this guard does.`,
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

  /**
   * @invariant guarded-tool-call/check-is-the-call A check is the call's own decision, unrecorded (#881).
   * Settings' "Try a command" asks on `ENSO_GUARD_CHECK_CHANNEL`, and the answer is `decide`'s, the
   * function `toolCall` runs, in this session's state now: the floor, a suspension, what it has read.
   * So a check and the call it stands for cannot disagree. Nothing is recorded: no risk signal, no
   * denial entry, no judge, no patch, since no call was made.
   */
  function answerCheck(raw: unknown): void {
    const question = checkQuestionOf(raw)
    if (question === undefined) {
      log.error('a guard check arrived malformed; nothing is answered: {raw}', { raw })
      return
    }
    const refusal = decide(canonicalToolName(question.toolName), inputRecordOf(question.input), question.cwd)
    question.answer(
      refusal === undefined ? undefined : { rule: refusal.rule, cause: refusal.cause, reason: refusal.reason },
    )
  }
  runtime.on(ENSO_GUARD_CHECK_CHANNEL, answerCheck)

  return { start, toolCall, toolResult, permissionDecision: (raw) => security.permissionDecision(raw) }
}

/** A host's question on `ENSO_GUARD_CHECK_CHANNEL`, read defensively: a bus carries `unknown`. */
function checkQuestionOf(raw: unknown): EnsoGuardCheckQuestion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  if (!('toolName' in raw && 'cwd' in raw && 'answer' in raw)) return undefined
  const { toolName, cwd, answer } = raw
  if (typeof toolName !== 'string' || typeof cwd !== 'string' || typeof answer !== 'function') return undefined
  const input = 'input' in raw ? inputRecordOf(raw.input) : {}
  return { toolName, input, cwd, answer: (refusal) => answer(refusal) }
}
