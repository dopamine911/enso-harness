import { readFileSync } from "node:fs";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	EXTERNAL_WEB_CONTENT_NOTICE,
	findRepoRoot,
	parseZenConfig,
	WEB_SEARCH_TIMEOUT_MS,
	WEB_SEARCH_TOOL_NAME,
	type WebSearchConfig,
	WebSearchToolParameters,
	ZEN_CONFIG_FILENAME,
	zenConfigPath,
} from "@zen/core";
import {
	DEEPSEEK_API_KEY_VARIABLE,
	type DeepseekSearchRequest,
	type ModelSearchRequest,
	resolveModelAuth,
	routedProviderIdForModel,
	runAnthropicProviderSearch,
	runDeepseekProviderSearch,
	runGoogleProviderSearch,
	runOpenAiProviderSearch,
	runTavilyProviderSearch,
	TAVILY_API_KEY_VARIABLE,
	type TavilySearchRequest,
	type WebSearchOutcome,
	WebSearchProviderError,
	type WebSearchProviderId,
} from "../../core/index.ts";

/**
 * The web_search tool (#63) — provider-native search with a Tavily fallback, consumed
 * from pi-web-search 1.4.0 (© ttttmr, MIT) and retyped behind zen's seams.
 *
 * The shape, in one pass:
 *
 * 1. **Primary selection.** `zen.config.json`'s optional `webSearch.backend: "deepseek"`
 *    pins the dedicated DeepSeek backend; otherwise the CURRENT MODEL routes to its own
 *    native search API (anthropic / google / openai families), billing the same identity
 *    the conversation does. A model with no native search selects nothing.
 * 2. **The fallback.** When the primary is unavailable, fails, or answers WITHOUT
 *    searching (`ungrounded`), and `TAVILY_API_KEY` is present in the environment, one
 *    Tavily retrieval call answers instead. Key absent → the primary's own outcome is
 *    returned unchanged. No config knob arms this — a key is a secret and secrets never
 *    enter the committed config.
 * 3. **The ACCURATE response** (#63, the requirement this exists for): every result's
 *    first line names the backend that answered and, on fallback, why. An ungrounded
 *    answer is never rendered as a search result — with no fallback armed it is returned
 *    labeled "no web search was performed". searched-vs-ungrounded is keyed on native
 *    search-activity blocks in the stream, never on source count.
 * 4. **One audit line per call** (stderr): provider, outcome, query, fallback reason —
 *    never a key.
 *
 * Config is read ONCE at extension load (the web_fetch discipline, #54): a session
 * cannot re-point its own search backend by editing the file mid-run. An unreadable
 * config fails CLOSED — "could not read the policy" is never "no policy".
 */

/** The IO seams. Provider runs are injectable so the fallback policy is testable alone. */
export interface WebSearchDependencies {
	/** Where `zen.config.json` lives. May throw; the extension fails CLOSED on that. */
	locateConfigFile: () => string;
	readConfigText: (path: string) => string;
	/** Env reads happen HERE (composition root) — providers receive values, never names. */
	readEnvironmentVariable: (variableName: string) => string | undefined;
	runProviders: {
		anthropic: (request: ModelSearchRequest) => Promise<WebSearchOutcome>;
		google: (request: ModelSearchRequest) => Promise<WebSearchOutcome>;
		openai: (request: ModelSearchRequest) => Promise<WebSearchOutcome>;
		deepseek: (request: DeepseekSearchRequest) => Promise<WebSearchOutcome>;
		tavily: (request: TavilySearchRequest) => Promise<WebSearchOutcome>;
	};
	fetchUrl: ModelSearchRequest["fetchUrl"];
}

/** A primary attempt that could not run or threw — the fallback's trigger record. */
interface PrimaryFailure {
	providerId: WebSearchProviderId | undefined;
	reason: string;
	/** True when an HTTP request left the process — the honest "may have billed" bit. */
	requestDispatched: boolean;
}

