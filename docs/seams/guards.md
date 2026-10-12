# Seam: the guards

The contract between a tool call and the one answer it gets before it runs: a policy, a hook, and a
verdict that is a denial with its reason or nothing. Glossary domain: **Permission** — guard, verdict,
policy, rule, participant, tool identity, read-before-write, egress — with the verdict as a **Record**
(every one is a log line). The command analyzer is a library behind our verdict; the registration is
the runtime's hook — leak **L5**, stated below.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/guards.md`.

## The contract

What a guard reads. One schema, in `@enso/core`, with its regex corpus beside it — the module header says
why the policy is not split across two packages.

<!-- source: packages/core/src/guard.ts#GuardPolicy -->
```ts
/**
 * The Tier 0 guard policy.
 *
 * ⚠ The regex constants at the bottom are not schemas, and they live here anyway. Splitting
 * the policy — schema in `@enso/core`, patterns beside the extension — would put half of one
 * decision in each of two packages, which is the duplication this package exists to prevent.
 * The policy is one thing; it is declared in one place.
 */
export const GuardPolicy = Type.Object({
  /** Absolute roots a mutating tool may write inside. Empty means "the session cwd only". */
  writeRoots: Type.Array(Type.String(), { default: [] }),
  /** Path fragments that deny a READ. Matched case-insensitively against the resolved path. */
  secretPathFragments: Type.Array(Type.String()),
  /** Path fragments that deny a WRITE, in addition to escaping `writeRoots`. */
  protectedWriteFragments: Type.Array(Type.String()),
  /** Seconds injected into a `bash` call that arrives without a timeout. */
  defaultBashTimeoutSeconds: Type.Number({ minimum: 1 }),
  /**
   * Ad-hoc network client names denied in `bash`/`powershell` commands (#9). Matched at
   * command position per shell segment (coarse word-scan on unparseable or PS input).
   * ⚠ A BAR, not a boundary: `git` and interpreters are deliberately absent — see
   * `network-egress.ts` for the stated non-coverage.
   */
  deniedNetworkBinaries: Type.Array(Type.String()),
})
```

