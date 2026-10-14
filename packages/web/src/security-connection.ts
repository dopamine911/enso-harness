import {
  EnsoJudgeKeyState,
  type EnsoJudgeKeyWrite,
  EnsoSecuritySettingsRead,
  type EnsoSecuritySettingsWrite,
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
 * Settings › Security's routes (#933), as the section calls them: read the user's `security`, save
 * it whole under the `ETag` read, and store or remove the judge's key. A failure is data, never a
 * throw: the section says it in the server's words.
 */

export type SecurityRead = SettingsFileRead<EnsoSecuritySettingsRead>

export type SecuritySave = SettingsFileSave<EnsoSecuritySettingsRead>

export type JudgeKeySave = { readonly kind: 'saved'; readonly judgeKeySet: boolean } | Unavailable

const SECURITY_PATH = '/api/settings/security'
const SETTINGS = [EnsoSecuritySettingsRead, 'security settings'] as const

export function fetchSecuritySettings(fetchImpl: FetchLike = fetch): Promise<SecurityRead> {
  return fetchSettingsFile(fetchImpl, SECURITY_PATH, SETTINGS)
}

/** Save the whole section, if the disk still holds the version `etag` names; none — no file — creates it. */
export function saveSecuritySettings(
  write: EnsoSecuritySettingsWrite,
  etag: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SecuritySave> {
  return saveSettingsFile(fetchImpl, SECURITY_PATH, { write, etag }, SETTINGS)
}

/** Store the judge's key, or remove it (`null`). The answer is only whether one is set. */
export function saveJudgeKey(write: EnsoJudgeKeyWrite, fetchImpl: FetchLike = fetch): Promise<JudgeKeySave> {
  return saveSideSetting(fetchImpl, `${SECURITY_PATH}/judge-key`, write, [EnsoJudgeKeyState, 'judge key state'])
}
