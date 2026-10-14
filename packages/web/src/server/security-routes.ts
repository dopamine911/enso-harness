import type { IncomingMessage, ServerResponse } from 'node:http'
import { EnsoJudgeKeyWrite, EnsoSecuritySettingsWrite, ensoLogger } from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { readSecuritySettings, writeJudgeKey, writeSecuritySettings } from '../host/security-config-file.ts'
import {
  answerJson,
  answerOrFail,
  answerWithEtag,
  conditionOrRefuse,
  endAndClose,
  MAX_DIALOG_BODY_BYTES,
  readClosedJsonBody,
  refuseWith,
} from './request-plumbing.ts'

/**
 * Settings › Security's routes (#933): the user's `config.json` `security` section read and saved
 * whole under its `ETag`, and the command judge's key stored in `secrets.env` — never answered. User
 * only: there is no project form of either. ⚠ `scripts/docs/routes.ts` reads the literal routes off
 * the `request.method === … && url …` conditions below (#174): keep that spelling.
 */

const log = ensoLogger('server', 'http')

export interface SecurityRoutesState {
  /** `ENSO_HOME`: its `config.json` and `secrets.env`. Absent (tests), the routes refuse. */
  readonly ensoHome: string | undefined
}

export interface SecurityRoutes {
  /** True when the request was a security-settings route. */
  readonly dispatchSecurityRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

/** Both bodies are a handful of keys: the dialog cap, the subject and what a save must carry. */
function readSettingsBody<Schema extends TSchema>(
  request: IncomingMessage,
  response: ServerResponse,
  schema: Schema,
  [name, requirement]: readonly [string, string],
): Promise<Static<Schema> | undefined> {
  const capText = `a ${name} save is at most ${MAX_DIALOG_BODY_BYTES} bytes`
  return readClosedJsonBody(request, response, { maxBytes: MAX_DIALOG_BODY_BYTES, capText, schema, name, requirement })
}

/**
 * `PUT /api/settings/security`: the whole `security` section, under the page's `If-Match` (or
 * `If-None-Match: *` when there was no file). 412 when the file changed since it was read; 422 when
 * the file is unreadable now or the result would be — nothing written either way.
 */
async function respondToSettingsWrite(home: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const condition = conditionOrRefuse(request, response, 'security settings')
  if (condition === undefined) return
  const body = await readSettingsBody(request, response, EnsoSecuritySettingsWrite, [
    'security settings',
    'a save carries `{ security }`, the whole section, each key one `config.json` declares',
  ])
  if (body === undefined) return
  const written = writeSecuritySettings(home, body.security, condition)
  if (written.kind !== 'written') {
    log.warn('security settings not saved: {reason}', { reason: written.reason })
    refuseWith(response, { status: written.kind === 'conflict' ? 412 : 422, reason: written.reason })
    return
  }
  log.info('security settings saved to {path}', { path: written.read.path })
  answerWithEtag(response, written.read, written.read.etag)
}

/** `PUT /api/settings/security/judge-key`: store or remove the key; the answer is only whether one is set. */
async function respondToJudgeKeyWrite(home: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readSettingsBody(request, response, EnsoJudgeKeyWrite, [
    'judge key',
    'a save carries `{ value }`: the key, or `null` to remove it',
  ])
  if (body === undefined) return
  const written = writeJudgeKey(home, body.value)
  if (written.kind === 'refused') {
    refuseWith(response, { status: 422, reason: written.reason })
    return
  }
  log.info('the command judge key was {change}', { change: body.value === null ? 'removed' : 'stored' })
  answerJson(response, { judgeKeySet: written.judgeKeySet })
}

export function createSecurityRoutes(state: SecurityRoutesState): SecurityRoutes {
  const { ensoHome } = state

  /** The routes need the home; a server started without one says so instead of guessing a path. */
  function withHome(
    request: IncomingMessage,
    response: ServerResponse,
    work: (home: string) => void | Promise<void>,
  ): void {
    if (ensoHome === undefined) {
      endAndClose(request, response, 404, 'this server was started without ENSO_HOME: no settings files')
      return
    }
    answerOrFail(
      Promise.resolve().then(() => work(ensoHome)),
      response,
    )
  }

  function dispatchSecurityRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/settings/security') {
      withHome(request, response, (home) => {
        const read = readSecuritySettings(home)
        answerWithEtag(response, read, read.etag)
      })
      return true
    }
    if (request.method === 'PUT' && url === '/api/settings/security') {
      withHome(request, response, (home) => respondToSettingsWrite(home, request, response))
      return true
    }
    if (request.method === 'PUT' && url === '/api/settings/security/judge-key') {
      withHome(request, response, (home) => respondToJudgeKeyWrite(home, request, response))
      return true
    }
    return false
  }

  return { dispatchSecurityRoute }
}