<!-- source: packages/core/src/guard.ts#DEFAULT_GUARD_POLICY -->
```ts
/**
 * Defaults.
 *
 * Deliberately conservative on reads of credential material and on writes outside the workspace
 * — the two cases from `docs/concepts/pi-immediate-needs.md` Tier 0 where pi ships no
 * confinement at all.
 */
export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  writeRoots: [],
  secretPathFragments: [
    '/.ssh/',
    '/.aws/',
    '/.gnupg/',
    '/.docker/config.json',
    '/.npmrc',
    '/.netrc',
    '/.pgpass',
    '/.kube/config',
    // The harness's OWN credential dir (#204): `ENSO_HOME` (`~/.enso`, #421) with its
    // `secrets.env` (#89) and, under `pi-agent/`, pi's `auth.json`, the provider-failover files
    // and every session transcript — all `0600` on disk, i.e. the operator's own umask calls
    // them secret — and a checkout's pre-#421 `.enso/` until it is migrated. The basename gate
    // below covered `secrets.env` alone, so `auth.json` was readable and `grep path=.enso`
    // recursed the lot; `containsPathFragment` appends a separator, so this one entry denies
    // the directory itself and everything under it.
    // ⚠ THE COST, stated: the agent can no longer read `ENSO_HOME/logs/*.jsonl` with a tool.
    // Reading the log is a human command — `bun run logs` — which uses node fs and never
    // passes this guard. Writes were already denied (`ENSO_PERSISTENCE_WRITE_DIRECTORIES`).
    '/.enso/',
    // ⚠ AND THE DIRECTORY IT USED TO BE. The rename to `.enso/` is a hard cutover — nothing
    // READS `.zen/` any more — but every existing checkout still HAS one, holding exactly these
    // files, until somebody runs `mv .zen .enso`. Dropping it from this list would have made an
    // agent able to read the secrets directory it was never able to read before, for the window
    // between merging and that command. A deny rule for a directory that should not exist costs
    // nothing and expires on its own; this is not a compatibility path, it is the opposite of one.
    '/.zen/',
  ],
  // Enso's config — `ENSO_HOME/config.json` since #421, carrying web_fetch's host allowlist
  // (#54) — is NOT listed here: a write there widens the harness's egress for every FUTURE
  // session, and it is refused as a persistence target instead (`.enso` in
  // `ENSO_PERSISTENCE_WRITE_DIRECTORIES`), with the rest of `ENSO_HOME`. The committed
  // `enso.config.json` this fragment named is gone.
  protectedWriteFragments: ['/.git/'],
  defaultBashTimeoutSeconds: 120,
  // The ad-hoc HTTP/TCP clients plus the PowerShell fetch cmdlets (the raw scan sees
  // those; a POSIX segment never will). git and interpreters deliberately absent (#9).
  deniedNetworkBinaries: [
    'curl',
    'wget',
    'nc',
    'ncat',
    'netcat',
    'socat',
    'ssh',
    'scp',
    'sftp',
    'rsync',
    'telnet',
    'ftp',
    'invoke-webrequest',
    'invoke-restmethod',
    'iwr',
    'irm',
  ],
}
```

More top-level constants in the same module are corpus, not schema, and are read by
`packages/harness/core/paths.ts` and `environment-dump.ts`: `PERSISTENCE_WRITE_BASENAMES` and `PERSISTENCE_WRITE_DIRECTORIES`
(Enso's lists of shell-init, git, editor and agent-config paths a write would *install* something
into, matched by exact basename — `core/src/guard.ts#PERSISTENCE_WRITE_BASENAMES`), `ENSO_PERSISTENCE_WRITE_DIRECTORIES` (`.pi`,
`.agents`, `.enso`, `.cc-safety-net`: the runtime's and the harness's own persistence surfaces,
`core/src/guard.ts#ENSO_PERSISTENCE_WRITE_DIRECTORIES`), `ENSO_PERSISTENCE_WRITE_BASENAMES`
(the further shell-init files — `.zshenv`, `.zlogin`, `.zlogout`, `.bash_login`, `.bash_logout` — and
direnv's `.envrc`, #160), `PROC_ENVIRON_PATH` and `PROC_ENVIRON_IN_COMMAND`
(a process's environment, per process or per thread: one shape for the read gate and the shell deny,
#160 §5), and `SECRET_BASENAME_PATTERNS` (`core/src/guard.ts#SECRET_BASENAME_PATTERNS`).

What the pi extension takes, and what it is:

<!-- source: packages/harness/extensions/guards/index.ts#GuardDependencies -->
```ts
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
```

<!-- source: packages/harness/extensions/guards/index.ts#createGuards -->
```ts
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
    const session = guardSessionOver(pi, dependencies)
    // The permission engine announces its decisions on pi's bus under its own channel name.
    pi.events.on(PERMISSIONS_DECISION_CHANNEL, (raw: unknown) => session.permissionDecision(raw))

    pi.on('session_start', (_event, extensionContext): void => {
      session.start({
        recordDirectory: () => extensionContext.sessionManager.getSessionDir(),
        transcript: () => transcriptOf(extensionContext.sessionManager.getBranch()),
      })
    })

    pi.on('tool_result', (event, extensionContext): void => {
      session.toolResult({
        toolName: event.toolName,
        input: event.input,
        isError: event.isError,
        wholeFile: returnedWholeFile(event),
        cwd: extensionContext.cwd,
      })
    })

    pi.on('tool_call', (event, extensionContext): ToolCallEventResult | undefined => {
      const outcome = session.toolCall({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        cwd: extensionContext.cwd,
        signal: extensionContext.signal,
        model: extensionContext.model?.id,
      })
      if (outcome.kind === 'allowed') {
        // pi runs the call with the input this hook leaves on the event: the patch is written into it.
        if (outcome.patch !== undefined) Object.assign(inputRecordOf(event.input), outcome.patch)
        return undefined
      }
      return outcome.terminate === true
        ? { block: outcome.block, reason: outcome.reason, terminate: true }
        : { block: outcome.block, reason: outcome.reason }
    })
  }
}
```

<!-- source: packages/harness/core/guard-denials.ts#GUARD_POLICY_TOOL_NAMES -->
```ts
/**
 * Every tool name the guard's policy references — the policy/tool-list check's input.
 *
 * ⚠ Deliberately NOT the full tool surface: the reader gate (`grep`, `find`, `ls`, and any
 * future path-bearing tool) works by EXCLUSION, so a renamed or newly registered reader is
 * still gated without being named here — only the tools matched BY NAME can silently un-gate on
 * a rename, and those are exactly the names this list carries.
 */