export function createWebSearch(dependencies: WebSearchDependencies): (pi: ExtensionAPI) => void {
	return function webSearch(pi: ExtensionAPI): void {
		// Load ONCE at extension load; see the header. The tool registers even on a broken
		// config so the refusal can say what to fix (a load-time throw could wedge pi).
		let webSearchConfig: WebSearchConfig = {};
		let configProblem: string | undefined;
		let configPath: string | undefined;
		try {
			configPath = dependencies.locateConfigFile();
			const parsed = parseZenConfig(dependencies.readConfigText(configPath));
			if (parsed.kind === "ok") {
				webSearchConfig = parsed.config.webSearch ?? {};
			} else {
				configProblem = parsed.reason;
			}
		} catch (error) {
			configProblem = `the config file could not be read: ${String(error)}`;
		}
		const configDisplayPath = configPath ?? `${ZEN_CONFIG_FILENAME} (at the zen-harness repository root)`;

		pi.registerTool({
			name: WEB_SEARCH_TOOL_NAME,
			label: "Web search",
			description:
				`Search the live web. Primary: the current model's own native search ` +
				`(Anthropic / Google Gemini / OpenAI Responses families)` +
				(webSearchConfig.backend === "deepseek" ? `, pinned by config to the dedicated DeepSeek backend` : "") +
				`; fallback: the Tavily retrieval API when its key is configured. The result names ` +
				`which backend answered — an answer produced WITHOUT searching is labeled as such, ` +
				`never presented as a search result.`,
			promptSnippet: `${WEB_SEARCH_TOOL_NAME}: search the live web (provider-native, Tavily fallback)`,
			parameters: WebSearchToolParameters,
			// ⚠ pi's execute contract is FIVE positional arguments and the gate caps declared
			// parameters at four (useMaxParams), so they arrive as a named tuple instead.
			execute: async (...executeArguments: WebSearchExecuteArguments): Promise<AgentToolResult<undefined>> => {
				const [, params, signal, onUpdate, extensionContext] = executeArguments;
				const query = params.query;
				if (configProblem !== undefined) {
					return refusal(
						`the ${WEB_SEARCH_TOOL_NAME} configuration could not be used — ${configProblem}. ` +
							`Nothing is searchable until a human fixes ${configDisplayPath} and restarts the session.`,
					);
				}

				const tavilyApiKey = dependencies.readEnvironmentVariable(TAVILY_API_KEY_VARIABLE);
				const isTavilyArmed = tavilyApiKey !== undefined && tavilyApiKey.length > 0;

				// --- the primary attempt.
				const primary = await runPrimary({
					dependencies,
					webSearchConfig,
					extensionContext,
					query,
					signal,
					onProgress: progressForwarder(onUpdate),
				});

				// --- the fallback decision. `searched` never falls back; everything else does
				// when Tavily is armed.
				const fallbackReason = fallbackReasonFor(primary);
				if (fallbackReason === undefined) {
					const outcome = primary as WebSearchOutcome;
					auditLine(outcome.kind, outcome.providerId, query, "primary");
					return renderOutcome(outcome, undefined);
				}
				if (!isTavilyArmed) {
					if ("kind" in primary && primary.kind === "ungrounded") {
						auditLine("ungrounded", primary.providerId, query, "no fallback armed");
						return renderUngrounded(primary);
					}
					const failure = primary as PrimaryFailure;
					auditLine("refused", failure.providerId, query, failure.reason);
					return refusal(
						`${failure.reason}. The Tavily fallback is not armed — a human can set ` +
							`${TAVILY_API_KEY_VARIABLE} in the environment (never in ${ZEN_CONFIG_FILENAME}) ` +
							`and restart the session.`,
					);
				}

				try {
					const tavilyOutcome = await underDeadline(signal, (deadlineSignal) =>
						dependencies.runProviders.tavily({
							query,
							apiKey: tavilyApiKey,
							includeDomains: webSearchConfig.tavily?.includeDomains,
							excludeDomains: webSearchConfig.tavily?.excludeDomains,
							fetchUrl: dependencies.fetchUrl,
							signal: deadlineSignal,
						}),
					);
					auditLine(tavilyOutcome.kind, "tavily", query, `fallback: ${fallbackReason}`);
					return renderOutcome(tavilyOutcome, fallbackReason);
				} catch (error) {
					const tavilyReason = error instanceof Error ? error.message : String(error);
					auditLine("refused", "tavily", query, tavilyReason);
					return refusal(`${fallbackReason}; the Tavily fallback then failed too: ${tavilyReason}`);
				}
			},
		});
	};
}

