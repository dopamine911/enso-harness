import { LOG_KEEP_DAYS } from '../../../packages/core/src/log-process.ts'

/**
 * The checked metadata `scripts/docs/env-and-config.ts` renders (#170): the prose source cannot
 * supply (purpose, default, phase, writer, lifetime) for every environment read, config field and
 * runtime path its detectors find. Data only — the detectors, the checks and the page are the
 * generator's.
 *
 * ⚠ WHY A MODULE OF ITS OWN (#593). These are inventory tables: one row per finding, every row the
 * same shape with different words. The duplication ratchet (`.fallowrc.jsonc` → `duplicates`)
 * pairs uniform rows as clones, and there is nothing to fold — a row that borrowed another's
 * fields would be wrong. `scripts/docs/inventory/` is excluded from that count by directory, so
 * only tables belong here: a function that does more than build a row stays in the generator,
 * where the ratchet still reads it.
 */

export interface EnvironmentOccurrence {
  readonly key: string
  readonly source: string
}

interface EnvironmentMetadata extends EnvironmentOccurrence {
  readonly reader: string
  readonly purposeAndDefault: string
  readonly phase: 'boot' | 'load' | 'per-call' | 'build' | 'boot / load' | 'boot / load / per-call'
}

/** A CLI that reads the running server (`ENSO_SERVER_URL`): one row per script, one default. */
function serverUrlReader(
  source: string,
  reader: string,
  readFor: string,
  phase: EnvironmentMetadata['phase'] = 'per-call',
): EnvironmentMetadata {
  return {
    key: 'ENSO_SERVER_URL',
    source,
    reader,
    purposeAndDefault: `Optional live-server URL for ${readFor}; defaults to \`http://127.0.0.1:5179\`.`,
    phase,
  }
}

