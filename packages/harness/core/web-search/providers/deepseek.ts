import { runAnthropicWireSearch } from '../anthropic-wire.ts'
import type { FetchUrl, WebSearchOutcome } from '../vocabulary.ts'
import { WebSearchProviderError } from '../vocabulary.ts'

/**
 * The `deepseek` provider (#63): the DEDICATED search backend, dsh's shape
 * (`dsh-web-search-deepseek`, MIT — the spec this follows). One full Messages call
 * against DeepSeek's Anthropic-compatible endpoint with the native `web_search` server
 * tool; the shared wire module parses the structured `web_search_tool_result` blocks and
 * never scrapes URLs out of model prose.
 *
 * ⚠ NEVER model-routed: pi's catalog registers every DeepSeek model as
 * `openai-completions` at `https://api.deepseek.com` (verified 2026-09-04), and the
 * SEARCH endpoint is a DIFFERENT base — the Anthropic-compatible
 * `https://api.deepseek.com/anthropic/v1`. Do not derive one base from the other.
 * Selection is by explicit `webSearch.backend: "deepseek"` in `zen.config.json` only, so
 * no provider is ever billed that the committed config never named.
 */

export const DEEPSEEK_SEARCH_BASE_URL = 'https://api.deepseek.com/anthropic/v1'
export const DEEPSEEK_SEARCH_MODEL_ID = 'deepseek-v4-flash'
/** The env var holding the key — the SAME name pi-ai's own provider-env map uses. */
export const DEEPSEEK_API_KEY_VARIABLE = 'DEEPSEEK_API_KEY'
const DEEPSEEK_ANTHROPIC_API_VERSION = '2023-06-01'
const DEEPSEEK_ANSWER_TOKENS = 4096
/** dsh's default server-tool budget for one search request. */
const DEEPSEEK_MAX_SERVER_TOOL_USES = 5

export interface DeepseekSearchRequest {
  query: string
  /** The key read at the composition root — never from config, never logged. */
  apiKey: string | undefined
  fetchUrl: FetchUrl
  signal: AbortSignal | undefined
  onProgress?: ((text: string) => void) | undefined
}

export async function runDeepseekProviderSearch(request: DeepseekSearchRequest): Promise<WebSearchOutcome> {
  if (request.apiKey === undefined || request.apiKey.length === 0) {
    throw new WebSearchProviderError(
      'deepseek',
      `the configured deepseek backend has no credential — set ${DEEPSEEK_API_KEY_VARIABLE} in the ` +
        `environment (a human step; the key never enters zen.config.json) and restart the session`,
      { requestDispatched: false },
    )
  }

  return runAnthropicWireSearch({
    providerId: 'deepseek',
    endpointUrl: `${DEEPSEEK_SEARCH_BASE_URL}/messages`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': DEEPSEEK_ANTHROPIC_API_VERSION,
      'x-api-key': request.apiKey,
    },
    modelId: DEEPSEEK_SEARCH_MODEL_ID,
    // dsh's tested instruction — DeepSeek's searching model gets told to search, where
    // the Anthropic path sends the bare query (consumed behavior, receipt-backed there).
    prompt: `Perform a web search for the query: ${request.query}`,
    maxTokens: DEEPSEEK_ANSWER_TOKENS,
    maxServerToolUses: DEEPSEEK_MAX_SERVER_TOOL_USES,
    fetchUrl: request.fetchUrl,
    signal: request.signal,
    onProgress: request.onProgress,
  })
}
