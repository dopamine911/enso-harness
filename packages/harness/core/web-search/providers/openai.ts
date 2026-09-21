import { applyIndexCitations, type IndexCitation } from '../citations.ts'
import { dispatchProviderPost, resolveProviderCredential } from '../dispatch.ts'
import { cleanSources, normalizeSearchUrl, titleFromUrl } from '../sources.ts'
import { readSseEvents } from '../sse.ts'
import type { ModelSearchRequest, WebSearchOutcome } from '../vocabulary.ts'
import { WebSearchProviderError } from '../vocabulary.ts'
import { asRecord, asString, trimTrailingSlash } from '../wire-json.ts'

/**
 * The `openai` provider (#63): the Responses API `web_search` tool, serving three model
 * APIs — `openai-responses`, `azure-openai-responses`, and `openai-codex-responses`
 * (including GitHub Copilot credentials, whose resolved endpoint rides the credential object).
 * The answer arrives as `response.output_text.delta` events; the search evidence arrives
 * as `web_search_call` output items and `url_citation` annotations with character
 * indices (hence the index citation applier).
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 *
 * ⚠ NO LIVE RECEIPT: no OpenAI/Azure/Copilot key exists in this install (#63) — the
 * stream parse is fixture-tested only. `web-search.test.ts` carries the named
 * non-coverage record.
 */

function isCodexModel(model: ModelSearchRequest['model']): boolean {
  return model.api === 'openai-codex-responses'
}

/**
 * GitHub Copilot routes through a credential-specific endpoint. Modern pi resolves it
 * onto the credential object; older pi returned only the token, whose `proxy-ep=` field names
 * the proxy host this maps onto the API host. Anything unparseable keeps the model's own
 * base URL.
 */
function resolveGitHubCopilotBaseUrl(
  model: ModelSearchRequest['model'],
  credential: { apiKey?: string; baseUrl?: string },
): string {
  if (model.provider !== 'github-copilot') return model.baseUrl
  if (credential.baseUrl !== undefined && credential.baseUrl.trim().length > 0) return credential.baseUrl
  if (credential.apiKey === undefined) return model.baseUrl

  const proxyEndpoints = credential.apiKey
    .split(';')
    .filter((field) => field.startsWith('proxy-ep='))
    .map((field) => field.slice('proxy-ep='.length))
  if (proxyEndpoints.length !== 1) return model.baseUrl

  const proxyHost = proxyEndpoints[0]?.toLowerCase() ?? ''
  const labels = proxyHost.split('.')
  const isValidLabel = (label: string): boolean =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  const isCopilotProxyHost =
    proxyHost.length <= 253 &&
    labels.length >= 4 &&
    labels[0] === 'proxy' &&
    labels.at(-2) === 'githubcopilot' &&
    labels.at(-1) === 'com' &&
    labels.every(isValidLabel)
  if (!isCopilotProxyHost) return model.baseUrl
  return `https://api.${labels.slice(1).join('.')}`
}

function resolveResponsesUrl(model: ModelSearchRequest['model'], baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl)
  if (!isCodexModel(model)) return `${base}/responses`
  if (base.endsWith('/codex/responses')) return base
  if (base.endsWith('/codex')) return `${base}/responses`
  return `${base}/codex/responses`
}

