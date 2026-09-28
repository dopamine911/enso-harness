import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { ENSO_RUN_CONTEXT_ENTRY, type EnsoConfigParseResult, type EnsoRunContext } from '@enso/core'
import { ensoHome } from '@enso/core/paths'
import { type SessionConfigContext, type SessionEnsoConfig, sessionEnsoConfig } from '../../core/index.ts'

/**
 * The run-context recorder (#435, Lineage #126): at every run start, what the run starts under —
 * git revision and dirty state, the resolved config's hash and files, the skills, the context
 * files' hashes, the permission mode's rule-set hash — appended to pi's log as an
 * `enso-run-context` entry (`@enso/core` `run-context.ts`) ONLY when a field differs from the last
 * one on the branch. Never per turn; a fork inherits the entries on its path, so its first run
 * appends only what changed.
 *
 * ⚠ LOADED LAST (`package.json` `pi.extensions`). `before_agent_start` handlers run in load order
 * and may change the prompt's skills and context files (`systemPromptOptions` is mutable); the
 * last handler sees what the model will receive. Written by an extension rather than the host so
 * the TUI records it too, and because the two sources live here: the config is resolved per
 * session in the harness (`session-config.ts`, shared by key with web_fetch and web_search — the
 * same resolution, never a second one), and the skills and context files arrive on the event.
 *
 * ⚠ GIT IN THE SESSION'S CWD, NOT THE ENVIRONMENT'S REPOSITORY. git honours an inherited
 * `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` over its working directory, and git exports them to
 * every hook — so a server started from a hook's shell would record the hook's repository for every
 * session. The probe runs through `node:child_process` with git's repository-locating variables
 * removed (`pi.exec` takes no environment); found under a worktree's pre-commit gate.
 *
 * ⚠ HASHES ONLY. No file body and no config value is written — a context file is its path and
 * sha256, the config a sha256 of the resolved value with keys sorted.
 *
 * The mode's rules are picc's: it persists them, with the mode name, as its `modes` custom entry
 * (`persistState`). This reads the last one on the branch — picc's own `restoreState` rule — and
 * hashes the rule set; the name stays picc's record, read beside this one. The fields are read by
 * name, not validated against picc's type (PR #440 review): an entry carrying none of them — picc
 * renamed its shape — records the mode as unknown (`null`), never a constant hash of nothing that
 * would stop noticing rule changes. The real-harness test in `agent-host.test.ts` loads picc and
 * asserts a hash is recorded, so a rename goes red there.
 */

/** The `customType` picc persists its mode and rules under. */
const PICC_MODES_ENTRY = 'modes'
/** How long one git query may take before the revision is recorded as unknown (no repository). */
const GIT_TIMEOUT_MS = 5000

export interface RunContextDependencies {
  /** The session's config — the one resolution per session (`session-config.ts`). */
  resolveSessionConfig: (session: object, context: Omit<SessionConfigContext, 'home'>) => Promise<SessionEnsoConfig>
  /** Run git in `cwd` — never in a repository an inherited environment names. */
  runGit: (args: string[], cwd: string) => Promise<GitResult>
}

/** What a git query answered. */
export interface GitResult {
  readonly code: number
  readonly stdout: string
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** JSON with every object's keys sorted, so equal values hash equal whatever order built them. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      // Keys of one object are distinct: never equal.
      .sort(([first], [second]) => (first < second ? -1 : 1))
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function gitState(dependencies: RunContextDependencies, cwd: string): Promise<EnsoRunContext['git']> {
  const head = await dependencies.runGit(['rev-parse', 'HEAD'], cwd)
  const revision = head.stdout.trim()
  if (head.code !== 0 || revision === '') return null
  const status = await dependencies.runGit(['status', '--porcelain'], cwd)
  return { revision, dirty: status.code !== 0 || status.stdout.trim() !== '' }
}

/**
 * git's repository-locating variables (`git rev-parse --local-env-vars`). ⚠ Dropped from the
 * child's environment: an inherited `GIT_DIR` — a git hook exports one, and so does anything run
 * from inside one — overrides `cwd`, and git would report THAT repository as the session's.
 * Found when the gate ran under a worktree's pre-commit hook.
 */
const GIT_LOCAL_VARIABLES: Record<string, true> = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: true,
  GIT_CONFIG: true,
  GIT_CONFIG_PARAMETERS: true,
  GIT_CONFIG_COUNT: true,
  GIT_OBJECT_DIRECTORY: true,
  GIT_DIR: true,
  GIT_WORK_TREE: true,
  GIT_IMPLICIT_WORK_TREE: true,
  GIT_GRAFT_FILE: true,
  GIT_INDEX_FILE: true,
  GIT_NO_REPLACE_OBJECTS: true,
  GIT_REPLACE_REF_BASE: true,
  GIT_PREFIX: true,
  GIT_SHALLOW_FILE: true,
  GIT_COMMON_DIR: true,
}

