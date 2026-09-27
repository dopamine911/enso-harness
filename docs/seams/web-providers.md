# Seam: web providers

The provider seam under the harness: five search backends behind one contract and one vocabulary,
selected by the tool that owns the fallback policy, and the fetch tool's injected IO beside it.
Glossary domains: **Permission** (egress — the two sanctioned network calls the bash guard denies by
name; an allowlist and a backend pin in the user config decide what may run) and **Control** (a tool
call inside a run). This directory is the pattern the consolidation (#162) copied elsewhere — *where
we already did it right*: a normalizer in our own code that has held.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/web-providers.md`.

## The contract

The vocabulary (`packages/harness/core/web-search/vocabulary.ts`) exports, top level:
`WebSearchProviderId`, `WebSource`, `WebSearchSnippet`, `WebSearchOutcome`, `WebSearchProviderError`,
`FetchUrlInit`, `FetchUrl`, `ResolvedProviderAuth`, `ModelSearchRequest`, `routedProviderIdForModel`.
Its header (lines 3-5) states the one structural rule: providers live in `./providers/`, one module
each, and MUST NOT import each other. The four that are the contract:

<!-- source: packages/harness/core/web-search/vocabulary.ts#WebSearchProviderId -->
```ts
/**
 * Every backend that can answer a web_search call.
 */
export type WebSearchProviderId = 'anthropic' | 'google' | 'openai' | 'deepseek' | 'tavily'
```

<!-- source: packages/harness/core/web-search/vocabulary.ts#WebSearchOutcome -->
```ts
/**
 * What one provider run produced — the ACCURATE outcome union (#63, Daniel's
 * requirement).
 *
 * ⚠ `searched` vs `ungrounded` is keyed on evidence that a native search actually ran (a
 * `server_tool_use` block on the Anthropic wire; each provider names its own signal), NEVER on
 * source count: a real search can return zero results, and an ungrounded answer citing a
 * hallucinated URL would read as grounded. Upstream's `grounded = sources.length > 0` had
 * exactly that defect.
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

<!-- source: packages/harness/core/web-search/vocabulary.ts#WebSearchProviderError -->
```ts
/**
 * Thrown by provider runs on failure.
 *
 * `requestDispatched` says whether the HTTP request left the process — an honest "may have
 * billed" bit (whether a failed request billed is the provider's accounting, not knowable
 * here), surfaced when the fallback re-searches.
 */
export class WebSearchProviderError extends Error {
  readonly providerId: WebSearchProviderId
  readonly requestDispatched: boolean

  constructor(providerId: WebSearchProviderId, message: string, options: { requestDispatched: boolean }) {
    super(message)
    this.name = 'WebSearchProviderError'
    this.providerId = providerId
    this.requestDispatched = options.requestDispatched
  }
}
```

<!-- source: packages/harness/core/web-search/vocabulary.ts#ModelSearchRequest -->
```ts
/**
 * What a MODEL-ROUTED provider run receives (anthropic / google / openai).
 */
export interface ModelSearchRequest {
  query: string
  model: SearchModel
  resolveAuth: (model: SearchModel) => Promise<ResolvedProviderAuth>
  fetchUrl: FetchUrl
  signal: AbortSignal | undefined
  /** Streaming progress for the UI; carries the accumulated answer text so far. */
  onProgress?: ((text: string) => void) | undefined
}
```

The two request shapes that are not model-routed are `DeepseekSearchRequest` (`providers/deepseek.ts:29-36`:
query, the key read at the composition root, `fetchUrl`, signal, progress) and `TavilySearchRequest`
(`providers/tavily.ts:22-29`: query, key, the two domain lists, `fetchUrl`, signal). Neither carries a
model; the config-pinned backend and the fallback are selected without one.

What the two extensions take at their composition roots — the IO seams tests replace:

<!-- source: packages/harness/extensions/web-search/index.ts#WebSearchDependencies -->
```ts
/** The IO seams. Provider runs are injectable so the fallback policy is testable alone. */
export interface WebSearchDependencies {
  /** Where the user's config lives. May throw; the extension fails CLOSED on that. */
  locateConfigFile: () => string
  /** `undefined` when there is no file: the defaults. */
  readConfigText: (path: string) => string | undefined
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
```

<!-- source: packages/harness/extensions/web-fetch/index.ts#WebFetchDependencies -->
```ts
/**
 * The IO seams, injected so tests never touch the network, DNS or the real config file —
 * same pattern as the guards' `analyzeBashCommand`.
 */
export interface WebFetchDependencies {
  /** Where the user's config lives — read from AND named in refusal messages. */
  locateConfigFile: () => string
  /** The config's text; `undefined` when there is no file, which is the defaults. A read that fails otherwise throws, and the extension fails CLOSED. */
  readConfigText: (path: string) => string | undefined
  fetchUrl: (url: string, init: WebFetchRequestInit) => Promise<Response>
  /** Resolve a hostname to its addresses. Rejects on NXDOMAIN/timeouts. */
  resolveHostAddresses: (hostname: string) => Promise<string[]>
}
```

The config sections, in `@enso/core`, composed into the one config file by `config.ts:57-64`
(`webFetch` required, `webSearch` optional). `WebSearchConfig` (`core/src/web-search.ts:55-70`) is
two optional knobs and nothing else: `backend: "deepseek"` — the ONLY way that backend is selected,
so no provider is billed the file never named — and `tavily.includeDomains` / `excludeDomains`, passed
verbatim; the fallback is armed by the key's presence, never by config, because a key is a secret
(header lines 47-53). The section must stay optional (42-45): the whole-file schema is closed and
fail-closed, so a required new section would make every existing config unreadable — and an
unreadable config refuses all web_fetch calls too.

<!-- source: packages/core/src/web-fetch.ts#WebFetchConfig -->
```ts
/**
 * web_fetch's section of the user's config. Absent, the allowlist is EMPTY.
 *
 * `allowedHosts` are exact hostnames (case-insensitive, no wildcards, no ports) — each entry is
 * one reviewable grant. Strict on unknown keys for the same reason the whole config is — see
 * `config.ts`.
 */
export const WebFetchConfig = Type.Object(
  {
    allowedHosts: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)
```

## Who implements it, who consumes it

**Five providers, one `run*` function each, all top level and all exported through the harness
core barrel** (`packages/harness/core/index.ts:45-58`):

| Provider | Function | Takes | Wire |
|---|---|---|---|
| `anthropic` | `providers/anthropic.ts#runAnthropicProviderSearch` | `ModelSearchRequest` | the shared `anthropic-wire.ts` |
| `google` | `providers/google.ts#runGoogleProviderSearch` | `ModelSearchRequest` | Gemini grounding, own parse |
| `openai` | `providers/openai.ts#runOpenAiProviderSearch` | `ModelSearchRequest` | Responses API, own parse |
| `deepseek` | `providers/deepseek.ts#runDeepseekProviderSearch` | `DeepseekSearchRequest` | the shared `anthropic-wire.ts` |
| `tavily` | `providers/tavily.ts#runTavilyProviderSearch` | `TavilySearchRequest` | one POST, own parse |

Each returns a `WebSearchOutcome` or throws a `WebSearchProviderError` with its `requestDispatched`
bit. `anthropic-wire.ts` is shared by exactly two: `providers/anthropic.ts:1` imports
`runAnthropicWireSearch` and the tool type, `providers/deepseek.ts:1` imports `runAnthropicWireSearch`;
`google.ts`, `openai.ts` and `tavily.ts` do not. Its header (lines 11-15) says why: DeepSeek's search
endpoint speaks the Anthropic Messages wire at its own base, so callers own endpoint, headers, model id
and budgets, and the wire module owns the request body, the stream parse and the searched/ungrounded
verdict — keyed on `server_tool_use` blocks having appeared, never on source count (lines 20-24).

**The web_search extension is the one consumer and owns selection** (`packages/harness/extensions/web-search/index.ts`).
`createWebSearch` (115-232) loads the config once at extension load and fails closed; `runPrimary`
(254-308) picks the backend: `webSearch.backend: "deepseek"` pins the dedicated backend (257), else the
current model routes through `routedProviderIdForModel` (273) and its auth through `resolveModelAuth`
(289-294), and a model with no native search selects nothing (274-281). The composition root (419-436)
wires the five `run*` functions into `runProviders`, real `fetch` into `fetchUrl`, and
`readEnvironmentVariable` to `readSecret` over `ENSO_HOME/secrets.env` — never `process.env` (422-427): the
host quarantines secrets out of the environment before a session exists, and providers receive values,
never names.

**web_fetch consumes its own four seams** (`web-fetch/index.ts:68-76`): `locateConfigFile` and
`readConfigText` are called once inside `createWebFetch` (91-92), so the allowlist is captured at load
and an in-session edit is inert (header lines 32-34); `resolveHostAddresses` feeds the advisory
public-address gate (`addressGateReason`, 178-202); `fetchUrl` is called once per call under
`fetchUnderDeadline` (205-231) with `redirect: 'manual'` and `WEB_FETCH_TIMEOUT_MS`. The pure policy —
URL gate, host match, content-type gate, the address classifier — is `harness/core/web-fetch-policy.ts`.

**The second implementation is every test.** `web-search.test.ts` (`extensions/web-search/__tests__/`)
drives `createWebSearch` with scripted `runProviders` and `readConfigText` — a searched primary, an
ungrounded one with and without the fallback armed, a post-dispatch failure that *admits it may have
billed*, both backends failing, the config-pinned backend, an unreadable config failing closed;
`web-fetch.test.ts` drives `createWebFetch` with fake DNS, fetch and config; `core/__tests__/web-search-model-providers.test.ts`
drives the three model-routed `run*` functions over scripted SSE, and `web-search-wire.test.ts` the shared wire.

## What fences it

- **The vendor gate's import allowlist** (`test/vendor-gate.test.ts#VENDOR_IMPORT_ALLOWED`) is the
  fence, and it is **empty** — the gate keeps it so, and its header says why. Any file under
  `harness/core` importing `@earendil-works/*` is a red test that names the file; adding a row back is
  adding a dependency site and must state its reason. The two entries this seam used to hold, and how
  they left, are below.
- **The one deadline** (#99). `WEB_SEARCH_TIMEOUT_MS = 60_000` (`core/src/web-search.ts:26`) is the
  budget for *primary AND fallback together, not per attempt*, and its header (19-24) says why: a
  per-attempt 60 s let primary + fallback run 120 s with no chunk crossing, and the server's 90 s
  no-progress cutoff read that as a hung run (#98). `createWebSearch` sets one `CallDeadline` per call
  (162-163); `underDeadline` (333-349) runs every attempt under what remains of it *and* the caller's
  signal, and a spent budget aborts before the attempt runs (`harness/core/deadline.ts:25`, header
  8-9) — a 0 ms timer would let a fast provider answer first. All three attempts go through it (212,
  258, 299), and two tests pin it: a primary that stalls for the whole budget leaves the fallback no
  time (`web-search.test.ts:377`), a primary that fails fast leaves it the rest (413).
- **The independence rule** (`vocabulary.ts:3-5`): providers do not import each other. Not gated;
  visible in the five files' imports today, and why a later split into provider packages is mechanical.

## What crosses it that should not

**Nothing of the runtime's, since L6 closed (#162).** `ModelSearchRequest.model` is `SearchModel` —
the seven fields the providers read, declared in `vocabulary.ts` as ours — and `resolveAuth` takes it;
`resolveModelAuth` takes the environment-key reader as a parameter instead of importing the runtime's.
The runtime's model record is converted once, at the composition root
(`extensions/web-search/index.ts#searchModelOf`), and the registry is asked with the runtime's record
inside a closure the provider never sees. `harness/core` imports nothing from `@earendil-works/*`; the
vendor gate's import allowlist is empty. Until then `vocabulary.ts` and `auth.ts` imported pi-ai's
`Api`/`Model` types and `getEnvApiKey`, allowlisted with the reason *leaves when web-search's provider
contract names its own model/credential types* — which is what happened. `auth.ts`'s header still
records the wire fact behind the env fallback: the runtime's registry returns `{ ok: true }` with no
key when auth comes only from provider env vars, so this code mirrors that fallback because it calls
`fetch` directly.

**The composition roots import the runtime's extension API** (`ExtensionAPI`, `AgentToolResult`,
`ExtensionContext`) — under `packages/harness/extensions/`, a root the vendor gate permits, and the
shape [*Leak numbers*](./README.md#leak-numbers) records as L5 for the guards: the registration is
the runtime's, the contract behind it is ours.

Nothing else. The outcome union, the error, the two request shapes and both dependency interfaces
name no vendor; `anthropic-wire.ts` names a provider's HTTP wire, which is the thing being adapted.

## Pivot cost

**Adding a provider** is one file under `providers/` exporting a `run*` over `ModelSearchRequest` (or
its own request shape, as `deepseek` and `tavily` do), one literal on `WebSearchProviderId`, one entry
in `WebSearchDependencies.runProviders` and the composition root's map, and — for a model-routed one —
a branch in `routedProviderIdForModel`. The extension's selection, fallback, deadline and rendering
do not change; `web-search.test.ts` runs against scripted providers and does not change either.

**Replacing the model API** — a runtime whose model registry has a different shape — changes
`vocabulary.ts` (`ModelSearchRequest.model`, `ResolvedProviderAuth`, `routedProviderIdForModel`, which
reads `model.provider` and `model.api`) and `auth.ts` (`ModelAuthSource`, `resolveModelAuth`), plus the
one call site that builds a `ModelSearchRequest` from the runtime's context
(`extensions/web-search/index.ts:286-298`).
The five providers read only `request.model` fields through the request and `resolveAuth`; the wire
modules, the outcome union, the config sections, web_fetch and every test that scripts a provider do
not change. That pivot has already been paid once: it is what deleted the allowlist's last two rows.
