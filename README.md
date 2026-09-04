# zen-harness

A **pi package** that provides **two surfaces over one agent loop**. [pi](https://github.com/earendil-works/pi)
owns the loop, the providers, sessions, and compaction; zen-harness adds guards, tools, and state as pi
extensions, and presents them through a terminal launcher and a web application. Neither surface has its
own brain — both are clients of the same package running against the same pi.

The founding stance, and the design of record, is [`docs/architecture.md`](docs/architecture.md); the
research behind each decision lives in [`docs/concepts/`](docs/concepts/). This README is the map of
what is **built and running today**.

## Quick start

```bash
bun install            # postinstall links the vendor packages into the harness
bun run zen            # a VANILLA pi with only zen-harness loaded (isolated agent dir)
bun run zen -p "..."   # non-interactive print run (loads the print variant — see below)
bun run dev            # both web surfaces: API server on :5179, app on :5178
bun run check          # THE gate: biome → tsc → bun test → coverage floor
```

`bun run zen` launches pi with `PI_CODING_AGENT_DIR` pointed at `.zen/pi-agent` (a scratch config dir —
none of your global packages, settings, or credentials are visible), `--no-extensions` (suppresses
discovery, including this repo's own `.pi/settings.json`), and `--no-skills`. Either `/login` once inside
that dir or export `ANTHROPIC_API_KEY`.

## What is built

### The guards (`packages/harness/extensions/guards/`)

One `tool_call` handler — additive, so a block is final regardless of extension load order. In
precedence order:

- **Fail-closed policy floor (#4):** every tool-name comparison is case-canonicalized, and the guard's
  policy names are checked against pi's live tool list (lazily, on the first call if `session_start`
  has not fired). A mismatch — or an unreadable tool list — denies *everything*, with the reason.
- **Bash policy (#9), two layers:** [`cc-safety-net`](https://www.npmjs.com/package/cc-safety-net)
  (exact-pinned, as a *library*) analyzes every bash command — destructive git, `rm -rf`, secret access
  through the shell; its throw is a deny by contract, and a contract test pins the vendor's verdict
  matrix. Then the **network egress deny** (`core/network-egress.ts`): ad-hoc HTTP/TCP clients (`curl`,
  `wget`, `nc`, `ssh`, …) at command position per shell segment, quote/brace/glob evasion resolved to
  the literal the shell would execute, transparent wrappers (`timeout`, `env`, `xargs`, …) unwrapped,
  `/dev/tcp` anywhere, and a coarse scan for PowerShell and unparseable input. The deny points at
  `web_fetch` as the sanctioned path.
- **Write confinement:** mutating tools stay inside the workspace (symlink-aware), never touch `.git/`
  or `zen.config.json`, never touch **persistence vectors** (#21: shell rc files, `.gitconfig`,
  `.mcp.json`, `.vscode/`, `.pi/`, `.zen/`, `.cc-safety-net/`, … — a write there executes later, as the
  user), and never touch credential-shaped paths.
- **Read gate by exclusion:** *every* path-bearing tool — including ones pi doesn't ship yet — is
  refused credential material (`~/.ssh/`, `~/.aws/`, `.env`, key files). Exclusion, not an inclusion
  list: an over-broad reader set blocks something harmless and says so; a too-narrow one leaks in silence.
- **Read-before-write (#10) and stale-write detection (#11):** a whole-file `write` requires the session
  to have seen the file, and any mutation of a file that *changed on disk underneath the session*
  (another agent, a git restore) is refused with "re-read first".
- **Timeout patch:** a bash call without a timeout gets the default injected — last, so a denied command
  is never mutated.

⚠ Stated non-coverage, so nobody reads the bash policy as confinement: `git` remotes, interpreters
(`python -c`, `node -e`), cross-call variable indirection, binary relocation, and nested-payload
splice-quoting (#57). Each is **pinned by a test**, not just prose.

### `web_fetch` (`packages/harness/extensions/web-fetch/`, #54)

The sanctioned web access that replaces what the egress deny took away. One tool, three properties a
`curl` in a shell string can never have:

1. **A committed, empty-by-default host allowlist** — `webFetch.allowedHosts` in
   [`zen.config.json`](zen.config.json). Read **once** at extension load (an in-session edit is inert
   until a restart has put the diff in front of a human), guard-write-protected, exact-host match only.
   Adding a host: edit the file, commit it, restart the session.
2. **One stderr audit line per call**, refusals included.
3. **Bounded handling:** http(s) only, no URL credentials, redirects reported but never followed,
   textual content types only, 512 KiB body cap, 30 s deadline, an advisory public-address check, and an
   untrusted-content banner before every body. (The DNS resolve-twice window and hex-form mapped IPv6
   are recorded non-coverage, pinned in tests.)

### `zen.config.json` + path helpers (`@zen/core`, #59)

The **one committed config file** for zen-harness — separate from pi's settings, one section per
consumer, TypeBox-validated, **strict on unknown keys** (a typo refuses loudly rather than configuring
nothing), parse fails closed. It belongs to the zen-harness *install*: located via `findRepoRoot` from
the harness's own tree, never the session cwd.

`packages/core/src/paths.ts` is the one place that walks the filesystem for roots — `findRepoRoot`
accepts `import.meta.url`, realpaths **first** (the print-harness symlink mirror is why), then walks to
the nearest `package.json` with a `workspaces` field. An **anchor test** (`no-duplicate-paths.test.ts`)
fails the suite by filename if `fileURLToPath` or inline `.zen` assembly reappears anywhere else.

### The print variant (#20)

picc-permission-modes fails closed when it cannot prompt, so a `-p` run under the full package could
chat and nothing else. Non-interactive runs (`-p`, or piped stdin) therefore load a **print variant**
materialized under `.zen/print-harness/` — the harness minus picc, guards and everything else intact.

### The web surface (`packages/web/`)

Bun's fullstack dev server (no vite, no node): a backend that spawns pi in `--mode rpc` per prompt and
maps its events onto AG-UI for a TanStack AI chat client. Built so far: streaming chat with tool-call
rendering, **pi's blocking dialogs answered from the browser** via AG-UI interrupt/resume (#27),
mode-change notifications, and a session-stats bar (cost + last-request token split, #45 phase 1).

### Vendored pi packages (`packages/harness/package.json` → `pi.extensions`)

[`picc-permission-modes`](https://www.npmjs.com/package/@ladbabynpm/picc-permission-modes) (Claude-Code-style
permission modes; interactive runs only), [`pi-multi-account`](https://www.npmjs.com/package/pi-multi-account),
and a theme. Vendor packages ride at exact-pinned versions; `scripts/link-vendor-packages.mjs`
(postinstall) symlinks them into the harness's own `node_modules`, because pi loads packages with
separate module roots.

## Repo layout

| Path | What it is |
|---|---|
| `packages/core/` | `@zen/core` — every TypeBox schema, the config loader, the path helpers ([its README](packages/core/README.md)) |
| `packages/harness/` | the pi package: `extensions/` (guards, web-fetch), `core/` (pure logic: egress, shell segments, read tracker, fetch policy), skills/prompts/themes |
| `packages/web/` | the web surface: server (pi rpc transport, dialog registry), client (TanStack AI chat) |
| `scripts/` | `zen.mjs` (the launcher), `dev.mjs`, `print-harness.mjs`, `gate.ts`, `check-coverage.ts`, `link-vendor-packages.mjs` |
| `zen.config.json` | the committed config — web_fetch's host allowlist lives here |
| `docs/` | `architecture.md` (the vision) and `concepts/` (the research) |
| `.zen/` | machine-local runtime state (pi agent dir, print variant) — gitignored |
| `.inspiration/` | read-only vendored codebases surveyed for design (oh-my-pi, pi, deepseek-harness, …) |

## How this repo verifies itself

`bun run check` is the single source of "green" — the pre-commit hook and CI both run it (biome, tsc,
bun test, a coverage floor over a **full denominator**: `test/coverage-manifest.test.ts` imports every
library source file so an untested module counts instead of vanishing from the table). CI adds a
secret scan, react-doctor, and an automated review pass on every PR.

Three **anchor tests** enforce conventions a reviewer would otherwise have to remember: no TypeBox
schema outside `@zen/core`, no duplicate path-walking outside `paths.ts`, and the barrel-as-inventory
rule. Beyond the gate, the working practice is: security-relevant assertions are **mutation-tested**
(break the code, watch the test go red, revert), every landed change carries **live receipts** (a real
run, not a green suite), and known gaps are **pinned as tests** that name themselves as records — if
one goes red, the gap closed and the record updates.

## Security posture, honestly stated

Guards here are **bars that accrete, not boundaries** — string analysis closes bounded, enumerable
classes, and each stated residual is a test, not a hope. Confinement-shaped guarantees (a bash the
guard cannot out-parse) are sandboxing's job, which is the agreed direction, not this layer's claim.
