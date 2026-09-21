import { dispatchProviderPost } from '../dispatch.ts'
import { cleanSources } from '../sources.ts'
import type { FetchUrl, WebSearchOutcome, WebSearchSnippet } from '../vocabulary.ts'
import { WebSearchProviderError } from '../vocabulary.ts'
import { asRecord, asString } from '../wire-json.ts'

/**
 * The `tavily` provider (#63): the FALLBACK — a dedicated retrieval API, not a model.
 *
 * One POST to Tavily's search endpoint returns title/url/snippet results; there is no
 * synthesized answer and no searched/ungrounded ambiguity (a response IS a search). Armed
 * solely by `TAVILY_API_KEY` being present in the environment — no config knob; the key never
 * enters `zen.config.json` and is never logged. Domain include/exclude (the `webSearch.tavily`
 * config section) pass through to the API verbatim.
 */

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
/** The env var that ARMS the fallback — read at the composition root only. */
export const TAVILY_API_KEY_VARIABLE = 'TAVILY_API_KEY'
/** Result-count bound sent to the API; Tavily's own default is 5. */
const TAVILY_MAX_RESULTS = 8

export interface TavilySearchRequest {
  query: string
  apiKey: string
  includeDomains?: readonly string[] | undefined
  excludeDomains?: readonly string[] | undefined
  fetchUrl: FetchUrl
  signal: AbortSignal | undefined
}

export async function runTavilyProviderSearch(request: TavilySearchRequest): Promise<WebSearchOutcome> {
  const requestBody: Record<string, unknown> = {
    query: request.query,
    max_results: TAVILY_MAX_RESULTS,
  }
  if (request.includeDomains !== undefined && request.includeDomains.length > 0) {
    requestBody.include_domains = request.includeDomains
  }
  if (request.excludeDomains !== undefined && request.excludeDomains.length > 0) {
    requestBody.exclude_domains = request.excludeDomains
  }

  const response = await dispatchProviderPost('tavily', request.fetchUrl, {
    url: TAVILY_SEARCH_URL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: requestBody,
    signal: request.signal,
  })

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new WebSearchProviderError('tavily', `the search API returned an unparseable body: ${String(error)}`, {
      requestDispatched: true,
    })
  }

  const results = asRecord(payload)?.results
  const snippets: WebSearchSnippet[] = []
  if (Array.isArray(results)) {
    for (const resultValue of results) {
      const result = asRecord(resultValue)
      const url = asString(result?.url)
      if (result === undefined || url === undefined || url.length === 0) continue
      snippets.push({
        title: asString(result.title) ?? url,
        url,
        snippet: asString(result.content),
      })
    }
  }

  return {
    kind: 'searched',
    providerId: 'tavily',
    sources: cleanSources(snippets),
    snippets,
  }
}
