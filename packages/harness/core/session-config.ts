import {
  ENSO_PROJECT_TRUST_BY_HOST,
  type EnsoConfigParseResult,
  type EnsoIncidentPolicy,
  type EnsoJudgeBackend,
  type EnsoJudgeConfig,
  type EnsoProjectTierPending,
  incidentPolicyOf,
  mergeEnsoConfig,
  parseEnsoConfig,
  tightenIncidentPolicy,
} from '@enso/core'
import {
  ensoAgentDir,
  ensoConfigPath,
  ensoHome,
  ensoProjectsDir,
  projectConfigApprovalsPath,
  projectIdOfCwd,
  readTextIfPresent,
} from '@enso/core/paths'
import { projectTierStanding } from '@enso/core/project-config'
import { type ProjectTrustRuntime, projectTrustOptions } from './project-trust.ts'

/**
 * The config one session runs under (#421): the user's `ENSO_HOME/config.json`, and over it the
 * project's own `<cwd>/.enso/config.json` — read ONLY once the project is trusted, by pi's own trust
 * store and rules (injected, `project-trust.ts`), so one answer covers the project's `.pi/` and `.enso/`;
 * and ONLY AS THE OPERATOR APPROVED IT (#753, `@enso/core/project-config`): a file changed since its
 * approval leaves the approved version applying, one never approved applies nothing, and the session
 * is told which.
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
   * time would name files the cached result never saw.
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
  /** pi's store and settings classes (#509), which the terminal's question reads and writes. */
  readonly projectTrust: ProjectTrustRuntime
}

/**
 * The context's process-wide parts: the user's `ENSO_HOME` and whether the web host owns project
 * trust (it sets {@link ENSO_PROJECT_TRUST_BY_HOST} before its first session), read from
 * `environment`; and pi's trust classes, which the calling extension imports and passes in (#509).
 *
 * @group Project trust
 */
export function sessionConfigEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  projectTrust: ProjectTrustRuntime,
): Pick<SessionConfigContext, 'home' | 'hostOwnsTrust' | 'projectTrust'> {
  return {
    home: ensoHome(environment),
    hostOwnsTrust: environment[ENSO_PROJECT_TRUST_BY_HOST] === '1',
    projectTrust,
  }
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
  // #753: the project's file is held to the version the operator approved — in a thread's tree, the
  // tree's copy to its project's approval — and only what was approved applies.
  const standing = projectTierStanding(context.cwd, 'shared', approvalsOf(context.home, context.cwd))
  const projectPath = standing.path
  if (standing.state === undefined) return userOnly
  const trusted = decidedProjectTrust(context) ?? (await askedProjectTrust(context, projectPath))
  if (!trusted) {
    context.ui.notify(
      `Enso: ${projectPath} was not read — this project is not trusted, so the session runs under ${userPath} only.`,
      'warning',
    )
    return userOnly
  }
  if (standing.state !== 'approved') context.ui.notify(pendingNotice(projectPath, standing.state), 'warning')
  if (standing.applied === undefined) return userOnly
  const bothSources = [...userSources, projectPath]
  const project = parseEnsoConfig(standing.applied)
  if (project.kind === 'unreadable') return { result: project, path: projectPath, sources: bothSources }
  // `projects.roots` is user-only: which directories may be projects is not a project's to widen.
  // ⚠ So is `claudeCode` (#925): nor may it change the Claude Code version Enso tells Anthropic it
  // is, and `security.judge` (#469): nor switch on a judge that sends commands off the machine.
  // ⚠ `security.incidents` may only TIGHTEN (#753): a checkout the agent can write must not switch
  // halting off or raise the thresholds its own incident is measured against. What tightens, the
  // guard applies (`sessionIncidentPolicy`); what loosens is named here and ignored. None of
  // `security` enters this merge. `threads` is a project setting since #754 (its tree mode, setup
  // and files to copy); the host resolves it by tier when it makes a tree
  // (`@enso/core/project-config`), and nothing in a session reads it from this merge.
  const { projects, security, claudeCode, ...projectConfig } = project.config
  const userOnlySections: readonly (readonly [string, unknown])[] = [
    ['projects.roots', projects],
    ['security.judge', security?.judge],
    ['claudeCode', claudeCode],
  ]
  for (const [section, projectSetting] of userOnlySections) {
    if (projectSetting === undefined) continue
    context.ui.notify(`Enso: ${projectPath} sets ${section}, which only ${userPath} may set — ignored.`, 'warning')
  }
  const { loosening } = tightenIncidentPolicy(incidentPolicyOf(user.result.config.security), security?.incidents)
  for (const key of loosening) {
    context.ui.notify(
      `Enso: ${projectPath} sets ${key} looser than ${userPath} does — ignored: a project may only tighten it.`,
      'warning',
    )
  }
  const merged = mergeEnsoConfig(user.result.config, projectConfig)
  return { result: { kind: 'ok', config: merged }, path: projectPath, sources: bothSources }
}

/** Where the approvals of `cwd`'s project are kept (#753): its project's, whether `cwd` is the checkout or one of its trees. */
function approvalsOf(home: string, cwd: string): string {
  const projectsDir = ensoProjectsDir(home)
  return projectConfigApprovalsPath(projectsDir, projectIdOfCwd(projectsDir, cwd))
}

