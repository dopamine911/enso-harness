import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  ENSO_CONFIG_EXAMPLE,
  ENSO_CONFIG_FILENAME,
  type EnsoConfigParseResult,
  EXTERNAL_WEB_CONTENT_NOTICE,
  ensoLogger,
  parseEnsoConfig,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_TOOL_NAME,
  WebFetchToolParameters,
} from '@enso/core'
import { ensoConfigPath, ensoHome, readTextIfPresent } from '@enso/core/paths'
import {
  isFetchableContentType,
  isHostAllowed,
  isPublicIpAddress,
  parseWebFetchUrl,
  runUnderDeadline,
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionEnsoConfig,
} from '../../core/index.ts'

/**
 * The web_fetch tool (#54) — the sanctioned web access that replaces the ad-hoc network
 * clients #9 denies in bash.
 *
 * Three properties the shell path could never have:
 *
 * 1. **An empty-by-default host allowlist.** The `webFetch.allowedHosts` section of the
 *    user's `ENSO_HOME/config.json` (#59, #421) names every fetchable host; absent — no
 *    file, no section — it is EMPTY, and each host a human adds is one deliberate line.
 *    ⚠ Read ONCE at extension load, deliberately: the running session cannot widen its own
 *    egress by editing the file — an edit takes effect next session. (write/edit into
 *    `ENSO_HOME` are also denied, as a persistence target; a bash redirect into it is the
 *    stated residual, made inert within the session by the load-once read.)
 *    ⚠ Never located from the session cwd — a foreign checkout's config must not become
 *    this session's allowlist (see config.ts).
 * 2. **An audit line per call** — every outcome, refusals included, prints one stderr line
 *    naming the URL and what happened.
 * 3. **Bounded response handling** — http(s) only, no credentials in URLs, redirects
 *    REPORTED but never followed, textual content types only, body capped at
 *    {@link WEB_FETCH_MAX_RESPONSE_BYTES} bytes, whole call capped at
 *    {@link WEB_FETCH_TIMEOUT_MS}. A docs-reader, not a browser.
 *
 * The pure policy (URL gate, host match, content-type gate, the ADVISORY public-address
 * classifier and its stated SSRF non-coverage) lives in `core/web-fetch-policy.ts`.
 * Refusals are returned as ordinary tool results, never thrown: a policy refusal is
 * information the model should read and adapt to, not an error in the loop.
 */

/**
 * The init the tool hands `fetchUrl`, every field load-bearing: `manual` so a redirect is
 * reported instead of followed (#54), the call's abort signal, and our own user agent.
 *
 * Named so the composition root and the tests' fakes annotate the parameter by type.
 */
export interface WebFetchRequestInit {
  redirect: 'manual'
  signal: AbortSignal
  headers: Record<string, string>
}

/**
 * The IO seams, injected so tests never touch the network, DNS or the real config file —
 * same pattern as the guards' `analyzeBashCommand`.
 */
export interface WebFetchDependencies {
  /** Where the user's config lives — read from AND named in refusal messages. */
  locateConfigFile: () => string
  /** The config's text; `undefined` when there is no file, which is the defaults. A read that fails otherwise throws, and the extension fails CLOSED. */
  readConfigText: (path: string) => string | undefined
  /**
   * The SESSION's config, at `session_start` (#421): the user's, and over it the project's own
   * `.enso/config.json` once the project is trusted — one resolution per session, shared with
   * web_search, so the trust question is asked once.
   */
  resolveSessionConfig: (session: object, context: Omit<SessionConfigContext, 'home'>) => Promise<SessionEnsoConfig>
  fetchUrl: (url: string, init: WebFetchRequestInit) => Promise<Response>
  /** Resolve a hostname to its addresses. Rejects on NXDOMAIN/timeouts. */
  resolveHostAddresses: (hostname: string) => Promise<string[]>
}

const USER_AGENT = 'enso-web-fetch'

/** What the tool enforces: the allowlist, or why there is none, and the file a human changes. */
interface WebFetchPolicy {
  allowedHosts: readonly string[]
  configProblem: string | undefined
  configDisplayPath: string
}