export const ENVIRONMENT_METADATA: readonly EnvironmentMetadata[] = [
  {
    key: 'ENSO_SITE_URL',
    source: 'scripts/docs/site-base.ts',
    reader: '`scripts/docs/site-base.ts#SITE_URL` (module read)',
    purposeAndDefault:
      'Optional; the origin the site is served from, which Astro needs to emit a sitemap — without it `@astrojs/sitemap` skips at WARN and the build still succeeds. Defaults to the unresolvable `https://example.invalid` because a local build has no origin; the publish workflow sets the origin Pages serves the site from (`configure-pages`).',
    phase: 'build',
  },
  {
    key: 'ENSO_SITE_BASE',
    source: 'scripts/docs/site-base.ts',
    reader: '`scripts/docs/site-base.ts#SITE_BASE` (module read)',
    purposeAndDefault:
      'Optional; the path the documentation site is served under. Defaults to `/enso` for a local build. The publish workflow sets it from the Pages configuration (`configure-pages`): `/<repository>` for a project site, empty for a custom domain — derived rather than a literal that rots on a rename or a domain change.',
    phase: 'build',
  },
  {
    key: 'ENSO_E2E_MODEL',
    source: 'packages/web/e2e/e2e-home.ts',
    reader: '`packages/web/e2e/e2e-home.ts#e2eStack` (config load)',
    purposeAndDefault:
      'Optional; `1` selects the browser suite’s `@model` tier, which `bun run e2e:model` sets: the stack keeps the operator’s home and may reuse a running one. Unset, the model-free tier runs over the suite’s own seeded home (#486).',
    phase: 'load',
  },
  {
    key: 'PI_CODING_AGENT_DIR',
    source: 'packages/web/e2e/e2e-home.ts',
    reader: '`packages/web/e2e/e2e-home.ts#seededHome` (process write)',
    purposeAndDefault:
      'Set to the seeded home’s agent directory before the suite writes its stored threads, so pi files them there and never in the operator’s `~/.pi/agent` (#486).',
    phase: 'load',
  },
  {
    key: 'TMPDIR',
    source: 'test/scratch-preload.ts',
    reader: '`test/scratch-preload.ts` (process write, before any test file loads)',
    purposeAndDefault:
      'Set by the test preload to a per-run scratch directory, so every temporary directory a suite or a spawned child makes lands in one place that is removed when the run ends — the suites leaked ~1,000 directories per gate run and filled a tmpfs’s inodes (#546). Never read by Enso itself.',
    phase: 'load',
  },
  {
    key: 'ENSO_HOME',
    source: 'test/scratch-preload.ts',
    reader: '`test/scratch-preload.ts` (process write, before any test file loads)',
    purposeAndDefault:
      'Set by the test preload to a directory under the run’s scratch, so the harness extensions a hosted thread loads in-process — which resolve `ensoHome` from the process environment for the user’s security config and for where a thread’s snapshot store is minted (#551) — never touch the operator’s `~/.enso`. Removed with the scratch when the run ends.',
    phase: 'load',
  },
  {
    key: 'GH_TOKEN',
    source: 'scripts/review/review-pr.ts',
    reader: '`scripts/review/review-pr.ts#reviewPoster` (child environment write)',
    purposeAndDefault:
      "Set only when `~/.config/enso-review/app.json` exists: the review App's one-hour installation token, for this repository only, so the local reviewer's `gh` reads and posts as the App's bot (#981). Absent: the reviewer's `gh` uses the owner's stored login.",
    phase: 'per-call',
  },
  {
    key: 'FORCE_COLOR',
    source: 'scripts/gate.ts',
    reader: '`scripts/gate.ts#runGate` (child environment write)',
    purposeAndDefault: 'Optional; set to `1` only when both gate output streams are TTYs, otherwise not overridden.',
    phase: 'per-call',
  },
  {
    key: 'PI_CODING_AGENT_DIR',
    source: 'packages/web/src/host/agent-host.ts',
    reader: '`packages/web/src/host/agent-host.ts#createAgentHost` (process write)',
    purposeAndDefault:
      'Required pin to the supplied scratch agent directory before pi loads; no fallback at this boundary.',
    phase: 'boot',
  },
  {
    key: 'PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS',
    source: 'packages/web/src/host/agent-host.ts',
    reader: '`packages/web/src/host/agent-host.ts#createAgentHost` (process write)',
    purposeAndDefault:
      'Always `1` in the server: pi-multi-account (≥1.23.2) makes every in-process session an independent root with its own failover, instead of passive after the first (#351). Stays set — the extension reads it per session.',
    phase: 'boot',
  },
  {
    key: 'ENSO_PROJECT_TRUST_BY_HOST',
    source: 'packages/web/src/host/agent-host.ts',
    reader: '`packages/web/src/host/agent-host.ts#createAgentHost` (process write)',
    purposeAndDefault:
      'Always `1` in the server: the host decides project trust, asking before a run (#502), so the harness’s `.enso/config.json` resolution follows pi’s answer (`harness/core/session-config.ts#sessionConfigEnvironment`) instead of asking a second time. Unset in the terminal, where the harness asks its own question.',
    phase: 'boot',
  },
  {
    key: 'ENSO_PROJECTS_DIR',
    source: 'packages/web/src/host/agent-host.ts',
    reader: '`packages/web/src/host/agent-host.ts#createAgentHost` (process write)',
    purposeAndDefault:
      'Set by every host to its `projectsDir`, and removed for a host with none, so the run-context extension snapshots into the stores the host mints and forks from (#586). The host owns the path; the extension no longer re-derives it from `ENSO_HOME`.',
    phase: 'boot',
  },
  {
    key: 'PI_CODING_AGENT_DIR',
    source: 'scripts/enso.ts',
    reader: '`scripts/enso.ts` (pi child environment write)',
    purposeAndDefault: 'Required pin to the selected agent directory in the spawned pi process.',
    phase: 'boot',
  },
  {
    key: 'PI_CODING_AGENT_SESSION_DIR',
    source: 'scripts/enso.ts',
    reader: '`scripts/enso.ts` (pi child environment write)',
    purposeAndDefault:
      'Always set, to the launch directory’s project folder — `ENSO_HOME/projects/<projectIdOf(cwd)>/sessions` — so the terminal and the web surface file and read one project’s threads in one place (#552). Unset, pi would file by encoded cwd under the agent dir.',
    phase: 'boot',
  },
  {
    key: 'PI_CODING_AGENT_DIR',
    source: 'packages/harness/extensions/run-context/index.ts',
    reader: '`packages/harness/extensions/run-context/index.ts` (the default export’s `readPermissionPolicy`)',
    purposeAndDefault:
      'The agent directory both Enso surfaces set, read to find the permission policy the engine reads under it, for the run context’s `mode.rulesHash` (#496). Unset, the mode is `null`.',
    phase: 'per-call',
  },
  {
    key: 'ENSO_PROJECTS_DIR',
    source: 'packages/harness/extensions/run-context/index.ts',
    reader: '`packages/harness/extensions/run-context/index.ts` (the default export’s `openSnapshotStore`)',
    purposeAndDefault:
      'The projects folder the host files trees and stores under, read to open the store each run snapshots into (#586). Unset (the terminal, which has no host), `ENSO_HOME/projects`.',
    phase: 'per-call',
  },
  {
    key: 'ENSO_HOME',
    source: 'packages/core/src/paths.ts',
    reader: '`packages/core/src/paths.ts#ensoHome`',
    purposeAndDefault:
      'Optional user-level Enso directory (#421); an absent or empty value defaults to `~/.enso`. ' +
      "pi's agent dir, the secrets file, the logs and the project list all resolve under it.",
    phase: 'boot / load / per-call',
  },
  {
    key: 'ENSO_LOG_CONSOLE',
    source: 'packages/core/src/log-process.ts',
    reader: '`packages/core/src/log-process.ts#parseEnsoLogLevels`',
    purposeAndDefault:
      'Optional terminal log level; launcher default is `info`, while child-pi logging ' +
      'defaults to no console sink.',
    phase: 'boot / load',
  },
  {
    key: 'ENSO_LOG_LEVEL',
    source: 'packages/core/src/log-process.ts',
    reader: '`packages/core/src/log-process.ts#parseEnsoLogLevels`',
    purposeAndDefault: 'Optional file log level and per-category overrides; defaults to `info`.',
    phase: 'boot / load',
  },
  serverUrlReader('scripts/enso-logs.ts', '`scripts/enso-logs.ts#main` (for `bundle`)', 'bundle retrieval'),
  serverUrlReader('scripts/enso-eval.ts', '`scripts/enso-eval.ts#main`', 'the session eval'),
  serverUrlReader('scripts/enso-incidents.ts', '`scripts/enso-incidents.ts#main`', 'the incident history'),
  serverUrlReader('scripts/enso-judge.ts', '`scripts/enso-judge.ts#main`', 'the command-judge cases and replay'),
  serverUrlReader('scripts/enso-thread.ts', '`scripts/enso-thread.ts`', 'thread inspection', 'boot'),
  {
    key: 'npm_config_user_agent',
    source: 'scripts/gate.ts',
    reader: '`scripts/gate.ts#detectPackageManager`',
    purposeAndDefault: 'Optional package-manager identity; falls back to Bun detection, then `npm`.',
    phase: 'boot',
  },
]

