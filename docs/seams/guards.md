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

What the extension takes, and what it is:

<!-- source: packages/harness/extensions/guards/index.ts#GuardDependencies -->
```ts
/**
 * The guard's two seams: the bash analyzer (#9) and the harness root (#160 §4).
 *
 * Production wires cc-safety-net's `checkCommand` and this checkout's root; tests inject known
 * verdicts and a root they built. `checkCommand` reads LOCAL policy per call, so a guard test that
 * touched the real library would vary with the machine's cc-safety-net config (the contract test
 * alone exercises the real one, and pins defaults explicitly).
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
}
```

<!-- source: packages/harness/extensions/guards/index.ts#createGuards -->
```ts
/**
 * The guards extension, over its two seams. The bash analyzer is a dependency of this one
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
```

<!-- source: packages/harness/extensions/guards/index.ts#GUARD_POLICY_TOOL_NAMES -->
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

**Tool identity.** Every tool-name comparison, on both sides, folds through `canonicalToolName`
(`harness/core/tool-identity.ts#canonicalToolName`: lowercase, no mapping table), because the runtime's
built-ins are lowercase and vendor packages register capitalised names — a case-sensitive miss would
let the call proceed with nothing reporting it (`tool-identity.ts`'s header).

**The verdict.** The `tool_call` handler returns the runtime's `ToolCallEventResult | undefined`
(`guards/index.ts#guardsWithDependencies`): a denial is `{ block: true, reason }`, plus `terminate: true`
for an authorization refusal (every `return` in `decide` and `shellCommandDenial` is a
`guards/index.ts#deny`, `{ block: true, reason, rule }`, and the handler strips the rule before
returning), a pass is `undefined`.
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

**Implemented once**, by `packages/harness/extensions/guards/index.ts`. The default export is
`createGuards({ analyzeBashCommand: checkCommand, harnessRoot })` — the real analyzer wired at the composition root.
`guardsWithDependencies` registers three hooks: `session_start` resets the read tracker, rebuilds the
session's risk from the branch, and verifies the policy's tool names against the live tool list
(`guards/index.ts#verifyPolicyToolNames`); `tool_result` records which files the session has seen,
from *results* only — a blocked call produces no result and a failed one arrives `isError`;
`tool_call` records the call for the session's risk, calls `decide` and logs the verdict.

**`decide`'s order** (`guards/index.ts#decide`) — nested, so described, not fenced:

1. **The fail-closed floor** (#4). If the policy names a tool the runtime does not register, or the tool
   list could not be enumerated, every call is denied with the mismatch in the reason.
   Checked lazily here if `session_start` has not fired yet, so the floor never depends on event order.
2. **Shell** (`bash`, `powershell`) — `guards/index.ts#shellCommandDenial`, deny first, patch last:
   the analyzer (bash only; a throw is a deny per its contract), then the network deny by
   name at command position per segment, with the *cannot vouch* floor for a construct it cannot
   resolve, then the environment-dump deny, then the secret-path deny —
   the reader gate's own policy over every literal word of the command (#204). Only a
   command that passed all four gets the default timeout injected, back in `decide`, so no denied command
   has mutated input.
3. **No `path` argument** → pass.
4. **Writes** (`write`, `edit`), in order: outside the write roots (the cwd when none are
   configured), a protected fragment, a persistence target, a credential pattern, then the session's
   knowledge of the file — *stale* refuses both tools, *unknown and existing* refuses `write` only, and
   so does *partial* — read, but only part of it (#10, #11, #57 S2; the comment in `decide` says why
   the messages differ).
5. **Every other tool with a `path` is a reader**, by exclusion, and a credential pattern denies it
   (`guards/index.ts#readerDenial`); so does a credential location beneath its path (`grep` over `~`),
   except for `ls` and `find`, which return names only (#160 §4). Exclusion, not inclusion: an inclusion list naming only `read` once let `grep` over
   `~/.aws` through (the header of `guards/index.ts`). Since #204 the same policy also runs on the shell route, so
   `read ~/.enso/pi-agent/auth.json` and `cat ~/.enso/pi-agent/auth.json` agree — they did not.

**Every verdict is a record** (#132): a denial at `warn` with the tool, the path and the reason; an
allow at `debug`; never silent (the `tool_call` handler; pinned by `guards.test.ts`).

**The session's risk is observed here, and decides nothing** (#464, phase 1 of #189;
`guards/index.ts#observeSessionRisk`). Every call, every guard refusal and every refusal the
permission engine makes of the agent's call (a person's No, a rule's deny, `auto`'s block — heard on
the engine's decision bus) go through one pure fold in `@enso/core`, `session-risk.ts#sessionRiskStep`.
A signal is appended as `enso-security-signal` and logged at `warn`; a rise in level as
`enso-session-risk`. The engine's decision names no tool call, so the guard — the first participant,
with pi preparing a batch's calls one at a time — attributes it to the call it saw last and records
it as `enso-permission-denial` with that call's id; a `user_denied` under an aborted run is the
Stop's, not a No, and is not recorded. A throw anywhere in the fold is logged and swallowed: a bug
in risk becomes neither a refusal nor a pass. On `session_start` the state is rebuilt by replaying
the branch through the same fold (`riskEventsOfEntries`), never read from stored signals, and the
server replays the same branch for the thread snapshot and the session eval — `guards.test.ts`
drives the guard over a refusal sequence and replays the branch it wrote: same signals, same levels.

**Consumed by the runtime.** Handlers stack; the first `block` returns and cannot be un-blocked by a
later extension, whatever the load order (the header of `guards/index.ts`). The participants and their load order are
the manifest, `pi.extensions` in `packages/harness/package.json`: logging, **guards**, web-fetch, web-search, the
permission engine, the mode extension, the multi-account extension, ask-user, system-prompt and run-context. Two of those register a `tool_call` handler — guards and
the permission engine, in that order (#496; the mode extension registers none).

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

**L5 — the tool names are the runtime's, and the guard is the runtime's extension.** (`.local/refactor/goals.md` §2.) The names: `bash`, `write`, `edit`,
`read`, `powershell` — `guards/index.ts#GUARD_POLICY_TOOL_NAMES`; the extension: it
registers through `pi.on('tool_call')` and returns the runtime's `ToolCallEventResult`
(`guards/index.ts#guardsWithDependencies`). The analyzer is a vendored library — `cc-safety-net/api`'s `checkCommand`, imported by `guards/index.ts` — held
behind our verdict: its `{ kind, reason, ruleId }` never leaves `shellCommandDenial`, which turns it into
`{ block, reason, rule }` with `guards/index.ts#deny`. So the library and the verdict shape survive a runtime change; the
registration and the hook's event types do not. That is already the arbiter's shape (#4): one handler
owning the verdict, participants as libraries beneath it — designed, deferred while the count is two
with aligned fail direction (`tool-call-participants.test.ts`'s header).

The guard also writes to the runtime's log: on every denial it appends a custom entry,
`ENSO_GUARD_DENIAL_ENTRY` with `{ toolCallId, rule }` (`@enso/core` `guard.ts`), through `pi.appendEntry`
(#387). The crossing is the call, not the shape — the entry's type and reader are ours — and it exists
because the runtime turns a block into an error result identical to a failed command's and runs no
result hook for a blocked call, so the entry is the only place a refusal survives a reload.

A smaller crossing, named: `guard.ts`'s `ENSO_PERSISTENCE_WRITE_DIRECTORIES` spells the analyzer's state
directory as a path (`core/src/guard.ts#ENSO_PERSISTENCE_WRITE_DIRECTORIES`), which is the gate's one guard line.

## Pivot cost

**Replace the runtime** and the file that changes is `packages/harness/extensions/guards/index.ts`: the
registration (`pi.on`), the event types it takes (`ToolCallEvent`, `ToolResultEvent`), the
tool-list read in `verifyPolicyToolNames`, and the verdict's return type. `decide`'s order,
the reasons, and the three hooks' responsibilities carry over as they are.

**What does not change**, and what proves it: `packages/harness/core/` — `paths.ts`, `network-egress.ts`,
`shell-segments.ts`, `environment-dump.ts`, `shell-secret-paths.ts`, `read-tracker.ts`,
`tool-identity.ts` — take strings, paths and a cwd and return matches or states (`packages/harness/core/index.ts`);
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
`shellCommandDenial`'s first block reads the new verdict, and the two allowlist mentions of its state
directory (`core/src/guard.ts#ENSO_PERSISTENCE_WRITE_DIRECTORIES`, the gate line) go with it.
