<!-- generated: scripts/docs/env-and-config.ts -->
# Environment and configuration reference

Generated from the owned source roots, `scripts/lint/process-environment.ts`, the core config/path declarations,
and `packages/harness/package.json`. No machine environment and no user config is read.

## Explicit environment keys

The 12 files that directly touch the process environment exactly match the
`node/no-process-env` exception list in `scripts/lint/process-environment.ts`; generation fails if either side gains or loses a file.
Rows cover literal dot access, literal bracket access, destructuring, `node:process` `env` imports,
grounded `environment.KEY` seams, and keys explicitly written beside a process-environment spread.

| Key | Reader | Purpose, requirement, and default | Phase |
|---|---|---|---|
| `ENSO_HOME` | `packages/core/src/paths.ts#ensoHome` | Optional user-level Enso directory (#421); an absent or empty value defaults to `~/.enso`. pi's agent dir, the secrets file, the logs and the project list all resolve under it. | boot / load / per-call |
| `ENSO_LOG_CONSOLE` | `packages/core/src/log-process.ts#parseEnsoLogLevels` | Optional terminal log level; launcher default is `info`, while child-pi logging defaults to no console sink. | boot / load |
| `ENSO_LOG_LEVEL` | `packages/core/src/log-process.ts#parseEnsoLogLevels` | Optional file log level and per-category overrides; defaults to `info`. | boot / load |
| `ENSO_SERVER_URL` | `scripts/enso-logs.ts#bundle` | Optional live-server URL for bundle retrieval; defaults to `http://127.0.0.1:5179`. | per-call |
| `ENSO_SERVER_URL` | `scripts/enso-thread.ts` | Optional live-server URL for thread inspection; defaults to `http://127.0.0.1:5179`. | boot |
| `ENSO_SITE_BASE` | `scripts/docs/site-base.ts#SITE_BASE` (module read) | Optional; the path the documentation site is served under. Defaults to `/enso` for a local build. The publish workflow sets it to `/<repository>` — what a GitHub project site is served from — so the base is derived rather than a literal that rots on a rename. | build |
| `ENSO_SITE_URL` | `scripts/docs/site-base.ts#SITE_URL` (module read) | Optional; the origin the site is served from, which Astro needs to emit a sitemap — without it `@astrojs/sitemap` skips at WARN and the build still succeeds. Defaults to the unresolvable `https://example.invalid` because a local build has no origin; the publish workflow sets the owner’s Pages origin. | build |
| `FORCE_COLOR` | `scripts/gate.ts#runGate` (child environment write) | Optional; set to `1` only when both gate output streams are TTYs, otherwise not overridden. | per-call |
| `PI_CODING_AGENT_DIR` | `packages/web/src/host/agent-host.ts#createAgentHost` (process write) | Required pin to the supplied scratch agent directory before pi loads; no fallback at this boundary. | boot |
| `PI_CODING_AGENT_DIR` | `scripts/enso.ts` (pi child environment write) | Required pin to the selected agent directory in the spawned pi process. | boot |
| `PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS` | `packages/web/src/host/agent-host.ts#createAgentHost` (process write) | Always `1` in the server: pi-multi-account (≥1.23.2) makes every in-process session an independent root with its own failover, instead of passive after the first (#351). Stays set — the extension reads it per session. | boot |
| `npm_config_user_agent` | `scripts/gate.ts#detectPackageManager` | Optional package-manager identity; falls back to Bun detection, then `npm`. | boot |

**Parser limit.** Only literal keys in the source shapes named above become rows. Computed names and
whole-environment quarantine/pass-through operations have no concrete key to report; adding a new literal
shape or a literal without checked metadata fails generation as `UNCLASSIFIED` rather than being omitted.

## `EnsoConfig` schema

The user's `ENSO_HOME/config.json` (#421). No file at all is every default below. A file that is there is strict
on unknown keys and fails closed when unreadable. Defaults are consumer behavior when an optional field is omitted;
required fields have no schema default.

| Field | Required | Default when omitted | Reader |
|---|---|---|---|
| `projects` | no | No roots: the launch directory is the only project, and registering another is refused. | `packages/web/src/server/dev.ts` → `startEnsoServer({ projectRoots })` |
| `projects.roots` | yes | n/a — absolute or `~/` paths; a page may register a project only strictly under one (#395), and a root taken out hides the projects under it | `packages/web/src/server/projects.ts#createProjectRegistry` |
| `webFetch` | no | An empty allowlist: nothing is fetchable. | `packages/harness/extensions/web-fetch/index.ts#createWebFetch` |
| `webFetch.allowedHosts` | yes | n/a — required once `webFetch` is present; `[]` fetches nothing. | `packages/harness/extensions/web-fetch/index.ts#createWebFetch` |
| `webSearch` | no | `{}`; current-model routing with no Tavily domain filters. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |
| `webSearch.backend` | no | Current-model routing; only `"deepseek"` pins the dedicated backend. | `packages/harness/extensions/web-search/index.ts#runPrimary` |
| `webSearch.tavily` | no | No Tavily domain filters. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |
| `webSearch.tavily.excludeDomains` | no | Omitted from the Tavily request. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |
| `webSearch.tavily.includeDomains` | no | Omitted from the Tavily request. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |

**Parser limit.** The schema reader handles this repository's current `Type.Object` / `Type.Optional`
declaration layout in `config.ts`, `web-fetch.ts`, and `web-search.ts`; metadata and consumer probes must
match every discovered field or generation fails.

## Runtime paths

Every runtime path helper in `packages/core/src/paths.ts`: the user's state under `ENSO_HOME` (`~/.enso` by default, #421), and the checkout's own build cache.

| Path | Assembler | Writer | Lifetime |
|---|---|---|---|
| `ENSO_HOME/logs` | `ensoLogsDir` | `configureProcessLogging` creates it and every harness process appends to the day file. | One file per local day; logging retains 14 days. |
| `ENSO_HOME/pi-agent` | `ensoAgentDir` | The TUI/server launchers create it; pi and `createAgentHost` write settings, auth, sessions, and the multi-account pin. | Per-user state shared by every checkout and launch; retained until the operator removes it. |
| `ENSO_HOME/projects.json` | `ensoProjectsPath` | The web server, when a page registers or removes a project (#395); written whole and renamed over. | Per-user until a project is removed; entries outside the configured roots are kept but not served. |
| `ENSO_HOME/secrets.env` | `ensoSecretsPath` | Operator only; harness code reads and quarantines but never writes it. | Per-user until the operator edits or removes it; secret reads are per call. |
| `node_modules/.cache/enso/print-harness` | `printHarnessDir` | `scripts/print-harness.ts#materializePrintHarness` rebuilds the package mirror for non-interactive launches. | Per-checkout build cache (its links point into this checkout); reconciled on every print launch. |

## Harness manifest resources

Generated from the `pi` manifest. Extension order is declaration order and is deliberately not sorted;
the other resource arrays are also shown in declared order. A vendor path is any path rooted at
`node_modules/`; repository paths are package-local.

| Kind | Declared order | Path | Origin |
|---|---:|---|---|
| extensions | 1 | `./extensions/logging/index.ts` | repository path |
| extensions | 2 | `./extensions/guards/index.ts` | repository path |
| extensions | 3 | `./extensions/web-fetch/index.ts` | repository path |
| extensions | 4 | `./extensions/web-search/index.ts` | repository path |
| extensions | 5 | `node_modules/@ladbabynpm/picc-permission-modes/index.ts` | **vendor path** |
| extensions | 6 | `node_modules/pi-multi-account/index.ts` | **vendor path** |
| extensions | 7 | `./extensions/ask-user/index.ts` | repository path |
| skills | 1 | `./skills` | repository path |
| prompts | 1 | `./prompts` | repository path |
| themes | 1 | `./themes` | repository path |
| themes | 2 | `node_modules/@mammothb/pi-tokyonight-storm/themes` | **vendor path** |
