import { lookup } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type EnsoConfig,
  ensoLogger,
  type ProjectWebTools,
  ProjectWebToolsChange,
  readWebFetchHostInput,
  TAVILY_API_KEY_VARIABLE,
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
import { changeProjectWebTools } from '@enso/core/project-config'
import { readDotenvFile, writeSecret } from '@enso/core/secrets'
import { readEnsoConfigFile } from '@enso/core/user-config-write'
import { changeUserAllowedHosts, nonPublicAddressReason } from '@enso/core/web-fetch-allowlist'
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
 * agent still cannot write the files (the guards refuse writes into `ENSO_HOME`). Only
 * `webFetch.allowedHosts` (`@enso/core/web-fetch-allowlist`), `webSearch.backend` and
 * `webSearch.tavily.*` (`@enso/core/web-search-settings`) change in `config.json`, and only the
 * `TAVILY_API_KEY` line of `secrets.env` (`writeSecret`).
 *
 * A project page's Web tools tab (#937) reads and changes the same keys in a project's shared
 * `.enso/config.json` (`/api/projects/<projectId>/web-tools`). ⚠ An untrusted project's file is
 * never read — nor written: its tab is read only until the project is trusted.
 */

/** `/api/projects/<projectId>/web-tools` (#937): `GET` reads a project's own web tools, `POST` changes one key. */
const PROJECT_WEB_TOOLS_ROUTE = /^\/api\/projects\/([0-9a-f]{16})\/web-tools$/

/** Why a project's Web tools are not answered or not changed: its status and reason, sent as the body. */
type ProjectRefusal = { readonly status: 404 | 422; readonly reason: string }

const log = ensoLogger('server', 'http')

/**
 * The request's deadline: never held open by a slow host. ⚠ The lookup before it carries none, as in
 * web_fetch's own gate: the system resolver's timeouts bound it.
 */
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
  readonly projects: Pick<ProjectRegistry, 'list' | 'get' | 'byDirectory'>
  readonly threads: Pick<ThreadRegistry, 'list'>
  /** pi's agent dir, whose `trust.json` decides whether a project's own hosts are read. */
  readonly agentDir: string
}

export interface WebToolsRoutes {
  /** True when the request was a web tools route. */
  readonly dispatchWebToolsRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

/**
 * At most one request to `https://<host>/` (#924), as `web_fetch` would make it: none when the host
 * does not resolve or resolves to an address web_fetch's gate refuses (`nonPublicAddressReason`, the
 * tool's own, and advisory as it is: the request resolves the host again); sent with web_fetch's User-Agent, its redirects
 * reported, never followed. ⚠ The answer is the host's, not a page web_fetch is sure to read: the
 * tool still applies its content-type check to each page.
 */
async function checkWebFetchHost(host: string, network: Required<HostCheckNetwork>): Promise<WebFetchHostCheck> {
  const refusedAddress = await nonPublicAddressReason(host, network.checkResolve)
  if (refusedAddress !== undefined)
    return {
      kind: 'failed',
      reason: `${refusedAddress}, so ${WEB_FETCH_TOOL_NAME} would refuse it: it reaches the public web only`,
    }
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

/** A config's own `webFetch` hosts and `webSearch`, as a project's Web tools tab shows them (#937). */
function webToolsOf(config: EnsoConfig): NonNullable<ProjectWebTools['own']> {
  const search = config.webSearch
  return {
    hosts: config.webFetch?.allowedHosts ?? [],
    ...(search?.backend === undefined ? {} : { backend: search.backend }),
    includeDomains: search?.tavily?.includeDomains ?? [],
    excludeDomains: search?.tavily?.excludeDomains ?? [],
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
  /** The same, per project, for the last change on its Web tools tab (#937): its own threads only. */
  const onOldProjectTools = new Map<string, Map<string, HostedThread>>()

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
    let secretsUnreadable: string | undefined
    try {
      tavilyKeySet = (readDotenvFile(secretsPath).get(TAVILY_API_KEY_VARIABLE) ?? '') !== ''
    } catch (error: unknown) {
      // Unknown, not "no key": the page says the file can't be read rather than that there is no fallback.
      secretsUnreadable = String(error)
      log.warn('secrets file unreadable for Settings: {error}', { error: secretsUnreadable, path: secretsPath })
    }
    return {
      path,
      backend: search?.backend ?? 'model',
      includeDomains: search?.tavily?.includeDomains ?? [],
      excludeDomains: search?.tavily?.excludeDomains ?? [],
      ...(read.kind === 'unreadable' ? { unreadable: read.reason } : {}),
      secretsPath,
      tavilyKeySet,
      ...(secretsUnreadable === undefined ? {} : { secretsUnreadable }),
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
      /** The file the change is written to, for the log. */
      readonly path: string
      readonly write: (
        body: Static<Schema>,
      ) => { readonly kind: 'written' | 'unchanged' } | { readonly kind: 'refused'; readonly reason: string }
      readonly onWritten: (live: Map<string, HostedThread>) => void
      readonly answer: () => unknown
    },
  ): Promise<void> {
    const body = await readBody(request, response, change.body)
    if (body === undefined) return
    const written = change.write(body)
    if (written.kind === 'written') {
      log.info('{what} changed from Settings: {change}', { what: change.what, change: body, path: change.path })
      change.onWritten(new Map(threads.list().map((thread) => [thread.threadId, thread.hosted])))
    }
    if (written.kind !== 'refused') return answerJson(response, change.answer())
    log.warn('{what} change refused: {reason}', { what: change.what, reason: written.reason })
    refuseWith(response, { status: 422, reason: written.reason })
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
      path,
      write: (change) => changeUserAllowedHosts(path, change),
      onWritten: (live) => {
        onOldList = live
      },
      answer: () => allowlistOf(path),
    })
  }

