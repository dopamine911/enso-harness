import {
  type EnsoPermissionCheckRequest,
  EnsoPermissionPolicyRead,
  EnsoPermissionPolicyRefusal,
  EnsoPermissionPolicyReset,
  type EnsoPermissionPolicyWrite,
  EnsoPermissionVerdict,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'

/**
 * The permission policy's routes (#474), as Settings' Permissions section calls them: read the
 * user's `ENSO_HOME/permissions.json`, write it whole under the ETag read, reset it to Enso's, and
 * ask a live thread's engine for its verdict on a value. Each payload is checked against the wire's
 * own schema, as `prompt-library-connection.ts` checks the prompt library's.
 *
 * A failure is data, never a throw: the section says it where it happened, in the server's words.
 */

export type PolicyRead =
  | { readonly kind: 'loaded'; readonly policy: EnsoPermissionPolicyRead }
  | { readonly kind: 'unavailable'; readonly detail: string }

/** The file changed on disk since it was read (412): nothing was written. */
export type PolicyConflict = { readonly kind: 'conflict'; readonly detail: string }

export type PolicySave =
  | { readonly kind: 'saved'; readonly policy: EnsoPermissionPolicyRead }
  | PolicyConflict
  /** The engine's schema refused the file (422): nothing was written, and each problem says where. */
  | { readonly kind: 'refused'; readonly refusal: EnsoPermissionPolicyRefusal }
  | { readonly kind: 'unavailable'; readonly detail: string }

export type PolicyResetOutcome =
  | { readonly kind: 'reset'; readonly reset: EnsoPermissionPolicyReset }
  | PolicyConflict
  | { readonly kind: 'unavailable'; readonly detail: string }

export type PermissionCheck =
  | { readonly kind: 'verdict'; readonly verdict: EnsoPermissionVerdict }
  /** 409: the thread's permission engine has published no service to ask. */
  | { readonly kind: 'not-live'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string }

const POLICY_PATH = '/api/permissions'

/** A non-2xx as the words the section shows: the server's `{ reason }` is written for a person. */
function reasonOf(body: string, status: number): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return `the server answered ${status}`
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && 'reason' in parsed && typeof parsed.reason === 'string') {
      return parsed.reason
    }
  } catch {
    // Not JSON: a proxy's or a fault's page, shown as it came.
  }
  return trimmed
}

type Unavailable = { readonly kind: 'unavailable'; readonly detail: string }

const failed = (failure: unknown): Unavailable => ({
  kind: 'unavailable',
  detail: failure instanceof Error ? failure.message : String(failure),
})

/** A 2xx body checked against `schema`; `what` names it when it does not match. */
async function checkedBody<Schema extends TSchema>(
  response: Response,
  schema: Schema,
  what: string,
): Promise<{ readonly kind: 'ok'; readonly payload: Static<Schema> } | Unavailable> {
  const payload: unknown = await response.json()
  return Check(schema, payload)
    ? { kind: 'ok', payload }
    : { kind: 'unavailable', detail: `the server's ${what} did not match its schema` }
}

/** The policy file as the server reads it, or why it cannot. */
export async function fetchPermissionPolicy(fetchImpl: FetchLike = fetch): Promise<PolicyRead> {
  try {
    const response = await fetchImpl(POLICY_PATH)
    if (!response.ok) return { kind: 'unavailable', detail: reasonOf(await response.text(), response.status) }
    const body = await checkedBody(response, EnsoPermissionPolicyRead, 'policy')
    return body.kind === 'ok' ? { kind: 'loaded', policy: body.payload } : body
  } catch (failure: unknown) {
    return failed(failure)
  }
}

/** A 422's refusal, when its body is one; otherwise the words it carried. */
function refusalOf(body: string, status: number): PolicySave {
  try {
    const parsed: unknown = JSON.parse(body)
    if (Check(EnsoPermissionPolicyRefusal, parsed)) return { kind: 'refused', refusal: parsed }
  } catch {
    // Not the refusal's shape: said as the server's words below.
  }
  return { kind: 'unavailable', detail: reasonOf(body, status) }
}

/** Write the whole file, if the disk still holds the version `etag` names (`*`: whatever is there). */
export async function savePermissionPolicy(
  write: EnsoPermissionPolicyWrite,
  etag: string,
  fetchImpl: FetchLike = fetch,
): Promise<PolicySave> {
  try {
    const response = await fetchImpl(POLICY_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(write),
    })
    if (response.ok) {
      const body = await checkedBody(response, EnsoPermissionPolicyRead, 'policy')
      return body.kind === 'ok' ? { kind: 'saved', policy: body.payload } : body
    }
    const text = await response.text()
    if (response.status === 412) return { kind: 'conflict', detail: reasonOf(text, response.status) }
    if (response.status === 422) return refusalOf(text, response.status)
    return { kind: 'unavailable', detail: reasonOf(text, response.status) }
  } catch (failure: unknown) {
    return failed(failure)
  }
}

/**
 * Put Enso's default policy in force, keeping the file it replaces as a backup. `etag` is the
 * version read; with none (no file there) the reset is a create, `If-None-Match: *`.
 */
export async function resetPermissionPolicy(
  etag: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<PolicyResetOutcome> {
  try {
    const response = await fetchImpl(`${POLICY_PATH}/reset`, {
      method: 'POST',
      headers: etag === undefined ? { 'If-None-Match': '*' } : { 'If-Match': etag },
    })
    if (response.ok) {
      const body = await checkedBody(response, EnsoPermissionPolicyReset, 'reset')
      return body.kind === 'ok' ? { kind: 'reset', reset: body.payload } : body
    }
    const detail = reasonOf(await response.text(), response.status)
    return response.status === 412 ? { kind: 'conflict', detail } : { kind: 'unavailable', detail }
  } catch (failure: unknown) {
    return failed(failure)
  }
}

/** The engine's own verdict on `request` for `threadId`, in that thread's current mode. */
export async function checkPermission(
  threadId: string,
  request: EnsoPermissionCheckRequest,
  fetchImpl: FetchLike = fetch,
): Promise<PermissionCheck> {
  try {
    const response = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/permissions/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (response.ok) {
      const body = await checkedBody(response, EnsoPermissionVerdict, 'verdict')
      return body.kind === 'ok' ? { kind: 'verdict', verdict: body.payload } : body
    }
    const detail = reasonOf(await response.text(), response.status)
    return response.status === 409 ? { kind: 'not-live', detail } : { kind: 'unavailable', detail }
  } catch (failure: unknown) {
    return failed(failure)
  }
}
