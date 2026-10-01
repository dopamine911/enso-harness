import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * The Tier 0 guard policy.
 *
 * ⚠ The regex constants at the bottom are not schemas, and they live here anyway. Splitting
 * the policy — schema in `@enso/core`, patterns beside the extension — would put half of one
 * decision in each of two packages, which is the duplication this package exists to prevent.
 * The policy is one thing; it is declared in one place.
 *
 * @group Guards
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

/** @group Guards */
export type GuardPolicy = Static<typeof GuardPolicy>

/**
 * The rules a denial can name, one per refusal site in the guard (#144 slice 4).
 *
 * A denial's `reason` is prose for the model — it names the path, the construct, the way
 * out — and prose is not something a day's stats can count by. `rule` is the closed word the
 * record carries beside it, so "denials by rule" is a count over a vocabulary rather than a
 * regex over sentences that were written to be read, not matched. Declared here, not in the
 * extension, because the reader that counts them is `@enso/core`'s and must not import the
 * guard to learn its words.
 *
 * @group Guards
 */
export const ENSO_GUARD_RULES = [
  /** #4's fail-closed floor: the policy names a tool pi does not have, so everything is refused. */
  'policy-mismatch',
  /** cc-safety-net's verdict on a bash command — destructive, or secret access through the shell. */
  'cc-safety-net',
  /** An ad-hoc network client at command position, or a construct the deny cannot see through (#9, #57). */
  'network-egress',
  /** An environment listing or a secret-shaped expansion (#89). */
  'environment-dump',
  /** A credential path named in a shell command (#204). */
  'secret-path',
  /** A write that resolves outside the workspace roots. */
  'write-confinement',
  /** A write into the harness's own protected internals. */
  'protected-internals',
  /** A write to a shell-init, git, editor or agent-config path that would execute later (#21). */
  'persistence-write',
  /** A write to a path that matches a credential pattern. */
  'secret-write',
  /** A mutation of a file that changed on disk since the session last read it (#11). */
  'stale-write',
  /** A whole-file write to an existing file the session has never read (#10). */
  'read-before-write',
  /** A read of a path that matches a credential pattern, by any tool carrying a `path`. */
  'secret-read',
  /** A call to a tool family an open security incident suspended, until a human resolves it (#466). */
  'incident-suspension',
  /** A shell command naming the session or log directory — the records an incident rests on (#466). */
  'protected-records',
] as const

/** @group Guards */
export type EnsoGuardRule = (typeof ENSO_GUARD_RULES)[number]

/**
 * What a rule's refusal asks of the one who hit it (#465):
 * - `authorization` — only the user can unblock it. The refusal names `ask_user` as the way out and
 *   ends the turn (pi's `terminate`), so asking is cheaper than trying another route (#189).
 * - `redirect` — the reason names a sanctioned route the agent can take itself (`web_fetch`, a
 *   non-secret variable). The turn goes on so it can; the refusal adds `ask_user` for when that
 *   route cannot do it.
 * - `procedure` — the fix is a step the agent can take itself: read the file first.
 * - `configuration` — the harness is misconfigured; neither the agent nor an answer can fix it.
 * - `suspension` — an open security incident suspended the tool (#466). Ends the turn; only the
 *   user's resolution of the incident lifts it, so the reason says that, not "ask".
 *
 * @group Guards
 */
export type EnsoGuardRuleKind = 'authorization' | 'redirect' | 'procedure' | 'configuration' | 'suspension'

/**
 * Every rule's kind — a closed table, so a rule added to `ENSO_GUARD_RULES` must be classified to
 * compile.
 *
 * @group Guards
 */
export const ENSO_GUARD_RULE_KINDS: Readonly<Record<EnsoGuardRule, EnsoGuardRuleKind>> = {
  'policy-mismatch': 'configuration',
  'cc-safety-net': 'authorization',
  'network-egress': 'redirect',
  'environment-dump': 'redirect',
  'secret-path': 'authorization',
  'write-confinement': 'authorization',
  'protected-internals': 'authorization',
  'persistence-write': 'authorization',
  'secret-write': 'authorization',
  'stale-write': 'procedure',
  'read-before-write': 'procedure',
  'secret-read': 'authorization',
  'incident-suspension': 'suspension',
  'protected-records': 'authorization',
}

