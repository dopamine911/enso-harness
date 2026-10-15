import {
  type EnsoProjectConfigApproval,
  type EnsoProjectConfigReview,
  type EnsoProjectSettings,
  type EnsoProjectSettingsUpdate,
  ensoLogger,
} from '@enso/core'
import { projectConfigPath, projectLocalConfigPath } from '@enso/core/paths'
import {
  approveProjectTier,
  type ProjectTierWrite,
  reviewProjectConfig,
  writeProjectThreadSettings,
} from '@enso/core/project-config'
import { approvalsPathOf, type ProjectThreadSettingsSource, resolveProjectThreadSettings } from '../host/tree-setup.ts'
import type { ProjectRegistry } from './projects.ts'

/**
 * `GET` and `PUT /api/projects/<projectId>/settings` (#754): the project page's Worktrees section —
 * a new tree's mode, files to copy and setup commands, each with the tier it resolves from — and
 * its edits, written to the tier the operator chooses: the project's shared or local file. And
 * `GET` and `PUT /api/projects/<projectId>/config-approval` (#753): each of those files against the
 * version the operator approved, as a diff, and its approval.
 *
 * ⚠ RESOLVED AS A NEW TREE WOULD BE: from the project's path (never a thread's tree), under pi's
 * trust for that path, its files read fresh, as approved. Untrusted, the page shows the user's and
 * the defaults, and says so (`trusted`). A write or an approval needs no trust: it is the operator's
 * own action through the page; it is read into a resolution only once the project is trusted.
 *
 * ⚠ AN APPROVAL NAMES WHAT WAS SEEN: the file's hash as the review answered it, so a file changed
 * after the page read it is refused (409), never approved unseen. A route reaches every allowed
 * interpreter command as every route does (the page's guard, #717, stops other pages only); such a
 * command can write the approvals file itself, as it can `trust.json` — this guards against what
 * reaches the files without running on this machine as the operator (a commit, a pull, a tool the
 * guard refuses), and the `config-tier-touch` signal names what tries.
 */

const log = ensoLogger('server', 'http')

interface ProjectSettingsRouteDeps {
  readonly projects: Pick<ProjectRegistry, 'get'>
  /** The user's config and its file; absent, the server reads no config and resolves no project settings. */
  readonly source: ProjectThreadSettingsSource | undefined
  /** pi's agent dir, whose `trust.json` decides whether a project's own tiers are read. */
  readonly agentDir: string
}

type Refusal = { readonly kind: 'refused'; readonly status: 404 | 409 | 422; readonly reason: string }

/** A route's answer: the settings, or a refusal with its status and its reason, sent as the body. */
export type ProjectSettingsAnswer = { readonly kind: 'settings'; readonly settings: EnsoProjectSettings } | Refusal

/** The approval routes' answer: the review, or a refusal with its status and its reason. */
export type ProjectConfigReviewAnswer = EnsoProjectConfigReview | Refusal

/** Where a project's settings are answered from: its canonical path, and the user's config. */
interface SettingsPlace {
  readonly path: string
  readonly missing: boolean
  readonly source: ProjectThreadSettingsSource
}

/**
 * The routes' answers, HTTP aside: 404 for a project this server has not registered; 409 for a
 * write over a file not approved as it is, or an approval of a file that changed since the page read
 * it; 422 for one that cannot be made (an unreadable tier file, never overwritten nor approved; a
 * directory that is gone).
 */
