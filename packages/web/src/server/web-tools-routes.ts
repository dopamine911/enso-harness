import { lookup } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import {
  ensoLogger,
  isPublicIpAddress,
  readWebFetchHostInput,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_USER_AGENT,
  type WebFetchAllowlist,
  WebFetchAllowlistChange,
  type WebFetchHostCheck,
  WebFetchHostCheckRequest,
  type WebFetchProjectHosts,
} from '@enso/core'
import { projectConfigPath } from '@enso/core/paths'
import { changeUserAllowedHosts, readEnsoConfigFile } from '@enso/core/web-fetch-allowlist'
import type { Static, TSchema } from 'typebox'
import type { HostedThread } from '../host/live-thread.ts'
import { projectTrusted } from '../host/project-trust.ts'
import type { ProjectRegistry } from './projects.ts'
import { answerJson, answerOrFail, MAX_DIALOG_BODY_BYTES, readClosedJsonBody, refuseWith } from './request-plumbing.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * Settings › Web tools (#924): the `web_fetch` allowlist, read, changed and checked from the page
 * instead of by hand in `ENSO_HOME/config.json`. ⚠ `scripts/docs/routes.ts` reads the literal routes
 * off the `request.method === … && url === …` conditions below (#174): keep that spelling.
 *
 * ⚠ The page is the only writer here, guarded like every route (#717, `fromTrustedOrigin`); the
 * agent still cannot write the file (the guards refuse writes into `ENSO_HOME`). Only
 * `webFetch.allowedHosts` changes (`@enso/core/web-fetch-allowlist`).
 */

const log = ensoLogger('server', 'http')

/** The check's whole deadline: one request, never held open by a slow host. */
const HOST_CHECK_TIMEOUT_MS = 10_000

/** The check's one request; injectable so a test answers it without the network. */
export type HostCheckFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: { 'user-agent': string } },
) => Promise<Response>

/** The check's lookup of the host's addresses; injectable so a test answers it without DNS. Rejects when it does not resolve. */
export type HostCheckResolve = (host: string) => Promise<string[]>

/** The check's network, each part injectable so a test answers it without one. */
export interface HostCheckNetwork {
  readonly checkFetch?: HostCheckFetch
  readonly checkResolve?: HostCheckResolve
}

export interface WebToolsRoutesState extends HostCheckNetwork {
  /** The user's `ENSO_HOME/config.json`; absent, the routes refuse (tests that start no config). */
  readonly userConfigPath: string | undefined
  readonly projects: Pick<ProjectRegistry, 'list'>
  readonly threads: Pick<ThreadRegistry, 'list'>
  /** pi's agent dir, whose `trust.json` decides whether a project's own hosts are read. */
  readonly agentDir: string
}

export interface WebToolsRoutes {
  /** True when the request was a web tools route. */
  readonly dispatchWebToolsRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

/**
 * Why web_fetch would refuse `host` by its addresses — it reaches the public web only, as its own
 * gate decides (`isPublicIpAddress`) — or undefined when they are all public. An IP literal is
 * classified as it is.
 */
async function nonPublicReason(host: string, checkResolve: HostCheckResolve): Promise<string | undefined> {
  let addresses: readonly string[]
  try {
    addresses = isIP(host) === 0 ? await checkResolve(host) : [host]
  } catch (error: unknown) {
    return `${host} did not resolve: ${String(error)}`
  }
  const nonPublic = addresses.find((address) => !isPublicIpAddress(address))
  if (addresses.length > 0 && nonPublic === undefined) return undefined
  return `${host} resolves to a non-public address${nonPublic === undefined ? '' : ` (${nonPublic})`}, so ${WEB_FETCH_TOOL_NAME} would refuse it: it reaches the public web only`
}

/**
 * The one request to `https://<host>/` (#924), as `web_fetch` would make it: refused when the host
 * resolves to an address web_fetch refuses (the server never asks a private one), sent with
 * web_fetch's User-Agent, its redirects reported, never followed. ⚠ The answer is the host's, not a
 * page web_fetch is sure to read: the tool still applies its content-type check to each page.
 */
async function checkWebFetchHost(host: string, network: Required<HostCheckNetwork>): Promise<WebFetchHostCheck> {
  const refusedAddress = await nonPublicReason(host, network.checkResolve)
  if (refusedAddress !== undefined) return { kind: 'failed', reason: refusedAddress }
  const url = `https://${host}/`
  let response: Response
  try {
    response = await network.checkFetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HOST_CHECK_TIMEOUT_MS),
      headers: { 'user-agent': WEB_FETCH_USER_AGENT },
    })
  } catch (error: unknown) {
    return { kind: 'failed', reason: `${url} did not answer: ${String(error)}` }
  }
  await response.body?.cancel()
  if (response.status < 300 || response.status > 399) return { kind: 'answered', status: response.status }
  const location = response.headers.get('location')
  let target: URL | undefined
  try {
    target = location === null ? undefined : new URL(location, url)
  } catch {
    target = undefined
  }
  if (target === undefined) return { kind: 'redirect', status: response.status }
  const suggested = /^https?:$/.test(target.protocol) ? readWebFetchHostInput(target.hostname) : undefined
  return {
    kind: 'redirect',
    status: response.status,
    target: target.href,
    ...(suggested?.kind === 'host' && suggested.host !== host ? { suggestedHost: suggested.host } : {}),
  }
}

