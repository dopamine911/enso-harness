import { ANTHROPIC_WEB_SEARCH_TOOL_TYPE, runAnthropicWireSearch } from "../anthropic-wire.ts";
import type { ModelSearchRequest, WebSearchOutcome } from "../vocabulary.ts";
import { WebSearchProviderError } from "../vocabulary.ts";

/**
 * The `anthropic` provider (#63): current-model routing onto the Anthropic Messages
 * native `web_search` server tool ({@link ANTHROPIC_WEB_SEARCH_TOOL_TYPE}). Auth comes
 * from pi's model registry — API key or the Claude OAuth credential — so a search bills
 * the SAME identity the conversation does; that credential parity is why this code was
 * consumed rather than hand-rolled (#63).
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 */

const ANTHROPIC_API_VERSION = "2023-06-01";
/** The beta flags the Claude Code OAuth credential requires on direct API calls. */
const ANTHROPIC_OAUTH_BETA_FLAGS = "claude-code-20250219,oauth-2025-04-20";
const ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.75";
/** Answer budget: a third of the model's output budget, clamped to a sane band. */
const MIN_ANSWER_TOKENS = 1024;
const DEFAULT_ANSWER_TOKENS = 4096;
const MAX_ANSWER_TOKENS = 8192;
const MAX_SERVER_TOOL_USES = 10;

function resolveMessagesUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

export async function runAnthropicProviderSearch(request: ModelSearchRequest): Promise<WebSearchOutcome> {
	const credential = await request.resolveAuth(request.model);
	if (!credential.ok) {
		throw new WebSearchProviderError(
			"anthropic",
			credential.error.length > 0 ? credential.error : "no credential resolved",
			{
				requestDispatched: false,
			},
		);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"anthropic-version": ANTHROPIC_API_VERSION,
		...(request.model.headers ?? {}),
		...(credential.headers ?? {}),
	};
	if (credential.apiKey !== undefined && credential.apiKey.length > 0) {
		const isOAuthCredential = credential.apiKey.includes("sk-ant-oat");
		if (isOAuthCredential) {
			if (headers.Authorization === undefined && headers.authorization === undefined) {
				headers.Authorization = `Bearer ${credential.apiKey}`;
			}
			headers["anthropic-beta"] =
				headers["anthropic-beta"] !== undefined
					? `${headers["anthropic-beta"]},${ANTHROPIC_OAUTH_BETA_FLAGS}`
					: ANTHROPIC_OAUTH_BETA_FLAGS;
			headers["user-agent"] = headers["user-agent"] ?? ANTHROPIC_OAUTH_USER_AGENT;
			headers["x-app"] = headers["x-app"] ?? "cli";
		} else if (headers["x-api-key"] === undefined && headers["X-Api-Key"] === undefined) {
			headers["x-api-key"] = credential.apiKey;
		}
	}

	const modelOutputBudget = Math.floor(request.model.maxTokens / 3);
	const answerTokens = Math.min(
		Math.max(MIN_ANSWER_TOKENS, modelOutputBudget > 0 ? modelOutputBudget : DEFAULT_ANSWER_TOKENS),
		MAX_ANSWER_TOKENS,
	);

	return runAnthropicWireSearch({
		providerId: "anthropic",
		endpointUrl: resolveMessagesUrl(request.model.baseUrl),
		headers,
		modelId: request.model.id,
		prompt: request.query,
		maxTokens: answerTokens,
		maxServerToolUses: MAX_SERVER_TOOL_USES,
		fetchUrl: request.fetchUrl,
		signal: request.signal,
		onProgress: request.onProgress,
	});
}
