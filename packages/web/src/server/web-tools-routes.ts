import { lookup } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import {
  type EnsoConfig,
  ensoLogger,
  isPublicIpAddress,
  readWebFetchHostInput,
  TavilyKeyChange,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_USER_AGENT,
  type WebFetchAllowlist,
  WebFetchAllowlistChange,
  type WebFetchHostCheck,
  WebFetchHostCheckRequest,
  type WebFetchProjectHosts,
  type WebToolsProject,
  type WebSearchProjectSettings,
  type WebSearchSettings,
  WebSearchSettingsChange,
} from '@enso/core'
import { projectConfigPath } from '@enso/core/paths'
import { readDotenvFile, writeSecret } from '@enso/core/secrets'
import { readEnsoConfigFile } from '@enso/core/user-config-write'
import { changeUserAllowedHosts } from '@enso/core/web-fetch-allowlist'
import { changeUserWebSearch } from '@enso/core/web-search-settings'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { HostedThread } from '../host/live-thread.ts'
import { projectTrusted } from '../host/project-trust.ts'
import type { ProjectRegistry } from './projects.ts'
import {
  answerJson,
  answerOrFail,
  MAX_DIALOG_BODY_BYTES,
  readClosedJsonBody,
  readJsonBody,
  refuseWith,
} from './request-plumbing.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * Settings › Web tools (#924, #932): the `web_fetch` allowlist, read, changed and checked from the
 * page instead of by hand in `ENSO_HOME/config.json`; and `web_search`'s backend, its Tavily domain
 * lists, and the `TAVILY_API_KEY` secret in `ENSO_HOME/secrets.env` — set, replaced or removed, its
 * value never answered back or logged. ⚠ `scripts/docs/routes.ts` reads the literal routes
 * off the `request.method === … && url === …` conditions below (#174): keep that spelling.
 *
 * ⚠ The page is the only writer here, guarded like every route (#717, `fromTrustedOrigin`); the
 * agent still cannot write the file (the guards refuse writes into `ENSO_HOME`). Only
 * `webFetch.allowedHosts` changes (`@enso/core/web-fetch-allowlist`).
 */

const log = ensoLogger('server', 'http')

/** The secret web_search's Tavily fallback reads per call (`TAVILY_API_KEY_VARIABLE` in the harness). */
const TAVILY_KEY_NAME = 'TAVILY_API_KEY'

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
  /** The user's `ENSO_HOME/secrets.env`, where the Tavily key is set; absent, the key route refuses. */
  readonly userSecretsPath: string | undefined
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
  const { userConfigPath, userSecretsPath, projects, threads, agentDir } = state
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
  /** The same, for the last Searching change: the backend and domains are read at session start too. */
  let onOldSearch = new Map<string, HostedThread>()

  /** Each trusted project's own config, read as a new session there would read it (#421). */
  function trustedProjectConfigs(): (WebToolsProject & { readonly config: EnsoConfig })[] {
    const found: (WebToolsProject & { readonly config: EnsoConfig })[] = []
    for (const project of projects.list()) {
      if (project.status === 'missing-dir' || !projectTrusted(project.path, agentDir)) continue
      const path = projectConfigPath(project.path)
      const parsed = readEnsoConfigFile(path)
      if (parsed.kind === 'ok')
        found.push({ projectId: project.projectId, title: project.title, path, config: parsed.config })
    }
    return found
  }

  /** Each trusted project's own hosts. */
  function projectHosts(): WebFetchProjectHosts[] {
    return trustedProjectConfigs()
      .map(({ config, ...project }) => ({ ...project, hosts: config.webFetch?.allowedHosts ?? [] }))
      .filter((project) => project.hosts.length > 0)
  }

  /** The live threads of `before` still on the session they ran then. */
  function stillOn(before: Map<string, HostedThread>): string[] {
    const live = new Set(threads.list().map((thread) => thread.hosted))
    return [...before].filter(([, hosted]) => live.has(hosted)).map(([threadId]) => threadId)
  }

  function allowlistOf(path: string): WebFetchAllowlist {
    const read = readEnsoConfigFile(path)
    const staleThreads = stillOn(onOldList)
    return {
      path,
      hosts: read.kind === 'ok' ? (read.config.webFetch?.allowedHosts ?? []) : [],
      ...(read.kind === 'unreadable' ? { unreadable: read.reason } : {}),
      projects: projectHosts(),
      staleThreads,
    }
  }

  /** Searching as the user's file holds it, each trusted project's own `webSearch`, and whether the key is set. */
  function searchSettingsOf(path: string, secretsPath: string): WebSearchSettings {
    const read = readEnsoConfigFile(path)
    const search = read.kind === 'ok' ? read.config.webSearch : undefined
    const projectSearch: WebSearchProjectSettings[] = trustedProjectConfigs()
      .filter(({ config }) => config.webSearch !== undefined)
      .map(({ config, ...project }) => ({
        ...project,
        ...(config.webSearch?.backend === undefined ? {} : { backend: config.webSearch.backend }),
        includeDomains: config.webSearch?.tavily?.includeDomains ?? [],
        excludeDomains: config.webSearch?.tavily?.excludeDomains ?? [],
      }))
    let tavilyKeySet = false
    try {
      tavilyKeySet = (readDotenvFile(secretsPath).get(TAVILY_KEY_NAME) ?? '') !== ''
    } catch (error: unknown) {
      log.warn('secrets file unreadable for Settings: {error}', { error: String(error), path: secretsPath })
    }
    return {
      path,
      backend: search?.backend ?? 'model',
      includeDomains: search?.tavily?.includeDomains ?? [],
      excludeDomains: search?.tavily?.excludeDomains ?? [],
      ...(read.kind === 'unreadable' ? { unreadable: read.reason } : {}),
      secretsPath,
      tavilyKeySet,
      projects: projectSearch,
      staleThreads: stillOn(onOldSearch),
    }
  }

  function noConfig(response: ServerResponse): void {
    refuseWith(response, {
      status: 422,
      reason: 'this server reads no user config, so it has no web tools settings to show',
    })
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

  /**
   * A config change from the page: its body read and checked, written by `write`, and answered with
   * `answer()` — the settings as they now stand — or refused with the reason. A write marks the live
   * threads that still run on the settings before it (`onWritten`).
   */
  async function respondToConfigChange<Schema extends TSchema>(
    request: IncomingMessage,
    response: ServerResponse,
    change: {
      readonly body: { readonly schema: Schema; readonly name: string; readonly requirement: string }
      /** What changed, for the log: "web_fetch allowlist". */
      readonly what: string
      readonly write: (body: Static<Schema>) => {
        readonly kind: 'written' | 'unchanged' | 'refused'
        readonly reason?: string
      }
      readonly onWritten: (live: Map<string, HostedThread>) => void
      readonly answer: () => unknown
    },
  ): Promise<void> {
    const body = await readBody(request, response, change.body)
    if (body === undefined) return
    const written = change.write(body)
    if (written.kind === 'written') {
      log.info('{what} changed from Settings: {change}', { what: change.what, change: body })
      change.onWritten(new Map(threads.list().map((thread) => [thread.threadId, thread.hosted])))
    }
    if (written.kind !== 'refused') return answerJson(response, change.answer())
    log.warn('{what} change refused: {reason}', { what: change.what, reason: written.reason })
    refuseWith(response, { status: 422, reason: written.reason ?? 'refused' })
  }

  /** `POST /api/settings/web-fetch`: `{ add }` or `{ remove }`, answered with the list as it now stands. */
  function respondToChange(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return respondToConfigChange(request, response, {
      body: {
        schema: WebFetchAllowlistChange,
        name: 'allowlist change',
        requirement: 'an allowlist change takes exactly `add` or `remove`, a host name',
      },
      what: 'web_fetch allowlist',
      write: (change) => changeUserAllowedHosts(path, change),
      onWritten: (live) => {
        onOldList = live
      },
      answer: () => allowlistOf(path),
    })
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

  /** `POST /api/settings/web-search`: `{ backend }`, or `{ list, add }` / `{ list, remove }`, answered with Searching as it now stands. */
  function respondToSearchChange(
    paths: { config: string; secrets: string },
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    return respondToConfigChange(request, response, {
      body: {
        schema: WebSearchSettingsChange,
        name: 'web search change',
        requirement:
          'a web search change takes exactly `backend` (`model` or `deepseek`), or `list` (`includeDomains` or `excludeDomains`) with `add` or `remove`, a domain',
      },
      what: 'web_search settings',
      write: (change) => changeUserWebSearch(paths.config, change),
      onWritten: (live) => {
        onOldSearch = live
      },
      answer: () => searchSettingsOf(paths.config, paths.secrets),
    })
  }

  /**
   * `POST /api/settings/web-search/tavily-key`: `{ set }` or `{ remove: true }`. ⚠ The key is never
   * answered back nor logged: the answer is Searching, which says only whether a key is set.
   */
  async function respondToTavilyKey(
    paths: { config: string; secrets: string },
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // ⚠ Not `readBody`: a JSON parser's error quotes the text it choked on, which here is the key.
    const requirement = 'a Tavily key change takes exactly `set`, the key, or `remove: true`, as JSON'
    const change = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a Tavily key change is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: (raw: string): TavilyKeyChange => {
        let body: unknown
        try {
          body = JSON.parse(raw)
        } catch {
          throw new Error(requirement)
        }
        if (!Check(TavilyKeyChange, body)) throw new Error(requirement)
        return body
      },
    })
    if (change === undefined) return
    const written = writeSecret(paths.secrets, TAVILY_KEY_NAME, 'set' in change ? change.set : undefined)
    if (written.kind === 'refused') {
      log.warn('Tavily key change refused: {reason}', { reason: written.reason })
      return refuseWith(response, { status: 422, reason: written.reason })
    }
    if (written.kind === 'written')
      log.info('Tavily key {action} from Settings', {
        action: 'set' in change ? 'set' : 'removed',
        path: paths.secrets,
      })
    answerJson(response, searchSettingsOf(paths.config, paths.secrets))
  }

  /** Searching's files: both, or the routes refuse. */
  const searchPaths =
    userConfigPath === undefined || userSecretsPath === undefined
      ? undefined
      : { config: userConfigPath, secrets: userSecretsPath }

  /** A Searching route answered: by `answer` over its files, or refused when this server has none. */
  function withSearchPaths(
    response: ServerResponse,
    answer: (paths: { config: string; secrets: string }) => void,
  ): true {
    if (searchPaths === undefined) noConfig(response)
    else answer(searchPaths)
    return true
  }

  function dispatchWebSearchRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/settings/web-search')
      return withSearchPaths(response, (paths) => answerJson(response, searchSettingsOf(paths.config, paths.secrets)))
    if (request.method === 'POST' && url === '/api/settings/web-search')
      return withSearchPaths(response, (paths) =>
        answerOrFail(respondToSearchChange(paths, request, response), response),
      )
    if (request.method === 'POST' && url === '/api/settings/web-search/tavily-key')
      return withSearchPaths(response, (paths) => answerOrFail(respondToTavilyKey(paths, request, response), response))
    return false
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
    return dispatchWebSearchRoute(request, response)
  }

  return { dispatchWebToolsRoute }
}
