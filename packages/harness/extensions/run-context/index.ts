import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  ProjectTrustStore,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import {
  ENSO_MODE_PRESETS,
  ENSO_RUN_CONTEXT_ENTRY,
  type EnsoConfigParseResult,
  type EnsoRunContext,
  type EnsoTranscriptEntry,
  lastCustomEntryData,
  readEnsoRunContext,
  recordedPermissionMode,
  ensoLogger,
  transcriptOf,
} from '@enso/core'
import { type GitRunner, runGit } from '@enso/core/git'
import {
  ensoHome,
  ensoProjectsDir,
  projectIdOf,
  projectSnapshotsDir,
  readTextIfPresent,
  realpathOrSelf,
  treeProjectId,
} from '@enso/core/paths'
import { permissionEngineConfigPath } from '@enso/core/permission-rules'
import { openSnapshotStore, type SnapshotStore } from '@enso/core/snapshot-store'
import {
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionConfigEnvironment,
  sessionEnsoConfig,
} from '../../core/index.ts'

/**
 * The run-context recorder (#435, Lineage #126): at every prompt's run start, what the run starts
 * under — git revision and dirty state, the resolved config's hash and files, the skills, the
 * context files' hashes, the permission mode's rule-set hash — appended to pi's log as an
 * `enso-run-context` entry (`@enso/core` `run-context.ts`) ONLY when a field differs from the last
 * one on the branch. Never per turn; a fork inherits the entries on its path, so its first run
 * appends only what changed.
 *
 * ⚠ A CONTINUE IS RECORDED FROM `agent_start` (#445). pi emits `before_agent_start` inside
 * `prompt()` only, and a #436 Continue runs through pi's private run lifecycle without it — but
 * `agent_start` fires for every agent loop, that one included. A run that reaches `agent_start`
 * with no `before_agent_start` before it is a continued run: git, the config and the mode are
 * read THEN, and the skills and context files are carried from the last record on the branch —
 * which is what the model receives, since a Continue prepends no prompt-section patch
 * (`agent-session.js#_preparePromptAndToolLoadout` runs in `prompt()` alone) and the transcript's
 * sections are those of the last prompt. Appended, as ever, only when something differs. A branch
 * with no record at all (a thread from before #435) gets none: the sections the model receives
 * are rendered text with no structured source, and a record claiming no skills would be false.
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
 * session. The probe runs through `@enso/core/git`'s `runGit`, which removes git's
 * repository-locating variables (`pi.exec` takes no environment); found under a worktree's
 * pre-commit gate. Its timeout bounds each query: a `rev-parse` past it records `git: null`, as any
 * failure of it does; a `status` past it records `dirty: true`.
 *
 * ⚠ HASHES ONLY. No file body and no config value is written — a context file is its path and
 * sha256, the config a sha256 of the resolved value with keys sorted.
 *
 * The mode's rules are the permission policy the engine reads (`ENSO_HOME/permissions.json`,
 * through the link `preparePermissionPolicy` makes) and the preset of the session's mode, which
 * the engine merges over it (#496). The rules hash is a sha256 of both. The mode NAME is the last
 * `active_agent` entry among the session's entries, the engine's own walk. A policy that is absent
 * or does not parse records the mode as unknown (`null`), never a constant hash of nothing that
 * would stop noticing rule changes.
 */

const log = ensoLogger('extension', 'run-context')

