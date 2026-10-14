import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  EnsoPermissionCheckRequest,
  type EnsoPermissionPolicyRead,
  type EnsoPermissionPolicyReset,
  EnsoPermissionPolicyWrite,
  ensoLogger,
} from '@enso/core'
import { readPermissionPolicy, resetPermissionPolicy, writePermissionPolicy } from '../host/permission-policy-file.ts'
import {
  answerJson,
  answerOrFail,
  endAndClose,
  MAX_DIALOG_BODY_BYTES,
  readClosedJsonBody,
  refuseWith,
  type ThreadRouteHandler,
  writeConditionOf,
} from './request-plumbing.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * The permission routes (#474, #810): the policy file read, saved and reset — Settings' permissions
 * page — and a thread's verdict for one call, its "Try a command". ⚠ `scripts/docs/routes.ts` reads
 * the literal routes off the `request.method === … && url …` conditions below (#174): keep that
 * spelling.
 */

const log = ensoLogger('server', 'http')

/** A permission policy is a hand-sized JSON file; a megabyte is far past any real one (#474). */
const MAX_POLICY_BODY_BYTES = 1024 * 1024

/** What the permission routes read from the server (#810): the live threads, and the policy file's place. */
export interface PermissionRoutesState {
  readonly threads: ThreadRegistry
  /** The permission policy file pi runs under (`ENSO_HOME/permissions.json`, #446, #496). */
  readonly permissionRulesPath: string
  readonly agentDir: string
}

/** The permission check's thread route, and the policy's dispatcher (#810). */
export interface PermissionRoutes {
  readonly respondToPermissionCheck: ThreadRouteHandler
  /** True when the request was a permission-policy route (#474). */
  readonly dispatchPermissionRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

export function createPermissionRoutes(state: PermissionRoutesState): PermissionRoutes {
  const { threads, permissionRulesPath, agentDir } = state

  /**
   * `POST /api/threads/:id/permissions/check` (#474, #881): what the thread decides for a value on a
   * surface, in its mode now — the guards' answer, then the engine's. Asked of the REAL guard and
   * engine the session runs (`HostedThread.checkPermission`), never a second matcher in the page. 409
   * when the engine has published no service for the session.
   */
  async function respondToPermissionCheck(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const check = await readClosedJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a permission check is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      schema: EnsoPermissionCheckRequest,
      name: 'permission check',
      requirement: 'a check needs a `surface` and a `value`',
    })
    if (check === undefined) return
    const thread = await threads.ensure(threadId)
    const verdict = thread.hosted.checkPermission(check)
    if (verdict === undefined) {
      refuseWith(response, {
        status: 409,
        reason: `thread ${threadId} has no permission engine loaded: nothing there decides a call`,
      })
      return
    }
    answerJson(response, verdict)
  }

  /** A policy read answered with its `ETag` when there is a file to name one. */
  function answerPolicy(response: ServerResponse, read: EnsoPermissionPolicyRead): void {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      ...(read.etag === undefined ? {} : { ETag: read.etag }),
    })
    response.end(JSON.stringify(read))
  }

  /**
   * `PUT /api/permissions` (#474): the whole file a page sent, under its `If-Match`; normalised,
   * validated against the engine's schema and written atomically (`host/permission-policy-file.ts`),
   * with Enso's record beside it when the page sent one (#945) — both, or neither. 412 when either
   * file changed since the page read them; 422 with each problem when the engine would not run it.
   */
  async function respondToPolicyWrite(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const condition = writeConditionOf(request, 'write', 'permission policy')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    const body = await readClosedJsonBody(request, response, {
      maxBytes: MAX_POLICY_BODY_BYTES,
      capText: `a permission policy is at most ${MAX_POLICY_BODY_BYTES} bytes`,
      schema: EnsoPermissionPolicyWrite,
      name: 'permission policy',
      requirement: 'a save carries `{ file }`, the whole file, and `record`, Enso’s record beside it, when it changed',
    })
    if (body === undefined) return
    const written = writePermissionPolicy(permissionRulesPath, agentDir, body, condition)
    if (written.kind === 'conflict') {
      log.warn('permission policy not saved: {reason}', { reason: written.reason })
      refuseWith(response, { status: 412, reason: written.reason })
      return
    }
    if (written.kind === 'refused') {
      log.warn('permission policy not saved: {reason}', { reason: written.refusal.reason })
      response.writeHead(422, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(written.refusal))
      return
    }
    log.info('permission policy saved to {path}', { path: permissionRulesPath })
    answerPolicy(response, written.read)
  }

  /** `POST /api/permissions/reset` (#474): Enso's default in force, the file it replaced kept beside it. */
  function respondToPolicyReset(request: IncomingMessage, response: ServerResponse): void {
    const condition = writeConditionOf(request, 'write', 'permission policy')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    const reset = resetPermissionPolicy(permissionRulesPath, agentDir, condition)
    if (reset.kind === 'conflict') {
      refuseWith(response, { status: 412, reason: reset.reason })
      return
    }
    log.info('permission policy reset to Enso’s; the previous file is {backup}', { backup: reset.backup ?? 'none' })
    const answer: EnsoPermissionPolicyReset = {
      ...(reset.backup === undefined ? {} : { backup: reset.backup }),
      policy: reset.read,
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      ...(reset.read.etag === undefined ? {} : { ETag: reset.read.etag }),
    })
    response.end(JSON.stringify(answer))
  }

  /** True when the request was a permission-policy route (#474). */
  function dispatchPermissionRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/permissions') {
      answerOrFail(
        Promise.resolve().then(() => answerPolicy(response, readPermissionPolicy(permissionRulesPath, agentDir))),
        response,
      )
      return true
    }
    if (request.method === 'PUT' && url === '/api/permissions') {
      answerOrFail(respondToPolicyWrite(request, response), response)
      return true
    }
    if (request.method === 'POST' && url === '/api/permissions/reset') {
      answerOrFail(
        Promise.resolve().then(() => respondToPolicyReset(request, response)),
        response,
      )
      return true
    }
    return false
  }

  return { respondToPermissionCheck, dispatchPermissionRoute }
}