/**
 * git in `cwd`, under `environment` without its repository-locating variables; a failure to run is
 * a non-zero code. Exported as the test seam: a test hands in an environment, never the process's.
 */
export function runGitIn(environment: NodeJS.ProcessEnv, args: string[], cwd: string): Promise<GitResult> {
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => GIT_LOCAL_VARIABLES[name] !== true))
  const { promise, resolve } = Promise.withResolvers<GitResult>()
  execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
    resolve({ code: error === null ? 0 : 1, stdout })
  })
  return promise
}

/** A resolution that failed outright (a bad trust store) is recorded as unreadable, with why. */
async function resolvedConfig(
  dependencies: RunContextDependencies,
  context: ExtensionContext,
): Promise<{ result: EnsoConfigParseResult; sources: string[] }> {
  try {
    const resolved = await dependencies.resolveSessionConfig(context.sessionManager, context)
    return { result: resolved.result, sources: [...resolved.sources] }
  } catch (error: unknown) {
    return { result: { kind: 'unreadable', reason: String(error) }, sources: [] }
  }
}

/** The branch's last entry of `customType`, root to leaf. */
function lastCustomData(branch: readonly unknown[], customType: string): unknown {
  for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = branch[entryIndex] as { type?: unknown; customType?: unknown; data?: unknown } | undefined
    if (entry?.type === 'custom' && entry.customType === customType) return entry.data
  }
  return undefined
}

/** The persisted rule fields of picc's `modes` entry (`ModesPersistedEntry`), in the order they are hashed. */
const PICC_RULE_FIELDS = [
  'alwaysAllowRules',
  'alwaysDenyRules',
  'alwaysAskRules',
  'additionalWorkingDirectories',
] as const

function modeRules(branch: readonly unknown[]): EnsoRunContext['mode'] {
  const data = lastCustomData(branch, PICC_MODES_ENTRY)
  if (typeof data !== 'object' || data === null) return null
  const persisted = data as Record<string, unknown>
  if (PICC_RULE_FIELDS.every((field) => persisted[field] === undefined)) return null
  const rules = Object.fromEntries(PICC_RULE_FIELDS.map((field) => [field, persisted[field] ?? null]))
  return { rulesHash: sha256(canonicalJson(rules)) }
}

/**
 * Code-point order, as `canonicalJson` orders keys (PR #440 review): `localeCompare` collates under
 * the process's locale, and the TUI and the web server may write one session file under different
 * `LANG`s — a spurious entry each time the surface changed.
 */
function byCodePoint(first: string, second: string): number {
  if (first < second) return -1
  return first > second ? 1 : 0
}

async function runContextOf(
  dependencies: RunContextDependencies,
  event: BeforeAgentStartEvent,
  context: ExtensionContext,
): Promise<EnsoRunContext> {
  const [git, config] = await Promise.all([gitState(dependencies, context.cwd), resolvedConfig(dependencies, context)])
  const skills = event.systemPromptOptions.skills
    .map((skill) => ({ name: skill.name, path: skill.filePath }))
    .sort((first, second) => byCodePoint(first.name, second.name) || byCodePoint(first.path, second.path))
  return {
    git,
    config: { hash: sha256(canonicalJson(config.result)), sources: config.sources },
    skills,
    contextFiles: event.systemPromptOptions.contextFiles.map((file) => ({
      path: file.path,
      sha256: sha256(file.content),
    })),
    mode: modeRules(context.sessionManager.getBranch()),
  }
}

/** The run-context recorder, over its dependencies; the default export wires the real ones. */
export function createRunContext(dependencies: RunContextDependencies): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    pi.on('before_agent_start', async (event, context) => {
      const current = await runContextOf(dependencies, event, context)
      // Compared RAW, not through the reader's schema (PR #440 review): a record this writer made
      // that the schema rejects would otherwise read as absent and be appended again every run.
      const last = lastCustomData(context.sessionManager.getBranch(), ENSO_RUN_CONTEXT_ENTRY)
      if (last !== undefined && canonicalJson(last) === canonicalJson(current)) return
      pi.appendEntry(ENSO_RUN_CONTEXT_ENTRY, current)
    })
  }
}

/**
 * The pi entry point — the session's config in `ENSO_HOME` (#421), whichever surface loads this;
 * git run through `node:child_process` rather than `pi.exec`, which takes no environment, so the
 * inherited repository-locating variables can be dropped (`GIT_LOCAL_VARIABLES`). Read per call:
 * the environment at the run, not at load.
 */
export default createRunContext({
  resolveSessionConfig: (session, context) => sessionEnsoConfig(session, { ...context, home: ensoHome(process.env) }),
  runGit: (args, cwd) => runGitIn(process.env, args, cwd),
})
