import {
  CLAUDE_CODE_DEFAULT_VERSION,
  claudeCodeUserAgent,
  claudeCodeVersionHint,
  claudeCodeVersionRefusalOf,
  isClaudeLoginCredential,
} from '@enso/core'
import { runAnthropicWireSearch } from '../anthropic-wire.ts'
import { resolveProviderCredential } from '../dispatch.ts'
import { type ModelSearchRequest, type WebSearchOutcome, WebSearchProviderError } from '../vocabulary.ts'
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

/**
 * The Claude Code OAuth credential's headers; a caller-supplied `Authorization` wins.
 *
 * The user-agent claims the configured Claude Code version when there is one (#925), over a
 * model's own header, as pi's conversation path does with the same setting (the request headers
 * it is given override the model's); else the model's, else the version pi itself sends.
 */
function applyOAuthHeaders(
  headers: Record<string, string>,
  apiKey: string,
  claudeCodeVersion: string | undefined,
): void {
  if (headers.Authorization === undefined && headers.authorization === undefined) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  headers['anthropic-beta'] =
    headers['anthropic-beta'] !== undefined
      ? `${headers['anthropic-beta']},${ANTHROPIC_OAUTH_BETA_FLAGS}`
      : ANTHROPIC_OAUTH_BETA_FLAGS
  headers['user-agent'] =
    claudeCodeVersion !== undefined
      ? claudeCodeUserAgent(claudeCodeVersion)
      : (headers['user-agent'] ?? claudeCodeUserAgent(CLAUDE_CODE_DEFAULT_VERSION))
  headers['x-app'] = headers['x-app'] ?? 'cli'
}

/** Adds the credential's auth to `headers`; `true` when it is a Claude Code OAuth credential. */
function applyCredentialHeaders(
  headers: Record<string, string>,
  apiKey: string | undefined,
  claudeCodeVersion: string | undefined,
): boolean {
  if (apiKey === undefined || apiKey.length === 0) return false
  if (isClaudeLoginCredential(apiKey)) {
    applyOAuthHeaders(headers, apiKey, claudeCodeVersion)
    return true
  }
  if (headers['x-api-key'] === undefined && headers['X-Api-Key'] === undefined) {
    headers['x-api-key'] = apiKey
  }
  return false
}

/**
 * Anthropic's refusal of the claimed Claude Code version, with what to do about it in Enso (#925):
 * its own sentence says "Run 'claude update'", which changes nothing Enso sends. Any other error
 * is returned as it came.
 */
function withVersionHint(error: unknown): unknown {
  if (!(error instanceof WebSearchProviderError)) return error
  const refusal = claudeCodeVersionRefusalOf(error.message)
  if (refusal === undefined) return error
  return new WebSearchProviderError(error.providerId, `${error.message} ${claudeCodeVersionHint(refusal)}`, {
    requestDispatched: error.requestDispatched,
  })
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
  const isOAuthCredential = applyCredentialHeaders(headers, credential.apiKey, request.claudeCodeVersion)
  const answerTokens = answerTokensFor(request.model.maxTokens)

  try {
    return await runAnthropicWireSearch({
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
  } catch (error) {
    throw withVersionHint(error)
  }
}