/**
 * The `customType` of the session entry the guards extension appends when it refuses a call
 * (#387 gap 1, #407 item 1).
 *
 * WHY AN ENTRY. pi discards the block marker: a `tool_call` handler's `{ block, reason }` becomes
 * `createErrorToolResult(reason)`, the same shape a thrown tool error makes, and a blocked call
 * never reaches `tool_result` hooks, so nothing can stamp its `details` either. The guard is the
 * one place that knows a refusal happened, and a custom entry is the one thing it can write that
 * pi persists — so a reload, a resume and the stored transcript still say "refused by policy",
 * where an event on pi's bus would be gone with the process.
 *
 * pi's context builder skips `custom` entries, so the model's view is unchanged; it reads the
 * reason from the tool result, as before.
 *
 * @group Guards
 */
export const ENSO_GUARD_DENIAL_ENTRY = 'enso-guard-denial' as const

/**
 * A guard refusal as data: the call it refused and the rule that refused it. The reason is
 * NOT repeated — it is the tool result's text already, the one copy the model and the page
 * both read.
 *
 * A network-egress refusal also carries its class (#464): `via`, how the deny matched
 * (`command-position`, … or `unresolvable`, a construct it cannot see through, #203), and
 * `matched`, what it matched. The session's risk fold tells a plain-name refusal from a
 * cannot-vouch one by `via`, not by the reason's wording.
 *
 * A stored tool result carries the refusal as `EnsoToolRefusal` (`session-risk.ts`, #523) — who
 * refused, this entry and the engine's resolving to one shape — under `ENSO_TOOL_REFUSAL_KEY`.
 *
 * @group Guards
 */
export const EnsoGuardDenial = Type.Object({
  toolCallId: Type.String({ minLength: 1 }),
  // `Unsafe` for the static type only: a union mapped from the list validates every rule, but
  // TypeBox infers a mapped array's union as `never`.
  rule: Type.Unsafe<EnsoGuardRule>(Type.Union(ENSO_GUARD_RULES.map((rule) => Type.Literal(rule)))),
  via: Type.Optional(Type.String({ minLength: 1 })),
  matched: Type.Optional(Type.String()),
})
/** @group Guards */
export type EnsoGuardDenial = Static<typeof EnsoGuardDenial>

const denialValidator = Compile(EnsoGuardDenial)

/**
 * The refusal a custom entry records, or undefined when the entry is another extension's or
 * malformed. Read defensively — an entry is a wire crossing, and a bad one is not a refusal.
 *
 * @group Guards
 */
export function readEnsoGuardDenial(customType: string, data: unknown): EnsoGuardDenial | undefined {
  return customType === ENSO_GUARD_DENIAL_ENTRY && denialValidator.Check(data) ? data : undefined
}

/**
 * Defaults.
 *
 * Deliberately conservative on reads of credential material and on writes outside the workspace
 * — the two cases from `docs/concepts/pi-immediate-needs.md` Tier 0 where pi ships no
 * confinement at all.
 *
 * @group Guards
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

/**
 * Basenames whose WRITE is a persistence vector (#21): the write itself is harmless, and
 * the execution happens later, outside the session, under the user's own identity — a
 * shell rc runs on the next login, `.gitconfig` hooks run on the next git command, agent
 * config hijacks the next agent session.
 *
 * Not secrets, so `looksLikeSecret` cannot catch them: nothing is exfiltrated, something is
 * installed.
 *
 * ⚠ Matched by EXACT basename (case-insensitive), never as a fragment — `.profile` as a
 * fragment would catch `~/work/.profile-notes/x.ts`.
 *
 * Enso's own list: files whose modification persists code execution or changes tool
 * behaviour across sessions. ⚠ This layer must stay UNCONDITIONAL: it is the only
 * always-on denial for these paths, including print runs.
 *
 * @group Guards
 */
export const PERSISTENCE_WRITE_BASENAMES: readonly string[] = [
  '.gitconfig', // can set `core.hooksPath`, `core.fsmonitor` or aliases that run commands
  '.gitmodules', // points submodule URLs/paths at attacker content fetched by later git runs
  '.bashrc', // runs at every interactive bash start
  '.bash_profile', // runs at every bash login shell
  '.zshrc', // runs at every interactive zsh start
  '.zprofile', // runs at every zsh login shell
  '.profile', // runs at login for sh-compatible shells
  '.ripgreprc', // default flags for every rg run (e.g. `--pre` runs a command per file)
  '.mcp.json', // registers MCP servers an agent launches as processes
  '.claude.json', // agent config: MCP servers and settings loaded next session
]

