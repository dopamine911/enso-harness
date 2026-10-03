import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { LOG_KEEP_DAYS } from '../../packages/core/src/log-process.ts'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { PROCESS_ENVIRONMENT_READERS } from '../lint/process-environment.ts'
import { filesUnder } from '../source-tree.ts'
import { runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/env-and-config.md` (#170): the explicit environment boundary,
 * the composed `EnsoConfig` shape, every `.enso/` path assembled by core, and the harness
 * manifest resources. Small source-shape parsers keep the inventory tied to the declarations;
 * the prose that source cannot supply (purpose, default, phase, writer, lifetime) is checked
 * metadata whose source occurrence must still exist.
 *
 * Blind spots, named: `isCommentedAt` is line-local and sees a `//` anywhere earlier on the
 * line as a comment, so a `process.env` read after a string containing `//` on the same line
 * would be skipped — no such line exists, and a skipped read shows up as "metadata without a
 * read" rather than vanishing; `NON_CODE` masks flat strings only, so a template with a nested
 * `${…}` string is unmasked and fails the field check instead of parsing wrong.
 */

const ROOT = findRepoRoot(import.meta.url)
const SOURCE_ROOTS = ['packages', 'scripts', 'test'] as const
const PROCESS_ENV_BASE = /\bprocess\s*\.\s*env\b/g
/**
 * `{ ...process.env, KEY: value, … }`: the whole override, so every key it sets is found, not only
 * the first. ⚠ FLAT overrides only, as every one in the tree is: a value that is itself an object
 * literal stops `[^{}]*`, the override is not matched, and its keys are not found. A key the
 * metadata lists is then reported as "without a read"; a new, unlisted one is missed.
 */
const PROCESS_ENV_CHILD_OVERRIDE = /\{\s*\.\.\.\s*process\s*\.\s*env\s*,([^{}]*)\}/g
const OVERRIDE_KEY = /([A-Za-z_$][\w$]*)\s*:/g
/** A runtime path helper: a file under `ENSO_HOME` (#421), or the checkout's own build cache under `node_modules`. */
const RUNTIME_PATH_EXPORT =
  /export function (\w+)[^{]+\{\s*return join\((home|repoRoot, 'node_modules'), ((?:'[^']+'(?:, )?)+)\)\s*\}/g
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

interface EnvironmentOccurrence {
  readonly key: string
  readonly source: string
}

interface EnvironmentScan {
  readonly occurrences: EnvironmentOccurrence[]
  readonly directFiles: string[]
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

const ENVIRONMENT_METADATA: readonly EnvironmentMetadata[] = [
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
  serverUrlReader('scripts/enso-logs.ts', '`scripts/enso-logs.ts#bundle`', 'bundle retrieval'),
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

interface SourceCheck {
  readonly file: string
  readonly contains: string
}

interface ConfigFieldMetadata {
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

const CONFIG_FIELD_METADATA: readonly ConfigFieldMetadata[] = [
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
    defaultWhenOmitted: 'No roots: the launch directory is the only project, and registering another is refused.',
    reader: '`packages/web/src/server/dev.ts` → `startEnsoServer({ projectRoots })`',
    check: { file: 'packages/web/src/server/dev.ts', contains: 'config.config.projects?.roots ?? []' },
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
      'A worktree for every new thread (#551 decision 1): a git worktree on branch `enso/<thread-id>` when the project is a repository\'s top level, else a copy — each one adds a worktree registration and that branch to the repository until the thread is deleted (#571). `tree` sets every project\'s mode (`"worktree"`, `"copy"`, or `"off"`: threads run in the checkout, with nothing to restore files to); `projects` maps a project path (absolute or `~/`, resolved to the canonical path) to its own mode, which beats `tree`. A tree holds no ignored file (`node_modules`, `.env`), so a build may need its install step first. User-only: a project\'s `threads` is ignored, and said.',
    reader: '`packages/core/src/config.ts#threadTreeFor`, from `packages/web/src/server/dev.ts`',
    check: {
      file: 'packages/core/src/config.ts',
      contains: "return own ?? config.threads?.tree ?? 'worktree'",
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
  incidentField('', 'Incidents alert and suspend nothing; the default risk thresholds.', 'security?.incidents'),
  incidentField(
    '.incidents',
    'As above. User-only: a trusted project’s `security` is ignored with a notice.',
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

interface RuntimePathMetadata {
  readonly helper: string
  readonly path: string
  readonly writer: string
  readonly lifetime: string
  readonly check: SourceCheck
}

const RUNTIME_PATH_METADATA: readonly RuntimePathMetadata[] = [
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

/**
 * Enough lexical masking for the current TypeBox declarations: comments and flat strings.
 * Nested template expressions are outside the declared parser shape and fail field checks.
 */
const NON_CODE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g

function addOccurrence(found: Map<string, EnvironmentOccurrence>, key: string, source: string): void {
  if (!IDENTIFIER.test(key)) return
  found.set(`${key}\0${source}`, { key, source })
}

function scanObjectReads(
  sourceText: string,
  objectName: string,
  source: string,
  found: Map<string, EnvironmentOccurrence>,
): void {
  const dot = new RegExp(`(?<![\\w$.])${objectName}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
  for (const match of sourceText.matchAll(dot)) {
    if (isCommentedAt(sourceText, match.index ?? 0)) continue
    addOccurrence(found, match[1] ?? '', source)
  }
  const bracket = new RegExp(`(?<![\\w$.])${objectName}\\s*\\[\\s*(['"])([A-Za-z_$][\\w$]*)\\1\\s*\\]`, 'g')
  for (const match of sourceText.matchAll(bracket)) {
    if (isCommentedAt(sourceText, match.index ?? 0)) continue
    addOccurrence(found, match[2] ?? '', source)
  }
  const destructuring = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${objectName}\\b`, 'g')
  for (const match of sourceText.matchAll(destructuring)) {
    const objectIndex = (match.index ?? 0) + match[0].lastIndexOf(objectName)
    if (isCommentedAt(sourceText, objectIndex)) continue
    for (const property of (match[1] ?? '').split(',')) {
      addOccurrence(found, property.split(':')[0]?.trim() ?? '', source)
    }
  }
}

function importedEnvironmentAliases(sourceText: string): string[] {
  const aliases: string[] = []
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*(['"])node:process\2/g
  for (const match of sourceText.matchAll(importPattern)) {
    if (isCommentedAt(sourceText, match.index ?? 0)) continue
    for (const specifier of (match[1] ?? '').split(',')) {
      const imported = /^\s*env(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier)
      if (imported) aliases.push(imported[1] ?? 'env')
    }
  }
  return aliases
}

/** Current source shapes put environment mentions in ordinary comments, never regex-generated code. */
function isCommentedAt(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index) + 1
  if (source.slice(lineStart, index).includes('//')) return true
  return source.lastIndexOf('/*', index) > source.lastIndexOf('*/', index)
}

function scanEnvironment(): EnvironmentScan {
  const found = new Map<string, EnvironmentOccurrence>()
  const directFiles = new Set<string>()
  const files = SOURCE_ROOTS.flatMap((sourceRoot) => filesUnder(join(ROOT, sourceRoot))).sort()
  for (const path of files) {
    const source = relative(ROOT, path).replaceAll('\\', '/')
    const sourceText = readFileSync(path, 'utf8')
    if (scanProcessEnvironmentReads(sourceText, source, found)) directFiles.add(source)
    for (const alias of importedEnvironmentAliases(sourceText)) {
      directFiles.add(source)
      scanObjectReads(sourceText, alias, source, found)
    }
    const isTestSource = source.includes('/__tests__/') || source.startsWith('test/')
    const declaresEnvironmentSeam = /\benvironment\s*:\s*(?:Readonly<)?Record<string,\s*string\s*\|\s*undefined>/.test(
      sourceText,
    )
    if (!isTestSource && declaresEnvironmentSeam) scanObjectReads(sourceText, 'environment', source, found)
  }
  return {
    occurrences: [...found.values()].sort(
      (left, right) => compareText(left.key, right.key) || compareText(left.source, right.source),
    ),
    directFiles: [...directFiles].sort(),
  }
}

/** Every literal `process.env` read in one file — dot, bracket, destructuring, child-override; true when the file touches it directly. */
function scanProcessEnvironmentReads(
  sourceText: string,
  source: string,
  found: Map<string, EnvironmentOccurrence>,
): boolean {
  const directBases = [...sourceText.matchAll(PROCESS_ENV_BASE)].filter(
    (match) => !isCommentedAt(sourceText, match.index ?? 0),
  )
  for (const base of directBases) {
    const tail = sourceText.slice((base.index ?? 0) + base[0].length)
    const dot = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(tail)
    const bracket = /^\s*\[\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]/.exec(tail)
    addOccurrence(found, dot?.[1] ?? bracket?.[2] ?? '', source)
  }
  const destructuring = /\{([^{}]+)\}\s*=\s*process\s*\.\s*env\b/g
  for (const match of sourceText.matchAll(destructuring)) {
    const processIndex = (match.index ?? 0) + match[0].lastIndexOf('process')
    if (isCommentedAt(sourceText, processIndex)) continue
    for (const property of (match[1] ?? '').split(',')) {
      addOccurrence(found, property.split(':')[0]?.trim() ?? '', source)
    }
  }
  for (const match of sourceText.matchAll(PROCESS_ENV_CHILD_OVERRIDE)) {
    const processIndex = (match.index ?? 0) + match[0].indexOf('process')
    if (isCommentedAt(sourceText, processIndex)) continue
    for (const key of (match[1] ?? '').matchAll(OVERRIDE_KEY)) addOccurrence(found, key[1] ?? '', source)
  }
  return directBases.length > 0
}

function sameRows(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertEnvironmentInventory(scan: EnvironmentScan): void {
  const allowlist = [...PROCESS_ENVIRONMENT_READERS].sort()
  if (!sameRows(scan.directFiles, allowlist)) {
    const detectedOnly = scan.directFiles.filter((file) => !allowlist.includes(file))
    const allowlistOnly = allowlist.filter((file) => !scan.directFiles.includes(file))
    throw new Error(
      `direct environment readers and the process-environment allowlist (scripts/lint/process-environment.ts) diverge; ` +
        `detected only: ${detectedOnly.join(', ') || '(none)'}; ` +
        `allowlist only: ${allowlistOnly.join(', ') || '(none)'}`,
    )
  }
  const discovered = scan.occurrences.map((row) => `${row.key}\0${row.source}`).sort()
  const classified = ENVIRONMENT_METADATA.map((row) => `${row.key}\0${row.source}`).sort()
  if (!sameRows(discovered, classified)) {
    const unclassified = discovered.filter((row) => !classified.includes(row)).map((row) => row.replace('\0', ' @ '))
    const stale = classified.filter((row) => !discovered.includes(row)).map((row) => row.replace('\0', ' @ '))
    throw new Error(
      `environment metadata differs from explicit source reads; ` +
        `UNCLASSIFIED: ${unclassified.join(', ') || '(none)'}; ` +
        `metadata without a read: ${stale.join(', ') || '(none)'}`,
    )
  }
}

function objectDeclaration(source: string, name: string): string {
  const marker = `export const ${name} = Type.Object(`
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`could not find Type.Object declaration ${name}`)
  const mask = source.replaceAll(NON_CODE, (nonCode) => ' '.repeat(nonCode.length))
  const open = source.indexOf('(', start)
  let depth = 0
  for (let characterIndex = open; characterIndex < source.length; characterIndex += 1) {
    if (mask[characterIndex] === '(') depth += 1
    else if (mask[characterIndex] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(start, characterIndex + 1)
    }
  }
  throw new Error(`could not find the end of Type.Object declaration ${name}`)
}

function objectFields(source: string, name: string, prefix = ''): string[] {
  const declaration = objectDeclaration(source, name)
  const matches = [...declaration.matchAll(/^(\s+)([A-Za-z_$][\w$]*):\s*(?:Type\.|[A-Za-z_$][\w$]*)/gm)]
  const minimumIndent = Math.min(...matches.map((match) => (match[1] ?? '').length))
  const parents: { indent: number; name: string }[] = []
  const fields: string[] = []
  for (const match of matches) {
    const indent = (match[1] ?? '').length
    const field = match[2] ?? ''
    while ((parents.at(-1)?.indent ?? -1) >= indent) parents.pop()
    fields.push(`${prefix}${parents.map((parent) => `${parent.name}.`).join('')}${field}`)
    parents.push({ indent, name: field })
  }
  if (!Number.isFinite(minimumIndent)) throw new Error(`${name} declares no fields`)
  return fields
}

function assertSourceCheck(check: SourceCheck): void {
  if (!readFileSync(join(ROOT, check.file), 'utf8').includes(check.contains)) {
    throw new Error(`checked metadata probe missing: ${check.file} must contain ${JSON.stringify(check.contains)}`)
  }
}

function configInventory(): { fields: ConfigFieldMetadata[] } {
  const configSource = readFileSync(join(ROOT, 'packages/core/src/config.ts'), 'utf8')
  const webFetchSource = readFileSync(join(ROOT, 'packages/core/src/web-fetch.ts'), 'utf8')
  const webSearchSource = readFileSync(join(ROOT, 'packages/core/src/web-search.ts'), 'utf8')
  const projectSource = readFileSync(join(ROOT, 'packages/core/src/project.ts'), 'utf8')
  const incidentSource = readFileSync(join(ROOT, 'packages/core/src/session-incident.ts'), 'utf8')
  const judgeSource = readFileSync(join(ROOT, 'packages/core/src/command-judge.ts'), 'utf8')
  const discovered = [
    ...objectFields(configSource, 'EnsoConfig'),
    ...objectFields(webFetchSource, 'WebFetchConfig', 'webFetch.'),
    ...objectFields(webSearchSource, 'WebSearchConfig', 'webSearch.'),
    ...objectFields(projectSource, 'EnsoProjectsConfig', 'projects.'),
    ...objectFields(incidentSource, 'EnsoSecurityConfig', 'security.'),
    ...objectFields(judgeSource, 'EnsoJudgeConfig', 'security.judge.'),
  ].sort()
  const metadata = [...CONFIG_FIELD_METADATA].sort((left, right) => compareText(left.field, right.field))
  const classified = metadata.map((row) => row.field)
  if (!sameRows(discovered, classified)) {
    const unclassified = discovered.filter((field) => !classified.includes(field))
    const stale = classified.filter((field) => !discovered.includes(field))
    throw new Error(
      `EnsoConfig metadata differs from schema; UNCLASSIFIED: ${unclassified.join(', ') || '(none)'}; ` +
        `metadata without a field: ${stale.join(', ') || '(none)'}`,
    )
  }
  for (const row of metadata) assertSourceCheck(row.check)
  return { fields: metadata }
}

function runtimePathInventory(): RuntimePathMetadata[] {
  const pathSource = readFileSync(join(ROOT, 'packages/core/src/paths.ts'), 'utf8')
  const discovered = [...pathSource.matchAll(RUNTIME_PATH_EXPORT)]
    .map((match) => ({
      helper: match[1] ?? '',
      path: `${match[2] === 'home' ? 'ENSO_HOME' : 'node_modules'}/${(match[3] ?? '').replaceAll("'", '').split(', ').join('/')}`,
    }))
    .sort((left, right) => compareText(left.path, right.path))
  const metadata = [...RUNTIME_PATH_METADATA].sort((left, right) => compareText(left.path, right.path))
  if (
    !sameRows(
      discovered.map((row) => `${row.helper}\0${row.path}`),
      metadata.map((row) => `${row.helper}\0${row.path}`),
    )
  ) {
    throw new Error('runtime path metadata differs from the exports assembled in packages/core/src/paths.ts')
  }
  for (const row of metadata) assertSourceCheck(row.check)
  return metadata
}

type ResourceKind = 'extensions' | 'skills' | 'prompts' | 'themes'
const RESOURCE_KINDS: readonly ResourceKind[] = ['extensions', 'skills', 'prompts', 'themes']

interface ManifestResource {
  readonly kind: ResourceKind
  readonly order: number
  readonly path: string
}

function manifestResources(): ManifestResource[] {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'packages/harness/package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('pi' in manifest)) {
    throw new Error('packages/harness/package.json has no pi manifest')
  }
  const pi: unknown = manifest.pi
  if (typeof pi !== 'object' || pi === null) {
    throw new Error('packages/harness/package.json pi manifest is not an object')
  }
  const resources: ManifestResource[] = []
  for (const kind of RESOURCE_KINDS) {
    const paths: unknown = (pi as Record<string, unknown>)[kind]
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new Error(`packages/harness/package.json pi.${kind} must be a string array`)
    }
    for (const [pathIndex, path] of paths.entries()) resources.push({ kind, order: pathIndex + 1, path: String(path) })
  }
  return resources
}

function tableText(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function generate(): string {
  const environment = scanEnvironment()
  assertEnvironmentInventory(environment)
  const config = configInventory()
  const runtimePaths = runtimePathInventory()
  const resources = manifestResources()
  const environmentRows = [...ENVIRONMENT_METADATA]
    .sort((left, right) => compareText(left.key, right.key) || compareText(left.reader, right.reader))
    .map((row) => `| \`${row.key}\` | ${row.reader} | ${tableText(row.purposeAndDefault)} | ${row.phase} |`)
  const configRows = config.fields.map(
    (row) => `| \`${row.field}\` | ${row.required} | ${tableText(row.defaultWhenOmitted)} | ${row.reader} |`,
  )
  const pathRows = runtimePaths.map(
    (row) => `| \`${row.path}\` | \`${row.helper}\` | ${tableText(row.writer)} | ${tableText(row.lifetime)} |`,
  )
  const resourceRows = resources.map((row) => {
    const origin = row.path.startsWith('node_modules/') ? '**vendor path**' : 'repository path'
    return `| ${row.kind} | ${row.order} | \`${row.path}\` | ${origin} |`
  })
  return [
    '<!-- generated: scripts/docs/env-and-config.ts -->',
    '# Environment and configuration reference',
    '',
    'Generated from the owned source roots, `scripts/lint/process-environment.ts`, the core config/path declarations,',
    'and `packages/harness/package.json`. No machine environment and no user config is read.',
    '',
    '## Explicit environment keys',
    '',
    `The ${environment.directFiles.length} files that directly touch the process environment exactly match the`,
    '`node/no-process-env` exception list in `scripts/lint/process-environment.ts`; generation fails if either side gains or loses a file.',
    'Rows cover literal dot access, literal bracket access, destructuring, `node:process` `env` imports,',
    'grounded `environment.KEY` seams, and keys explicitly written beside a process-environment spread.',
    '',
    '| Key | Reader | Purpose, requirement, and default | Phase |',
    '|---|---|---|---|',
    ...environmentRows,
    '',
    '**Parser limit.** Only literal keys in the source shapes named above become rows. Computed names and',
    'whole-environment quarantine/pass-through operations have no concrete key to report; adding a new literal',
    'shape or a literal without checked metadata fails generation as `UNCLASSIFIED` rather than being omitted.',
    '',
    '## `EnsoConfig` schema',
    '',
    "The user's `ENSO_HOME/config.json` (#421). No file at all is every default below. A file that is there is strict",
    'on unknown keys and fails closed when unreadable. Defaults are consumer behavior when an optional field is omitted;',
    'required fields have no schema default.',
    '',
    '| Field | Required | Default when omitted | Reader |',
    '|---|---|---|---|',
    ...configRows,
    '',
    "**Parser limit.** The schema reader handles this repository's current `Type.Object` / `Type.Optional`",
    'declaration layout in `config.ts`, `web-fetch.ts`, and `web-search.ts`; metadata and consumer probes must',
    'match every discovered field or generation fails.',
    '',
    '## Runtime paths',
    '',
    "Every runtime path helper in `packages/core/src/paths.ts`: the user's state under `ENSO_HOME` (`~/.enso` by default, #421), and the checkout's own build cache.",
    '',
    '| Path | Assembler | Writer | Lifetime |',
    '|---|---|---|---|',
    ...pathRows,
    '',
    '## Harness manifest resources',
    '',
    'Generated from the `pi` manifest. Extension order is declaration order and is deliberately not sorted;',
    'the other resource arrays are also shown in declared order. A vendor path is any path rooted at',
    '`node_modules/`; repository paths are package-local.',
    '',
    '| Kind | Declared order | Path | Origin |',
    '|---|---:|---|---|',
    ...resourceRows,
    '',
  ].join('\n')
}

runGenerator('env-and-config', generate)