  /**
   * `POST /api/settings/web-fetch/check`: `{ host }`, at most one request to it from this server, after
   * a lookup web_fetch's address gate would accept.
   */
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
      path: paths.config,
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
    const written = writeSecret(paths.secrets, TAVILY_API_KEY_VARIABLE, 'set' in change ? change.set : undefined)
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

  /** The project's live threads, by the session each runs: its checkout's and its trees' (#551). */
  function liveThreadsOf(projectId: string): Map<string, HostedThread> {
    return new Map(
      threads
        .list()
        .filter((thread) => projects.byDirectory(thread.hosted.inspect().cwd)?.projectId === projectId)
        .map((thread) => [thread.threadId, thread.hosted]),
    )
  }

  /**
   * A project's Web tools tab (#937): its shared file, read only once the project is trusted, and
   * the user's own settings beside it; or why there is none to answer.
   */
  function projectWebToolsOf(projectId: string): ProjectWebTools | ProjectRefusal {
    const project = projects.get(projectId)
    if (project === undefined) return { status: 404, reason: `no registered project has the id ${projectId}` }
    if (userConfigPath === undefined)
      return { status: 422, reason: 'this server reads no user config, so it has no web tools settings to show' }
    const user = readEnsoConfigFile(userConfigPath)
    const path = projectConfigPath(project.path)
    const trusted = projectTrusted(project.path, agentDir)
    // ⚠ Untrusted, the file is never read (#502, #873): nothing of it is shown.
    const read = trusted ? readEnsoConfigFile(path) : undefined
    const yours = webToolsOf(user.kind === 'ok' ? user.config : {})
    return {
      projectId,
      title: project.title,
      path,
      trusted,
      ...(read?.kind === 'ok' ? { own: webToolsOf(read.config) } : {}),
      ...(read?.kind === 'unreadable' ? { unreadable: read.reason } : {}),
      yours: {
        ...yours,
        path: userConfigPath,
        backend: yours.backend ?? 'model',
        ...(user.kind === 'unreadable' ? { unreadable: user.reason } : {}),
      },
      staleThreads: stillOn(onOldProjectTools.get(projectId) ?? new Map()),
    }
  }

  function answerProjectWebTools(response: ServerResponse, answer: ProjectWebTools | ProjectRefusal): void {
    if ('status' in answer) refuseWith(response, answer)
    else answerJson(response, answer)
  }

  /**
   * `POST /api/projects/<projectId>/web-tools` (#937): one host or Searching key changed in the
   * project's shared `.enso/config.json`, answered with the tab as it now stands. ⚠ Refused for an
   * untrusted project, before its file is read, and for a folder that is gone.
   */
  async function respondToProjectChange(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const change = await readBody(request, response, {
      schema: ProjectWebToolsChange,
      name: 'project web tools change',
      requirement:
        'a project web tools change takes exactly `add` or `remove`, a host name; or a web search change: `backend` (`model` or `deepseek`), or `list` (`includeDomains` or `excludeDomains`) with `add` or `remove`, a domain',
    })
    if (change === undefined) return
    const target = writableProject(projectId)
    const written = 'status' in target ? target : changeProjectWebTools(target.path, change)
    if ('status' in written || written.kind === 'refused') {
      log.warn('project {projectId}: web tools change refused: {reason}', { projectId, reason: written.reason })
      return refuseWith(response, 'status' in written ? written : { status: 422, reason: written.reason })
    }
    if (written.kind === 'written') {
      log.info('project {projectId}: web tools changed from its page: {change}', { projectId, change })
      onOldProjectTools.set(projectId, liveThreadsOf(projectId))
    }
    answerProjectWebTools(response, projectWebToolsOf(projectId))
  }

  /** The project whose file a change may be written to: registered, there, and trusted — or why not. */
  function writableProject(projectId: string): { readonly path: string } | ProjectRefusal {
    const project = projects.get(projectId)
    if (project === undefined) return { status: 404, reason: `no registered project has the id ${projectId}` }
    if (project.status === 'missing-dir')
      return { status: 422, reason: `${project.path} is gone; nothing is written there` }
    if (!projectTrusted(project.path, agentDir))
      return {
        status: 422,
        reason:
          'this project is not trusted, so Enso does not read its .enso/config.json; trust it to change its web tools',
      }
    return { path: project.path }
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
    return dispatchProjectWebToolsRoute(request, response, url) || dispatchWebSearchRoute(request, response)
  }

  /** `GET` and `POST /api/projects/<projectId>/web-tools` (#937). */
  function dispatchProjectWebToolsRoute(request: IncomingMessage, response: ServerResponse, url: string): boolean {
    const projectId = PROJECT_WEB_TOOLS_ROUTE.exec(url)?.[1]
    if (projectId === undefined) return false
    if (request.method === 'GET') answerProjectWebTools(response, projectWebToolsOf(projectId))
    else if (request.method === 'POST') answerOrFail(respondToProjectChange(projectId, request, response), response)
    else return false
    return true
  }

  return { dispatchWebToolsRoute }
}
