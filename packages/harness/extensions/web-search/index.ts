import { readFileSync } from 'node:fs'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getEnvApiKey } from '@earendil-works/pi-ai/compat'
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  ENSO_CONFIG_FILENAME,
  EXTERNAL_WEB_CONTENT_NOTICE,
  ensoLogger,
  parseEnsoConfig,
  WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchConfig,
  WebSearchToolParameters,
} from '@enso/core'
import { ensoConfigPath, findRepoRoot } from '@enso/core/paths'
import { readSecret } from '@enso/core/secrets'
import {
  DEEPSEEK_API_KEY_VARIABLE,
  type DeepseekSearchRequest,
  type FetchUrlInit,
  type ModelSearchRequest,
  type ResolvedProviderAuth,
  resolveModelAuth,
  routedProviderIdForModel,
  runAnthropicProviderSearch,
  runDeepseekProviderSearch,
  runGoogleProviderSearch,
  runOpenAiProviderSearch,
  runTavilyProviderSearch,
  runUnderDeadline,
  type SearchModel,
  TAVILY_API_KEY_VARIABLE,
  type TavilySearchRequest,
  type WebSearchOutcome,
  WebSearchProviderError,
  type WebSearchProviderId,
} from '../../core/index.ts'

/**
 * The web_search tool (#63) — provider-native search with a Tavily fallback, consumed
 * from pi-web-search 1.4.0 (© ttttmr, MIT) and retyped behind enso's seams.
 *
 * The shape, in one pass:
 *
 * 1. **Primary selection.** `enso.config.json`'s optional `webSearch.backend: "deepseek"`
 *    pins the dedicated DeepSeek backend; otherwise the CURRENT MODEL routes to its own
 *    native search API (anthropic / google / openai families), billing the same identity
 *    the conversation does. A model with no native search selects nothing.
 * 2. **The fallback.** When the primary is unavailable, fails, or answers WITHOUT
 *    searching (`ungrounded`), and `TAVILY_API_KEY` is present in the gated secrets file
 *    `.enso/secrets.env` (#89 — never the process environment), one Tavily call answers instead. Key absent → the primary's own outcome is
 *    returned unchanged. No config knob arms this — a key is a secret and secrets never
 *    enter the committed config.
 * 3. **The ACCURATE response** (#63, the requirement this exists for): every result's
 *    first line names the backend that answered and, on fallback, why. An ungrounded
 *    answer is never rendered as a search result — with no fallback armed it is returned
 *    labeled "no web search was performed". searched-vs-ungrounded is keyed on native
 *    search-activity blocks in the stream, never on source count.
 * 4. **One audit record per call** (#132 — a log record, not a stderr line): provider,
 *    outcome, query, fallback reason — never a key.
 *
 * Config is read ONCE at extension load (the web_fetch discipline, #54): a session
 * cannot re-point its own search backend by editing the file mid-run. An unreadable
 * config fails CLOSED — "could not read the policy" is never "no policy".
 */

/** The IO seams. Provider runs are injectable so the fallback policy is testable alone. */
export interface WebSearchDependencies {
  /** Where `enso.config.json` lives. May throw; the extension fails CLOSED on that. */
  locateConfigFile: () => string
  readConfigText: (path: string) => string
  /** Env reads happen HERE (composition root) — providers receive values, never names. */
  readEnvironmentVariable: (variableName: string) => string | undefined
  runProviders: {
    anthropic: (request: ModelSearchRequest) => Promise<WebSearchOutcome>
    google: (request: ModelSearchRequest) => Promise<WebSearchOutcome>
    openai: (request: ModelSearchRequest) => Promise<WebSearchOutcome>
    deepseek: (request: DeepseekSearchRequest) => Promise<WebSearchOutcome>
    tavily: (request: TavilySearchRequest) => Promise<WebSearchOutcome>
  }
  fetchUrl: ModelSearchRequest['fetchUrl']
  /** The whole-call deadline. Defaults to `WEB_SEARCH_TIMEOUT_MS`; injectable so the chain's budget is testable in milliseconds. */
  timeoutMs?: number
}

/** A primary attempt that could not run or threw — the fallback's trigger record. */
interface PrimaryFailure {
  providerId: WebSearchProviderId | undefined
  reason: string
  /** True when an HTTP request left the process — the honest "may have billed" bit. */
  requestDispatched: boolean
}

/**
 * The runtime's model record → the provider seam's `SearchModel` (L6): the seven fields the
 * providers read, copied — nothing of the runtime's type crosses into `harness/core`.
 */
function searchModelOf(model: Model<Api>): SearchModel {
  return {
    id: model.id,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    maxTokens: model.maxTokens,
    ...(model.headers === undefined ? {} : { headers: model.headers }),
  }
}