/** What a session is told of a project file that is not the version approved (#753). */
function pendingNotice(path: string, state: EnsoProjectTierPending['state']): string {
  if (state === 'changed') {
    return `Enso: ${path} has changed since you approved it, so the version you approved is in use. Review the change and approve it on the project page.`
  }
  if (state === 'removed') {
    return `Enso: ${path} is gone, so the version you approved is in use until you approve the removal on the project page.`
  }
  return `Enso: ${path} has not been approved, so nothing in it applies. Review it and approve it on the project page.`
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

/**
 * The incident policy (#466) a session runs under: the USER's `config.json`, and over it — once the
 * project is `trusted` — its approved `.enso/config.json`'s `security.incidents`, which can only
 * TIGHTEN it (#753, `tightenIncidentPolicy`; a loosening key is ignored, and the session told so by
 * `sessionEnsoConfig`). Synchronous, where the guard needs it (`session_start`, before any call is
 * decided), so no trust question is asked here: `project` says what was decided. `undefined` — no
 * session started yet — is the user's alone. ⚠ Unreadable fails CLOSED, as every consumer of these
 * files does: halting on, and `problem` says why.
 *
 * @group Session incident
 */
export function sessionIncidentPolicy(
  home: string,
  project: { readonly cwd: string; readonly trusted: boolean } | undefined,
): { readonly policy: EnsoIncidentPolicy; readonly problem?: string } {
  const { result } = readConfig(ensoConfigPath(home))
  if (result.kind === 'unreadable') {
    return { policy: { ...incidentPolicyOf(undefined), halt: true }, problem: result.reason }
  }
  const user = incidentPolicyOf(result.config.security)
  if (project === undefined || !project.trusted) return { policy: user }
  const { path, applied } = projectTierStanding(project.cwd, 'shared', approvalsOf(home, project.cwd))
  const approved = parseEnsoConfig(applied)
  if (approved.kind === 'unreadable') {
    return { policy: { ...user, halt: true }, problem: `${path}, as approved: ${approved.reason}` }
  }
  return { policy: tightenIncidentPolicy(user, approved.config.security?.incidents).policy }
}

/**
 * The command judge's backend (#469) from the USER's `config.json` alone: `security.judge` is
 * user-only, so a project cannot switch a judge on, or off, for the user. Absent
 * is `off`. ⚠ Unreadable fails CLOSED, which for the judge means OFF — nothing is sent anywhere —
 * and `problem` says why; so does `local` without the router and model it needs (#532).
 *
 * @group Command judge
 */
export function userJudgeConfig(
  home: string,
):
  | { readonly backend: Exclude<EnsoJudgeBackend, 'local'>; readonly problem?: string }
  | { readonly backend: 'local'; readonly local: NonNullable<EnsoJudgeConfig['local']> } {
  const { result } = readConfig(ensoConfigPath(home))
  if (result.kind === 'unreadable') return { backend: 'off', problem: result.reason }
  const judge = result.config.security?.judge
  const backend = judge?.backend ?? 'off'
  if (backend !== 'local') return { backend }
  if (judge?.local === undefined) {
    return { backend: 'off', problem: '`security.judge.backend` is `local`, but `security.judge.local` is missing' }
  }
  return { backend, local: judge.local }
}

/**
 * The trust already decided for the session's project, without asking: the web host's answer when
 * it owns trust (#502), else pi's saved decision for the cwd or its nearest ancestor, else
 * `defaultProjectTrust` — `undefined` when that is `ask`, the question `sessionEnsoConfig` asks. What
 * the guard reads at `session_start` (#753), which cannot wait on a question: a project trusted only
 * for one terminal session is untrusted there, so its tightening waits for a saved decision.
 *
 * @group Project trust
 */
export function decidedProjectTrust(
  context: Pick<SessionConfigContext, 'home' | 'cwd' | 'hostOwnsTrust' | 'isProjectTrusted' | 'projectTrust'>,
): boolean | undefined {
  if (context.hostOwnsTrust) return context.isProjectTrusted()
  const agentDir = ensoAgentDir(context.home)
  const saved = new context.projectTrust.ProjectTrustStore(agentDir).get(context.cwd)
  if (saved !== null) return saved
  // pi reads `defaultProjectTrust` from the agent dir's settings only; `projectTrusted: false` keeps
  // the untrusted project's own `.pi/settings.json` unread while asking whether to trust it.
  const fallback = context.projectTrust.SettingsManager.create(context.cwd, agentDir, {
    projectTrusted: false,
  }).getDefaultProjectTrust()
  return fallback === 'ask' ? undefined : fallback === 'always'
}

/** The terminal's trust question, when nothing decided it: pi's answers, saved as pi saves them; with no UI, untrusted. */
async function askedProjectTrust(context: SessionConfigContext, projectPath: string): Promise<boolean> {
  if (!context.hasUI) return false
  const options = projectTrustOptions(context.cwd)
  const picked = await context.ui.select(
    `Trust project folder?\n${context.cwd}\n\nThis allows Enso to read ${projectPath}, which can change what ` +
      `this session may fetch and search. The same answer covers the project's .pi/.`,
    options.map((option) => option.label),
  )
  const answer = options.find((option) => option.label === picked)
  if (answer === undefined) return false
  if (answer.updates.length > 0) {
    new context.projectTrust.ProjectTrustStore(ensoAgentDir(context.home)).setMany([...answer.updates])
  }
  return answer.trusted
}