/**
 * Directory names (any single path segment) whose CONTENTS are write-persistence vectors
 * — editor tasks, agent settings, git internals.
 *
 * Same matching rules as {@link PERSISTENCE_WRITE_BASENAMES}. `.git` overlaps
 * `protectedWriteFragments`' `/.git/` deliberately; the fragment also catches the bare repo
 * case and predates this.
 *
 * @group Guards
 */
export const PERSISTENCE_WRITE_DIRECTORIES: readonly string[] = [
  '.git', // hooks run on git commands; config can run commands
  '.vscode', // tasks.json/settings.json can run commands when the editor opens the folder
  '.idea', // run configurations and tool settings executed by the IDE
  '.claude', // agent settings, hooks and commands loaded next session
]

/**
 * Agent-specific persistence directories for the harness itself (pi and Enso):
 *
 *   `.pi`      — a project-local `.pi/settings.json` installs an extension package that
 *                loads on the user's next plain `pi` session in that repo (the exact
 *                mechanism scripts/enso.ts suppresses with --no-extensions).
 *   `.agents`  — pi discovers skills from `~/.agents/skills/` even under a redirected
 *                agent dir (scripts/enso.ts's --no-skills note); a written skill loads
 *                next session.
 *   `.enso`     — `ENSO_HOME` (`~/.enso`: the agent dir, auth.json, config.json) and any
 *                project's `.enso/config.json`, which widens that project's sessions once
 *                it is trusted (#421). No agent task legitimately writes there via write/edit.
 *   `.cc-safety-net` — cc-safety-net's own policy dir (#9). Probed 2026-09-04: its
 *                checkCommand DENIES `rm -rf .cc-safety-net` but ALLOWS a shell redirect
 *                into it (`echo x > .cc-safety-net/rules.json`), and pi's write/edit
 *                tools never pass through checkCommand at all — so this guard is the only
 *                layer that can keep the agent from editing the policy that gates it.
 *
 * @group Guards
 */
export const ENSO_PERSISTENCE_WRITE_DIRECTORIES: readonly string[] = ['.pi', '.agents', '.enso', '.cc-safety-net']

/**
 * Further shell-init files and direnv's file, beyond {@link PERSISTENCE_WRITE_BASENAMES} (#160,
 * folded from #21):
 *
 *   `.zshenv`   — read by EVERY zsh, interactive or not, so it runs before any script a later
 *                 tool call or cron job starts: the widest of the family.
 *   `.zlogin`, `.zlogout`, `.bash_login`, `.bash_logout` — login-shell start and exit
 *                 (`.bash_login` runs when there is no `.bash_profile`).
 *   `.envrc`    — direnv runs it on `cd` into the folder. direnv refuses a CHANGED file until it
 *                 is re-allowed, so this is a lure the user is one `direnv allow` from running,
 *                 rather than silent execution; refused all the same, as the rc files are.
 *
 * Same matching as {@link PERSISTENCE_WRITE_BASENAMES}: exact basename, case-insensitive.
 *
 * @group Guards
 */
export const ENSO_PERSISTENCE_WRITE_BASENAMES: readonly string[] = [
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.bash_login',
  '.bash_logout',
  '.envrc',
]

/**
 * The kernel's copy of a process's environment: `/proc/<pid>/environ`, and the same bytes per
 * thread at `/proc/<pid>/task/<tid>/environ` (#160 §5 — one segment deeper, and both copies of the
 * pattern had missed it). ONE shape, so the read gate and the shell deny cannot drift apart again:
 * the two had already diverged in anchoring. The read gate matches a whole path; the shell deny
 * finds it anywhere in a command line.
 */
const PROC_ENVIRON_SHAPE = String.raw`/proc/[^/\s]+(?:/task/[^/\s]+)?/environ`

/**
 * A resolved path that IS a process's environment (see the shape above).
 *
 * @group Guards
 */
export const PROC_ENVIRON_PATH = new RegExp(`^${PROC_ENVIRON_SHAPE}$`)

/**
 * A process's environment named anywhere in a command line (see the shape above).
 *
 * @group Guards
 */
export const PROC_ENVIRON_IN_COMMAND = new RegExp(`${PROC_ENVIRON_SHAPE}\\b`)

/**
 * Basenames that deny a read outright, regardless of directory.
 *
 * @group Guards
 */
export const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^secrets?\.(env|json|ya?ml|toml|ini)$/i,
  /^credentials?(\.(json|ya?ml|toml|ini))?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
]