/** pi's five positional execute arguments, named as a tuple (see the execute comment). */
type WebSearchExecuteArguments = [
	toolCallId: string,
	params: { query: string },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<undefined> | undefined,
	extensionContext: ExtensionContext,
];

interface RunPrimaryOptions {
	dependencies: WebSearchDependencies;
	webSearchConfig: WebSearchConfig;
	extensionContext: ExtensionContext;
	query: string;
	signal: AbortSignal | undefined;
	onProgress: (text: string) => void;
}

/** Run the selected primary backend; a non-outcome return is the failure record. */
async function runPrimary(options: RunPrimaryOptions): Promise<WebSearchOutcome | PrimaryFailure> {
	const { dependencies, webSearchConfig, extensionContext, query, signal, onProgress } = options;
	try {
		if (webSearchConfig.backend === "deepseek") {
			return await underDeadline(signal, (deadlineSignal) =>
				dependencies.runProviders.deepseek({
					query,
					apiKey: dependencies.readEnvironmentVariable(DEEPSEEK_API_KEY_VARIABLE),
					fetchUrl: dependencies.fetchUrl,
					signal: deadlineSignal,
					onProgress,
				}),
			);
		}

		const currentModel = extensionContext.model;
		if (currentModel === undefined) {
			return { providerId: undefined, reason: "no model is selected", requestDispatched: false };
		}
		const routedProviderId = routedProviderIdForModel(currentModel);
		if (routedProviderId === undefined) {
			return {
				providerId: undefined,
				reason:
					`the current model (${currentModel.id}, ${currentModel.provider}/${currentModel.api}) ` +
					`has no native web search`,
				requestDispatched: false,
			};
		}
		const modelRequest = (deadlineSignal: AbortSignal): ModelSearchRequest => ({
			query,
			model: currentModel,
			resolveAuth: (model) => resolveModelAuth(extensionContext.modelRegistry, model),
			fetchUrl: dependencies.fetchUrl,
			signal: deadlineSignal,
			onProgress,
		});
		return await underDeadline(signal, (deadlineSignal) =>
			dependencies.runProviders[routedProviderId](modelRequest(deadlineSignal)),
		);
	} catch (error) {
		if (error instanceof WebSearchProviderError) {
			return { providerId: error.providerId, reason: error.message, requestDispatched: error.requestDispatched };
		}
		return { providerId: undefined, reason: String(error), requestDispatched: false };
	}
}

/** Why the fallback should run, or undefined when the primary outcome stands. */
function fallbackReasonFor(primary: WebSearchOutcome | PrimaryFailure): string | undefined {
	if ("kind" in primary) {
		if (primary.kind === "searched") return undefined;
		return `the ${primary.providerId} backend answered WITHOUT searching (the model used its own knowledge)`;
	}
	const providerName = primary.providerId ?? "primary";
	const billingNote = primary.requestDispatched ? " after the request was sent (it may have billed)" : "";
	return `the ${providerName} search failed${billingNote}: ${primary.reason}`;
}

/** Run one provider attempt under the per-attempt deadline AND the caller's signal. */
async function underDeadline<T>(
	callerSignal: AbortSignal | undefined,
	run: (deadlineSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(new Error(`${WEB_SEARCH_TOOL_NAME} timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`)),
		WEB_SEARCH_TIMEOUT_MS,
	);
	const abortWithCaller = (): void => controller.abort(callerSignal?.reason);
	// An ALREADY-aborted signal never fires the event — same pre-abort guard as web_fetch.
	if (callerSignal?.aborted === true) {
		abortWithCaller();
	} else {
		callerSignal?.addEventListener("abort", abortWithCaller, { once: true });
	}
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timeoutId);
		callerSignal?.removeEventListener("abort", abortWithCaller);
	}
}

