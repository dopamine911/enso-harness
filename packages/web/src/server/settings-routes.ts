import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  EnsoDefaultProjectTrustState,
  EnsoJudgeKeyWrite,
  type EnsoProjectsSettingsRead,
  EnsoProjectsSettingsWrite,
  type EnsoSecuritySettingsRead,
  EnsoSecuritySettingsWrite,
  ensoLogger,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import type { ConfigSectionWrite } from '../host/config-file.ts'
import type { WriteCondition } from '../host/permission-policy-file.ts'
import { writeDefaultProjectTrust } from '../host/project-trust.ts'
import { readProjectsSettings, writeProjectsSettings } from '../host/projects-config-file.ts'
import { readSecuritySettings, writeJudgeKey, writeSecuritySettings } from '../host/security-config-file.ts'
import {
  answerJson,
  answerWithEtag,
  conditionOrRefuse,
  MAX_DIALOG_BODY_BYTES,
  readClosedJsonBody,
  refuseWith,
  withServed,
  type WriteSubject,
} from './request-plumbing.ts'

/**
 * Settings' server-side files, user only — there is no project form of any of them:
 *
 * - Security (#933): the user's `config.json` `security` section, read and saved whole under its
 *   `ETag`, and the command judge's key stored in `secrets.env` — never answered.
 * - Projects & threads (#934): the same file's `projects` (the roots fence) and `threads` (the user
 *   tier of a new thread's tree), and pi's `defaultProjectTrust`, set through pi's own writer.
 *
 * ⚠ `scripts/docs/routes.ts` reads the literal routes off the `request.method === … && url …`
 * conditions below (#174): keep that spelling.
 */

const log = ensoLogger('server', 'http')

export interface SettingsRoutesState {
  /** `ENSO_HOME`: its `config.json` and `secrets.env`. Absent (tests), the routes refuse. */
  readonly ensoHome: string | undefined
  /** pi's agent directory, whose `settings.json` holds `defaultProjectTrust`. */
  readonly agentDir: string
}