export function createWebToolsRoutes(state: WebToolsRoutesState): WebToolsRoutes {
  const { userConfigPath, projects, threads, agentDir } = state
  const network: Required<HostCheckNetwork> = {
    checkFetch:
      state.checkFetch ??
      ((url, init) => fetch(url, { redirect: 'manual', signal: init.signal, headers: init.headers })),
    checkResolve:
      state.checkResolve ?? (async (host) => (await lookup(host, { all: true })).map((found) => found.address)),
  }
  /**
   * The live threads when the list last changed here, by the session they ran: a thread still on
   * that session reads the old list (it is read at session start), one rebuilt since does not.
   */
  let onOldList = new Map<string, HostedThread>()

  /** Each trusted project's own hosts, read as a new session there would read them (#421). */
  function projectHosts(): WebFetchProjectHosts[] {
    const found: WebFetchProjectHosts[] = []
    for (const project of projects.list()) {
      if (project.status === 'missing-dir' || !projectTrusted(project.path, agentDir)) continue
      const path = projectConfigPath(project.path)
      const parsed = readEnsoConfigFile(path)
      const hosts = parsed.kind === 'ok' ? (parsed.config.webFetch?.allowedHosts ?? []) : []
      if (hosts.length > 0) found.push({ projectId: project.projectId, title: project.title, path, hosts })
    }
    return found
  }

  function allowlistOf(path: string): WebFetchAllowlist {
    const read = readEnsoConfigFile(path)
    const live = new Set(threads.list().map((thread) => thread.hosted))
    const staleThreads = [...onOldList].filter(([, hosted]) => live.has(hosted)).map(([threadId]) => threadId)
    return {
      path,
      hosts: read.kind === 'ok' ? (read.config.webFetch?.allowedHosts ?? []) : [],
      ...(read.kind === 'unreadable' ? { unreadable: read.reason } : {}),
      projects: projectHosts(),
      staleThreads,
    }
  }

  function noConfig(response: ServerResponse): void {
    refuseWith(response, { status: 422, reason: 'this server reads no user config, so it has no allowlist to show' })
  }

  /** A web tools request's body: at most `MAX_DIALOG_BODY_BYTES` and exactly `schema`, else its 413 or 400 is answered. */
  function readBody<Schema extends TSchema>(
    request: IncomingMessage,
    response: ServerResponse,
    body: { readonly schema: Schema; readonly name: string; readonly requirement: string },
  ): Promise<Static<Schema> | undefined> {
    const capText = `the ${body.name} is at most ${MAX_DIALOG_BODY_BYTES} bytes`
    return readClosedJsonBody(request, response, { maxBytes: MAX_DIALOG_BODY_BYTES, capText, ...body })
  }

  /** `POST /api/settings/web-fetch`: `{ add }` or `{ remove }`, answered with the list as it now stands. */
  async function respondToChange(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requirement = 'an allowlist change takes exactly `add` or `remove`, a host name'
    const change = await readBody(request, response, {
      schema: WebFetchAllowlistChange,
      name: 'allowlist change',
      requirement,
    })
    if (change === undefined) return
    const written = changeUserAllowedHosts(path, change)
    if (written.kind === 'written') {
      log.info('web_fetch allowlist changed from Settings: {change}', { change, path })
      onOldList = new Map(threads.list().map((thread) => [thread.threadId, thread.hosted]))
    }
    if (written.kind !== 'refused') return answerJson(response, allowlistOf(path))
    log.warn('web_fetch allowlist change refused: {reason}', { reason: written.reason })
    refuseWith(response, { status: 422, reason: written.reason })
  }

  /** `POST /api/settings/web-fetch/check`: `{ host }`, one request to it from this server. */
  async function respondToCheck(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requirement = 'a host check takes exactly `host`, a host name'
    const asked = await readBody(request, response, {
      schema: WebFetchHostCheckRequest,
      name: 'host check',
      requirement,
    })
    if (asked === undefined) return
    const typed = readWebFetchHostInput(asked.host)
    if (typed.kind === 'host' && typed.host === asked.host)
      return answerJson(response, await checkWebFetchHost(typed.host, network))
    refuseWith(response, { status: 422, reason: typed.kind === 'refused' ? typed.reason : 'check the host itself' })
  }

  function dispatchWebToolsRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/settings/web-fetch') {
      if (userConfigPath === undefined) noConfig(response)
      else answerJson(response, allowlistOf(userConfigPath))
      return true
    }
    if (request.method === 'POST' && url === '/api/settings/web-fetch') {
      if (userConfigPath === undefined) noConfig(response)
      else answerOrFail(respondToChange(userConfigPath, request, response), response)
      return true
    }
    if (request.method === 'POST' && url === '/api/settings/web-fetch/check') {
      answerOrFail(respondToCheck(request, response), response)
      return true
    }
    return false
  }

  return { dispatchWebToolsRoute }
}