export interface SourceCheck {
  readonly file: string
  readonly contains: string
}

export interface ConfigFieldMetadata {
  readonly field: string
  readonly required: 'yes' | 'no'
  readonly defaultWhenOmitted: string
  readonly reader: string
  readonly check: SourceCheck
}

const WEB_SEARCH_SOURCE = 'packages/harness/extensions/web-search/index.ts'

/** A `webSearch` field: optional, read in the extension's source, proven there by `contains`. */
function webSearchField(
  suffix: string,
  defaultWhenOmitted: string,
  contains: string,
  readerSymbol = 'createWebSearch',
): ConfigFieldMetadata {
  return {
    field: `webSearch${suffix}`,
    required: 'no',
    defaultWhenOmitted,
    reader: `\`${WEB_SEARCH_SOURCE}#${readerSymbol}\``,
    check: { file: WEB_SEARCH_SOURCE, contains },
  }
}

/** What `userJudgeConfig` reads each `security.judge` field by — the docs check it is still there. */
const JUDGE_READS: Readonly<Record<string, string>> = {
  '': 'result.config.security?.judge',
  '.backend': "judge?.backend ?? 'off'",
  '.local': 'judge?.local === undefined',
}

export const CONFIG_FIELD_METADATA: readonly ConfigFieldMetadata[] = [
  {
    field: 'webFetch',
    required: 'no',
    defaultWhenOmitted: 'An empty allowlist: nothing is fetchable.',
    reader: '`packages/harness/extensions/web-fetch/index.ts#createWebFetch`',
    check: {
      file: 'packages/harness/extensions/web-fetch/index.ts',
      contains: 'result.config.webFetch?.allowedHosts ?? []',
    },
  },
  {
    field: 'webFetch.allowedHosts',
    required: 'yes',
    defaultWhenOmitted: 'n/a — required once `webFetch` is present; `[]` fetches nothing.',
    reader: '`packages/harness/extensions/web-fetch/index.ts#createWebFetch`',
    check: {
      file: 'packages/harness/extensions/web-fetch/index.ts',
      contains: 'result.config.webFetch?.allowedHosts ?? []',
    },
  },
  {
    field: 'projects',
    required: 'no',
    defaultWhenOmitted:
      'No roots, no fence (#866): a page may add any folder the standing refusals allow — never the home folder or one holding it, never `ENSO_HOME` or anything under it, and no hidden folder unless the person shows them.',
    reader:
      '`packages/web/src/server/dev.ts` → `startEnsoServer({ projectRoots })` → `packages/web/src/server/projects.ts#createProjectRegistry`',
    // The fence's own guard, not the read: a change to what "no roots" means must fail this probe.
    check: { file: 'packages/web/src/server/projects.ts', contains: 'if (roots.length > 0) return refusalUnderRoots(' },
  },
  {
    field: 'projects.roots',
    required: 'yes',
    defaultWhenOmitted:
      'n/a — absolute or `~/` paths; a page may register a project only strictly under one (#395), and a root taken out hides the projects under it',
    reader: '`packages/web/src/server/projects.ts#createProjectRegistry`',
    check: {
      file: 'packages/web/src/server/projects.ts',
      contains: 'is not an absolute or ~/ path — fix ${configPath}',
    },
  },
  {
    field: 'threads',
    required: 'no',
    defaultWhenOmitted:
      'A worktree for every new thread (#551 decision 1): a git worktree on branch `enso/<thread-id>` when the project is a repository\'s top level, else a copy — each one adds a worktree registration and that branch to the repository until the thread is deleted (#571). `tree` sets the mode (`"worktree"`, `"copy"`, or `"off"`: threads run in the checkout, with nothing to restore files to); `projects`, in the user\'s file only, maps a project path (absolute or `~/`, resolved to the canonical path) to its own mode, which beats `tree`. A tree holds no ignored file (`node_modules`, `.env`): `copy` lists the project\'s paths (files or directories, relative to it, never leaving it) copied into a new tree, and `setup` the commands then run in it with `sh -c`, in order, each for at most 10 minutes, stopping at the first failure; the outcome is recorded on the thread, which opens either way (#754). Default: no copy, no setup. Tiered per project (#754): `<project>/.enso/config.local.json` > `<project>/.enso/config.json` > this file > the default, each key\'s whole value from one tier (a list replaces, never extends); the project\'s own files are read only once the project is trusted, fresh for each new tree.',
    reader:
      '`packages/core/src/project-config.ts#readProjectThreadSettings`, from `packages/web/src/host/agent-host.ts`',
    check: {
      file: 'packages/core/src/project-config.ts',
      contains: "tree: highest(layers, 'tree') ?? { value: 'worktree', tier: 'default' }",
    },
  },
  webSearchField('', '`{}`; current-model routing with no Tavily domain filters.', 'parsed.config.webSearch ?? {}'),
  webSearchField(
    '.backend',
    'Current-model routing; only `"deepseek"` pins the dedicated backend.',
    "webSearchConfig.backend === 'deepseek'",
    'runPrimary',
  ),
  webSearchField('.tavily', 'No Tavily domain filters.', 'webSearchConfig.tavily?.includeDomains'),
  webSearchField(
    '.tavily.excludeDomains',
    'Omitted from the Tavily request.',
    'webSearchConfig.tavily?.excludeDomains',
  ),
  webSearchField(
    '.tavily.includeDomains',
    'Omitted from the Tavily request.',
    'webSearchConfig.tavily?.includeDomains',
  ),
  {
    field: 'claudeCode',
    required: 'no',
    defaultWhenOmitted:
      'A Claude login claims pi’s own Claude Code version: conversations send pi’s, and the web search sends the same one. User-only: a trusted project’s `claudeCode` is ignored with a notice (#925).',
    reader: `\`${WEB_SEARCH_SOURCE}#createWebSearch\``,
    check: { file: WEB_SEARCH_SOURCE, contains: 'parsed.config.claudeCode?.version' },
  },
  {
    field: 'claudeCode.version',
    required: 'yes',
    defaultWhenOmitted:
      'n/a — required once `claudeCode` is present: a version as Anthropic writes them (`"2.1.284"`). It is the `claude-cli/<version>` user-agent of every request made with a Claude login (OAuth), the conversation’s and the web search’s alike; an API key’s requests claim none. Set it when Anthropic refuses a request as `claude_code_version_too_old` before pi has caught up: the refusal names the version it requires. New sessions use it (#925).',
    reader: `\`${WEB_SEARCH_SOURCE}#claimClaudeCodeVersion\``,
    check: { file: WEB_SEARCH_SOURCE, contains: "headers['user-agent'] = claudeCodeUserAgent(version)" },
  },
  incidentField('', 'Incidents alert and suspend nothing; the default risk thresholds.', 'security?.incidents'),
  incidentField(
    '.incidents',
    'As above. A trusted project’s approved `.enso/config.json` may only tighten it — halting on, a threshold reached sooner, a wider window — and what would loosen it is ignored with a notice (#753).',
    'security?.incidents',
  ),
  incidentField(
    '.incidents.halt',
    '`false`: an incident opens as an alert and suspends nothing (#466).',
    'halt: incidents?.halt ?? false',
  ),
  incidentField(
    '.incidents.windowCalls',
    '`8` calls back.',
    'incidents?.windowCalls ?? DEFAULT_RISK_THRESHOLDS.windowCalls',
  ),
  incidentField(
    '.incidents.highAtSignals',
    '`3` signals for `high`.',
    'incidents?.highAtSignals ?? DEFAULT_RISK_THRESHOLDS.highAtSignals',
  ),
  incidentField(
    '.incidents.highAtKinds',
    '`2` distinct kinds for `high`.',
    'incidents?.highAtKinds ?? DEFAULT_RISK_THRESHOLDS.highAtKinds',
  ),
  incidentField(
    '.incidents.incidentAtSignals',
    '`5` signals for `incident`.',
    'incidents?.incidentAtSignals ?? DEFAULT_RISK_THRESHOLDS.incidentAtSignals',
  ),
  judgeField('', 'The judge is off: nothing is sent.'),
  judgeField(
    '.backend',
    '`"off"`: nothing is sent (#469). `"jev"` sends each in-scope `bash` call, redacted, to TypeSafe; `"local"` asks the llama.cpp model `security.judge.local` names, on this machine (#532). Recorded only. An unreadable `config.json` leaves it off.',
  ),
  judgeField(
    '.local',
    'None. Required by `"local"`, which is off without it: `{ "baseUrl", "model" }` — a llama.cpp router on a loopback address (anything else is sent nothing) and the model it asks.',
  ),
]

