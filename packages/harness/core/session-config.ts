import { ENSO_PROJECT_TRUST_BY_HOST, type EnsoConfigParseResult, mergeEnsoConfig, parseEnsoConfig } from '@enso/core'
import { ensoAgentDir, ensoConfigPath, ensoHome, projectConfigPath, readTextIfPresent } from '@enso/core/paths'
import { createProjectTrustStore, defaultProjectTrust, projectTrustOptions } from './project-trust.ts'

/**
 * The config one session runs under (#421): the user's `ENSO_HOME/config.json`, and over it the
 * project's own `<cwd>/.enso/config.json` — read ONLY once the project is trusted, by pi's trust
 * store and rules (`project-trust.ts`), so one answer covers the project's `.pi/` and `.enso/`.
 *
 * pi's order: a saved decision (the project or its nearest ancestor), else `defaultProjectTrust`,
 * else the question — pi's answers, asked on the session's UI; with no UI, untrusted. An untrusted
 * project's config is not read, and the session is told so: skipped, never silently ignored.
 *
 * ⚠ ONE resolution per session, shared by every tool that reads the config: keyed on the
 * session's `sessionManager`, the one object pi's runner hands every extension's context in that
 * session. Two tools resolving on their own would ask the trust question twice. (Not `pi.events`:
 * pi builds that object per EXTENSION — keyed on it, each tool resolved and asked on its own,
 * found live.)
 */

/**
 * What a session's tools read their policy from.
 *
 * @group Project trust
 */
export interface SessionEnsoConfig {
  /** The merged config, or why it could not be read — a caller fails CLOSED on `unreadable`. */
  readonly result: EnsoConfigParseResult
  /** The file a human changes to change this session's policy: the project's, when it was read. */
  readonly path: string
  /**
   * The config files this resolution read, user first; empty when none exists (#435). Recorded
   * here, where the reading happens: the resolution is cached per session, so a probe at record
   * time would name files the cached result never saw (PR #440 review).
   */
  readonly sources: readonly string[]
}

/**
 * The session's context, as pi hands it to `session_start`.
 *
 * @group Project trust
 */
export interface SessionConfigContext {
  readonly home: string
  readonly cwd: string
  readonly hasUI: boolean
  readonly ui: {
    select(title: string, options: string[]): Promise<string | undefined>
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
  /** pi's answer for this session: whether the project's own scope is loaded. */
  isProjectTrusted(): boolean
  /**
   * The web host decides trust (#502): it asks before a run, applies the answer to pi and reloads,
   * so here the project's config follows `isProjectTrusted()` and nothing is asked twice. The
   * terminal has no host: there the question below is Enso's own, as pi's covers only `.pi/`.
   */
  readonly hostOwnsTrust: boolean
}

/**
 * The context's two process-wide parts, read from `environment`: the user's `ENSO_HOME`, and whether
 * the web host owns project trust (it sets {@link ENSO_PROJECT_TRUST_BY_HOST} before its first
 * session).
 *
 * @group Project trust
 */
export function sessionConfigEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Pick<SessionConfigContext, 'home' | 'hostOwnsTrust'> {
  return { home: ensoHome(environment), hostOwnsTrust: environment[ENSO_PROJECT_TRUST_BY_HOST] === '1' }
}

/**
 * Resolutions per session, and within one per trust answer: under the web host a Trust reloads the
 * session, and the reloaded tools must read the project's config the untrusted resolution skipped.
 */
const resolutions = new WeakMap<object, Map<boolean | 'asked', Promise<SessionEnsoConfig>>>()

/**
 * The session's config, resolved once per `session` (the context's `sessionManager`) and trust
 * answer: under the web host a Trust reloads the session, and the trusted resolution is a new one.
 *
 * @group Project trust
 */
export function sessionEnsoConfig(session: object, context: SessionConfigContext): Promise<SessionEnsoConfig> {
  let perTrust = resolutions.get(session)
  if (perTrust === undefined) {
    perTrust = new Map()
    resolutions.set(session, perTrust)
  }
  const key = context.hostOwnsTrust ? context.isProjectTrusted() : 'asked'
  let resolution = perTrust.get(key)
  if (resolution === undefined) {
    resolution = resolveSessionConfig(context)
    perTrust.set(key, resolution)
  }
  return resolution
}

async function resolveSessionConfig(context: SessionConfigContext): Promise<SessionEnsoConfig> {
  const userPath = ensoConfigPath(context.home)
  const user = readConfig(userPath)
  const userSources = user.present ? [userPath] : []
  const userOnly = { result: user.result, path: userPath, sources: userSources }
  if (user.result.kind === 'unreadable') return userOnly
  const projectPath = projectConfigPath(context.cwd)
  const bothSources = [...userSources, projectPath]
  let projectText: string | undefined
  try {
    projectText = readTextIfPresent(projectPath)
  } catch (error: unknown) {
    const reason = `could not be read: ${String(error)}`
    return { result: { kind: 'unreadable', reason }, path: projectPath, sources: bothSources }
  }
  if (projectText === undefined) return userOnly
  const trusted = context.hostOwnsTrust ? context.isProjectTrusted() : await projectTrusted(context, projectPath)
  if (!trusted) {
    context.ui.notify(
      `Enso: ${projectPath} was not read — this project is not trusted, so the session runs under ${userPath} only.`,
      'warning',
    )
    return userOnly
  }
  const project = parseEnsoConfig(projectText)
  if (project.kind === 'unreadable') return { result: project, path: projectPath, sources: bothSources }
  // `projects.roots` is user-only: which directories may be projects is not a project's to widen.
  const { projects, ...projectConfig } = project.config
  if (projects !== undefined) {
    context.ui.notify(`Enso: ${projectPath} sets projects.roots, which only ${userPath} may set — ignored.`, 'warning')
  }
  const merged = mergeEnsoConfig(user.result.config, projectConfig)
  return { result: { kind: 'ok', config: merged }, path: projectPath, sources: bothSources }
}

/** A config file's parse, and whether there was a file to read — a read that threw had one. */
function readConfig(path: string): { readonly result: EnsoConfigParseResult; readonly present: boolean } {
  try {
    const text = readTextIfPresent(path)
    return { result: parseEnsoConfig(text), present: text !== undefined }
  } catch (error: unknown) {
    return { result: { kind: 'unreadable', reason: `could not be read: ${String(error)}` }, present: true }
  }
}

async function projectTrusted(context: SessionConfigContext, projectPath: string): Promise<boolean> {
  const agentDir = ensoAgentDir(context.home)
  const store = createProjectTrustStore(agentDir)
  const saved = store.get(context.cwd)
  if (saved !== null) return saved
  const fallback = defaultProjectTrust(agentDir)
  if (fallback !== 'ask') return fallback === 'always'
  if (!context.hasUI) return false
  const options = projectTrustOptions(context.cwd)
  const picked = await context.ui.select(
    `Trust project folder?\n${context.cwd}\n\nThis allows Enso to read ${projectPath}, which can change what ` +
      `this session may fetch and search. The same answer covers the project's .pi/.`,
    options.map((option) => option.label),
  )
  const answer = options.find((option) => option.label === picked)
  if (answer === undefined) return false
  if (answer.updates.length > 0) store.setMany(answer.updates)
  return answer.trusted
}