export const GUARD_POLICY_TOOL_NAMES: readonly string[] = [TOOL_READ, TOOL_WRITE, TOOL_EDIT, TOOL_BASH, TOOL_POWERSHELL]
```

What any runtime's glue gives the guard, and what it calls (#861). The pi extension above fills the
port from `ExtensionAPI`; a second runtime fills it from its own records and bus:

<!-- source: packages/harness/core/guard-session.ts#GuardRuntime -->
```ts
/**
 * What a runtime gives the guard (#861): the runtime's side of the guard seam, in our words. The pi
 * glue fills it from `ExtensionAPI` (`appendEntry`, `events`, `getAllTools`); a second runtime fills
 * it from its own records and bus. Nothing of a runtime's shape crosses it.
 */
export interface GuardRuntime {
  /** The runtime's name, as a refusal names it to the model ("…tools pi does not register"). */
  readonly name: string
  /** Append a record of ours to the thread's log, beside the transcript: a denial, a signal, an incident. */
  append(customType: string, data: unknown): void
  /** Say something on a named channel of the thread's bus. */
  emit(channel: string, data: unknown): void
  /** Listen on a named channel of the thread's bus, for the session's life. */
  on(channel: string, handler: (data: unknown) => void): void
  /** Every tool the runtime registers now, by its own name. May throw: the floor reads a throw as a mismatch. */
  toolNames(): readonly string[]
}
```

<!-- source: packages/harness/core/guard-session.ts#GuardSession -->
```ts
/**
 * One thread's guard: what a runtime's hooks call, in the order the runtime raises them.
 */
