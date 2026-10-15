import {
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_SETUP_ENTRY,
  type EnsoConfig,
  type EnsoProjectSettings,
  type EnsoProjectThreadSettings,
  type EnsoProjectTierPending,
  type EnsoTranscriptEntry,
  EnsoTreeSetupOutcome,
  ensoLogger,
} from '@enso/core'
import { projectConfigApprovalsPath, projectIdOf } from '@enso/core/paths'
import { readProjectThreadSettings } from '@enso/core/project-config'
import { Compile } from 'typebox/compile'
import { projectTrusted } from './project-trust.ts'

/**
 * The host's side of #754: a project's tree settings resolved by tier under pi's trust for the
 * project and the operator's approval of its files (#753), and the setup outcome a thread's branch
 * records. The tiers, the files, the approvals and the setup run are `@enso/core/project-config` and
 * `@enso/core/tree-setup`; this module adds the trust decision.
 */

const log = ensoLogger('host')

/**
 * What a project's tree settings resolve against (#754): the user's config — its `threads` is the
 * user tier — the file it came from, named on the project page, how its project keys are
 * canonicalized (`~/code/app`, a trailing slash, a symlink: `canonicalConfigPath`), and the project
 * folders (`ENSO_HOME/projects`), where each project's approved tiers are kept (#753).
 */
export interface ProjectThreadSettingsSource {
  readonly user: EnsoConfig
  readonly userPath: string
  readonly canonical: (key: string) => string
  readonly projectsDir: string
}

/** Where `project`'s (a canonical path) approved tiers are kept (#753). */
export function approvalsPathOf(source: ProjectThreadSettingsSource, project: string): string {
  return projectConfigApprovalsPath(source.projectsDir, projectIdOf(project))
}

/**
 * `project`'s new-tree settings (a canonical path), whether its own tiers were read — pi's trust for
 * the project's path (#502), as a new tree asks it (`projectTrusted`) — and which of them are not the
 * version approved (#753), whose approved version was read instead, or nothing. ⚠ Read fresh on every
 * call: an edit, an approval, or a trust set or revoked (#873), applies to the next tree. An approved
 * version that no longer reads is logged and resolved without (fails closed).
 */
export function resolveProjectThreadSettings(
  project: string,
  source: ProjectThreadSettingsSource,
  agentDir: string,
): {
  readonly threads: EnsoProjectThreadSettings
  readonly trusted: boolean
  readonly unreadable: EnsoProjectSettings['unreadable']
  readonly pending: readonly EnsoProjectTierPending[]
} {
  const trusted = projectTrusted(project, agentDir)
  const read = readProjectThreadSettings({
    project,
    user: source.user,
    canonical: source.canonical,
    trusted,
    approvals: approvalsPathOf(source, project),
  })
  for (const unreadable of read.unreadable) {
    log.warn('{path}, the {tier} tier of {project}, as approved does not read and was not applied (#753): {reason}', {
      project,
      ...unreadable,
    })
  }
  for (const pending of read.pending) {
    log.warn('{path}, the {tier} tier of {project}, is {state}: only what was approved of it applies (#753)', {
      project,
      ...pending,
    })
  }
  return { threads: read.threads, trusted, unreadable: [...read.unreadable], pending: read.pending }
}

const setupOutcomeValidator = Compile(EnsoTreeSetupOutcome)

/**
 * What preparing the thread's tree did (#754): the setup record after the branch's last tree
 * record — a fork's branch holds its source's records before its own, and a fork with nothing to
 * set up has none of its own. `undefined` for a thread with no tree, or a tree made with nothing to
 * set up, or before setup existed.
 */
export function treeSetupOf(transcript: readonly EnsoTranscriptEntry[]): EnsoTreeSetupOutcome | undefined {
  for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = transcript[entryIndex]
    if (entry?.kind !== 'custom') continue
    if (entry.customType === ENSO_THREAD_TREE_ENTRY) return undefined
    if (entry.customType === ENSO_TREE_SETUP_ENTRY && setupOutcomeValidator.Check(entry.data)) return entry.data
  }
  return undefined
}
