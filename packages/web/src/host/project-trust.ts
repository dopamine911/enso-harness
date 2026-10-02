import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent'
import { type EnsoTranscriptEntry, threadTrustsProject } from '@enso/core'
import { projectConfigPath, projectPromptsDir } from '@enso/core/paths'

/**
 * Whether a hosted session may read its project's own configuration (#502): decided HERE, before pi
 * builds anything. pi's answer in an SDK host is "trusted" — a `SettingsManager` created with no trust
 * option defaults to it — so a repository's `.pi/extensions/pi-permission-system/config.json`
 * `{"yoloMode": true}` switched every permission prompt off (probed).
 *
 * The decision, in order: a saved one in pi's `trust.json` (the project or its nearest ancestor —
 * "Trust project", shared with terminal pi); else the thread's own "Trust this thread" record; else
 * `defaultProjectTrust` `always`/`never`; else UNTRUSTED.
 *
 * ⚠ STRICT: A PROJECT NOBODY DECIDED IS UNTRUSTED, WHATEVER IT HOLDS NOW. pi's terminal treats a
 * project with nothing trust-gated as trusted without asking; here that would load a `.pi/` that
 * arrives mid-session (a `git pull`) on the next turn, because the permission engine re-reads its
 * runtime config every turn. And pi's list of what is gated has no `.pi/agents/`, where the engine
 * reads a project's own mode definitions.
 *
 * ⚠ ASKED BEFORE THE RUN, NEVER DURING ONE. When the decision is open and the project has something
 * trust would load, the first run waits (`createTrustGate`): the question is asked, the answer
 * recorded, and on a Trust the session is reloaded BEFORE the run starts — the engine binds a
 * project's permission rules and modes only when a session starts, so a reload is what loads them,
 * and before the first run it costs nothing: no approvals to lose, no reads to forget.
 */
export interface HostedProjectTrust {
  /** The settings pi builds the session on, trusted or not; a Trust is applied to it. */
  readonly settingsManager: SettingsManager
  /** The decision is still open, and the project holds something it would load: ask before a run. */
  readonly open: boolean
}

/** @group Project trust */
export function hostedProjectTrust(
  cwd: string,
  agentDir: string,
  branch: readonly EnsoTranscriptEntry[],
): HostedProjectTrust {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const saved = new ProjectTrustStore(agentDir).get(cwd)
  const fallback = settingsManager.getDefaultProjectTrust()
  const trusted = saved ?? (threadTrustsProject(branch) || fallback === 'always')
  settingsManager.setProjectTrusted(trusted)
  const open = !trusted && saved === null && fallback === 'ask' && hasTrustGatedResources(cwd)
  return { settingsManager, open }
}

/**
 * The project holds something trust would load: pi's list (`.pi/settings.json`, `extensions`,
 * `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`, a `.agents/skills` above it),
 * plus what pi does not know: the engine's `.pi/agents/`, Enso's `.enso/config.json`, and the
 * project's own prompt library, `.enso/prompts/` (#470) — so a project that holds only prompts is
 * asked about too, and "Trust project" lists them for the threads after this one.
 */
export function hasTrustGatedResources(cwd: string): boolean {
  return (
    hasTrustRequiringProjectResources(cwd) ||
    existsSync(join(cwd, '.pi', 'agents')) ||
    existsSync(projectConfigPath(cwd)) ||
    existsSync(projectPromptsDir(cwd))
  )
}

/** The answers, in the order the question offers them. */
const TRUST_PROJECT = 'Trust project'
const TRUST_THREAD = 'Trust this thread'
const DO_NOT_TRUST = "Don't trust"
export const PROJECT_TRUST_OPTIONS: readonly string[] = [TRUST_PROJECT, TRUST_THREAD, DO_NOT_TRUST]

/** The question's title: the project, and what trusting it lets in. Read as one paragraph in the card. */
export function projectTrustQuestion(cwd: string): string {
  return (
    `Trust the project ${cwd}? It has its own configuration — .pi/ settings, skills, prompts, permission ` +
    `rules and modes, .enso/config.json or .enso/prompts — which can change what the agent may do without ` +
    `asking. Until you trust it, only your own configuration applies. The run waits for your answer.`
  )
}

/**
 * What the thread is told once a Trust is applied: the engine's "project is not trusted" warning from
 * the session's start is still on screen, and the reload that made it stale says nothing itself.
 */
export function projectTrustedNotice(answer: 'project' | 'thread'): string {
  return answer === 'project'
    ? "Project trusted — its own configuration is loaded, and the answer is saved in pi's trust.json, so it is not asked again."
    : 'Project trusted for this thread — its own configuration is loaded. A new thread in this project asks again.'
}

/** What an answer means; a dismissed question is "Don't trust". */
export type ProjectTrustAnswer = 'project' | 'thread' | 'untrusted'

function projectTrustAnswer(label: string | undefined): ProjectTrustAnswer {
  if (label === TRUST_PROJECT) return 'project'
  if (label === TRUST_THREAD) return 'thread'
  return 'untrusted'
}

/** Why a run waiting on the question does not start when Stop is pressed before it is answered. */
const STOPPED_BEFORE_TRUST = 'stopped before the project-trust question was answered'

/** @group Project trust */
export interface TrustGate {
  /** Start a run once the session's trust is settled: at once, or after the question and its answer. */
  run(start: () => void, refuse: (reason: string) => void): void
  /** Stop: the runs waiting on the question are refused, and it is asked again at the next run. */
  abort(): void
}

/**
 * Holds runs until the open decision is made. One question at a time: runs arriving while it is
 * asked wait with the first, in order. An answer is applied (recorded, trust set, session reloaded)
 * before any waiting run starts; an answer that cannot be applied refuses them rather than run on a
 * half-applied trust.
 */
export function createTrustGate(options: {
  readonly open: boolean
  readonly ask: () => Promise<string | undefined>
  readonly apply: (answer: ProjectTrustAnswer) => Promise<void>
}): TrustGate {
  let open = options.open
  let waiting: { readonly start: () => void; readonly refuse: (reason: string) => void }[] = []
  /** The question in flight; a Stop replaces it, so a late answer to it is ignored. */
  let asking: object | undefined

  const settle = (outcome: { readonly started: true } | { readonly refused: string }): void => {
    const runs = waiting
    waiting = []
    for (const run of runs) {
      if ('started' in outcome) run.start()
      else run.refuse(outcome.refused)
    }
  }

  return {
    run(start, refuse): void {
      if (!open) {
        start()
        return
      }
      waiting.push({ start, refuse })
      if (asking !== undefined) return
      const question = {}
      asking = question
      void options
        .ask()
        .then(async (label) => {
          if (asking !== question) return
          await options.apply(projectTrustAnswer(label))
          asking = undefined
          open = false
          settle({ started: true })
        })
        .catch((error: unknown) => {
          if (asking !== question) return
          asking = undefined
          settle({ refused: `the project-trust answer could not be applied: ${String(error)}` })
        })
    },
    abort(): void {
      asking = undefined
      settle({ refused: STOPPED_BEFORE_TRUST })
    },
  }
}