/**
 * A `security` field (#466): optional, read by `incidentPolicyOf`, which the guard (at each session
 * start) and the server (for the replayed risk) both call — so the live level and the replay agree.
 */
function incidentField(suffix: string, defaultWhenOmitted: string, contains: string): ConfigFieldMetadata {
  return {
    field: `security${suffix}`,
    required: 'no',
    defaultWhenOmitted,
    reader: '`packages/core/src/session-incident.ts#incidentPolicyOf`',
    check: { file: 'packages/core/src/session-incident.ts', contains },
  }
}

/**
 * A `security.judge` field (#469): optional and user-only, read by `userJudgeConfig` at each
 * session start; anything but a readable `"jev"`, or `"local"` with its router, is off.
 */
function judgeField(suffix: string, defaultWhenOmitted: string): ConfigFieldMetadata {
  return {
    field: `security.judge${suffix}`,
    required: 'no',
    defaultWhenOmitted,
    reader: '`packages/harness/core/session-config.ts#userJudgeConfig`',
    check: { file: 'packages/harness/core/session-config.ts', contains: JUDGE_READS[suffix] ?? suffix },
  }
}

export interface RuntimePathMetadata {
  readonly helper: string
  readonly path: string
  readonly writer: string
  readonly lifetime: string
  readonly check: SourceCheck
}