export function createWebSearch(dependencies: WebSearchDependencies): (pi: ExtensionAPI) => void {
  return function webSearch(pi: ExtensionAPI): void {
    // Load ONCE at extension load; see the header. The tool registers even on a broken
    // config so the refusal can say what to fix (a load-time throw could wedge pi).
    let webSearchConfig: WebSearchConfig = {}
    let configProblem: string | undefined
    let configPath: string | undefined
    try {
      configPath = dependencies.locateConfigFile()
      const parsed = parseEnsoConfig(dependencies.readConfigText(configPath))
      if (parsed.kind === 'ok') {
        webSearchConfig = parsed.config.webSearch ?? {}
      } else {
        configProblem = parsed.reason
      }
    } catch (error) {
      configProblem = `the config file could not be read: ${String(error)}`
    }
    const configDisplayPath = configPath ?? `${ENSO_CONFIG_FILENAME} (at the Enso repository root)`

    pi.registerTool({
      name: WEB_SEARCH_TOOL_NAME,
      label: 'Web search',
      description:
        `Search the live web. Primary: the current model's own native search ` +
        `(Anthropic / Google Gemini / OpenAI Responses families)` +
        (webSearchConfig.backend === 'deepseek' ? `, pinned by config to the dedicated DeepSeek backend` : '') +
        `; fallback: the Tavily retrieval API when its key is configured. The result names ` +
        `which backend answered — an answer produced WITHOUT searching is labeled as such, ` +
        `never presented as a search result.`,
      promptSnippet: `${WEB_SEARCH_TOOL_NAME}: search the live web (provider-native, Tavily fallback)`,
      parameters: WebSearchToolParameters,
      // ⚠ pi's execute contract is FIVE positional arguments and the gate caps declared
      // parameters at four (useMaxParams), so they arrive as a named tuple instead.
      execute: async (...executeArguments: WebSearchExecuteArguments): Promise<AgentToolResult<undefined>> => {
        const [, params, signal, onUpdate, extensionContext] = executeArguments
        const query = params.query
        if (configProblem !== undefined) {
          return refusal(
            `the ${WEB_SEARCH_TOOL_NAME} configuration could not be used — ${configProblem}. ` +
              `Nothing is searchable until a human fixes ${configDisplayPath} and restarts the session.`,
          )
        }
        const tavilyApiKey = dependencies.readEnvironmentVariable(TAVILY_API_KEY_VARIABLE)
        const isTavilyArmed = tavilyApiKey !== undefined && tavilyApiKey.length > 0
        // ⚠ ONE deadline for the call (#99): the fallback runs under what the primary left,
        // so primary + fallback can never outlast the server's no-progress cutoff.
        const budgetMs = dependencies.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS
        const deadline: CallDeadline = { at: Date.now() + budgetMs, budgetMs }
        const onProgress = progressForwarder(onUpdate)

        // --- the primary attempt.
        const primary = await runPrimary({
          dependencies,
          webSearchConfig,
          extensionContext,
          query,
          signal,
          deadline,
          onProgress,
        })

        // --- the fallback decision. `searched` never falls back; everything else does
        // when Tavily is armed.
        //
        // ⚠ THE DISCRIMINANT IS THE BRANCH, not a string the call site re-reads (#227).
        // `fallbackReasonFor` used to return `string | undefined` and `undefined` meant
        // "the primary stands", so two `as` casts stood in for a narrowing the compiler
        // could not carry. The one edit anyone would plausibly make — "do not fall back
        // when the request already billed", i.e. return `undefined` for some
        // `PrimaryFailure` — then compiled unchanged and sent a `PrimaryFailure` down the
        // `searched` path, where `renderOutcome` reads `.sources` off an object that has
        // none and throws out of `execute`. Now that edit cannot be written.
        if ('kind' in primary && primary.kind === 'searched') {
          auditLine(primary.kind, primary.providerId, query, 'primary')
          return renderOutcome(primary, undefined)
        }
        if (!isTavilyArmed) {
          if ('kind' in primary) {
            auditLine('ungrounded', primary.providerId, query, 'no fallback armed')
            return renderUngrounded(primary)
          }
          auditLine('refused', primary.providerId, query, primary.reason)
          return refusal(
            `${primary.reason}. The Tavily fallback is not armed — a human can set ` +
              `${TAVILY_API_KEY_VARIABLE} in .enso/secrets.env (never in ${ENSO_CONFIG_FILENAME}, never in ` +
              `the root .env, never in the environment — #89). No restart needed; the file is read per call.`,
          )
        }
        // After the unarmed branch, which builds its refusal from `primary` directly: computed
        // where it is read, so "why is this string here" needs no answer (#227).
        const fallbackReason = fallbackReasonFor(primary)

        // A progress update before the fallback: the server counts tool activity as
        // progress (#99), and this is the one moment in the chain that is otherwise silent.
        onProgress(`${fallbackReason} — trying the Tavily fallback…`)
        try {
          const tavilyOutcome = await underDeadline(signal, deadline, (deadlineSignal) =>
            dependencies.runProviders.tavily({
              query,
              apiKey: tavilyApiKey,
              includeDomains: webSearchConfig.tavily?.includeDomains,
              excludeDomains: webSearchConfig.tavily?.excludeDomains,
              fetchUrl: dependencies.fetchUrl,
              signal: deadlineSignal,
            }),
          )
          auditLine(tavilyOutcome.kind, 'tavily', query, `fallback: ${fallbackReason}`)
          return renderOutcome(tavilyOutcome, fallbackReason)
        } catch (error) {
          const tavilyReason = error instanceof Error ? error.message : String(error)
          auditLine('refused', 'tavily', query, tavilyReason)
          return refusal(`${fallbackReason}; the Tavily fallback then failed too: ${tavilyReason}`)
        }
      },
    })
  }
}