export interface RunContextDependencies {
  /** The session's config — one resolution per session and trust answer (`session-config.ts`). */
  resolveSessionConfig: (
    session: object,
    context: Omit<SessionConfigContext, 'home' | 'hostOwnsTrust' | 'projectTrust'>,
  ) => Promise<SessionEnsoConfig>
  /** Run git in `cwd` — never in a repository an inherited environment names. */
  runGit: GitRunner
  /** The permission policy's text as the engine reads it; `undefined` when there is none. */
  readPermissionPolicy: () => string | undefined
  /**
   * The thread's snapshot store for its tree (#551): opened — minted when absent — per run, so a
   * store removed with its thread is not held open; `undefined` when it cannot be minted.
   */
  openSnapshotStore: (tree: string, threadId: string) => Promise<SnapshotStore | undefined>
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** JSON with every object's keys sorted, so equal values hash equal whatever order built them. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      // Keys of one object are distinct: never equal.
      .toSorted(([first], [second]) => (first < second ? -1 : 1))
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

function modeRules(entries: readonly EnsoTranscriptEntry[], policyText: string | undefined): EnsoRunContext['mode'] {
  if (policyText === undefined) return null
  let policy: unknown
  try {
    policy = JSON.parse(policyText)
  } catch {
    return null
  }
  const mode = recordedPermissionMode(entries)
  const preset = mode === 'default' ? null : ENSO_MODE_PRESETS[mode]
  return { rulesHash: sha256(canonicalJson({ policy, preset })) }
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

/** The facts a record holds that are read from the session, not from the prompt's event: git, config, mode, snapshot. */
async function sessionFactsOf(
  dependencies: RunContextDependencies,
  context: ExtensionContext,
): Promise<Pick<EnsoRunContext, 'git' | 'config' | 'mode' | 'snapshot'>> {
  const [git, config, snapshot] = await Promise.all([
    gitState(dependencies, context.cwd),
    resolvedConfig(dependencies, context),
    snapshotOf(dependencies, context),
  ])
  return {
    git,
    config: { hash: sha256(canonicalJson(config.result)), sources: config.sources },
    mode: modeRules(transcriptOf(context.sessionManager.getEntries()), dependencies.readPermissionPolicy()),
    snapshot,
  }
}

/**
 * The tree as the run begins, as a snapshot (#551): `null` when the store cannot be opened or a
 * git of it fails — said in the log with the step, never a thrown hook, never a stale hash.
 */
async function snapshotOf(
  dependencies: RunContextDependencies,
  context: ExtensionContext,
): Promise<{ hash: string } | null> {
  const store = await dependencies.openSnapshotStore(context.cwd, context.sessionManager.getSessionId())
  if (store === undefined) {
    log.warn('no snapshot store for {tree}: the run records no snapshot', { tree: context.cwd })
    return null
  }
  if (store.migration !== undefined) {
    log.info('snapshot stores moved onto the project object store (#573): {stores}', {
      stores: store.migration.migrated.join(', '),
    })
    for (const lost of store.migration.pruned) {
      log.warn("snapshot store {store} had lost {missing} objects to the checkout's gc before it moved (#573)", lost)
    }
    for (const stuck of store.migration.unmigrated) {
      log.warn('snapshot store {store} could not be moved onto the project object store (#573): {reason}', stuck)
    }
  }
  const outcome = await store.snapshot()
  if (outcome.kind === 'refused') {
    log.warn('snapshot of {tree} refused at {step} (git exit {code}): {stderr}', {
      tree: context.cwd,
      ...outcome.refused,
    })
    return null
  }
  return { hash: outcome.taken.hash }
}

async function runContextOf(
  dependencies: RunContextDependencies,
  event: BeforeAgentStartEvent,
  context: ExtensionContext,
): Promise<EnsoRunContext> {
  const facts = await sessionFactsOf(dependencies, context)
  const skills = event.systemPromptOptions.skills
    .map((skill) => ({ name: skill.name, path: skill.filePath }))
    .toSorted((first, second) => byCodePoint(first.name, second.name) || byCodePoint(first.path, second.path))
  return {
    ...facts,
    skills,
    contextFiles: event.systemPromptOptions.contextFiles.map((file) => ({
      path: file.path,
      sha256: sha256(file.content),
    })),
  }
}

/**
 * A continued run's record (#445): the session's facts now, the prompt's facts as the transcript
 * holds them — the last record's. Undefined when the branch has no readable record to carry.
 */
async function continuedRunContextOf(
  dependencies: RunContextDependencies,
  context: ExtensionContext,
): Promise<EnsoRunContext | undefined> {
  const last = readEnsoRunContext(
    ENSO_RUN_CONTEXT_ENTRY,
    lastCustomEntryData(transcriptOf(context.sessionManager.getBranch()), ENSO_RUN_CONTEXT_ENTRY),
  )
  if (last === undefined) return undefined
  const facts = await sessionFactsOf(dependencies, context)
  return { ...facts, skills: last.skills, contextFiles: last.contextFiles }
}

/** Append `current` unless it equals the last record on the branch, compared raw (PR #440 review). */
function appendIfChanged(pi: ExtensionAPI, context: ExtensionContext, current: EnsoRunContext): void {
  // Compared RAW, not through the reader's schema: a record this writer made that the schema
  // rejects would otherwise read as absent and be appended again every run.
  const last = lastCustomEntryData(transcriptOf(context.sessionManager.getBranch()), ENSO_RUN_CONTEXT_ENTRY)
  if (last !== undefined && canonicalJson(last) === canonicalJson(current)) return
  pi.appendEntry(ENSO_RUN_CONTEXT_ENTRY, current)
}

/** The run-context recorder, over its dependencies; the default export wires the real ones. */
export function createRunContext(dependencies: RunContextDependencies): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    // Set by a prompt's `before_agent_start`, cleared by the `agent_start` that follows it; an
    // `agent_start` that finds it clear is a run that had no prompt — a Continue (#445).
    // ⚠ A mark left set is a prompt that failed between the hook and its loop: in pi 1.1.0 the one
    // thing there that can throw is image normalization (`agent-session.js#prompt`, `:1599`), and
    // that failure rejects `prompt()` itself. The cost is ONE Continue after it recorded as if it
    // were that prompt's loop; the next prompt sets the mark afresh. Stated rather than closed: the
    // alternative is a clock on the mark, and a slow image would then misread a real prompt.
    let promptRecorded = false
    pi.on('before_agent_start', async (event, context) => {
      promptRecorded = true
      appendIfChanged(pi, context, await runContextOf(dependencies, event, context))
    })
    pi.on('agent_start', async (_event, context) => {
      if (promptRecorded) {
        promptRecorded = false
        return
      }
      const current = await continuedRunContextOf(dependencies, context)
      if (current !== undefined) appendIfChanged(pi, context, current)
    })
  }
}

