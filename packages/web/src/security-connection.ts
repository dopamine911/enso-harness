import {
  EnsoJudgeKeyState,
  type EnsoJudgeKeyWrite,
  EnsoSecuritySettingsRead,
  type EnsoSecuritySettingsWrite,
} from '@enso/core'
import type { FetchLike } from './browser-logging.ts'
import { sendChecked, type Unavailable } from './permissions-connection.ts'

/**
 * Settings › Security's routes (#933), as the section calls them: read the user's `security`, save
 * it whole under the `ETag` read, and store or remove the judge's key. A failure is data, never a
 * throw: the section says it in the server's words.
 */

export type SecurityRead = { readonly kind: 'loaded'; readonly settings: EnsoSecuritySettingsRead } | Unavailable

export type SecuritySave =
  | { readonly kind: 'saved'; readonly settings: EnsoSecuritySettingsRead }
  /** 412: the file changed on disk since it was read; nothing was written. */
  | { readonly kind: 'conflict'; readonly detail: string }
  /** 422: the file is unreadable, or the result would be; nothing was written. */
  | { readonly kind: 'refused'; readonly detail: string }
  | Unavailable

export type JudgeKeySave = { readonly kind: 'saved'; readonly judgeKeySet: boolean } | Unavailable

const SECURITY_PATH = '/api/settings/security'
const SETTINGS = [EnsoSecuritySettingsRead, 'security settings'] as const

export async function fetchSecuritySettings(fetchImpl: FetchLike = fetch): Promise<SecurityRead> {
  const sent = await sendChecked(fetchImpl, SECURITY_PATH, undefined, SETTINGS)
  return sent.kind === 'ok' ? { kind: 'loaded', settings: sent.payload } : { kind: 'unavailable', detail: sent.detail }
}

/** Save the whole section, if the disk still holds the version `etag` names; none — no file — creates it. */
export async function saveSecuritySettings(
  write: EnsoSecuritySettingsWrite,
  etag: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SecuritySave> {
  const precondition = etag === undefined ? { 'If-None-Match': '*' } : { 'If-Match': etag }
  const sent = await sendChecked(
    fetchImpl,
    SECURITY_PATH,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', ...precondition }, body: JSON.stringify(write) },
    SETTINGS,
  )
  if (sent.kind === 'ok') return { kind: 'saved', settings: sent.payload }
  if (sent.kind === 'answered' && sent.status === 412) return { kind: 'conflict', detail: sent.detail }
  if (sent.kind === 'answered' && sent.status === 422) return { kind: 'refused', detail: sent.detail }
  return { kind: 'unavailable', detail: sent.detail }
}

/** Store the judge's key, or remove it (`null`). The answer is only whether one is set. */
export async function saveJudgeKey(write: EnsoJudgeKeyWrite, fetchImpl: FetchLike = fetch): Promise<JudgeKeySave> {
  const sent = await sendChecked(
    fetchImpl,
    `${SECURITY_PATH}/judge-key`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write) },
    [EnsoJudgeKeyState, 'judge key state'],
  )
  return sent.kind === 'ok'
    ? { kind: 'saved', judgeKeySet: sent.payload.judgeKeySet }
    : { kind: 'unavailable', detail: sent.detail }
}
