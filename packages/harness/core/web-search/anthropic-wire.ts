import { applyTextCitations, type CitedTextCitation } from "./citations.ts";
import { cleanSources, normalizeSearchUrl, titleFromUrl } from "./sources.ts";
import { readSseEvents } from "./sse.ts";
import type { FetchUrl, WebSearchOutcome, WebSearchProviderId } from "./vocabulary.ts";
import { WebSearchProviderError } from "./vocabulary.ts";

/**
 * The Anthropic Messages WIRE — one streaming `/messages` call with the native
 * `web_search` server tool, parsed into the outcome union. ⚠ Shared by TWO providers:
 * `anthropic` (current-model routing, pi-resolved auth) and `deepseek` (the dedicated
 * backend — DeepSeek's search endpoint speaks this exact wire at its Anthropic-compatible
 * base, #63). Callers own endpoint, headers, model id and budgets; this module owns the
 * request body, the stream parse, and the searched/ungrounded verdict.
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 *
 * ⚠ The searched/ungrounded verdict is keyed on `server_tool_use` /
 * `web_search_tool_result` BLOCKS having appeared — never on source count (#63; a real
 * search can return zero sources, and an ungrounded answer citing a made-up URL would
 * read as grounded). DeepSeek documents the same structured blocks (dsh's provider
 * parses them identically), so the verdict is meaningful on both backends.
 */

/**
 * The server-tool type both wires accept. 2026-09-04: DeepSeek's Anthropic-compatible
 * API documents exactly this dated identifier (dsh `web-search-deepseek` sends it), so a
 * NEWER Anthropic tool date must not be adopted here without re-verifying DeepSeek.
 */
export const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

export interface AnthropicWireSearchOptions {
	providerId: WebSearchProviderId;
	/** The full `/messages` endpoint URL. */
	endpointUrl: string;
	/** Fully resolved request headers, auth included. */
	headers: Record<string, string>;
	modelId: string;
	/** The user text sent to the searching model. */
	prompt: string;
	maxTokens: number;
	maxServerToolUses: number;
	fetchUrl: FetchUrl;
	signal: AbortSignal | undefined;
	onProgress?: ((text: string) => void) | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export async function runAnthropicWireSearch(options: AnthropicWireSearchOptions): Promise<WebSearchOutcome> {
	const requestBody = {
		model: options.modelId,
		max_tokens: options.maxTokens,
		messages: [{ role: "user", content: options.prompt }],
		tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: options.maxServerToolUses }],
		stream: true,
	};

	let response: Response;
	try {
		response = await options.fetchUrl(options.endpointUrl, {
			method: "POST",
			headers: options.headers,
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});
	} catch (error) {
		throw new WebSearchProviderError(options.providerId, `the search request failed to send: ${String(error)}`, {
			requestDispatched: false,
		});
	}
	if (!response.ok) {
		const errorBody = await response.text();
		throw new WebSearchProviderError(
			options.providerId,
			`the search API answered HTTP ${response.status}: ${errorBody}`,
			{
				requestDispatched: true,
			},
		);
	}

	let accumulatedText = "";
	const citations: CitedTextCitation[] = [];
	const resultSources: Array<{ title?: string | undefined; url: string }> = [];
	let sawNativeSearchBlock = false;

	const collectResultSource = (resultEntry: unknown): void => {
		const entry = asRecord(resultEntry);
		const url = asString(entry?.url);
		if (entry === undefined || url === undefined || url.length === 0) return;
		resultSources.push({ title: asString(entry.title), url });
	};

	const handleBlockStart = (block: Record<string, unknown>): void => {
		const blockType = asString(block.type);
		if (blockType === "text") {
			const initialText = asString(block.text);
			if (initialText !== undefined && initialText.length > 0) {
				accumulatedText += initialText;
				options.onProgress?.(accumulatedText);
			}
		} else if (blockType === "server_tool_use" && asString(block.name) === "web_search") {
			sawNativeSearchBlock = true;
			options.onProgress?.(accumulatedText);
		} else if (blockType === "web_search_tool_result") {
			sawNativeSearchBlock = true;
			const blockContent = block.content;
			if (Array.isArray(blockContent)) {
				for (const resultEntry of blockContent) collectResultSource(resultEntry);
			}
			// A `web_search_tool_result_error` content object still proves a search RAN;
			// it just returned nothing collectable.
		}
	};

	const handleDelta = (delta: Record<string, unknown>): void => {
		const deltaType = asString(delta.type);
		if (deltaType === "text_delta") {
			accumulatedText += asString(delta.text) ?? "";
			options.onProgress?.(accumulatedText);
		} else if (deltaType === "citations_delta") {
			const citation = asRecord(delta.citation);
			const citationUrl = asString(citation?.url);
			if (
				citation !== undefined &&
				asString(citation.type) === "web_search_result_location" &&
				citationUrl !== undefined
			) {
				citations.push({
					citedText: asString(citation.cited_text),
					title: asString(citation.title) ?? titleFromUrl(citationUrl),
					url: citationUrl,
				});
			}
		}
	};

	try {
		await readSseEvents(response, options.signal, ({ data }) => {
			const event = asRecord(data);
			if (event === undefined) return undefined;
			const eventType = asString(event.type);
			if (eventType === "content_block_start") {
				const block = asRecord(event.content_block);
				if (block !== undefined) handleBlockStart(block);
			} else if (eventType === "content_block_delta") {
				const delta = asRecord(event.delta);
				if (delta !== undefined) handleDelta(delta);
			} else if (eventType === "error") {
				const errorRecord = asRecord(event.error);
				throw new WebSearchProviderError(
					options.providerId,
					asString(errorRecord?.message) ?? JSON.stringify(event.error ?? event),
					{ requestDispatched: true },
				);
			}
			return undefined;
		});
	} catch (error) {
		if (error instanceof WebSearchProviderError) throw error;
		throw new WebSearchProviderError(options.providerId, `the search stream failed: ${String(error)}`, {
			requestDispatched: true,
		});
	}

	const answerText = accumulatedText.length > 0 ? accumulatedText : "No answer text was returned.";
	if (!sawNativeSearchBlock) {
		return { kind: "ungrounded", providerId: options.providerId, answerText };
	}

	const cited = applyTextCitations(answerText, citations);
	// Citation-backed sources first and UNTOUCHED — their positions ARE the `[n]` markers
	// already inserted into the text, so normalizing or deduping them here would renumber
	// the list out from under the markers (a defect the consumed code had: it junk-filtered
	// AFTER numbering). Only the never-cited search results get the hygiene pass, appended.
	const citedUrls = new Set(cited.sources.flatMap((source) => [source.url, normalizeSearchUrl(source.url)]));
	const uncitedSources = cleanSources(resultSources).filter((source) => !citedUrls.has(source.url));
	const sources = [...cited.sources, ...uncitedSources];
	return { kind: "searched", providerId: options.providerId, answerText: cited.text, sources };
}