export function createProjectSettingsRoute(deps: ProjectSettingsRouteDeps): {
  read(projectId: string): ProjectSettingsAnswer
  write(projectId: string, update: EnsoProjectSettingsUpdate): ProjectSettingsAnswer
  review(projectId: string): ProjectConfigReviewAnswer
  approve(projectId: string, approval: EnsoProjectConfigApproval): ProjectConfigReviewAnswer
} {
  /** The project and the source, or why there are none to answer from. */
  function placeOf(projectId: string): SettingsPlace | Refusal {
    const project = deps.projects.get(projectId)
    if (project === undefined) {
      return { kind: 'refused', status: 404, reason: `no registered project has the id ${projectId}` }
    }
    if (deps.source === undefined) {
      return { kind: 'refused', status: 422, reason: 'this server reads no user config, so it has no project settings' }
    }
    return { path: project.path, missing: project.status === 'missing-dir', source: deps.source }
  }

  function settingsOf(projectId: string, place: SettingsPlace): ProjectSettingsAnswer {
    const { threads, trusted, unreadable } = resolveProjectThreadSettings(place.path, place.source, deps.agentDir)
    const files = {
      user: place.source.userPath,
      shared: projectConfigPath(place.path),
      local: projectLocalConfigPath(place.path),
    }
    return { kind: 'settings', settings: { projectId, path: place.path, trusted, threads, files, unreadable } }
  }

  function reviewOf(projectId: string, place: SettingsPlace): EnsoProjectConfigReview {
    return { projectId, tiers: reviewProjectConfig(place.path, approvalsPathOf(place.source, place.path)) }
  }

  /** The place to write in, or why not: ⚠ never a directory that is gone — the write would make it again. */
  function writablePlaceOf(projectId: string): SettingsPlace | Refusal {
    const place = placeOf(projectId)
    if ('kind' in place || !place.missing) return place
    return { kind: 'refused', status: 422, reason: `${place.path} is gone; nothing is written there` }
  }

  /** An approval made, logged either way — what was approved, by its hash, or why not (#753). */
  function approveAt(
    projectId: string,
    place: SettingsPlace,
    approval: EnsoProjectConfigApproval,
  ): ProjectConfigReviewAnswer {
    const approved = approveProjectTier(place.path, approvalsPathOf(place.source, place.path), approval)
    if (approved.kind === 'refused') {
      log.warn('project {projectId}: config not approved: {reason}', { projectId, reason: approved.reason })
      return approved
    }
    log.info('project {projectId}: its {tier} config approved as {sha256} (#753)', { projectId, ...approval })
    return reviewOf(projectId, place)
  }

  /** `answer` at the place `found`, or the refusal that found none. */
  const at = <Answer>(found: SettingsPlace | Refusal, answer: (place: SettingsPlace) => Answer): Answer | Refusal =>
    'kind' in found ? found : answer(found)

  return {
    read: (projectId) => at(placeOf(projectId), (place) => settingsOf(projectId, place)),
    write: (projectId, update) =>
      at(writablePlaceOf(projectId), (place) => writeTier(place, update) ?? settingsOf(projectId, place)),
    review: (projectId) => at(placeOf(projectId), (place) => reviewOf(projectId, place)),
    approve: (projectId, approval) => at(writablePlaceOf(projectId), (place) => approveAt(projectId, place, approval)),
  }
}

/** What the page is told of a file a Save would write over unseen (#753). */
const PENDING_REASON = {
  changed: 'has changed since you approved it',
  removed: 'is gone since you approved it',
  unapproved: 'has not been approved',
} as const

/**
 * Why a page write to one of the project's own files was not made, with its status — 409 for a file
 * not the version approved, 422 for one that cannot be read or a change refused — or `undefined`
 * when it was (or there was nothing to write). The project's Worktrees settings (#754) and its Web
 * tools (#937) answer alike.
 */
export function tierWriteRefusal(written: ProjectTierWrite): Refusal | undefined {
  if (written.kind === 'pending') {
    return {
      kind: 'refused',
      status: 409,
      reason: `${written.path} ${PENDING_REASON[written.state]}; review and approve it before saving, so nothing is approved unseen`,
    }
  }
  if (written.kind === 'refused') return { kind: 'refused', status: 422, reason: written.reason }
  if (written.kind === 'unreadable') {
    return {
      kind: 'refused',
      status: 422,
      reason: `${written.path} is unreadable (${written.reason}); fix or remove it — it is never overwritten`,
    }
  }
  return undefined
}

/** The tier file written, or why not. */
function writeTier(place: SettingsPlace, update: EnsoProjectSettingsUpdate): Refusal | undefined {
  try {
    return tierWriteRefusal(writeProjectThreadSettings(place.path, update, approvalsPathOf(place.source, place.path)))
  } catch (error: unknown) {
    return {
      kind: 'refused',
      status: 422,
      reason: `the ${update.tier} settings could not be written: ${String(error)}`,
    }
  }
}
