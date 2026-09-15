import { type FetchUrl, WebSearchProviderError, type WebSearchProviderId } from './vocabulary.ts'

/**
 * How every provider sends its request (#174): a JSON POST, and the two ways it fails —
 * the request never left (`requestDispatched: false`, so the extension may fall through to
 * the next provider) or the API answered but not OK (`requestDispatched: true`, the body
 * quoted). Four copies of this block existed; the wording and the two flags are the
 * contract the extension's fallback reads, so they live once.
 */
export interface ProviderPost {
  readonly url: string
  readonly headers: Record<string, string>
  /** Serialised with `JSON.stringify` here, so a provider hands over the object it built. */
  readonly body: unknown
  readonly signal?: AbortSignal | undefined
}

/** The OK response, or the `WebSearchProviderError` that says which side failed. */
export async function dispatchProviderPost(
  providerId: WebSearchProviderId,
  fetchUrl: FetchUrl,
  post: ProviderPost,
): Promise<Response> {
  let response: Response
  try {
    response = await fetchUrl(post.url, {
      method: 'POST',
      headers: post.headers,
      body: JSON.stringify(post.body),
      signal: post.signal,
    })
  } catch (error) {
    throw new WebSearchProviderError(providerId, `the search request failed to send: ${String(error)}`, {
      requestDispatched: false,
    })
  }
  if (!response.ok) {
    const errorBody = await response.text()
    throw new WebSearchProviderError(providerId, `the search API answered HTTP ${response.status}: ${errorBody}`, {
      requestDispatched: true,
    })
  }
  return response
}
