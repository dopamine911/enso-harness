import type { EnsoProjectSettings, EnsoProjectSettingsUpdate } from '@enso/core'
import { projectConfigPath, projectLocalConfigPath } from '@enso/core/paths'
import { writeProjectThreadSettings } from '@enso/core/project-config'
import { type ProjectThreadSettingsSource, resolveProjectThreadSettings } from '../host/tree-setup.ts'
import type { ProjectRegistry } from './projects.ts'

/**
 * `GET` and `PUT /api/projects/<projectId>/settings` (#754): the project page's Worktrees section —
 * a new tree's mode, files to copy and setup commands, each with the tier it resolves from — and
 * its edits, written to the tier the operator chooses: the project's shared or local file.
 *
 * ⚠ RESOLVED AS A NEW TREE WOULD BE: from the project's path (never a thread's tree), under pi's
 * trust for that path, its files read fresh. Untrusted, the page shows the user's and the defaults,
 * and says so (`trusted`). A write needs no trust: it is the operator's own action through the page;
 * it is read into a resolution only once the project is trusted.
 */

interface ProjectSettingsRouteDeps {
  readonly projects: Pick<ProjectRegistry, 'get'>
  /** The user's config and its file; absent, the server reads no config and resolves no project settings. */
  readonly source: ProjectThreadSettingsSource | undefined
  /** pi's agent dir, whose `trust.json` decides whether a project's own tiers are read. */
  readonly agentDir: string
}

type Refusal = { readonly kind: 'refused'; readonly status: 404 | 422; readonly reason: string }

/** A route's answer: the settings, or a refusal with its status and its reason, sent as the body. */
export type ProjectSettingsAnswer = { readonly kind: 'settings'; readonly settings: EnsoProjectSettings } | Refusal

/** Where a project's settings are answered from: its canonical path, and the user's config. */
interface SettingsPlace {
  readonly path: string
  readonly missing: boolean
  readonly source: ProjectThreadSettingsSource
}

/**
 * The two routes' answers, HTTP aside: 404 for a project this server has not registered, 422 for a
 * write that cannot be made (an unreadable tier file, never overwritten; a directory that is gone).
 */
export function createProjectSettingsRoute(deps: ProjectSettingsRouteDeps): {
  read(projectId: string): ProjectSettingsAnswer
  write(projectId: string, update: EnsoProjectSettingsUpdate): ProjectSettingsAnswer
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

  return {
    read(projectId) {
      const place = placeOf(projectId)
      return 'kind' in place ? place : settingsOf(projectId, place)
    },
    write(projectId, update) {
      const place = placeOf(projectId)
      if ('kind' in place) return place
      // ⚠ Never into a directory that is gone: the write would make the project's directory again.
      if (place.missing)
        return { kind: 'refused', status: 422, reason: `${place.path} is gone; nothing is written there` }
      return writeTier(place.path, update) ?? settingsOf(projectId, place)
    },
  }
}

/** The tier file written, or why not. */
function writeTier(path: string, update: EnsoProjectSettingsUpdate): Refusal | undefined {
  try {
    const written = writeProjectThreadSettings(path, update)
    if (written.kind === 'written') return undefined
    return {
      kind: 'refused',
      status: 422,
      reason: `${written.path} is unreadable (${written.reason}); fix or remove it — it is never overwritten`,
    }
  } catch (error: unknown) {
    return {
      kind: 'refused',
      status: 422,
      reason: `the ${update.tier} settings could not be written: ${String(error)}`,
    }
  }
}
