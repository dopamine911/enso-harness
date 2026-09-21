/**
 * The web_search vocabulary (#63): provider ids, the outcome union, and the request
 * shapes every provider module accepts.
 *
 * Providers live in `./providers/`, one module each, and MUST NOT import each other — that
 * independence is what makes a later split into provider packages mechanical (the dsh `ctx.web`
 * seam pattern, surveyed in #56).
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 */

/** Every backend that can answer a web_search call. */
export type WebSearchProviderId = 'anthropic' | 'google' | 'openai' | 'deepseek' | 'tavily'

/** One cited or returned web source. */
export interface WebSource {
  title: string
  url: string
}

/** One retrieval-style result (the Tavily shape): a source plus its snippet. */
export interface WebSearchSnippet {
  title: string
  url: string
  snippet?: string | undefined
}

/**
 * What one provider run produced — the ACCURATE outcome union (#63, Daniel's
 * requirement).
 *
 * ⚠ `searched` vs `ungrounded` is keyed on evidence that a native search actually ran (a
 * `server_tool_use` block on the Anthropic wire; each provider names its own signal), NEVER on
 * source count: a real search can return zero results, and an ungrounded answer citing a
 * hallucinated URL would read as grounded. Upstream's `grounded = sources.length > 0` had
 * exactly that defect.
 */
export type WebSearchOutcome =
  | {
      kind: 'searched'
      providerId: WebSearchProviderId
      /** The provider-synthesized answer, citation-marked. Absent for retrieval backends (Tavily). */
      answerText?: string
      sources: WebSource[]
      /** Retrieval results with snippets — the Tavily shape; model-native backends leave it absent. */
      snippets?: WebSearchSnippet[]
    }
  | {
      /** The model answered WITHOUT searching — its own knowledge, not the live web. */
      kind: 'ungrounded'
      providerId: WebSearchProviderId
      answerText: string
    }

/**
 * Thrown by provider runs on failure.
 *
 * `requestDispatched` says whether the HTTP request left the process — an honest "may have
 * billed" bit (whether a failed request billed is the provider's accounting, not knowable
 * here), surfaced when the fallback re-searches.
 */
export class WebSearchProviderError extends Error {
  readonly providerId: WebSearchProviderId
  readonly requestDispatched: boolean

  constructor(providerId: WebSearchProviderId, message: string, options: { requestDispatched: boolean }) {
    super(message)
    this.name = 'WebSearchProviderError'
    this.providerId = providerId
    this.requestDispatched = options.requestDispatched
  }
}

/**
 * The init the fetch seam takes — a `fetch` init narrowed to what a provider run actually
 * sets.
 *
 * Named (not inline) so a fake in a test and the composition root's real `fetch` wrapper can
 * both annotate the parameter instead of leaning on inference.
 */
export interface FetchUrlInit {
  method?: string
  redirect?: 'manual'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal | undefined
}

/** The injected fetch seam — tests never touch the network. Same shape as web_fetch's. */
export type FetchUrl = (url: string, init: FetchUrlInit) => Promise<Response>

/**
 * Auth for one model-routed request, as pi's model registry resolves it (plus the
 * provider-env fallback — see `auth.ts`).
 */
export type ResolvedProviderAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; baseUrl?: string }
  | { ok: false; error: string }

/**
 * The model the conversation runs on, as the PROVIDER SEAM sees it (L6 closed, #162): the
 * seven fields the providers read, declared here as ours.
 *
 * The runtime's own model record is converted once, at the extension
 * (`extensions/web-search/index.ts#searchModelOf`), and nothing under `harness/core` imports
 * the runtime's type for it any more. A provider that needs an eighth field adds it here, where
 * the seam is, not by reaching for the vendor's.
 */
export interface SearchModel {
  id: string
  /** The wire API the model speaks — `anthropic-messages`, `openai-responses`, … — which routes the search. */
  api: string
  /** The provider's id, which names the environment key that may authenticate it. */
  provider: string
  baseUrl: string
  reasoning: boolean
  maxTokens: number
  headers?: Record<string, string> | undefined
}

/** What a MODEL-ROUTED provider run receives (anthropic / google / openai). */
export interface ModelSearchRequest {
  query: string
  model: SearchModel
  resolveAuth: (model: SearchModel) => Promise<ResolvedProviderAuth>
  fetchUrl: FetchUrl
  signal: AbortSignal | undefined
  /** Streaming progress for the UI; carries the accumulated answer text so far. */
  onProgress?: ((text: string) => void) | undefined
}

/**
 * Which model-routed provider serves a model, by its API kind.
 *
 * `undefined` means no native search path exists for it — selection falls through to the
 * fallback chain. (pi registers DeepSeek models as `openai-completions`, so they land here as
 * `undefined` too: the DeepSeek backend is config-pinned, never model-routed — #63.)
 */
export function routedProviderIdForModel(model: SearchModel): 'anthropic' | 'google' | 'openai' | undefined {
  if (model.provider === 'google-generative-ai' || model.api === 'google-generative-ai') return 'google'
  if (
    model.api === 'openai-responses' ||
    model.api === 'azure-openai-responses' ||
    model.api === 'openai-codex-responses'
  ) {
    return 'openai'
  }
  if (model.api === 'anthropic-messages') return 'anthropic'
  return undefined
}