export interface SettingsRoutes {
  /** True when the request was a settings route. */
  readonly dispatchSettingsRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

/** Every settings body is a handful of keys: the dialog cap, the subject and what a save must carry. */
function readSettingsBody<Schema extends TSchema>(
  request: IncomingMessage,
  response: ServerResponse,
  schema: Schema,
  [name, requirement]: readonly [string, string],
): Promise<Static<Schema> | undefined> {
  const capText = `a ${name} save is at most ${MAX_DIALOG_BODY_BYTES} bytes`
  return readClosedJsonBody(request, response, { maxBytes: MAX_DIALOG_BODY_BYTES, capText, schema, name, requirement })
}

/** Where the settings files are: `ENSO_HOME`, and pi's agent dir. */
interface SettingsPlaces {
  readonly home: string
  readonly agentDir: string
}

/** A `config.json` section's routes: its read, and its save's body, words and write. */
interface ConfigSection<Schema extends TSchema, Read extends { path: string; etag?: string }> {
  readonly subject: WriteSubject
  readonly schema: Schema
  readonly requirement: string
  readonly read: (places: SettingsPlaces) => Read
  readonly write: (places: SettingsPlaces, body: Static<Schema>, condition: WriteCondition) => ConfigSectionWrite<Read>
}

const SECURITY_SECTION: ConfigSection<typeof EnsoSecuritySettingsWrite, EnsoSecuritySettingsRead> = {
  subject: 'security settings',
  schema: EnsoSecuritySettingsWrite,
  requirement: 'a save carries `{ security }`, the whole section, each key one `config.json` declares',
  read: ({ home }) => readSecuritySettings(home),
  write: ({ home }, body, condition) => writeSecuritySettings(home, body.security, condition),
}

const PROJECTS_SECTION: ConfigSection<typeof EnsoProjectsSettingsWrite, EnsoProjectsSettingsRead> = {
  subject: 'projects settings',
  schema: EnsoProjectsSettingsWrite,
  requirement: 'a save carries `{ projects?, threads }`, each section whole, each key one `config.json` declares',
  read: ({ home, agentDir }) => readProjectsSettings(home, agentDir),
  write: ({ home, agentDir }, body, condition) => writeProjectsSettings(home, agentDir, body, condition),
}

/**
 * A `config.json` section's read, with the file's `ETag`; or its save, under the page's `If-Match`
 * (or `If-None-Match: *` when there was no file): 412 when the file changed since it was read, 422
 * when it is refused — the file is unreadable now, or the result would be, or the section's own
 * check fails — nothing written either way; else 200 with the new read and its `ETag`.
 */
async function respondToConfigSection<Schema extends TSchema, Read extends { path: string; etag?: string }>(
  request: IncomingMessage,
  response: ServerResponse,
  places: SettingsPlaces,
  section: ConfigSection<Schema, Read>,
): Promise<void> {
  if (request.method === 'GET') {
    const read = section.read(places)
    answerWithEtag(response, read, read.etag)
    return
  }
  const condition = conditionOrRefuse(request, response, section.subject)
  if (condition === undefined) return
  const body = await readSettingsBody(request, response, section.schema, [section.subject, section.requirement])
  if (body === undefined) return
  const written = section.write(places, body, condition)
  if (written.kind !== 'written') {
    log.warn('{subject} not saved: {reason}', { subject: section.subject, reason: written.reason })
    refuseWith(response, { status: written.kind === 'conflict' ? 412 : 422, reason: written.reason })
    return
  }
  log.info('{subject} saved to {path}', { subject: section.subject, path: written.read.path })
  answerWithEtag(response, written.read, written.read.etag)
}

/**
 * A write beside the file (the judge's key, the trust default): no precondition, 422 when refused,
 * else 200 with what it wrote — everything but `kind` — and `said` logged.
 */
async function respondToSideWrite<Schema extends TSchema, Answer extends object>(
  request: IncomingMessage,
  response: ServerResponse,
  save: {
    readonly subject: readonly [string, string]
    readonly schema: Schema
    readonly write: (
      body: Static<Schema>,
    ) => Promise<({ readonly kind: 'written' } & Answer) | { readonly kind: 'refused'; readonly reason: string }>
    readonly said: (body: Static<Schema>) => readonly [string, Record<string, string>]
  },
): Promise<void> {
  const body = await readSettingsBody(request, response, save.schema, save.subject)
  if (body === undefined) return
  const written = await save.write(body)
  if (written.kind === 'refused') {
    refuseWith(response, { status: 422, reason: written.reason })
    return
  }
  log.info(...save.said(body))
  const { kind: _written, ...answer } = written
  answerJson(response, answer)
}

export function createSettingsRoutes(state: SettingsRoutesState): SettingsRoutes {
  const { ensoHome, agentDir } = state

  /** The routes need the home; a server started without one says so instead of guessing a path. */
  function withHome(
    request: IncomingMessage,
    response: ServerResponse,
    work: (home: string) => void | Promise<void>,
  ): true {
    return withServed(
      request,
      response,
      [ensoHome, 'this server was started without ENSO_HOME: no settings files'],
      work,
    )
  }

  function dispatchSettingsRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    const section = <Schema extends TSchema, Read extends { path: string; etag?: string }>(
      config: ConfigSection<Schema, Read>,
    ): true =>
      withHome(request, response, (home) => respondToConfigSection(request, response, { home, agentDir }, config))
    if (request.method === 'GET' && url === '/api/settings/security') return section(SECURITY_SECTION)
    if (request.method === 'PUT' && url === '/api/settings/security') return section(SECURITY_SECTION)
    if (request.method === 'PUT' && url === '/api/settings/security/judge-key') {
      // The answer is only whether a key is set: the value is never logged or sent back.
      return withHome(request, response, (home) =>
        respondToSideWrite(request, response, {
          subject: ['judge key', 'a save carries `{ value }`: the key, or `null` to remove it'],
          schema: EnsoJudgeKeyWrite,
          write: async (body) => writeJudgeKey(home, body.value),
          said: (body) => [
            'the command judge key was {change}',
            { change: body.value === null ? 'removed' : 'stored' },
          ],
        }),
      )
    }
    if (request.method === 'GET' && url === '/api/settings/projects') return section(PROJECTS_SECTION)
    if (request.method === 'PUT' && url === '/api/settings/projects') return section(PROJECTS_SECTION)
    if (request.method === 'PUT' && url === '/api/settings/projects/trust') {
      return withHome(request, response, () =>
        respondToSideWrite(request, response, {
          subject: ['default project trust', 'a save carries `{ defaultProjectTrust }`: `ask`, `always` or `never`'],
          schema: EnsoDefaultProjectTrustState,
          write: (body) => writeDefaultProjectTrust(agentDir, body.defaultProjectTrust),
          said: (body) => ['default project trust set to {value}', { value: body.defaultProjectTrust }],
        }),
      )
    }
    return false
  }

  return { dispatchSettingsRoute }
}