/** The Codex Responses API requires the ChatGPT account id carried inside the OAuth token. */
function extractCodexAccountId(token: string): string {
  try {
    const tokenParts = token.split('.')
    if (tokenParts.length !== 3) throw new Error('not a JWT')
    const base64 = (tokenParts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const payloadBytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    const payload: unknown = JSON.parse(new TextDecoder().decode(payloadBytes))
    const accountId = asString(asRecord(asRecord(payload)?.['https://api.openai.com/auth'])?.chatgpt_account_id)
    if (accountId === undefined || accountId.length === 0) throw new Error('missing account id')
    return accountId
  } catch {
    throw new WebSearchProviderError(
      'openai',
      'failed to extract the ChatGPT account ID from the openai-codex credential',
      { requestDispatched: false },
    )
  }
}

/** The url_citation annotations carried by one final-response `message` output item. */
function messageAnnotationsOf(itemValue: unknown): unknown[] {
  const item = asRecord(itemValue)
  if (item === undefined || asString(item.type) !== 'message') return []
  const contents = Array.isArray(item.content) ? item.content : []
  const annotations: unknown[] = []
  for (const contentValue of contents) {
    const content = asRecord(contentValue)
    if (content === undefined || asString(content.type) !== 'output_text') continue
    if (Array.isArray(content.annotations)) annotations.push(...content.annotations)
  }
  return annotations
}

function extractUrlCitation(annotation: Record<string, unknown>): IndexCitation | undefined {
  const nested = asRecord(annotation.url_citation) ?? asRecord(annotation.urlCitation)
  const url = asString(annotation.url) ?? asString(nested?.url)
  if (url === undefined || url.length === 0) return undefined
  const title = asString(annotation.title) ?? asString(nested?.title) ?? titleFromUrl(url)
  const endIndexValue = annotation.end_index ?? annotation.endIndex ?? nested?.end_index ?? nested?.endIndex
  return { endIndex: typeof endIndexValue === 'number' ? endIndexValue : undefined, title, url }
}

/** Assemble the request headers, including the Codex-specific credential requirements. */
function buildRequestHeaders(
  request: ModelSearchRequest,
  credential: { apiKey?: string | undefined; headers?: Record<string, string> | undefined },
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(request.model.headers ?? {}),
    ...(credential.headers ?? {}),
  }
  if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json'
  if (headers.Accept === undefined) headers.Accept = 'text/event-stream'
  if (credential.apiKey !== undefined && credential.apiKey.length > 0 && headers.Authorization === undefined) {
    headers.Authorization = `Bearer ${credential.apiKey}`
  }

  if (isCodexModel(request.model)) {
    const hasBearerAuth = headers.Authorization !== undefined && /^Bearer\s+\S+/i.test(headers.Authorization)
    if (!hasBearerAuth) {
      throw new WebSearchProviderError('openai', 'no OAuth credential configured for the openai-codex model', {
        requestDispatched: false,
      })
    }
    if (headers['chatgpt-account-id'] === undefined) {
      if (credential.apiKey === undefined) {
        throw new WebSearchProviderError('openai', 'no ChatGPT account ID configured for the openai-codex model', {
          requestDispatched: false,
        })
      }
      headers['chatgpt-account-id'] = extractCodexAccountId(credential.apiKey)
    }
    if (headers.originator === undefined) headers.originator = 'codex_cli_rs'
  }
  return headers
}

/** Assemble the Responses API request body; Codex needs its own input and control fields. */
function buildRequestBody(request: ModelSearchRequest): Record<string, unknown> {
  const isCodex = isCodexModel(request.model)
  const requestBody: Record<string, unknown> = {
    model: request.model.id,
    input: isCodex ? [{ role: 'user', content: [{ type: 'input_text', text: request.query }] }] : request.query,
    tools: [{ type: 'web_search' }],
    include: isCodex
      ? ['web_search_call.action.sources']
      : ['web_search_call.action.sources', 'web_search_call.results'],
    stream: true,
    store: false,
  }
  if (request.model.reasoning) requestBody.reasoning = { effort: 'none' }
  if (isCodex) {
    requestBody.instructions = "Answer the user's request using web search when needed."
    requestBody.text = { verbosity: 'low' }
    requestBody.tool_choice = 'required'
    requestBody.parallel_tool_calls = true
  }
  return requestBody
}