export const RUNTIME_PATH_METADATA: readonly RuntimePathMetadata[] = [
  {
    helper: 'printHarnessDir',
    path: 'node_modules/.cache/enso/print-harness',
    writer:
      '`scripts/print-harness.ts#materializePrintHarness` rebuilds the package mirror ' +
      'for non-interactive launches.',
    lifetime: 'Per-checkout build cache (its links point into this checkout); reconciled on every print launch.',
    check: { file: 'scripts/print-harness.ts', contains: 'export function materializePrintHarness' },
  },
  {
    helper: 'ensoAgentDir',
    path: 'ENSO_HOME/pi-agent',
    writer:
      'The TUI/server launchers create it; pi and `createAgentHost` write settings, auth, ' +
      'sessions, and the multi-account seed.',
    lifetime: 'Per-user state shared by every checkout and launch; retained until the operator removes it.',
    check: {
      file: 'packages/web/src/host/agent-host.ts',
      contains: 'seedMultiAccountConfig(agentDir)',
    },
  },
  {
    helper: 'ensoPermissionRulesPath',
    path: 'ENSO_HOME/permissions.json',
    writer:
      'The operator; `preparePermissionPolicy` seeds it with Enso’s default policy before pi loads, when it is absent or holds no `permission` block, and replaces an old-format rules file (kept beside it as `.picc-backup`, #496). It links the permission engine’s config path under the agent dir to this file and rewrites the mode agents (`agents/enso-mode-*.md`) at every launch. An unreadable file refuses the launch.',
    lifetime:
      'Per-user until the operator edits it; the permission engine re-reads it when it changes, so an edit applies to running sessions too.',
    check: { file: 'packages/core/src/permission-rules.ts', contains: 'linkEngineConfig(agentDir, policyPath)' },
  },
  {
    helper: 'ensoLogsDir',
    path: 'ENSO_HOME/logs',
    writer: '`configureProcessLogging` creates it and every harness process appends to the day file.',
    lifetime: `One file per local day; logging retains ${LOG_KEEP_DAYS} days.`,
    check: { file: 'packages/core/src/log-process.ts', contains: 'maxAgeMs: LOG_KEEP_DAYS * DAY_MS' },
  },
  {
    helper: 'ensoProjectsPath',
    path: 'ENSO_HOME/projects.json',
    writer: 'The web server, when a page registers or removes a project (#395); written whole and renamed over.',
    lifetime: 'Per-user until a project is removed; entries outside the configured roots are kept but not served.',
    check: { file: 'packages/web/src/server/projects.ts', contains: 'renameSync(staging, statePath)' },
  },
  {
    helper: 'ensoProjectsDir',
    path: 'ENSO_HOME/projects',
    writer:
      'One folder per project, named by `projectIdOf` (sixteen hex digits of the real path’s SHA-256; `projects.json` is the only id↔path map). Under it, `sessions/` holds the project’s thread logs — pi’s session files (#552): the web host and `bun run enso` both file there (`PI_CODING_AGENT_SESSION_DIR`), and a launch first moves the sessions pi filed by encoded cwd under the agent dir into their folders, never over an existing file. `snapshots/<thread-id>` is one thread’s snapshot store (#551): a bare repository the `run-context` extension writes at every run start through `@enso/core/snapshot-store` — the tree’s tracked set and unignored untracked files, never a force-add — its objects in the project’s object store `snapshots/.objects`, which owns them all, so the checkout’s own `git gc` cannot take one (#573); a mint copies there the blobs of the checkout’s index it seeds from. `trees/<name>` is one thread’s tree, its cwd (#551), where trees are on: a worktree on `enso/<thread-id>` or a copy, minted by the web host at a new thread’s first run (named by its id) and at each fork (a fresh id; its `enso-thread-tree` entry names it).',
    lifetime:
      'Per-user; a moved checkout changes its id, so its threads stay under the old one until moved by hand. Deleting a thread (#571) removes its tree after an inventory and its store, then collects the object store (#573): what only that thread’s snapshots reached goes, a fork’s history stays. Trust (`pi-agent/trust.json`) and the checkout’s `.enso/config.json` stay where they are.',
    check: { file: 'packages/core/src/paths.ts', contains: 'export function migrateSessionsIntoProjects' },
  },
  {
    helper: 'ensoPromptsDir',
    path: 'ENSO_HOME/prompts',
    writer:
      'The web server, when a page writes or deletes a library prompt (#443) — one `<id>.md` per prompt, written whole under the precondition the request states (a create is linked into place and never lands on a file there; a replace or delete lands only on the version read, by its ETag); the operator may edit the files directly.',
    lifetime: 'Per-user until a prompt is deleted; a thread that ran one keeps the text its log recorded.',
    check: { file: 'packages/web/src/server/prompt-library.ts', contains: 'renameSync(staging, path)' },
  },
  {
    helper: 'ensoSecretsPath',
    path: 'ENSO_HOME/secrets.env',
    writer: 'Operator only; harness code reads and quarantines but never writes it.',
    lifetime: 'Per-user until the operator edits or removes it; secret reads are per call.',
    check: { file: 'packages/core/src/secrets.ts', contains: 'readDotenvFile(ensoSecretsPath(home)).get(name)' },
  },
]
