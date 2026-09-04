import { applyByteIndexCitations, type ByteIndexInsertion } from "../citations.ts";
import { titleFromUrl } from "../sources.ts";
import { readSseEvents } from "../sse.ts";
import type { ModelSearchRequest, WebSearchOutcome, WebSource } from "../vocabulary.ts";
import { WebSearchProviderError } from "../vocabulary.ts";

/**
 * The `google` provider (#63): Gemini "Grounding with Google Search" over the
 * `streamGenerateContent` SSE endpoint. The answer arrives as text parts; the search
 * evidence arrives as `groundingMetadata` on the final chunks — `groundingChunks` are
 * the sources, `groundingSupports` map BYTE ranges of the answer onto chunk indices
 * (hence the byte-safe citation applier), and `webSearchQueries` names the searches the
 * model ran.
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 *
 * ⚠ NO LIVE RECEIPT: no Google key exists in this install (#63) — the stream parse is
 * fixture-tested only. `web-search.test.ts` carries the named non-coverage record.
 */

/** Grounding results hide behind this redirector; a HEAD reveals the real page. */
const GOOGLE_GROUNDING_REDIRECT_PATTERN = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//;
/** Bound on redirect lookups per search — grounding rarely returns more chunks than this. */
const MAX_REDIRECT_RESOLUTIONS = 20;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

interface GroundingDetails {
	searchQueries: string[];
	/** Chunk-ordered sources; index position IS the citation number the supports point at. */
	chunkSources: Array<{ title?: string | undefined; url: string }>;
	insertions: ByteIndexInsertion[];
}

function extractGroundingDetails(groundingMetadata: Record<string, unknown> | undefined): GroundingDetails {
	const searchQueries = Array.isArray(groundingMetadata?.webSearchQueries)
		? groundingMetadata.webSearchQueries.filter((query): query is string => typeof query === "string")
		: [];
	const chunks = Array.isArray(groundingMetadata?.groundingChunks) ? groundingMetadata.groundingChunks : [];
	const supports = Array.isArray(groundingMetadata?.groundingSupports) ? groundingMetadata.groundingSupports : [];

	const chunkSources: Array<{ title?: string | undefined; url: string }> = [];
	for (const chunk of chunks) {
		const web = asRecord(asRecord(chunk)?.web);
		chunkSources.push({ title: asString(web?.title), url: asString(web?.uri) ?? "" });
	}

	const insertions: ByteIndexInsertion[] = [];
	for (const support of supports) {
		const supportRecord = asRecord(support);
		const segment = asRecord(supportRecord?.segment);
		const endIndex = typeof segment?.endIndex === "number" ? segment.endIndex : undefined;
		const chunkIndices = Array.isArray(supportRecord?.groundingChunkIndices)
			? supportRecord.groundingChunkIndices.filter((index): index is number => typeof index === "number")
			: [];
		if (endIndex === undefined || chunkIndices.length === 0) continue;
		insertions.push({ byteIndex: endIndex, marker: chunkIndices.map((chunkIndex) => `[${chunkIndex + 1}]`).join("") });
	}

	return { searchQueries, chunkSources, insertions };
}

/** Swap grounding-redirect URLs for their real targets, in place; failures keep the original. */
async function resolveGroundingRedirects(
	chunkSources: Array<{ title?: string | undefined; url: string }>,
	fetchUrl: ModelSearchRequest["fetchUrl"],
	signal: AbortSignal | undefined,
): Promise<void> {
	const redirectUrls = [
		...new Set(chunkSources.map((source) => source.url).filter((url) => GOOGLE_GROUNDING_REDIRECT_PATTERN.test(url))),
	].slice(0, MAX_REDIRECT_RESOLUTIONS);
	if (redirectUrls.length === 0) return;

	const resolvedTargets = new Map<string, string>();
	await Promise.all(
		redirectUrls.map(async (redirectUrl) => {
			try {
				const response = await fetchUrl(redirectUrl, { method: "HEAD", redirect: "manual", signal });
				const locationHeader = response.headers.get("location");
				if (locationHeader !== null && locationHeader.length > 0) resolvedTargets.set(redirectUrl, locationHeader);
			} catch {
				// Keep the redirect URL — a failed resolution still points somewhere real.
			}
		}),
	);

	for (const source of chunkSources) {
		const resolvedUrl = resolvedTargets.get(source.url);
		if (resolvedUrl === undefined) continue;
		source.url = resolvedUrl;
		if (source.title === undefined || source.title.length === 0 || source.title === "Unknown") {
			source.title = titleFromUrl(resolvedUrl);
		}
	}
}

