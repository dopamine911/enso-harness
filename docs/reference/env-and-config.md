<!-- generated: scripts/docs/env-and-config.ts -->
# Environment and configuration reference

Generated from the owned source roots, `biome.jsonc`, the core config/path declarations,
`zen.config.json`, and `packages/harness/package.json`. No machine environment is read.

## Explicit environment keys

The 9 files that directly touch the process environment exactly match the
`noProcessEnv` exception list in `biome.jsonc`; generation fails if either side gains or loses a file.
Rows cover literal dot access, literal bracket access, destructuring, `node:process` `env` imports,
grounded `environment.KEY` seams, and keys explicitly written beside a process-environment spread.

| Key | Reader | Purpose, requirement, and default | Phase |
|---|---|---|---|
| `FORCE_COLOR` | `scripts/gate.ts#runGate` (child environment write) | Optional; set to `1` only when both gate output streams are TTYs, otherwise not overridden. | per-call |
| `PI_CODING_AGENT_DIR` | `packages/web/src/host/agent-host.ts#createAgentHost` (process write) | Required pin to the supplied scratch agent directory before pi loads; no fallback at this boundary. | boot |
| `PI_CODING_AGENT_DIR` | `scripts/zen.ts` (pi child environment write) | Required pin to the selected agent directory in the spawned pi process. | boot |
| `ZEN_AGENT_DIR` | `scripts/zen.ts` | Optional agent-directory override; defaults to `.zen/pi-agent`. | boot |
| `ZEN_LOGS_DIR` | `packages/core/src/log-process.ts#logsDirFrom` | Optional log-directory override; an absent or empty value defaults to `.zen/logs`. | boot / load / per-call |
| `ZEN_LOG_CONSOLE` | `packages/core/src/log-process.ts#parseZenLogLevels` | Optional terminal log level; launcher default is `info`, while child-pi logging defaults to no console sink. | boot / load |
| `ZEN_LOG_LEVEL` | `packages/core/src/log-process.ts#parseZenLogLevels` | Optional file log level and per-category overrides; defaults to `info`. | boot / load |
| `ZEN_SERVER_URL` | `scripts/zen-logs.ts#bundle` | Optional live-server URL for bundle retrieval; defaults to `http://127.0.0.1:5179`. | per-call |
| `ZEN_SERVER_URL` | `scripts/zen-thread.ts` | Optional live-server URL for thread inspection; defaults to `http://127.0.0.1:5179`. | boot |
| `npm_config_user_agent` | `scripts/gate.ts#detectPackageManager` | Optional package-manager identity; falls back to Bun detection, then `npm`. | boot |

**Parser limit.** Only literal keys in the source shapes named above become rows. Computed names and
whole-environment quarantine/pass-through operations have no concrete key to report; adding a new literal
shape or a literal without checked metadata fails generation as `UNCLASSIFIED` rather than being omitted.

## `ZenConfig` schema

The whole-file schema is strict on unknown keys. Nested fields are explicit below. Defaults are consumer
behavior when an optional field is omitted; required fields have no schema default.

| Field | Required | Default when omitted | Reader |
|---|---|---|---|
| `webFetch` | yes | None; omission makes the strict config unreadable. | `packages/harness/extensions/web-fetch/index.ts#createWebFetch` |
| `webFetch.allowedHosts` | yes | None in the schema; the committed policy is shown from `zen.config.json` below. | `packages/harness/extensions/web-fetch/index.ts#createWebFetch` |
| `webSearch` | no | `{}`; current-model routing with no Tavily domain filters. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |
| `webSearch.backend` | no | Current-model routing; only `"deepseek"` pins the dedicated backend. | `packages/harness/extensions/web-search/index.ts#runPrimary` |
| `webSearch.tavily` | no | No Tavily domain filters. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |
| `webSearch.tavily.excludeDomains` | no | Omitted from the Tavily request. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |
| `webSearch.tavily.includeDomains` | no | Omitted from the Tavily request. | `packages/harness/extensions/web-search/index.ts#createWebSearch` |

Committed `webFetch.allowedHosts`: `[]`.

**Parser limit.** The schema reader handles this repository's current `Type.Object` / `Type.Optional`
declaration layout in `config.ts`, `web-fetch.ts`, and `web-search.ts`; metadata and consumer probes must
match every discovered field or generation fails.

## `.zen/` runtime paths

These are every exported path assembled with `ZEN_RUNTIME_DIRECTORY` in `packages/core/src/paths.ts`.

| Path | Assembler | Writer | Lifetime |
|---|---|---|---|
| `.zen/logs` | `zenLogsDir` | `configureProcessLogging` creates it and every harness process appends to the day file. | One file per local day; logging retains 14 days. |
| `.zen/pi-agent` | `zenAgentDir` | The TUI/server launchers create it; pi and `createAgentHost` write settings, auth, sessions, and the multi-account pin. | Machine-local state shared across launches; retained until the operator removes it. |
| `.zen/print-harness` | `printHarnessDir` | `scripts/print-harness.ts#materializePrintHarness` rebuilds the package mirror for non-interactive launches. | Machine-local scratch; reconciled on every print launch. |
| `.zen/secrets.env` | `zenSecretsPath` | Operator only; harness code reads and quarantines but never writes it. | Machine-local until the operator edits or removes it; secret reads are per call. |

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
| skills | 1 | `./skills` | repository path |
| prompts | 1 | `./prompts` | repository path |
| themes | 1 | `./themes` | repository path |
| themes | 2 | `node_modules/@mammothb/pi-tokyonight-storm/themes` | **vendor path** |
