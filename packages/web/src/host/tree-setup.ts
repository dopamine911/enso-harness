import {
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_SETUP_ENTRY,
  type EnsoConfig,
  type EnsoProjectSettings,
  type EnsoProjectThreadSettings,
  type EnsoTranscriptEntry,
  EnsoTreeSetupOutcome,
  ensoLogger,
} from '@enso/core'
import { readProjectThreadSettings } from '@enso/core/project-config'
import { Compile } from 'typebox/compile'
import { hostedProjectTrust } from './project-trust.ts'

/**
 * The host's side of #754: a project's tree settings resolved by tier under pi's trust for the
 * project, and the setup outcome a thread's branch records. The tiers, the files and the setup run
 * are `@enso/core/project-config` and `@enso/core/tree-setup`; this module adds the trust decision.
 */

const log = ensoLogger('host')

/**
 * What a project's tree settings resolve against (#754): the user's config — its `threads` is the
 * user tier — the file it came from, named on the project page, and how its project keys are
 * canonicalized (`~/code/app`, a trailing slash, a symlink: `canonicalConfigPath`).
 */
export interface ProjectThreadSettingsSource {
  readonly user: EnsoConfig
  readonly userPath: string
  readonly canonical: (key: string) => string
}

/**
 * `project`'s new-tree settings (a canonical path) and whether its own tiers were read: pi's trust
 * for the project's path (#502), asked with no thread's branch — a project page and a new tree
 * belong to no thread, so a "Trust this thread" answer does not count. ⚠ Read fresh on every call:
 * an edit applies to the next tree. An unreadable tier is logged and resolved without (fails closed).
 */
export function resolveProjectThreadSettings(
  project: string,
  source: ProjectThreadSettingsSource,
  agentDir: string,
): {
  readonly threads: EnsoProjectThreadSettings
  readonly trusted: boolean
  readonly unreadable: EnsoProjectSettings['unreadable']
} {
  const trusted = hostedProjectTrust(project, project, agentDir, []).settingsManager.isProjectTrusted()
  const read = readProjectThreadSettings({ project, user: source.user, canonical: source.canonical, trusted })
  for (const unreadable of read.unreadable) {
    log.warn('{path}, the {tier} tier of {project}, is unreadable and was not read (#754): {reason}', {
      project,
      ...unreadable,
    })
  }
  return { threads: read.threads, trusted, unreadable: [...read.unreadable] }
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