export async function runGoogleProviderSearch(request: ModelSearchRequest): Promise<WebSearchOutcome> {
	const credential = await request.resolveAuth(request.model);
	if (!credential.ok) {
		throw new WebSearchProviderError(
			"google",
			credential.error.length > 0 ? credential.error : "no credential resolved",
			{
				requestDispatched: false,
			},
		);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(credential.headers ?? {}),
	};
	if (credential.apiKey !== undefined && credential.apiKey.length > 0) headers["x-goog-api-key"] = credential.apiKey;

	const endpointUrl = `${request.model.baseUrl}/models/${request.model.id}:streamGenerateContent?alt=sse`;
	const requestBody = {
		contents: [{ role: "user", parts: [{ text: request.query }] }],
		tools: [{ google_search: {} }],
	};

	let response: Response;
	try {
		response = await request.fetchUrl(endpointUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: request.signal,
		});
	} catch (error) {
		throw new WebSearchProviderError("google", `the search request failed to send: ${String(error)}`, {
			requestDispatched: false,
		});
	}
	if (!response.ok) {
		const errorBody = await response.text();
		throw new WebSearchProviderError("google", `the search API answered HTTP ${response.status}: ${errorBody}`, {
			requestDispatched: true,
		});
	}

	let accumulatedText = "";
	let groundingMetadata: Record<string, unknown> | undefined;

	try {
		await readSseEvents(response, request.signal, ({ data }) => {
			const chunk = asRecord(data);
			if (chunk === undefined) return undefined;
			const chunkError = asRecord(chunk.error);
			if (chunkError !== undefined) {
				throw new WebSearchProviderError(
					"google",
					`the search API reported an error: ${asString(chunkError.message) ?? JSON.stringify(chunkError)}`,
					{ requestDispatched: true },
				);
			}
			// Internal Google APIs wrap the payload one level deeper under `response`.
			const payload = asRecord(chunk.response) ?? chunk;
			const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
			const candidate = asRecord(candidates[0]);
			if (candidate === undefined) return undefined;

			const content = asRecord(candidate.content);
			const parts = Array.isArray(content?.parts) ? content.parts : [];
			for (const part of parts) {
				const partText = asString(asRecord(part)?.text);
				if (partText !== undefined && partText.length > 0) {
					accumulatedText += partText;
					request.onProgress?.(accumulatedText);
				}
			}

			const candidateGrounding = asRecord(candidate.groundingMetadata);
			if (candidateGrounding !== undefined) groundingMetadata = candidateGrounding;
			return undefined;
		});
	} catch (error) {
		if (error instanceof WebSearchProviderError) throw error;
		throw new WebSearchProviderError("google", `the search stream failed: ${String(error)}`, {
			requestDispatched: true,
		});
	}

	const answerText = accumulatedText.length > 0 ? accumulatedText : "No answer text was returned.";
	const details = extractGroundingDetails(groundingMetadata);
	// ⚠ The searched/ungrounded verdict: grounding metadata carrying actual search queries
	// or chunks is Gemini's equivalent of the Anthropic server_tool_use block (#63) — the
	// bare answer text proves nothing.
	if (details.searchQueries.length === 0 && details.chunkSources.length === 0) {
		return { kind: "ungrounded", providerId: "google", answerText };
	}

	await resolveGroundingRedirects(details.chunkSources, request.fetchUrl, request.signal);
	const citedText = applyByteIndexCitations(answerText, details.insertions);
	// Chunk order IS the citation numbering — no dedupe, no reorder (see anthropic-wire.ts).
	const sources: WebSource[] = details.chunkSources.map((chunkSource) => ({
		title:
			chunkSource.title !== undefined && chunkSource.title.length > 0
				? chunkSource.title
				: titleFromUrl(chunkSource.url),
		url: chunkSource.url,
	}));
	return { kind: "searched", providerId: "google", answerText: citedText, sources };
}