function policyFrom(result: EnsoConfigParseResult, path: string): WebFetchPolicy {
  return result.kind === 'ok'
    ? { allowedHosts: result.config.webFetch?.allowedHosts ?? [], configProblem: undefined, configDisplayPath: path }
    : { allowedHosts: [], configProblem: result.reason, configDisplayPath: path }
}

/** The user's config at extension load — what the tool says before its session has started. */
function loadPolicy(dependencies: WebFetchDependencies): WebFetchPolicy {
  let configPath: string | undefined
  try {
    configPath = dependencies.locateConfigFile()
    return policyFrom(parseEnsoConfig(dependencies.readConfigText(configPath)), configPath)
  } catch (error) {
    // A locate failure leaves no path to name; the filename plus its home still tells
    // the human where to look.
    return {
      allowedHosts: [],
      configProblem: `the config file could not be read: ${String(error)}`,
      configDisplayPath: configPath ?? `${ENSO_CONFIG_FILENAME} in ENSO_HOME (~/.enso by default)`,
    }
  }
}

export function createWebFetch(dependencies: WebFetchDependencies): (pi: ExtensionAPI) => void {
  return function webFetch(pi: ExtensionAPI): void {
    // Read ONCE per session — see the header's property 1 for why: at extension load the user's
    // config, then at `session_start` the session's (#421: the project's, over it, once trusted),
    // re-registering so the description names the hosts the session really has. Every failure
    // mode (unlocatable, unreadable, wrong shape) fails CLOSED: the tool still registers, and
    // every call refuses with the reason, because "could not read the policy" must never render
    // as "no policy" (and a throw here could wedge pi's load).
    const policy = loadPolicy(dependencies)
    const session: { ready: Promise<void> } = { ready: Promise.resolve() }
    const register = (): void => registerWebFetch(pi, dependencies, policy, session)
    register()
    pi.on('session_start', (_event, context) => {
      // ⚠ NOT awaited (#421): the trust question is asked on the thread, and the host delivers a
      // question raised during session_start only once the session exists and the thread is being
      // followed — awaiting it here held session creation on an answer nobody could see, a deadlock
      // (found live). The call that needs the policy awaits it instead, like a permission prompt.
      session.ready = dependencies.resolveSessionConfig(context.sessionManager, context).then(
        (resolved) => {
          Object.assign(policy, policyFrom(resolved.result, resolved.path))
          register()
        },
        (error: unknown) => {
          Object.assign(policy, {
            allowedHosts: [],
            configProblem: `the session's config could not be resolved: ${String(error)}`,
          })
        },
      )
    })
  }
}