function progressForwarder(onUpdate: AgentToolUpdateCallback<undefined> | undefined): (text: string) => void {
	return (text: string): void => {
		onUpdate?.({ content: [{ type: "text", text }], details: undefined });
	};
}

function refusal(reason: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: `Not searched: ${reason}` }], details: undefined };
}

/** An ungrounded answer with no fallback armed: returned, loudly labeled, never as a search. */
function renderUngrounded(outcome: Extract<WebSearchOutcome, { kind: "ungrounded" }>): AgentToolResult<undefined> {
	return {
		content: [
			{
				type: "text",
				text:
					`No web search was performed — the ${outcome.providerId} model answered from its own ` +
					`knowledge, and this is NOT a search result.\n\n${outcome.answerText}`,
			},
		],
		details: undefined,
	};
}

/** Render a `searched` outcome: backend-named first line, the notice, answer, sources. */
function renderOutcome(outcome: WebSearchOutcome, fallbackReason: string | undefined): AgentToolResult<undefined> {
	if (outcome.kind === "ungrounded") return renderUngrounded(outcome);

	const viaLine =
		fallbackReason === undefined
			? `Searched the web via ${outcome.providerId}.`
			: `Searched the web via ${outcome.providerId} (fallback — ${fallbackReason}).`;

	const bodySections: string[] = [viaLine, EXTERNAL_WEB_CONTENT_NOTICE];
	if (outcome.answerText !== undefined && outcome.answerText.length > 0) {
		bodySections.push(outcome.answerText);
	}
	if (outcome.snippets !== undefined && outcome.snippets.length > 0) {
		const snippetLines = outcome.snippets.map((snippet, snippetIndex) => {
			const snippetTail = snippet.snippet !== undefined && snippet.snippet.length > 0 ? `\n   ${snippet.snippet}` : "";
			return `${snippetIndex + 1}. ${snippet.title} — ${snippet.url}${snippetTail}`;
		});
		bodySections.push(`## Results\n${snippetLines.join("\n")}`);
	} else if (outcome.sources.length > 0) {
		const sourceLines = outcome.sources.map(
			(source, sourceIndex) => `${sourceIndex + 1}. [${source.title}](${source.url})`,
		);
		bodySections.push(`## Sources\n${sourceLines.join("\n")}`);
	}

	return { content: [{ type: "text", text: bodySections.join("\n\n") }], details: undefined };
}

/** One stderr line per call, every outcome — the audit property (#54's discipline). */
function auditLine(outcome: string, providerId: WebSearchProviderId | undefined, query: string, detail: string): void {
	console.error(
		`${WEB_SEARCH_TOOL_NAME} audit: ${outcome} provider=${providerId ?? "(none)"} query=${query} — ${detail}`,
	);
}

/**
 * The pi entry point — real filesystem, env and fetch, wired at the composition root.
 * `findRepoRoot` realpaths first, so the config named is the COMMITTED file even under
 * the print harness's symlink mirror (#20, same rationale as web_fetch's root).
 */
export default createWebSearch({
	locateConfigFile: () => zenConfigPath(findRepoRoot(import.meta.url)),
	readConfigText: (path) => readFileSync(path, "utf8"),
	readEnvironmentVariable: (variableName) => process.env[variableName],
	runProviders: {
		anthropic: runAnthropicProviderSearch,
		google: runGoogleProviderSearch,
		openai: runOpenAiProviderSearch,
		deepseek: runDeepseekProviderSearch,
		tavily: runTavilyProviderSearch,
	},
	fetchUrl: (url, init) => fetch(url, { ...init, signal: init.signal ?? null }),
});
