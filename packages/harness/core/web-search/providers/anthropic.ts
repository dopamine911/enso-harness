import { runAnthropicWireSearch } from '../anthropic-wire.ts'
import { resolveProviderCredential } from '../dispatch.ts'
import type { ModelSearchRequest, WebSearchOutcome } from '../vocabulary.ts'
import { trimTrailingSlash } from '../wire-json.ts'

/**
 * The `anthropic` provider (#63): current-model routing onto the Anthropic Messages
 * native `web_search` server tool (`ANTHROPIC_WEB_SEARCH_TOOL_TYPE` in `anthropic-wire.ts`). Auth comes
 * from pi's model registry — API key or the Claude OAuth credential — so a search bills
 * the SAME identity the conversation does; that credential parity is why this code was
 * consumed rather than hand-rolled (#63).
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 */

const ANTHROPIC_API_VERSION = '2023-06-01'
/** The beta flags the Claude Code OAuth credential requires on direct API calls. */
const ANTHROPIC_OAUTH_BETA_FLAGS = 'claude-code-20250219,oauth-2025-04-20'
/**
 * ⚠ The Claude Code version the OAuth search claims: EXACTLY pi-ai's own hardcoded
 * `claudeCodeVersion` (anthropic-messages.js), which pi's conversation path sends — pi exposes no
 * export for it, and `harness/core` may not import pi (#145). A drift is a broken search, not a
 * cosmetic one: Anthropic refuses the OAuth `web_search` tool below its minimum
 * (`claude_code_version_too_old`, #925) while conversations still pass. `web-search-wire.test.ts`
 * reads pi's installed value and fails when this one differs, so a pi upgrade that moves it is
 * caught there.
 */
const ANTHROPIC_OAUTH_USER_AGENT = 'claude-cli/2.1.280'
/**
 * ⚠ Load-bearing on the OAuth path, not branding: Anthropic rejects a Claude Code OAuth
 * credential whose request lacks this exact identity as the first system block —
 * observed live 2026-09-04 as HTTP 429 `rate_limit_error`/"Error" (request_id
 * req_011CejDyvm41VXVA7BY1jHgw) while the same credential's conversation turns
 * succeeded; with the block, the same credential searched (print receipt 4). pi-ai's
 * provider carries the same line: "For OAuth tokens, we MUST include Claude Code
 * identity".
 */
const ANTHROPIC_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
/** Answer budget: a third of the model's output budget, clamped to a sane band. */
const MIN_ANSWER_TOKENS = 1024
const DEFAULT_ANSWER_TOKENS = 4096
const MAX_ANSWER_TOKENS = 8192
const MAX_SERVER_TOOL_USES = 10

function resolveMessagesUrl(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl)
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

/** The Claude Code OAuth credential's headers; a caller-supplied `Authorization` wins. */
function applyOAuthHeaders(headers: Record<string, string>, apiKey: string): void {
  if (headers.Authorization === undefined && headers.authorization === undefined) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  headers['anthropic-beta'] =
    headers['anthropic-beta'] !== undefined
      ? `${headers['anthropic-beta']},${ANTHROPIC_OAUTH_BETA_FLAGS}`
      : ANTHROPIC_OAUTH_BETA_FLAGS
  headers['user-agent'] = headers['user-agent'] ?? ANTHROPIC_OAUTH_USER_AGENT
  headers['x-app'] = headers['x-app'] ?? 'cli'
}

/** Adds the credential's auth to `headers`; `true` when it is a Claude Code OAuth credential. */
function applyCredentialHeaders(headers: Record<string, string>, apiKey: string | undefined): boolean {
  if (apiKey === undefined || apiKey.length === 0) return false
  if (apiKey.includes('sk-ant-oat')) {
    applyOAuthHeaders(headers, apiKey)
    return true
  }
  if (headers['x-api-key'] === undefined && headers['X-Api-Key'] === undefined) {
    headers['x-api-key'] = apiKey
  }
  return false
}

function answerTokensFor(maxTokens: number): number {
  const modelOutputBudget = Math.floor(maxTokens / 3)
  return Math.min(
    Math.max(MIN_ANSWER_TOKENS, modelOutputBudget > 0 ? modelOutputBudget : DEFAULT_ANSWER_TOKENS),
    MAX_ANSWER_TOKENS,
  )
}

/** @group Web search */
export async function runAnthropicProviderSearch(request: ModelSearchRequest): Promise<WebSearchOutcome> {
  const credential = await resolveProviderCredential('anthropic', request)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'anthropic-version': ANTHROPIC_API_VERSION,
    ...request.model.headers,
    ...credential.headers,
  }
  const isOAuthCredential = applyCredentialHeaders(headers, credential.apiKey)
  const answerTokens = answerTokensFor(request.model.maxTokens)

  return runAnthropicWireSearch({
    providerId: 'anthropic',
    endpointUrl: resolveMessagesUrl(request.model.baseUrl),
    headers,
    modelId: request.model.id,
    prompt: request.query,
    systemTextBlocks: isOAuthCredential ? [ANTHROPIC_OAUTH_IDENTITY] : undefined,
    maxTokens: answerTokens,
    maxServerToolUses: MAX_SERVER_TOOL_USES,
    fetchUrl: request.fetchUrl,
    signal: request.signal,
    onProgress: request.onProgress,
  })
}
