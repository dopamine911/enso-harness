import { existsSync } from 'node:fs'
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_GUARD_POLICY,
  ENSO_LOG_EVENTS,
  type EnsoGuardRule,
  ensoLogger,
  type GuardPolicy,
  WEB_FETCH_TOOL_NAME,
} from '@enso/core'
import { type CheckCommandResult, checkCommand } from 'cc-safety-net/api'
import {
  canonicalToolName,
  createSessionReadTracker,
  findDeniedNetworkEgress,
  findEnvironmentDump,
  findSecretPathWord,
  isInsideAnyRoot,
  isPersistenceWriteTarget,
  isProtectedForWrite,
  looksLikeSecret,
  resolveAgainstCwd,
} from '../../core/index.ts'

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
 * on both sides, so a Claude-Code-style capitalised registration (`Write`, `Grep` —
 * picc's own types carry `tool: "Bash"`) can never skip a branch by case. And on
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
 * every mode, every surface, including print runs where picc is absent entirely (#20).
 * picc reaches at most "ask" for the same set, and an ask is mode-shaped (auto's
 * classifier may approve one); this layer is the always-on floor beneath that.
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
 * The bash analyzer seam (#9).
 *
 * Production wires cc-safety-net's `checkCommand`; tests inject known verdicts — `checkCommand`
 * reads LOCAL policy per call, so a guard test that touched the real library would vary with
 * the machine's cc-safety-net config (the contract test alone exercises the real one, and pins
 * defaults explicitly).
 */
export interface GuardDependencies {
  analyzeBashCommand: (input: { command: string; cwd: string }) => CheckCommandResult
}

export function createGuards(dependencies: GuardDependencies): (pi: ExtensionAPI) => void {
  return function guards(pi: ExtensionAPI): void {
    guardsWithDependencies(pi, dependencies)
  }
}

/** The pi entry point — the real analyzer, wired at the composition root. */
export default createGuards({ analyzeBashCommand: checkCommand })

/**
 * A refusal as this guard produces it: pi's `{ block, reason }` plus the RULE that refused
 * (#144 slice 4). The rule is what the denial record carries and what a day's stats count
 * by; the reason is prose for the model. Stripped back to pi's shape at the handler, so the
 * runtime is handed exactly the contract it published and nothing of ours rides on it.
 */
interface GuardDenial {
  readonly block: true
  readonly reason: string
  readonly rule: EnsoGuardRule
}

function deny(rule: EnsoGuardRule, reason: string): GuardDenial {
  return { block: true, reason, rule }
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
 * 4. The secret-path deny (#204) — the READER GATE'S OWN POLICY on this route. Measured
 *    before it existed: `read .enso/secrets.env` was refused and `cat .enso/secrets.env`
 *    was allowed, because nothing on the bash route resolved a path and cc-safety-net's
 *    corpus is `~/.aws`, `~/.ssh`, `.env`-basename — its "secret access THROUGH bash"
 *    half does not know this harness's own credential dir. LAST of the four: a command
 *    that is destructive, exfiltrating or dumping is refused for that first, which keeps
 *    the older reasons' wording stable. `shell-secret-paths.ts` states its non-coverage.
 */
function shellCommandDenial(
  call: { toolName: string; command: string; cwd: string },
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
    )
  }
  if (egress !== undefined) {
    return deny(
      'network-egress',
      `${toolName} network egress is blocked: "${egress.matched}" (matched by ${egress.via}). ` +
        `Ad-hoc network clients are denied in shell commands (#9) — use the ${WEB_FETCH_TOOL_NAME} ` +
        `tool instead (#54): it fetches http(s) URLs from hosts on the committed allowlist. ` +
        `web_fetch and web_search (#63) are the only sanctioned web access. ` +
        `Do not try to work around the deny.`,
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
        `API keys are read by the harness's own tools from .enso/secrets.env, never the root .env.`,
    )
  }

  const secret = findSecretPathWord(command, policy.secretPathFragments, cwd, { coarse })
  if (secret !== undefined) {
    return deny(
      'secret-path',
      `${toolName} command refused: "${secret.matched}" names credential material ` +
        `(matched by ${secret.via}). The read gate refuses that path for read/grep/find/ls, ` +
        `so this route refuses it too (#204) — one policy, both routes, because a secret ` +
        `read is the precondition for exfiltration. This gates the WORD, not the read, so a ` +
        `mention counts: if the word is prose or a search pattern rather than a path, spell ` +
        `it so it is not one (an escaped dot, '/\\.enso/', passes). The harness's own ` +
        `credential dir (.enso/) is off limits for inspection either way; the log-reading ` +
        `path is "bun run logs", a human command and not a tool call.`,
    )
  }
  return undefined
}

function guardsWithDependencies(pi: ExtensionAPI, dependencies: GuardDependencies): void {
  const policy: GuardPolicy = DEFAULT_GUARD_POLICY

  // #10: which files this session has seen. Session-scoped twice over: pi tears the
  // extension runtime down on session replacement (fresh closure), and session_start —
  // which also fires for "reload" and "resume", where the runtime survives — resets it.
  const readTracker = createSessionReadTracker()

  // #4 gap 2, half two: a policy naming a tool pi does not register is a silent no-op —
  // the guard compiles, loads, and never fires. Checked against the LIVE tool list each
  // session_start (extensions can register tools, so the list is per-session state) —
  // AND lazily on the first tool_call if session_start has not fired yet, so the floor
  // never depends on pi's event ordering: a lifecycle that delivered a tool_call first
  // would otherwise fail OPEN through this very window (PR #52 review). The check cannot
  // run at extension load — pi refuses action methods there ("Extension runtime not
  // initialized") — but by the first tool_call the registry is certainly populated.
  // ⚠ Deny-all via this variable, NEVER a throw: a throwing session_start handler wedges
  // print mode outright (probed 2026-09-04 — 120s hang, zero output). The unreadable-list
  // case fails closed the same way: "could not check" must not render as "checked, fine".
  let policyToolsChecked = false
  let policyToolMismatch: string | undefined

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

  pi.on('session_start', (): void => {
    readTracker.reset()
    verifyPolicyToolNames()
  })

  // Record knowledge from RESULTS, never from calls: a blocked call produces no
  // tool_result at all (verified in pi's agent-loop — the "immediate" path skips
  // afterToolCall), and a failed one arrives with isError, so neither can record.
  pi.on('tool_result', (event, extensionContext): void => {
    if (event.isError) return
    const candidate = pathArgumentOf(event)
    if (candidate === undefined) return
    const target = resolveAgainstCwd(candidate, extensionContext.cwd)
    const toolName = canonicalToolName(event.toolName)
    if (KNOWLEDGE_CONFERRING_TOOLS.has(toolName)) {
      readTracker.recordKnownPath(target)
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

  // Every verdict is a record (#132): a denial at `warn` with the tool, the path it named,
  // the RULE that refused (#144 — the word a day's stats count by) and the reason; an allow
  // at `debug`. The transcript shows the model what was refused; this says WHEN, on which
  // call, in the file beside every other layer's line about it. pi is handed its own shape
  // back — `{ block, reason }` — and never our `rule`.
  pi.on('tool_call', (event, extensionContext): ToolCallEventResult | undefined => {
    const verdict = decide(event, extensionContext.cwd)
    const path = pathArgumentOf(event)
    const properties = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(path === undefined ? {} : { path }),
    }
    if (verdict === undefined) {
      log.debug('{toolName} allowed', properties)
      return undefined
    }
    log.warn(ENSO_LOG_EVENTS.toolDenied, { ...properties, rule: verdict.rule, reason: verdict.reason })
    return { block: verdict.block, reason: verdict.reason }
  })

  function decide(event: ToolCallEvent, cwd: string): GuardDenial | undefined {
    const toolName = canonicalToolName(event.toolName)

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

    // --- bash/powershell (#9): deny first, patch last — a denied command must never
    // have had its input mutated. The four denies live in `shellCommandDenial` so this
    // handler stays under the complexity ceiling biome.jsonc pins.
    if (toolName === TOOL_BASH || toolName === TOOL_POWERSHELL) {
      const input = inputRecordOf(event)
      const command = typeof input.command === 'string' ? input.command : ''
      const denial = shellCommandDenial({ toolName, command, cwd }, dependencies, policy)
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
      if (isPersistenceWriteTarget(target)) {
        return deny(
          'persistence-write',
          `Writing to "${candidate}" is blocked: it targets a shell-init, git, editor or ` +
            `agent-config persistence path — a write there is harmless now and executes ` +
            `later, outside this session, as the user.`,
        )
      }
      if (looksLikeSecret(target, policy.secretPathFragments)) {
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
      if (toolName === TOOL_WRITE && knownState === 'unknown' && existsSync(target)) {
        return deny(
          'read-before-write',
          `Writing to "${candidate}" is blocked: the file exists and this session has not ` +
            `read it, so a whole-file write would replace content the session has never seen. ` +
            `Read "${candidate}" first, then write.`,
        )
      }
      return undefined
    }

    // --- every remaining tool carrying a `path` reads the filesystem: deny credential
    // material. This is an EXCLUSION, never an inclusion list, and the asymmetry is the
    // whole point for a boundary: an over-broad reader set blocks something harmless and
    // says so, while a too-narrow one permits a credential read silently. pi ships `read`,
    // `grep`, `find` and `ls` with a `path` today — an inclusion list naming only `read`
    // left `grep` over ~/.aws returning the credential line, past a guard whose own header
    // claimed it denied secret reads.
    if (looksLikeSecret(target, policy.secretPathFragments)) {
      return deny(
        'secret-read',
        `Reading "${candidate}" via ${event.toolName} is blocked: it matches a credential pattern. ` +
          `A secret read is the precondition for exfiltration, so this is denied even for inspection.`,
      )
    }

    return undefined
  }
}
