import {
  type EnsoDefaultProjectTrust,
  EnsoDefaultProjectTrustState,
  EnsoProjectsSettingsRead,
  type EnsoProjectsSettingsWrite,
} from '@enso/core'
import type { FetchLike } from './browser-logging.ts'
import type { Unavailable } from './permissions-connection.ts'
import {
  fetchSettingsFile,
  type SettingsFileRead,
  type SettingsFileSave,
  saveSettingsFile,
  saveSideSetting,
} from './settings-file-connection.ts'

/**
 * Settings › Projects & threads' routes (#934), as the section calls them: read the user's
 * `projects` and `threads`, save them whole under the `ETag` read, and set the trust an undecided
 * project gets. A failure is data, never a throw: the section says it in the server's words.
 */

export type DefaultTrustSave =
  | { readonly kind: 'saved'; readonly defaultProjectTrust: EnsoDefaultProjectTrust }
  | Unavailable

const PROJECTS_SETTINGS_PATH = '/api/settings/projects'
const SETTINGS = [EnsoProjectsSettingsRead, 'projects settings'] as const

export function fetchProjectsSettings(
  fetchImpl: FetchLike = fetch,
): Promise<SettingsFileRead<EnsoProjectsSettingsRead>> {
  return fetchSettingsFile(fetchImpl, PROJECTS_SETTINGS_PATH, SETTINGS)
}

/** Save both sections, if the disk still holds the version `etag` names; none — no file — creates it. */
export function saveProjectsSettings(
  write: EnsoProjectsSettingsWrite,
  etag: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SettingsFileSave<EnsoProjectsSettingsRead>> {
  return saveSettingsFile(fetchImpl, PROJECTS_SETTINGS_PATH, { write, etag }, SETTINGS)
}

/** Set pi's `defaultProjectTrust`; the answer is the value read back. */
export function saveDefaultProjectTrust(
  defaultProjectTrust: EnsoDefaultProjectTrust,
  fetchImpl: FetchLike = fetch,
): Promise<DefaultTrustSave> {
  return saveSideSetting(fetchImpl, `${PROJECTS_SETTINGS_PATH}/trust`, { defaultProjectTrust }, [
    EnsoDefaultProjectTrustState,
    'default project trust',
  ])
}