/** pi's five positional execute arguments, named as a tuple (see the execute comment). */
type WebSearchExecuteArguments = [
  toolCallId: string,
  params: { query: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<undefined> | undefined,
  extensionContext: ExtensionContext,
]

interface RunPrimaryOptions {
  dependencies: WebSearchDependencies
  webSearchConfig: WebSearchConfig
  extensionContext: ExtensionContext
  query: string
  signal: AbortSignal | undefined
  deadline: CallDeadline
  onProgress: (text: string) => void
}

/** Run the selected primary backend; a non-outcome return is the failure record. */
async function runPrimary(options: RunPrimaryOptions): Promise<WebSearchOutcome | PrimaryFailure> {
  const { dependencies, webSearchConfig, extensionContext, query, signal, deadline, onProgress } = options
  try {
    if (webSearchConfig.backend === 'deepseek') {
      return await underDeadline(signal, deadline, (deadlineSignal) =>
        dependencies.runProviders.deepseek({
          query,
          apiKey: dependencies.readEnvironmentVariable(DEEPSEEK_API_KEY_VARIABLE),
          fetchUrl: dependencies.fetchUrl,
          signal: deadlineSignal,
          onProgress,
        }),
      )
    }

    const currentModel = extensionContext.model
    if (currentModel === undefined) {
      return { providerId: undefined, reason: 'no model is selected', requestDispatched: false }
    }
    const routedProviderId = routedProviderIdForModel(searchModelOf(currentModel))
    if (routedProviderId === undefined) {
      return {
        providerId: undefined,
        reason:
          `the current model (${currentModel.id}, ${currentModel.provider}/${currentModel.api}) ` +
          `has no native web search`,
        requestDispatched: false,
      }
    }
    // L6 closed: the runtime's model record crosses the provider seam as OURS, converted here
    // and nowhere else; the registry (the runtime's) is asked with the runtime's record, which
    // this closure holds — the provider never sees it.
    const modelRequest = (deadlineSignal: AbortSignal): ModelSearchRequest => ({
      query,
      model: searchModelOf(currentModel),
      resolveAuth: (model: SearchModel): Promise<ResolvedProviderAuth> =>
        resolveModelAuth(
          { getApiKeyAndHeaders: () => extensionContext.modelRegistry.getApiKeyAndHeaders(currentModel) },
          model,
          getEnvApiKey,
        ),
      fetchUrl: dependencies.fetchUrl,
      signal: deadlineSignal,
      onProgress,
    })
    return await underDeadline(signal, deadline, (deadlineSignal) =>
      dependencies.runProviders[routedProviderId](modelRequest(deadlineSignal)),
    )
  } catch (error) {
    if (error instanceof WebSearchProviderError) {
      return { providerId: error.providerId, reason: error.message, requestDispatched: error.requestDispatched }
    }
    return { providerId: undefined, reason: String(error), requestDispatched: false }
  }
}

/**
 * Why the fallback runs.
 *
 * It ALWAYS runs from here: the `searched` arm never reaches this function, because the call
 * site branched on the discriminant instead of on this string being `undefined` (#227). The
 * type says so, so "the primary stands" can no longer be expressed as a return value at all. ⓘ
 * Exported for `__tests__/web-search.test.ts`, which pins both halves of that signature at
 * compile time.
 */
export function fallbackReasonFor(primary: Extract<WebSearchOutcome, { kind: 'ungrounded' }> | PrimaryFailure): string {
  if ('kind' in primary) {
    return `the ${primary.providerId} backend answered WITHOUT searching (the model used its own knowledge)`
  }
  const providerName = primary.providerId ?? 'primary'
  const billingNote = primary.requestDispatched ? ' after the request was sent (it may have billed)' : ''
  return `the ${providerName} search failed${billingNote}: ${primary.reason}`
}

/** One call's deadline: the instant it passes, and the budget it was set from (named in the refusal). */
interface CallDeadline {
  readonly at: number
  readonly budgetMs: number
}

/** Run one provider attempt under what remains of the call's deadline AND the caller's signal. */
function underDeadline<T>(
  callerSignal: AbortSignal | undefined,
  deadline: CallDeadline,
  run: (deadlineSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runUnderDeadline(
    callerSignal,
    {
      remainingMs: deadline.at - Date.now(),
      reason: () =>
        new Error(
          `${WEB_SEARCH_TOOL_NAME} passed its deadline (${deadline.budgetMs}ms for primary and fallback together)`,
        ),
    },
    run,
  )
}

function progressForwarder(onUpdate: AgentToolUpdateCallback<undefined> | undefined): (text: string) => void {
  return (text: string): void => {
    onUpdate?.({ content: [{ type: 'text', text }], details: undefined })
  }
}

function refusal(reason: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: `Not searched: ${reason}` }], details: undefined }
}