function registerWebFetch(
  pi: ExtensionAPI,
  dependencies: WebFetchDependencies,
  policy: WebFetchPolicy,
  session: { readonly ready: Promise<void> },
): void {
  const { allowedHosts } = policy
  pi.registerTool({
    name: WEB_FETCH_TOOL_NAME,
    label: 'Web fetch',
    description:
      `Fetch one absolute http(s) URL and return the response body as text (capped at ` +
      `${WEB_FETCH_MAX_RESPONSE_BYTES} bytes; redirects are reported, never followed). ` +
      `Only hosts on the config's allowlist are fetchable` +
      (allowedHosts.length > 0 ? ` (currently: ${allowedHosts.join(', ')})` : ` — and it is currently EMPTY`) +
      `; a refusal names the file a human can extend.`,
    promptSnippet: `${WEB_FETCH_TOOL_NAME}: fetch an allowlisted http(s) URL as text`,
    parameters: WebFetchToolParameters,
    execute: async (
      _toolCallId: string,
      params: WebFetchToolParameters,
      signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<undefined>> => {
      const rawUrl = params.url

      // --- the policy gates, in cheapest-first order; each refusal is final.
      const urlDecision = parseWebFetchUrl(rawUrl)
      if (urlDecision.kind === 'refused') return refusal(rawUrl, urlDecision.reason)
      const url = urlDecision.url

      // The session's policy, once its trust question (if any) is answered.
      await session.ready
      const { configProblem, configDisplayPath } = policy
      if (configProblem !== undefined) {
        return refusal(
          rawUrl,
          `the ${WEB_FETCH_TOOL_NAME} host allowlist could not be used — ${configProblem}. ` +
            `Nothing is fetchable until a human fixes ${configDisplayPath} ` +
            `(expected shape: ${ENSO_CONFIG_EXAMPLE}) and restarts the session.`,
        )
      }
      if (policy.allowedHosts.length === 0) {
        return refusal(
          rawUrl,
          `the ${WEB_FETCH_TOOL_NAME} host allowlist is EMPTY — the recorded default policy (#54), ` +
            `not an accident. No host is fetchable until a human adds one: edit ` +
            `${configDisplayPath} to name exact hostnames, e.g. ${ENSO_CONFIG_EXAMPLE}, ` +
            `and restart the session — the allowlist is read once at session start. Do not edit ` +
            `that file from this session; ask the human.`,
        )
      }
      if (!isHostAllowed(url.hostname, policy.allowedHosts)) {
        return refusal(
          rawUrl,
          `"${url.hostname}" is not on the ${WEB_FETCH_TOOL_NAME} host allowlist ` +
            `(allowed: ${policy.allowedHosts.join(', ')}). Hosts match exactly — no wildcards, no subdomain ` +
            `inheritance. A human can add it in ${configDisplayPath} and restart the session.`,
        )
      }

      // --- the ADVISORY address gate (see web-fetch-policy.ts's stated non-coverage:
      // resolve-here vs resolve-in-fetch is a TOCTOU window, accepted for MVP).
      const addressProblem = await addressGateReason(url.hostname, dependencies.resolveHostAddresses)
      if (addressProblem !== undefined) return refusal(rawUrl, addressProblem)

      return await fetchUnderDeadline(url, rawUrl, dependencies, signal)
    },
  })
}

function refusal(rawUrl: string, reason: string): AgentToolResult<undefined> {
  auditLine('refused', rawUrl, reason)
  return { content: [{ type: 'text', text: `Not fetched: ${reason}` }], details: undefined }
}

/**
 * The advisory address gate: refuse a host whose addresses are not all provably public.
 * Returns the refusal reason, or undefined when the fetch may proceed. An IP-literal
 * hostname classifies directly (URL brackets IPv6 literals; strip them).
 */
async function addressGateReason(
  hostname: string,
  resolveHostAddresses: WebFetchDependencies['resolveHostAddresses'],
): Promise<string | undefined> {
  const bareHost = hostname.replace(/^\[/, '').replace(/\]$/, '')
  let addresses: readonly string[]
  if (isIP(bareHost) !== 0) {
    addresses = [bareHost]
  } else {
    try {
      addresses = await resolveHostAddresses(bareHost)
    } catch (error) {
      return `"${bareHost}" did not resolve (${String(error)})`
    }
  }
  const nonPublicAddress = addresses.find((address) => !isPublicIpAddress(address))
  if (addresses.length === 0 || nonPublicAddress !== undefined) {
    return (
      `"${bareHost}" resolves to a non-public address` +
      (nonPublicAddress !== undefined ? ` (${nonPublicAddress})` : '') +
      ` — ${WEB_FETCH_TOOL_NAME} reaches the public web only.`
    )
  }
  return undefined
}

/** The fetch itself, under the whole-call deadline AND the caller's abort signal. */
function fetchUnderDeadline(
  url: URL,
  rawUrl: string,
  dependencies: WebFetchDependencies,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<undefined>> {
  return runUnderDeadline(
    signal,
    {
      remainingMs: WEB_FETCH_TIMEOUT_MS,
      reason: () => new Error(`${WEB_FETCH_TOOL_NAME} timed out after ${WEB_FETCH_TIMEOUT_MS}ms`),
    },
    async (deadlineSignal) => {
      let response: Response
      try {
        response = await dependencies.fetchUrl(url.href, {
          redirect: 'manual',
          signal: deadlineSignal,
          headers: { 'user-agent': USER_AGENT },
        })
      } catch (error) {
        return refusal(rawUrl, `the request failed: ${String(error)}`)
      }
      return await renderResponse(url, rawUrl, response)
    },
  )
}

const REDIRECT_STATUS_MIN = 300
const REDIRECT_STATUS_MAX = 399

/**
 * Resolve a Location header against the requested URL for display. A MALFORMED header
 * (`Location: https://`) must come back as undefined, never throw — the tool's contract is
 * that refusals are returned, and a server-controlled header must not crash the loop.
 */
function resolveRedirectTarget(locationHeader: string | null, base: URL): string | undefined {
  if (locationHeader === null) return undefined
  try {
    return new URL(locationHeader, base).href
  } catch {
    return undefined
  }
}

/** Turn the HTTP response into the tool result: redirect report, content-type gate, capped body. */
async function renderResponse(url: URL, rawUrl: string, response: Response): Promise<AgentToolResult<undefined>> {
  // Redirects are REPORTED, never followed: an open redirect on an allowlisted host must
  // not become a fetch of an unlisted one. The model re-requests the target itself, where
  // the allowlist gate runs again.
  if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
    const locationHeader = response.headers.get('location')
    const target = resolveRedirectTarget(locationHeader, url)
    auditLine('redirect', rawUrl, target ?? '(no usable Location header)')
    let redirectTail: string
    if (target !== undefined) {
      redirectTail =
        ` redirecting to ${target}. ${WEB_FETCH_TOOL_NAME} never follows redirects — ` +
        `fetch that URL directly if its host is on the allowlist; otherwise it needs ` +
        `a human allowlist edit.`
    } else if (locationHeader === null) {
      redirectTail = ` with no Location header.`
    } else {
      redirectTail = ` with an unparseable Location header.`
    }
    return {
      content: [
        {
          type: 'text',
          text: `Not fetched: ${url.href} answered HTTP ${response.status}${redirectTail}`,
        },
      ],
      details: undefined,
    }
  }

  const contentType = response.headers.get('content-type')
  if (!isFetchableContentType(contentType)) {
    const contentTypeDescription =
      contentType === null
        ? 'carries no Content-Type header, and absent fails closed'
        : `Content-Type "${contentType}" is not textual`
    return refusal(
      rawUrl,
      `the response ${contentTypeDescription} — ${WEB_FETCH_TOOL_NAME} returns text, not binary content.`,
    )
  }

  const body = await readBodyUpTo(response, WEB_FETCH_MAX_RESPONSE_BYTES)
  auditLine(
    'fetched',
    rawUrl,
    `HTTP ${response.status}, ${body.text.length} chars${body.truncated ? ' (truncated)' : ''}`,
  )
  return {
    content: [
      {
        type: 'text',
        text:
          `Fetched ${url.href} — HTTP ${response.status}, ${contentType}` +
          (body.truncated ? `, TRUNCATED at ${WEB_FETCH_MAX_RESPONSE_BYTES} bytes` : '') +
          `.\n\n${EXTERNAL_WEB_CONTENT_NOTICE}\n\n${body.text}`,
      },
    ],
    details: undefined,
  }
}

const log = ensoLogger('extension', 'web-fetch')

/** One record per call, every outcome — the audit property #54 names (#132: in the file, at `info`; a refusal at `warn`). */
function auditLine(outcome: string, url: string, detail: string): void {
  const properties = { outcome, url, detail }
  if (outcome === 'refused') log.warn('audit: {outcome} {url} — {detail}', properties)
  else log.info('audit: {outcome} {url} — {detail}', properties)
}

/** Read up to `maxBytes` of the body as UTF-8, cancelling the stream past the cap. */
async function readBodyUpTo(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body
  if (body === null) return { text: '', truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let text = ''
  let bytesRead = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    bytesRead += value.byteLength
    if (bytesRead > maxBytes) {
      const bytesToKeep = value.byteLength - (bytesRead - maxBytes)
      text += decoder.decode(value.subarray(0, bytesToKeep), { stream: true })
      await reader.cancel()
      return { text, truncated: true }
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return { text, truncated: false }
}

/**
 * The pi entry point — real filesystem, DNS and fetch, wired at the composition root. The
 * config is the user's, in `ENSO_HOME` (#421), whichever surface — or print mirror — loads this.
 */
export default createWebFetch({
  locateConfigFile: () => ensoConfigPath(ensoHome(process.env)),
  readConfigText: readTextIfPresent,
  resolveSessionConfig: (session, context) => sessionEnsoConfig(session, { ...context, home: ensoHome(process.env) }),
  fetchUrl: (url: string, init: WebFetchRequestInit) => fetch(url, init),
  resolveHostAddresses: async (hostname: string) =>
    (await lookup(hostname, { all: true })).map((resolved) => resolved.address),
})
