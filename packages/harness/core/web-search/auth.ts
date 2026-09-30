import type { ResolvedProviderAuth, SearchModel } from './vocabulary.ts'

/**
 * Model-routed auth (#63): resolve one model's credentials THROUGH PI's model registry —
 * the same identity the conversation bills, including the OAuth path — with the
 * provider-env fallback pi 0.80.1+ made necessary.
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 *
 * ⚠ Why the env fallback exists (upstream's finding, kept): pi-coding-agent 0.80.1+
 * returns `{ ok: true }` with NO key from `getApiKeyAndHeaders()` when auth comes only
 * from provider env vars such as `ANTHROPIC_API_KEY` — pi-ai's own request path does its
 * own `getEnvApiKey()` fallback, but this code calls fetch directly, so it must mirror
 * that fallback while preserving explicit model/auth headers.
 */

/**
 * The slice of pi's ModelRegistry this module needs — injectable in tests.
 *
 * The result shape mirrors pi's `ResolvedRequestAuth` (its headers admit `null` values, which
 * {@link resolveModelAuth} strips into the clean {@link ResolvedProviderAuth}).
 *
 * @group Web search
 */
export interface ModelAuthSource {
  getApiKeyAndHeaders(model: SearchModel): Promise<
    | {
        ok: true
        apiKey?: string | undefined
        headers?: Record<string, string | null> | undefined
        baseUrl?: string | undefined
      }
    | { ok: false; error: string }
  >
}

/** Drop null-valued headers — pi's ProviderHeaders uses null to mean "unset this". */
function withoutNullHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const cleaned: Record<string, string> = {}
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerValue !== null) cleaned[headerName] = headerValue
  }
  return cleaned
}

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (headers === undefined) return false
  return Object.entries(headers).some(([headerName, headerValue]) => {
    if (headerValue.length === 0) return false
    const normalizedName = headerName.toLowerCase()
    return normalizedName === 'authorization' || normalizedName === 'x-api-key' || normalizedName === 'x-goog-api-key'
  })
}

/**
 * `readProviderEnvironmentKey` is a SEAM (PR #64 review): it defaults to pi-ai's
 * `getEnvApiKey`, which reads the launching process environment — injectable so the
 * fallback's POSITIVE path is testable without a test ever touching `process.env`.
 *
 * @group Web search
 */
export async function resolveModelAuth(
  authSource: ModelAuthSource,
  model: SearchModel,
  readProviderEnvironmentKey: (provider: string) => string | undefined,
): Promise<ResolvedProviderAuth> {
  // @invariant web-search-call/auth-identity Auth is the conversation's identity; the provider env key is the last resort.
  // This asks the runtime's model registry, passes a failure through, drops null-valued headers,
  // and reads the environment only when neither a key nor an `authorization` / `x-api-key` /
  // `x-goog-api-key` header came back. The extension builds the resolver into `ModelSearchRequest`
  // (`resolveAuth`), and the provider, not the extension, decides when to call it.
  const resolved = await authSource.getApiKeyAndHeaders(model)
  if (!resolved.ok) return resolved
  const headers = withoutNullHeaders(resolved.headers)
  const normalized: ResolvedProviderAuth = { ok: true }
  if (resolved.apiKey !== undefined) normalized.apiKey = resolved.apiKey
  if (headers !== undefined) normalized.headers = headers
  if (resolved.baseUrl !== undefined) normalized.baseUrl = resolved.baseUrl
  if (normalized.apiKey !== undefined || hasAuthHeader(headers)) return normalized
  const environmentApiKey = readProviderEnvironmentKey(model.provider)
  if (environmentApiKey === undefined || environmentApiKey.length === 0) return normalized
  return { ...normalized, apiKey: environmentApiKey }
}