export async function runOpenAiProviderSearch(request: ModelSearchRequest): Promise<WebSearchOutcome> {
  const credential = await resolveProviderCredential('openai', request)

  const isCodex = isCodexModel(request.model)
  const headers = buildRequestHeaders(request, credential)
  const requestBody = buildRequestBody(request)
  const baseUrl = resolveGitHubCopilotBaseUrl(request.model, credential)
  const response = await dispatchProviderPost('openai', request.fetchUrl, {
    url: resolveResponsesUrl(request.model, baseUrl),
    headers,
    body: requestBody,
    signal: request.signal,
  })

  let accumulatedText = ''
  const citations: IndexCitation[] = []
  const searchCallSources: Array<{ title?: string | undefined; url: string }> = []
  let sawWebSearchCall = false

  const collectAnnotation = (annotationValue: unknown): void => {
    const annotation = asRecord(annotationValue)
    if (annotation === undefined || asString(annotation.type) !== 'url_citation') return
    const citation = extractUrlCitation(annotation)
    if (citation !== undefined) citations.push(citation)
  }

  const collectWebSearchCall = (itemValue: unknown): void => {
    const item = asRecord(itemValue)
    if (item === undefined || asString(item.type) !== 'web_search_call') return
    sawWebSearchCall = true
    const action = asRecord(item.action) ?? {}
    if (Array.isArray(action.sources)) {
      for (const sourceValue of action.sources) {
        const source = asRecord(sourceValue)
        const sourceUrl = asString(source?.url)
        if (source === undefined || sourceUrl === undefined || sourceUrl.length === 0) continue
        searchCallSources.push({
          title: asString(source.title) ?? asString(source.display_name) ?? asString(source.name),
          url: sourceUrl,
        })
      }
    }
    const actionUrl = asString(action.url)
    if (actionUrl !== undefined && actionUrl.length > 0) searchCallSources.push({ url: actionUrl })
  }

  const collectFromFinalResponse = (responseValue: unknown): void => {
    const finalResponse = asRecord(responseValue)
    const outputItems = Array.isArray(finalResponse?.output) ? finalResponse.output : []
    for (const itemValue of outputItems) {
      collectWebSearchCall(itemValue)
      for (const annotationValue of messageAnnotationsOf(itemValue)) collectAnnotation(annotationValue)
    }
  }

  const throwStreamError = (event: Record<string, unknown>): never => {
    const message =
      asString(event.message) ??
      asString(asRecord(event.error)?.message) ??
      asString(asRecord(asRecord(event.response)?.error)?.message)
    throw new WebSearchProviderError('openai', message ?? JSON.stringify(event), { requestDispatched: true })
  }

  const handleStreamEvent = (event: Record<string, unknown>): true | undefined => {
    const eventType = asString(event.type)
    if (eventType === 'error' || eventType === 'response.failed') throwStreamError(event)
    if (eventType === 'response.output_text.delta') {
      accumulatedText += asString(event.delta) ?? ''
      request.onProgress?.(accumulatedText)
    } else if (eventType === 'response.output_text.annotation.added') {
      collectAnnotation(event.annotation)
    } else if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
      collectWebSearchCall(event.item)
    } else if (
      eventType === 'response.completed' ||
      eventType === 'response.done' ||
      eventType === 'response.incomplete'
    ) {
      collectFromFinalResponse(event.response)
      // The Codex stream never closes on its own after the final response event.
      if (isCodex) return true
    } else if (eventType?.startsWith('response.web_search_call.') === true) {
      sawWebSearchCall = true
      request.onProgress?.(accumulatedText)
    }
    return undefined
  }

  try {
    await readSseEvents(response, request.signal, ({ data }) => {
      const event = asRecord(data)
      return event === undefined ? undefined : handleStreamEvent(event)
    })
  } catch (error) {
    if (error instanceof WebSearchProviderError) throw error
    throw new WebSearchProviderError('openai', `the search stream failed: ${String(error)}`, {
      requestDispatched: true,
    })
  }

  const answerText = accumulatedText.length > 0 ? accumulatedText : 'No answer text was returned.'
  // ⚠ The searched/ungrounded verdict: `web_search_call` items and their status events
  // are the Responses API's equivalent of the Anthropic server_tool_use block (#63). A
  // url_citation annotation also only exists as web-search output, so citations count.
  if (!sawWebSearchCall && citations.length === 0) {
    return { kind: 'ungrounded', providerId: 'openai', answerText }
  }

  const cited = applyIndexCitations(answerText, citations)
  // Cited sources own the [n] numbering — untouched; uncited search-call sources get the
  // hygiene pass and append (see anthropic-wire.ts for the numbering rationale).
  const citedUrls = new Set(cited.sources.flatMap((source) => [source.url, normalizeSearchUrl(source.url)]))
  const uncitedSources = cleanSources(searchCallSources).filter((source) => !citedUrls.has(source.url))
  return {
    kind: 'searched',
    providerId: 'openai',
    answerText: cited.text,
    sources: [...cited.sources, ...uncitedSources],
  }
}
