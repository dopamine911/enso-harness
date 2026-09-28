import { createHash } from 'node:crypto'
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { ENSO_RUN_CONTEXT_ENTRY, type EnsoConfigParseResult, type EnsoRunContext, readEnsoRunContext } from '@enso/core'
import { ensoHome } from '@enso/core/paths'
import {
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionConfigSources,
  sessionEnsoConfig,
} from '../../core/index.ts'

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
 * ⚠ HASHES ONLY. No file body and no config value is written — a context file is its path and
 * sha256, the config a sha256 of the resolved value with keys sorted.
 *
 * The mode's rules are picc's: it persists them, with the mode name, as its `modes` custom entry
 * (`persistState`). This reads the last one on the branch — picc's own `restoreState` rule — and
 * hashes the rule set; the name stays picc's record, read beside this one.
 */

/** The `customType` picc persists its mode and rules under. */
const PICC_MODES_ENTRY = 'modes'
/** How long one git query may take before the revision is recorded as unknown (no repository). */
const GIT_TIMEOUT_MS = 5000

export interface RunContextDependencies {
  /** The session's config — the one resolution per session (`session-config.ts`). */
  resolveSessionConfig: (session: object, context: Omit<SessionConfigContext, 'home'>) => Promise<SessionEnsoConfig>
  /** The config files that resolution read. */
  configSources: (cwd: string, resolved: SessionEnsoConfig) => string[]
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

async function gitState(pi: ExtensionAPI, cwd: string): Promise<EnsoRunContext['git']> {
  const options = { cwd, timeout: GIT_TIMEOUT_MS }
  const head = await pi.exec('git', ['rev-parse', 'HEAD'], options)
  const revision = head.stdout.trim()
  if (head.code !== 0 || revision === '') return null
  const status = await pi.exec('git', ['status', '--porcelain'], options)
  return { revision, dirty: status.code !== 0 || status.stdout.trim() !== '' }
}

/** A resolution that failed outright (a bad trust store) is recorded as unreadable, with why. */
async function resolvedConfig(
  dependencies: RunContextDependencies,
  context: ExtensionContext,
): Promise<{ result: EnsoConfigParseResult; sources: string[] }> {
  try {
    const resolved = await dependencies.resolveSessionConfig(context.sessionManager, context)
    return { result: resolved.result, sources: dependencies.configSources(context.cwd, resolved) }
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

function modeRules(branch: readonly unknown[]): EnsoRunContext['mode'] {
  const data = lastCustomData(branch, PICC_MODES_ENTRY)
  if (typeof data !== 'object' || data === null) return null
  const persisted = data as Record<string, unknown>
  const rules = {
    alwaysAllowRules: persisted.alwaysAllowRules ?? null,
    alwaysDenyRules: persisted.alwaysDenyRules ?? null,
    alwaysAskRules: persisted.alwaysAskRules ?? null,
    additionalWorkingDirectories: persisted.additionalWorkingDirectories ?? null,
  }
  return { rulesHash: sha256(canonicalJson(rules)) }
}

async function runContextOf(
  pi: ExtensionAPI,
  dependencies: RunContextDependencies,
  event: BeforeAgentStartEvent,
  context: ExtensionContext,
): Promise<EnsoRunContext> {
  const [git, config] = await Promise.all([gitState(pi, context.cwd), resolvedConfig(dependencies, context)])
  const skills = event.systemPromptOptions.skills
    .map((skill) => ({ name: skill.name, path: skill.filePath }))
    .sort((first, second) =>
      first.name === second.name ? first.path.localeCompare(second.path) : first.name.localeCompare(second.name),
    )
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

/** The run-context recorder, over its two dependencies; the default export wires the real ones. */
export function createRunContext(dependencies: RunContextDependencies): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    pi.on('before_agent_start', async (event, context) => {
      const current = await runContextOf(pi, dependencies, event, context)
      const last = lastCustomData(context.sessionManager.getBranch(), ENSO_RUN_CONTEXT_ENTRY)
      const recorded = last === undefined ? undefined : readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, last)
      if (recorded !== undefined && canonicalJson(recorded) === canonicalJson(current)) return
      pi.appendEntry(ENSO_RUN_CONTEXT_ENTRY, current)
    })
  }
}

/** The pi entry point — the session's config in `ENSO_HOME` (#421), whichever surface loads this. */
export default createRunContext({
  resolveSessionConfig: (session, context) => sessionEnsoConfig(session, { ...context, home: ensoHome(process.env) }),
  configSources: (cwd, resolved) => sessionConfigSources(ensoHome(process.env), cwd, resolved),
})