export interface GuardSession {
  start(facts: GuardStart): void
  toolCall(call: GuardToolCall): GuardCallOutcome
  toolResult(result: GuardToolResult): void
  /** A permission engine's decision, as its channel carried it (#496). */
  permissionDecision(raw: unknown): void
}
```

**Tool identity.** Every tool-name comparison, on both sides, folds through `canonicalToolName`
(`harness/core/tool-identity.ts#canonicalToolName`: lowercase, no mapping table), because the runtime's
built-ins are lowercase and vendor packages register capitalised names — a case-sensitive miss would
let the call proceed with nothing reporting it (`tool-identity.ts`'s header).

**The verdict.** The session's `toolCall` answers `refused` in the runtime's own shape — `{ block: true,
reason }`, plus `terminate: true` for an authorization refusal — or `allowed`, with the bash default
timeout as a `patch` when it adds one (`guard-session.ts#GuardCallOutcome`). Every `return` in `decide`
and `shellCommandDenial` is a `guard-denials.ts#deny`, `{ block: true, reason, rule }`, and the session
strips the rule; the pi glue hands pi `ToolCallEventResult | undefined` and writes the patch into the
call's input, where pi reads it.
There is no third value — the glossary's Retired table refuses `allow`/`abstain` as verdict words.

**What a refusal asks of the model** (#465, #189). Each rule has a kind in core
(`ENSO_GUARD_RULE_KINDS`, a closed table, so a new rule must be classified to compile), and `deny`
shapes the refusal by it. Asking must be cheaper than working around a refusal:
- **`authorization`**: only the user can lift it. The reason ends with one line naming `ask_user` as
  the way out, and the verdict sets pi's `terminate`. pi ends the run only when every call of the
  batch set it, so a batch the guard refused whole hands the turn back to the user; a batch where a
  call ran goes on, and the model reads the line then.
- **`redirect`** (`network-egress`, `environment-dump`): the reason names a sanctioned route the
  agent can take itself (`web_fetch`, a non-secret variable). The turn goes on so it can, and the
  reason adds `ask_user` for when that route cannot do it.
- **`procedure`** (`stale-write`, `read-before-write`) and **`configuration`** (`policy-mismatch`):
  neither line; asking cannot unblock them.

There is no grant: an answer to `ask_user` never lets the refused call through (#465's decision).
Pinned per rule by `guards.test.ts#⚠ an authorization refusal names the ask route and ends the turn; a redirect only names it; the others do neither (#465)`,
and against pi's real loop by `agent-host.test.ts#⚠⚠ a batch the guard refused whole ends the run; a batch where a call ran, or a redirect, goes on (#465)`.

## Who implements it, who consumes it

**Implemented once**, runtime free, by `packages/harness/core/guard-session.ts#createGuardSession` over its
port (`GuardRuntime`), with the denies that read no session state in `guard-denials.ts` and the session's
security in `session-security.ts` (#861). **Glued once**, to pi, by `packages/harness/extensions/guards/index.ts`:
its default export is `createGuards({ analyzeBashCommand: checkCommand, harnessRoot, incidentPolicy,
logsDirectory, projectsDirectory })` — the real analyzer, the user's `config.json` `security` section, and
`ENSO_HOME`'s log and projects directories, wired at the composition root. The glue registers three hooks
and each calls the session: `session_start` → `start`, which resets the read tracker, rebuilds the
session's risk and incidents from the branch with the incident policy read afresh, and verifies the
policy's tool names against the live tool list (`guard-session.ts#verifyPolicyToolNames`); `tool_result`
→ `toolResult`, which records which files the session has seen, from *results* only — a blocked call
produces no result and a failed one arrives `isError`; `tool_call` → `toolCall`, which records the call
for the session's risk, calls `decide` and logs the verdict.

**`decide`'s order** (`guard-session.ts#decide`) — nested, so described, not fenced:

1. **The fail-closed floor** (#4). If the policy names a tool the runtime does not register, or the tool
   list could not be enumerated, every call is denied with the mismatch in the reason.
   Checked lazily here if `session_start` has not fired yet, so the floor never depends on event order.
2. **An incident's suspension** (#466, `guard-denials.ts#suspensionDenial`). While a halting incident's
   **report is owed** (#467), every tool but `file_incident_report` is refused under
   `incident-suspension` — reads and `ask_user` included: the report turn is bounded. Otherwise a tool
   whose family an incident suspended — execute (`bash`, `powershell`), network (`web_fetch`,
   `web_search`), write (`write`, `edit`) — is refused under the same rule, before any other: the
   incident is the thread's state, not a judgement of the call. Reading and searching are never
   suspended once the report is settled.
3. **Shell** (`bash`, `powershell`) — `guard-denials.ts#shellCommandDenial`, deny first, patch last:
   the analyzer (bash only; a throw is a deny per its contract), then the network deny by
   name at command position per segment, with the *cannot vouch* floor for a construct it cannot
   resolve — at every depth: a wrapper's operand or `-c` payload built at runtime, and a
   `find -exec` payload, meet the same floor as the top level (#524) — then the environment-dump deny, then the records deny (#466: a word naming this project's
   session directory or the log directory, resolved and through its realpath —
   `shell-secret-paths.ts#findDirectoryWord`), then the secret-path deny —
   the reader gate's own policy over every literal word of the command (#204). The records deny comes
   before secret-path, which refuses a literal `/.enso/` too, so a touch of the records is named as one
   and raises its own signal. Only a command that passed them all gets the default timeout, as the
   allowed answer's patch from `toolCall`, so no denied command has patched input.
4. **No `path` argument** → pass.
5. **Writes** (`write`, `edit`), in order: outside the write roots (the cwd when none are
   configured), a protected fragment, a persistence target, a credential pattern, then the session's
   knowledge of the file — *stale* refuses both tools, *unknown and existing* refuses `write` only, and
   so does *partial* — read, but only part of it (#10, #11, #57 S2; the comment in `decide` says why
   the messages differ).
6. **Every other tool with a `path` is a reader**, by exclusion, and a credential pattern denies it
   (`guard-session.ts#readerDenial`); so does a credential location beneath its path (`grep` over `~`),
   except for `ls` and `find`, which return names only (#160 §4). Exclusion, not inclusion: an inclusion list naming only `read` once let `grep` over
   `~/.aws` through (the header of `guard-session.ts`). Since #204 the same policy also runs on the shell route, so
   `read ~/.enso/pi-agent/auth.json` and `cat ~/.enso/pi-agent/auth.json` agree — they did not.

**Every verdict is a record** (#132): a denial at `warn` with the tool, the path and the reason; an
allow at `debug`; never silent (the `tool_call` handler; pinned by `guards.test.ts`).

**The session's risk is observed here, and an incident is opened here** (#464, #466, phases 1 and 3
of #189; `session-security.ts#observeSessionSecurity`). Every call, every guard refusal and every refusal
the permission engine makes of the agent's call (a person's No, a rule's deny, `auto`'s block — heard
on the engine's decision bus) go through one pure fold in `@enso/core`,
`session-risk.ts#sessionRiskStep`, with the thresholds from `config.json` (`security.incidents`). A
signal is appended as `enso-security-signal` and logged at `warn`; a rise in level as
`enso-session-risk`. The engine's decision names no tool call, so the guard — the first participant,
with pi preparing a batch's calls one at a time — attributes it to the call it saw last and records
it as `enso-permission-denial` with that call's id; a `user_denied` under an aborted run is the
Stop's, not a No, and is not recorded. A throw anywhere in the fold is logged and swallowed: a bug
in risk becomes neither a refusal nor a pass. On `session_start` the state is rebuilt by replaying
the branch through the same fold (`riskEventsOfEntries`), never read from stored signals, and the
server replays the same branch for the thread snapshot and the session eval — `guards.test.ts`
drives the guard over a refusal sequence and replays the branch it wrote: same signals, same levels.

**An incident** (`@enso/core` `session-incident.ts`) opens when the risk is at `incident` and none is
open: the guard appends `enso-incident-opened` with the signals it rests on, whether it halted
(`security.incidents.halt`, off by default: then it is an alert and suspends nothing) and the families
it suspended — all three. A refusal that tips the session into a halting incident ends the batch
(`terminate`), whatever its own rule. The suspension is the fold of the branch's incident records
(`sessionIncidentsStep`), rebuilt at every `session_start`, so a restart, a resume, a reload or a
config switched to alert-only since does not lift it. Only a human's resolution does: the host's
resolve route appends `enso-incident-resolved` and announces it on `ENSO_INCIDENT_RESOLVED_CHANNEL`,
and the guard applies the same step live; the resolution also resets the risk, the only reset. The
policy is read at every `session_start` and lazily at the first call if none fired — the floor's
reasoning. ⚠ The records are **tamper-evident at best, and not yet that** (the hash chain is #526): the
records deny refuses a shell command naming them, which makes an edit harder and visible as a
signal, not impossible — the guards are the whole boundary (#24).

**The report turn** (#467; `extensions/incident-report/index.ts`, `@enso/core` `incident-report.ts`).
A halting opening is announced on `ENSO_INCIDENT_OPENED_CHANNEL`. The `incident-report` extension —
loaded after the permission engine, which re-adds every registered tool at each prompt's start —
narrows the active tools to `file_incident_report` and sends the request as a follow-up, so pi's
loop delivers it after the halted batch, before the run ends; at every session start and prompt start
the tool is out of the active set again. The tool's nine fields are #189's questions: the task, what
was denied and what was tried cite `{ ref, quote }` (a tool call id the model can see, or `prompt`), and
the extension — never the model — checks each quote against the branch, whitespace-normalised; "what
was denied" must cite one of the incident's own calls, or it is flagged. At most two submissions: a
first that checks is recorded; one that does not is named back for one correction, and the second is
recorded as it is. A run that ends without one records the failed try, flagged, or
`enso-incident-report-missing`, and so does a session that starts still owing it. Every settlement is
announced on `ENSO_INCIDENT_REPORT_CHANNEL`, and the guard's report window closes. The engine lets the
tool through by policy: the seed allows it, and a launch adds `allow` to a file with no rule for it.

**The history and the replay** (#468; `@enso/core` `session-incident.ts#replayIncidents`, `bun run incidents`).
The opening records the run's model. A day's security record is a fold of the log
(`log-stats.ts`, the day stats page): signals by kind, incidents opened and halted, by model, the
reports filed, checked and missing, and the resolutions — one line per fact, so the host's resolve
route logs a resolution and the guard's live application logs at debug. `GET /api/threads/:id/incidents`
returns each incident's record with the custom entries it rests on, as stored (`incidentEntriesOf`),
and the branch replayed under the server's thresholds or the query's: `replayIncidents` runs the
guard's own step over the events it met (`riskEventsOfEntries`) and opens by its rule, a fork's
inherited opening holding the incident open, and says of each opening `same`, `would-open` or
`would-miss`. Under the thresholds a branch ran with, every row is `same` — `guards.test.ts` pins it
over the guard's own branch, halting or not. ⚠ The branch is replayed as it happened: a replay that
opens earlier still reads the calls a halt would have stopped.

**The command judge, recorded only** (#469 PR1; `@enso/core` `command-judge.ts`, `config.json` `security.judge.backend`).
Off by default, and user-only as the rest of `security` is: an unreadable `config.json` leaves it off.
Switched on (`jev` or `local`), the guard asks it about a `bash` call it let through when the call follows a
refusal in the risk window or is one the guards cannot read — built at run time, decoded, handed to an
interpreter — the selection `judgeContextOf` makes off the risk fold's own state, so
`judgeContextsOfEntries` replays exactly the calls the guard judged (`guards.test.ts` pins it).
"Cannot read" is read off the command's **live text** (#544, `@enso/core` `command-constructs.ts`): what
bash would run, with a quoted heredoc's body, single-quoted strings, `#` comments, escaped operator
characters and a `|`/`;`/`&` inside double quotes set aside. ⚠ The raw text selected 28 % of the user's
bash calls against ~10 % — the excess almost all message bodies (`--body "$(cat <<'EOF' … EOF)"`), the
text most likely to carry the user's prose. A quoted heredoc a shell reads (`bash <<'EOF'`) is walked
as commands, `$'…'` stays live because bash decodes it, and a command the walk cannot read (an
unterminated quote or substitution, a heredoc with no closing line) stays in. `bun run corpus` §2
measures the rule through `judgeContextOf` beside the same constructs, so the two rows must agree. The
answer is recorded as `enso-command-judgement` and one `commandJudged` log line, and that is all:
⚠ it feeds no risk signal and asks nothing, and the call is never kept waiting on it — the judge is
not awaited, and a failure is recorded `unjudged`, never clean. The state is redacted before it
leaves (`@enso/core/judge`): known secret values, secret-shaped assignments, flags, headers and
token shapes become markers; paths stay, because a path is what the judge has to read, and a file
whose path looks like a secret is never read for its contents.
The backends live in the guards extension (`guards/judge-backends.ts`), the one place pi's libraries
may be named, and ask through pi-ai's `classify()` (#535). ⚠ They import it as
`@earendil-works/pi-classifier`, an npm alias of the agent's own pi-ai version: pi's extension
loader maps `@earendil-works/pi-ai` to its `compat` entry, and under Node it rewrites any subpath onto
it, so a direct `@earendil-works/pi-ai/api/…` import fails the whole guards extension in the terminal
`pi` (measured on the 0.99.2 bump). `jev` posts to TypeSafe's pinned endpoint and model;
`local` (#532) asks the llama.cpp router `security.judge.local` names, and ⚠ a router that is not on
a loopback address is sent nothing. A failed call's reason is its HTTP status, never the server's
error body, which may echo the request.

**Consumed by the runtime.** Handlers stack; the first `block` returns and cannot be un-blocked by a
later extension, whatever the load order (the header of `guards/index.ts`). The participants and their load order are
the manifest, `pi.extensions` in `packages/harness/package.json`: logging, **guards**, web-fetch, web-search, the
permission engine, the mode extension, the multi-account extension, ask-user, system-prompt, run-context and incident-report. Two of those register a `tool_call` handler — guards and
the permission engine, in that order (#496; the mode extension registers none).

**The permission engine this page was measured against: `@gotgenes/pi-permission-system` 40.0.2**
(#744; the pin in `packages/harness/package.json`). Three of its changes since 36.2.0 meet the guards.
39.0.0 narrowed its "pi infrastructure" read bypass to pi's harness entries in the agent dir
(`settings.json`, `skills/`, `extensions/` …), never its own permission logs, and lets a targeted
`external_directory` deny block such a read. Enso's agent dir is `ENSO_HOME/pi-agent`, which the
guard's `/.enso/` fragment refuses whole before the engine is asked, harness entries included
(`guards.test.ts`); under a custom `ENSO_HOME` outside any `.enso`, the engine now asks for the agent
dir's credentials, sessions and logs where 36.2.0 let them through (`agent-host.test.ts`). 40.0.0
matches a bash path argument in its absolute spelling too, so a rule naming an absolute path into the
thread's tree reaches `cat x` and `cd <tree> && cat x` as well. 38.0.0 gates pi's MCP tools on the
`mcp` surface, which every mode denies by default ([permission modes](./permission-mode.md)).

**Second implementation:** the injected analyzer. `guards.test.ts#loadGuardRuntime` builds the extension over a
stand-in `ExtensionAPI` (captures `on`, fakes `getAllTools`) and an analyzer that allows everything,
because the real one reads the *machine's* local policy per call (`guards.test.ts#ALLOW_ALL_ANALYZER`). The injected-verdict tests
prove our wiring — a deny blocks with its `ruleId` in the reason, a throw is a deny, a deny
without a `ruleId` invents none. The real library runs in exactly one place, the contract test
`packages/harness/extensions/guards/__tests__/cc-safety-net-contract.test.ts`: a fixed command set
asserted verdict-by-verdict against the exact pin, so a vendor bump that shifts the boundary goes red
(the file's header). Its `EXPECTED_ALLOWS` pins the non-coverage on purpose — egress and shell persistence
writes are *our* layers' jobs (`cc-safety-net-contract.test.ts#EXPECTED_ALLOWS`).

## What fences it

- **The participants tripwire** (`packages/harness/extensions/__tests__/tool-call-participants.test.ts`):
  scans every declared extension tree for a `tool_call` registration and asserts set equality with the
  two known participants, in load order (`tool-call-participants.test.ts#ALLOWED_TOOL_CALL_PARTICIPANTS`). A third handler is the arbiter's trigger (#4) and
  fails this test by name; the file's header says not to add yourself to the list.
- **The policy-tool floor** above: a rename upstream turns into a denial that names the missing tool,
  not a guard that compiles and never fires.
- **The vendor gate** (`test/vendor-gate.test.ts#VENDOR_NAMED_ALLOWED`): `packages/core/src/guard.ts` is one allowlist
  line — "the guard's write-allowlist names cc-safety-net's state directory: a path, not an import.
  Leaves when the harness owns the list of directories an extension may write."
- **The schema rule**: `packages/harness/core/index.ts`'s header — no TypeBox schema is declared there; the
  policy is imported from `@enso/core` or does not exist.
- **The pi-version parity gate** (#217, `scripts/__tests__/pi-version-parity.test.ts`): the replica's
  agreement with pi is pinned against the WORKSPACE copy only; the `pi` the terminal launcher spawns is
  bounded instead by `scripts/enso-launch.ts#SUPPORTED_PI_VERSIONS`, which the launcher refuses outside
  and that test holds equal to the corpus's pi. Without it the corpus described a pi the terminal
  surface need never have run.

## What crosses it that should not

**L5 — the tool names are the runtime's.** (`.local/refactor/goals.md` §2.) The names: `bash`, `write`, `edit`,
`read`, `powershell` — `guard-denials.ts#GUARD_POLICY_TOOL_NAMES`; a runtime whose tools are named otherwise
meets the fail-closed floor until its glue settles the names. Since #861 the guard is no longer the
runtime's extension: the session is runtime free, and only the glue registers through `pi.on('tool_call')`
and returns the runtime's `ToolCallEventResult` (`guards/index.ts#createGuards`). The analyzer is a vendored
library — `cc-safety-net/api`'s `checkCommand`, imported by `guards/index.ts` — held behind our verdict: its
`{ kind, reason, ruleId }` never leaves the glue, which turns it into a `ShellAnalyzerDenial` (rule and
reason), and `shellCommandDenial` makes that a `{ block, reason, rule }` with `guard-denials.ts#deny`. So the
library, the policy and the verdict shape survive a runtime change; the registration and the hook's event
types do not. That is already the arbiter's shape (#4): one handler owning the verdict, participants as
libraries beneath it — designed, deferred while the count is two with aligned fail direction
(`tool-call-participants.test.ts`'s header).

The guard also writes to the runtime's log: on every denial it appends a custom entry,
`ENSO_GUARD_DENIAL_ENTRY` with `{ toolCallId, rule }` (`@enso/core` `guard.ts`), through the port's `append` — `pi.appendEntry` in the pi glue
(#387). The crossing is the call, not the shape — the entry's type and reader are ours — and it exists
because the runtime turns a block into an error result identical to a failed command's and runs no
result hook for a blocked call, so the entry is the only place a refusal survives a reload.

A smaller crossing, named: `guard.ts`'s `ENSO_PERSISTENCE_WRITE_DIRECTORIES` spells the analyzer's state
directory as a path (`core/src/guard.ts#ENSO_PERSISTENCE_WRITE_DIRECTORIES`), which is the gate's one guard line.

## Pivot cost

Which files may import the runtime is fixed by a gate (#558): `VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS` in `test/vendor-gate.test.ts` lists them, and the list only shrinks, so a new file cannot quietly add to what follows.

**Replace the runtime** and the file that changes is the glue, `packages/harness/extensions/guards/index.ts`, or a
second glue beside it: the registration (`pi.on`), the event types it takes (`ToolCallEvent`,
`ToolResultEvent`), the port's four calls (`GuardRuntime`), how a read's partial result is told apart
(`returnedWholeFile`), and the verdict's return type. `decide`'s order, the reasons, the session's
security and the three hooks' responsibilities do not move: they are `createGuardSession`'s, and
`core/__tests__/guard-session.test.ts` drives them through the port with no runtime at all.

**What does not change**, and what proves it: `packages/harness/core/` — `paths.ts`, `network-egress.ts`,
`shell-segments.ts`, `environment-dump.ts`, `shell-secret-paths.ts`, `read-tracker.ts`,
`tool-identity.ts`, and since #861 `guard-session.ts`, `guard-denials.ts` and `session-security.ts` — take
strings, paths, a cwd and the port, and return matches, states or verdicts (`packages/harness/core/index.ts`);
nothing in them imports the runtime, which the vendor gate holds for every file outside `extensions/`
and the host across every source root the repo has — `packages/core/src`, `packages/web/src`,
`packages/harness`, `packages/web/e2e`, `scripts` and `test`, `__tests__` directories included since
#215. Their tests (`core/__tests__/paths.test.ts`, `network-egress.test.ts`,
`environment-dump.test.ts`, `shell-secret-paths.test.ts`, `read-tracker.test.ts`) drive them without an
extension — with one allowlisted exception, stated because the gate now sees it:
`core/__tests__/paths.test.ts` DOES import the runtime, by
`import.meta.resolve('@earendil-works/pi-coding-agent')`, to pin the replica of `resolveToCwd` and
`normalizeWindowsShellPath` against pi's own `utils/paths.js` on every input. That import is the
corpus, and it leaves when the replica does. `packages/core/src/guard.ts` is data. The contract test
pins the analyzer independently of any hook.

**Replace the analyzer** and `GuardDependencies` is the seam: its `analyzeBashCommand` is one function `{ command, cwd } →
{ kind, reason, ruleId? }`, injected by the default export (`guards/index.ts#createGuards`); the contract test is rewritten for the new library,
the glue's `safetyNetDenial` reads the new verdict, and the two allowlist mentions of its state
directory (`core/src/guard.ts#ENSO_PERSISTENCE_WRITE_DIRECTORIES`, the gate line) go with it.
