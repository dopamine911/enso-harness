import { type Static, Type } from 'typebox'

/**
 * The Tier 0 guard policy.
 *
 * ⚠ The regex constants at the bottom are not schemas, and they live here anyway. Splitting
 * the policy — schema in `@zen/core`, patterns beside the extension — would put half of one
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

export type GuardPolicy = Static<typeof GuardPolicy>

/**
 * Defaults. Deliberately conservative on reads of credential material and on
 * writes outside the workspace — the two cases from `docs/concepts/pi-immediate-needs.md`
 * Tier 0 where pi ships no confinement at all.
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
  ],
  // `zen.config.json` is zen-harness's committed config (#59) and carries web_fetch's
  // host allowlist (#54): a write there widens the harness's egress for every FUTURE
  // session (it is read once at extension load, so the running session cannot re-read
  // its own edit). Same rationale as `.cc-safety-net` below — the guard is the only
  // layer keeping the agent from editing the policy that gates it. Fragment matching is
  // deliberately loose (any path whose name contains it is refused) — over-blocking a
  // lookalike file fails safe and says so.
  protectedWriteFragments: ['/.git/', 'zen.config.json'],
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
 * config hijacks the next agent session. Not secrets, so `looksLikeSecret` cannot catch
 * them: nothing is exfiltrated, something is installed.
 *
 * ⚠ Matched by EXACT basename (case-insensitive), never as a fragment — `.profile` as a
 * fragment would catch `~/work/.profile-notes/x.ts`.
 *
 * Vendored from `@ladbabynpm/picc-permission-modes` v0.1.1 (`permissionContext.ts`
 * `DANGEROUS_FILES` / `DANGEROUS_DIRECTORIES`, MIT, © 2026 Ladbaby), as a COPY rather
 * than a deep import: the lists are a corpus, not logic, and an unversioned deep import
 * into a v0.1.1 package is the risk #7 names. Kept in upstream's order so a divergence
 * is visible in a diff. ⚠ This layer must stay UNCONDITIONAL: picc reaches at most "ask"
 * for these paths (mode-shaped — an auto-mode classifier may approve one), and print
 * runs load no picc at all (#20), so here is the only always-on denial.
 */
export const PERSISTENCE_WRITE_BASENAMES: readonly string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
]

/**
 * Directory names (any single path segment) whose CONTENTS are write-persistence vectors
 * — editor tasks, agent settings, git internals. Same provenance and matching rules as
 * {@link PERSISTENCE_WRITE_BASENAMES}. `.git` overlaps `protectedWriteFragments`'
 * `/.git/` deliberately; the fragment also catches the bare repo case and predates this.
 */
export const PERSISTENCE_WRITE_DIRECTORIES: readonly string[] = ['.git', '.vscode', '.idea', '.claude']

/**
 * ZEN ADDITIONS — NOT from picc. Kept as a separate constant so the vendored block above
 * stays byte-comparable against upstream. picc's corpus protects the agent picc ships in
 * (Claude Code: `.claude`, `.claude.json`, `.mcp.json`); the agent running THIS harness is
 * pi, whose persistence surfaces upstream has no reason to know:
 *
 *   `.pi`      — a project-local `.pi/settings.json` installs an extension package that
 *                loads on the user's next plain `pi` session in that repo (the exact
 *                mechanism scripts/zen.mjs suppresses with --no-extensions).
 *   `.agents`  — pi discovers skills from `~/.agents/skills/` even under a redirected
 *                agent dir (scripts/zen.mjs's --no-skills note); a written skill loads
 *                next session.
 *   `.zen`     — the harness's own agent dir (`.zen/pi-agent`: settings, extensions,
 *                auth.json). No agent task legitimately writes there via write/edit;
 *                scripts/zen.mjs writes `.zen/print-harness` through node fs, which never
 *                passes this guard.
 *   `.cc-safety-net` — cc-safety-net's own policy dir (#9). Probed 2026-09-04: its
 *                checkCommand DENIES `rm -rf .cc-safety-net` but ALLOWS a shell redirect
 *                into it (`echo x > .cc-safety-net/rules.json`), and pi's write/edit
 *                tools never pass through checkCommand at all — so this guard is the only
 *                layer that can keep the agent from editing the policy that gates it.
 */
export const ZEN_PERSISTENCE_WRITE_DIRECTORIES: readonly string[] = ['.pi', '.agents', '.zen', '.cc-safety-net']

/** Basenames that deny a read outright, regardless of directory. */
export const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^secrets?\.(env|json|ya?ml|toml|ini)$/i,
  /^credentials?(\.(json|ya?ml|toml|ini))?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
]