/**
 * The pi entry point — the session's config in `ENSO_HOME` (#421), whichever surface loads this;
 * git run through `@enso/core/git` rather than `pi.exec`, which takes no environment, so the
 * inherited repository-locating variables can be dropped; the permission policy at the path the
 * engine reads under `PI_CODING_AGENT_DIR`, which both Enso surfaces set (#496). Read per call:
 * the environment at the run, not at load.
 */
export default createRunContext({
  resolveSessionConfig: (session, context) =>
    sessionEnsoConfig(session, {
      ...context,
      // pi's own trust store and settings (#509): `harness/core` may not import them.
      ...sessionConfigEnvironment(process.env, { ProjectTrustStore, SettingsManager }),
    }),
  runGit,
  readPermissionPolicy: () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR
    if (agentDir === undefined) return undefined
    try {
      return readTextIfPresent(permissionEngineConfigPath(agentDir))
    } catch {
      // Unreadable (a permission error, a dangling link): the mode is unknown, never a failed run.
      return undefined
    }
  },
  // The store beside the thread's session, under its project's folder (#552): the tree is the
  // session's cwd; its project id the one a minted tree's path names (#551), else the canonical
  // path's. Opened per run; minted on the first — a thread on a tree finds the store its mint made.
  openSnapshotStore: (tree, threadId) => {
    // The host's folder when a host runs this (#586: it owns the path); the terminal has no host and
    // derives it from ENSO_HOME, as its launcher does.
    const projectsDir = process.env.ENSO_PROJECTS_DIR ?? ensoProjectsDir(ensoHome(process.env))
    const projectId = treeProjectId(projectsDir, tree) ?? projectIdOf(realpathOrSelf(tree))
    return openSnapshotStore({
      directory: join(projectSnapshotsDir(projectsDir, projectId), threadId),
      tree,
      environment: process.env,
    })
  },
})
