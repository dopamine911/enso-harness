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
import { ensoConfigPath, ensoHome, ensoSecretsPath, readTextIfPresent } from '@enso/core/paths'
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
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionEnsoConfig,
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
 * 1. **Primary selection.** The user config's optional `webSearch.backend: "deepseek"`
 *    pins the dedicated DeepSeek backend; otherwise the CURRENT MODEL routes to its own
 *    native search API (anthropic / google / openai families), billing the same identity
 *    the conversation does. A model with no native search selects nothing.
 * 2. **The fallback.** When the primary is unavailable, fails, or answers WITHOUT
 *    searching (`ungrounded`), and `TAVILY_API_KEY` is present in the gated secrets file
 *    `ENSO_HOME/secrets.env` (#89 — never the process environment), one Tavily call answers instead. Key absent → the primary's own outcome is
 *    returned unchanged. No config knob arms this — a key is a secret and secrets never
 *    enter the config.
 * 3. **The ACCURATE response** (#63, the requirement this exists for): every result's
 *    first line names the backend that answered and, on fallback, why. An ungrounded
 *    answer is never rendered as a search result — with no fallback armed it is returned
 *    labeled "no web search was performed". searched-vs-ungrounded is keyed on native
 *    search-activity blocks in the stream, never on source count.
 * 4. **One audit record per call** (#132 — a log record, not a stderr line): provider,
 *    outcome, query, fallback reason — never a key.
 *
 * Config is read ONCE per session (the web_fetch discipline, #54): the user's at extension load,
 * then the session's at `session_start` — a trusted project's `.enso/config.json` over the user's
 * (#421), resolved once and shared with web_fetch. A session cannot re-point its own search
 * backend by editing the file mid-run. An unreadable config fails CLOSED — "could not read the
 * policy" is never "no policy".
 */

/** The IO seams. Provider runs are injectable so the fallback policy is testable alone. */
export interface WebSearchDependencies {
  /** Where the user's config lives. May throw; the extension fails CLOSED on that. */
  locateConfigFile: () => string
  /** `undefined` when there is no file: the defaults. */
  readConfigText: (path: string) => string | undefined
  /** The SESSION's config at `session_start` (#421) — shared with web_fetch; see its seam. */
  resolveSessionConfig: (session: object, context: Omit<SessionConfigContext, 'home'>) => Promise<SessionEnsoConfig>
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

/**
 * @flow web-search-call A web_search call: route, authenticate, search, fall back, label
 * One `web_search` call is the model asking for the live web through a sanctioned egress: one of
 * the two network tools the bash guard denies the ad-hoc clients for. The extension reads the
 * committed config ONCE per session and fails closed (the user's `ENSO_HOME/config.json`, and a
 * trusted project's `.enso/config.json` over it; absent means defaults, unreadable means every
 * call refuses and no provider runs). Per call it routes the CURRENT MODEL to its own native
 * search API, resolves auth through the runtime's model registry, and, only when
 * `TAVILY_API_KEY` sits in `ENSO_HOME/secrets.env`, arms one Tavily attempt behind it. The
 * result's first line names the backend that answered and, on fallback, why; an answer produced
 * without searching is labeled, never rendered as a search result (#63). One deadline covers
 * both attempts (#99); one audit record per call.
 * @contract packages/harness/core/web-search/vocabulary.ts#WebSearchOutcome
 * @see docs/seams/web-providers.md the seam and its fences
 * @see docs/reference/env-and-config.md the config knobs and the secrets file
 * @see docs/glossary.md the words: egress and secret (Permission)
 * @see packages/core/src/web-search.ts the deadline and the arming rule
 * @see packages/harness/extensions/web-search/index.ts the shape in one pass (the file's header)
 */
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
    let configDisplayPath = configPath ?? `${ENSO_CONFIG_FILENAME} in ENSO_HOME (~/.enso by default)`

    // The session's config replaces the user's at its start, and the tool is registered again so
    // its description names the backend the session really has.
    let sessionReady: Promise<void> = Promise.resolve()
    pi.on('session_start', (_event, context) => {
      // ⚠ NOT awaited (#421): the trust question is asked on the thread, and the host delivers a
      // question raised during session_start only once the session exists and the thread is being
      // followed — awaiting it here held session creation on an answer nobody could see, a deadlock
      // (found live). The call that needs the policy awaits it instead, like a permission prompt.
      sessionReady = dependencies.resolveSessionConfig(context.sessionManager, context).then(
        (session) => {
          webSearchConfig = session.result.kind === 'ok' ? (session.result.config.webSearch ?? {}) : {}
          configProblem = session.result.kind === 'ok' ? undefined : session.result.reason
          configDisplayPath = session.path
          register()
        },
        // Reset and re-registered on failure too (#428 review), as for an unreadable result: the
        // description must not keep the load-time backend pin for a session whose calls all refuse.
        (error: unknown) => {
          webSearchConfig = {}
          configProblem = `the session's config could not be resolved: ${String(error)}`
          register()
        },
      )
    })

    const register = (): void =>
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
          // The session's config, once its trust question (if any) is answered.
          await sessionReady
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
                `${TAVILY_API_KEY_VARIABLE} in ${ensoSecretsPath(ensoHome(process.env))} (never in ${ENSO_CONFIG_FILENAME}, never in ` +
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
    register()
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

/**
 * Run the selected primary backend; a non-outcome return is the failure record.
 *
 * @invariant web-search-call/model-selects Selection is the current model's own API, or the configured pin, never implicit.
 * DeepSeek runs only when the user's config says `webSearch.backend: "deepseek"`; otherwise
 * `routedProviderIdForModel` reads `model.provider` and `model.api` (Google by either, the three
 * Responses APIs to `openai`, `anthropic-messages` to `anthropic`), and anything else (the
 * runtime registers DeepSeek chat models as `openai-completions`) selects nothing: a failure
 * record. The `google` and `openai` branches are driven through the tool; the absent-model record
 * is not.
 */
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
 *
 * @invariant web-search-call/secret-arms-fallback The fallback is armed by a secret's presence, never by config, and fires on three things.
 * `TAVILY_API_KEY` is read per call through `readSecret` over `ENSO_HOME/secrets.env`, never
 * `process.env`, which the host has quarantined (#89); present and non-empty arms it. This is
 * the whole policy: `searched` never falls back; `ungrounded`, an unrouted model and a thrown
 * provider error all do. The key reaches neither the rendered text nor the audit record.
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

/**
 * Run one provider attempt under what remains of the call's deadline AND the caller's signal.
 *
 * @invariant web-search-call/one-deadline-one-audit One deadline, one progress update, one audit record.
 * `WEB_SEARCH_TIMEOUT_MS` (60 s) is set once per call and covers both attempts, so primary and
 * fallback stay under the server's 90 s no-progress cutoff (#98): a primary that stalls for the
 * whole budget leaves the fallback an already-dead signal. The fallback's announcement is tool
 * progress (#99). `auditLine` logs `warn` for a refusal and `info` otherwise: exactly one record
 * per call, naming provider and outcome (#132).
 */
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

/**
 * Render a `searched` outcome: backend-named first line, the notice, answer, sources.
 *
 * @invariant web-search-call/honest-render The render is honest about who answered and what it may have cost.
 * The first line names `providerId`; on fallback it appends the reason, which says the primary
 * may have billed when `requestDispatched` is true (set in `dispatchProviderPost`: false when the
 * request failed to send, true when the API answered non-OK). `EXTERNAL_WEB_CONTENT_NOTICE`
 * (shared with `web_fetch`) is the second section of every `searched` result;
 * `renderUngrounded` omits it and the via-line, and labels the answer as NOT a search result.
 */
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
 * The pi entry point — real filesystem, env and fetch, wired at the composition root. The config
 * is the user's, in `ENSO_HOME` (#421).
 */
export default createWebSearch({
  locateConfigFile: () => ensoConfigPath(ensoHome(process.env)),
  readConfigText: readTextIfPresent,
  resolveSessionConfig: (session, context) => sessionEnsoConfig(session, { ...context, home: ensoHome(process.env) }),
  // ⚠ From the gated `ENSO_HOME/secrets.env` FILE, never `process.env` (#89): the host
  // quarantines every secret out of the environment before a session exists, precisely so
  // a `bash` child cannot print it. Extension code is trusted to read the file the model's
  // `read` cannot. The composition root keeps the dependency's name — the providers still
  // receive values, never names, and never learn where they came from.
  readEnvironmentVariable: (variableName: string) => readSecret(ensoHome(process.env), variableName),
  runProviders: {
    anthropic: runAnthropicProviderSearch,
    google: runGoogleProviderSearch,
    openai: runOpenAiProviderSearch,
    deepseek: runDeepseekProviderSearch,
    tavily: runTavilyProviderSearch,
  },
  fetchUrl: (url: string, init: FetchUrlInit) => fetch(url, { ...init, signal: init.signal ?? null }),
})
