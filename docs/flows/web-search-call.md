# Flow: a web_search call — route, authenticate, search, fall back, label

One `web_search` call is the model asking for the live web through a sanctioned egress — one of the
two network tools the bash guard denies the ad-hoc clients for. The extension reads the committed
config **once** at load and fails closed; per call it routes the **current model** to its own native
search API, resolves auth through the runtime's model registry, and — only when `TAVILY_API_KEY`
sits in `.zen/secrets.env` — arms one Tavily attempt behind it. The result's first line names the
backend that answered and, on fallback, why; an answer produced without searching is labeled, never
rendered as a search result (#63). One deadline covers both attempts (#99); one audit record per call.

## The sequence

```mermaid
sequenceDiagram
  participant R as runtime (a tool call inside a run)
  participant X as web_search (extensions/web-search/index.ts)
  participant S as .zen/secrets.env (readSecret)
  participant V as core/web-search (vocabulary.ts, auth.ts)
  participant P as native provider · Tavily (providers/*.ts)

  Note over X: at load: zen.config.json read ONCE; unreadable ⇒ every call refuses, no provider runs
  R->>X: execute({ query }, signal, onUpdate, context)
  X->>S: TAVILY_API_KEY — the fallback is armed iff present and non-empty
  X->>V: routedProviderIdForModel(context.model) — unless config pins backend "deepseek"
  V-->>X: anthropic | google | openai | undefined (no native search)
  X->>P: run<Provider>Search({ query, model, resolveAuth, fetchUrl, signal, onProgress }) under ONE deadline
  P->>V: resolveAuth(model) ⇒ resolveModelAuth(context.modelRegistry, model)
  P-->>X: WebSearchOutcome, or WebSearchProviderError{ requestDispatched }
  alt searched
    X-->>R: "Searched the web via <provider>." + notice + answer + sources
  else ungrounded · no route · failure, Tavily NOT armed
    X-->>R: "No web search was performed …" | "Not searched: … TAVILY_API_KEY in .zen/secrets.env"
  else Tavily armed
    X->>P: runTavilyProviderSearch, announced as progress, under what the primary LEFT of the deadline
    X-->>R: "Searched the web via tavily (fallback — <reason>)." | "Not searched: <both reasons>"
  end
```

## The invariants it shows

1. **Selection is the current model's own API, or the committed pin — never implicit.** `runPrimary`
   runs DeepSeek only when `zen.config.json` says `webSearch.backend: "deepseek"`; otherwise
   `routedProviderIdForModel` reads `model.provider` and `model.api` — Google by either, the three
   Responses APIs to `openai`, `anthropic-messages` to `anthropic` — and anything else (the runtime
   registers DeepSeek chat models as `openai-completions`) selects nothing: a failure record. The
   `google` and `openai` branches are driven through the tool (below); the absent-model record is not.
2. **Auth is the conversation's identity; the provider env key is the last resort.** `resolveModelAuth`
   asks the runtime's model registry, passes a failure through, drops null-valued headers, and reads
   the environment only when neither a key nor an `authorization` / `x-api-key` / `x-goog-api-key`
   header came back. The resolver travels inside `ModelSearchRequest`; the extension never calls it.
3. **The fallback is armed by a secret's presence, never by config, and fires on three things.**
   `TAVILY_API_KEY` is read per call through `readSecret` over `.zen/secrets.env` — never
   `process.env`, which the host has quarantined (#89). `fallbackReasonFor` is the whole policy:
   `searched` never falls back; `ungrounded`, an unrouted model and a thrown provider error all do.
4. **`searched` vs `ungrounded` is keyed on search activity, never on source count.** The fence below
   is the contract; a citation with no search block is `ungrounded`, an errored search is `searched`.
5. **The render is honest about who answered and what it may have cost.** The first line names
   `providerId`; on fallback it appends the reason, which says the primary may have billed when
   `requestDispatched` is true — set in `dispatchProviderPost`: false when the request failed to send,
   true when the API answered non-OK. `EXTERNAL_WEB_CONTENT_NOTICE` (shared with `web_fetch`) is the
   second section of every `searched` result; `renderUngrounded` omits it and the via-line.
6. **One deadline, one progress update, one audit record.** `WEB_SEARCH_TIMEOUT_MS` (60 s) covers
   both attempts to stay under the server's 90 s no-progress cutoff (#98); the fallback's announcement
   is tool progress (#99). `auditLine` logs `warn` for a refusal, `info` otherwise — a record (#132).
7. **`web_fetch`, the sibling, gates cheapest-first and each refusal is final:** URL parse → config
   problem → empty allowlist → exact host match → the advisory public-address gate (one non-public
   answer refuses) → one fetch with `redirect: 'manual'`; a redirect is reported, never followed.

## The outcome contract

<!-- source: packages/harness/core/web-search/vocabulary.ts#WebSearchOutcome -->
```ts
/**
 * What one provider run produced — the ACCURATE outcome union (#63, Daniel's
 * requirement). ⚠ `searched` vs `ungrounded` is keyed on evidence that a native search
 * actually ran (a `server_tool_use` block on the Anthropic wire; each provider names its
 * own signal), NEVER on source count: a real search can return zero results, and an
 * ungrounded answer citing a hallucinated URL would read as grounded. Upstream's
 * `grounded = sources.length > 0` had exactly that defect.
 */
export type WebSearchOutcome =
  | {
      kind: 'searched'
      providerId: WebSearchProviderId
      /** The provider-synthesized answer, citation-marked. Absent for retrieval backends (Tavily). */
      answerText?: string
      sources: WebSource[]
      /** Retrieval results with snippets — the Tavily shape; model-native backends leave it absent. */
      snippets?: WebSearchSnippet[]
    }
  | {
      /** The model answered WITHOUT searching — its own knowledge, not the live web. */
      kind: 'ungrounded'
      providerId: WebSearchProviderId
      answerText: string
    }
```

## The tests that pin it

Each marker below is checked by `test/docs-gate.test.ts`: a renamed or deleted pin fails this page.

<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#a Gemini model routes to the google provider through the tool, and the audit names it -->
- **Invariant 1, the google branch through the tool** — the wrong providers' fakes throw, so a
  wrong selection fails by name.
<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#every Responses-family api routes to the openai provider through the tool: openai, azure, codex -->
- **Invariant 1, the three Responses APIs** — each to `openai`, through the tool.
<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#a searched primary renders the via-line, the notice, the answer, and the sources -->
- **Invariants 5 and 6, the happy path** — [`web-search.test.ts`](../../packages/harness/extensions/web-search/__tests__/web-search.test.ts):
  Tavily is not called; exactly one audit record names provider and outcome.
<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#ungrounded with no Tavily key: labeled as NOT a search result, no notice, no via-line -->
- **Invariants 3 and 5, unarmed** — the accuracy contract with nothing to fall back to.
<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#ungrounded WITH Tavily armed falls back, and the render says why -->
- **Invariant 3, armed** — the key reaches neither the text nor the audit record.
<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#an unrouted model with no Tavily key refuses, naming the arming env var -->
- **Invariants 1 and 3** — an `openai-completions` model selects nothing; no provider ran.
<!-- test: packages/harness/extensions/web-search/__tests__/web-search.test.ts#⚠ a primary that stalls for the whole budget leaves the fallback NO time — it is refused with the deadline, not run for another budget -->
- **Invariant 6, the one deadline** — the fallback receives an already-dead signal.
<!-- test: packages/harness/core/__tests__/web-search-support.test.ts#resolveModelAuth falls back to the provider env key — and only when nothing else authenticates -->
- **Invariant 2** — [`web-search-support.test.ts`](../../packages/harness/core/__tests__/web-search-support.test.ts):
  the injected reader is consulted once, and not at all when a key or an auth header was resolved.
<!-- test: packages/harness/core/__tests__/web-search-wire.test.ts#an answer with a citation but NO search block is `ungrounded` — sources are not the key -->
- **Invariant 4** — [`web-search-wire.test.ts`](../../packages/harness/core/__tests__/web-search-wire.test.ts):
  the fixture upstream's source-count rule called grounded.
<!-- test: packages/harness/extensions/web-fetch/__tests__/web-fetch.test.ts#a redirect is REPORTED with its absolute target and never followed -->
- **Invariant 7** — [`web-fetch.test.ts`](../../packages/harness/extensions/web-fetch/__tests__/web-fetch.test.ts):
  one fetch, the target in the text.

## Where it is stated

The seam and its fences: [`seams/web-providers.md`](../seams/web-providers.md). The config knobs and
the secrets file: [`reference/env-and-config.md`](../reference/env-and-config.md). *Egress* and
*secret*: [`glossary.md`](../glossary.md) → *Permission*. The shape in one pass: the header of
`packages/harness/extensions/web-search/index.ts`; the deadline and the arming rule: `packages/core/src/web-search.ts`.