/** An ungrounded answer with no fallback armed: returned, loudly labeled, never as a search. */
function renderUngrounded(outcome: Extract<WebSearchOutcome, { kind: 'ungrounded' }>): AgentToolResult<undefined> {
  return {
    content: [
      {
        type: 'text',
        text:
          `No web search was performed — the ${outcome.providerId} model answered from its own ` +
          `knowledge, and this is NOT a search result.\n\n${outcome.answerText}`,
      },
    ],
    details: undefined,
  }
}

/** Render a `searched` outcome: backend-named first line, the notice, answer, sources. */
function renderOutcome(outcome: WebSearchOutcome, fallbackReason: string | undefined): AgentToolResult<undefined> {
  if (outcome.kind === 'ungrounded') return renderUngrounded(outcome)

  const viaLine =
    fallbackReason === undefined
      ? `Searched the web via ${outcome.providerId}.`
      : `Searched the web via ${outcome.providerId} (fallback — ${fallbackReason}).`

  const bodySections: string[] = [viaLine, EXTERNAL_WEB_CONTENT_NOTICE]
  if (outcome.answerText !== undefined && outcome.answerText.length > 0) {
    bodySections.push(outcome.answerText)
  }
  if (outcome.snippets !== undefined && outcome.snippets.length > 0) {
    const snippetLines = outcome.snippets.map((snippet, snippetIndex) => {
      const snippetTail = snippet.snippet !== undefined && snippet.snippet.length > 0 ? `\n   ${snippet.snippet}` : ''
      return `${snippetIndex + 1}. ${snippet.title} — ${snippet.url}${snippetTail}`
    })
    bodySections.push(`## Results\n${snippetLines.join('\n')}`)
  } else if (outcome.sources.length > 0) {
    const sourceLines = outcome.sources.map(
      (source, sourceIndex) => `${sourceIndex + 1}. [${source.title}](${source.url})`,
    )
    bodySections.push(`## Sources\n${sourceLines.join('\n')}`)
  }

  return { content: [{ type: 'text', text: bodySections.join('\n\n') }], details: undefined }
}

const log = ensoLogger('extension', 'web-search')

/** One record per call, every outcome — the audit property (#54's discipline; #132: in the file). */
function auditLine(outcome: string, providerId: WebSearchProviderId | undefined, query: string, detail: string): void {
  const properties = { outcome, provider: providerId ?? '(none)', query, detail }
  if (outcome === 'refused') log.warn('audit: {outcome} provider {provider} — {detail}', properties)
  else log.info('audit: {outcome} provider {provider} — {detail}', properties)
}

/**
 * The pi entry point — real filesystem, env and fetch, wired at the composition root.
 * `findRepoRoot` realpaths first, so the config named is the COMMITTED file even under
 * the print harness's symlink mirror (#20, same rationale as web_fetch's root).
 */
export default createWebSearch({
  locateConfigFile: () => ensoConfigPath(findRepoRoot(import.meta.url)),
  readConfigText: (path: string) => readFileSync(path, 'utf8'),
  // ⚠ From the gated `.enso/secrets.env` FILE, never `process.env` (#89): the host
  // quarantines every secret out of the environment before a session exists, precisely so
  // a `bash` child cannot print it. Extension code is trusted to read the file the model's
  // `read` cannot. The composition root keeps the dependency's name — the providers still
  // receive values, never names, and never learn where they came from.
  readEnvironmentVariable: (variableName: string) => readSecret(findRepoRoot(import.meta.url), variableName),
  runProviders: {
    anthropic: runAnthropicProviderSearch,
    google: runGoogleProviderSearch,
    openai: runOpenAiProviderSearch,
    deepseek: runDeepseekProviderSearch,
    tavily: runTavilyProviderSearch,
  },
  fetchUrl: (url: string, init: FetchUrlInit) => fetch(url, { ...init, signal: init.signal ?? null }),
})
