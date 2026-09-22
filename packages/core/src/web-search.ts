import { type Static, Type } from 'typebox'

/**
 * The web_search tool's shapes and config section (#63).
 *
 * web_search answers a query through the CURRENT MODEL's own native search API
 * (provider-native — Anthropic Messages web_search, Google Gemini grounding, OpenAI
 * Responses web search), through a dedicated DeepSeek backend, or through the Tavily
 * retrieval API as the fallback. The provider wire code lives in
 * `packages/harness/core/web-search/`; the extension that wires IO and owns selection
 * lives in `packages/harness/extensions/web-search/`. This module holds the shared
 * shapes: the tool's parameter schema and its `enso.config.json` section.
 */

/**
 * The tool's registered name.
 *
 * @group Web tools
 */
export const WEB_SEARCH_TOOL_NAME = 'web_search'

/**
 * The deadline for ONE web_search call — primary AND fallback together, not per attempt
 * (#99).
 *
 * A native search is a full model turn, so this is generous where web_fetch's 30s is tight; dsh
 * ships the same 60s for the same reason. ⚠ It must stay under the server's no-progress cutoff
 * (`NO_PROGRESS_TIMEOUT_MS`, 90s): a per-attempt 60s let primary + fallback run 120s with no
 * chunk crossing, and the server read that as a hung run and cut it mid-search (#98). The
 * fallback gets whatever the primary left of this budget.
 *
 * @group Web tools
 */
export const WEB_SEARCH_TIMEOUT_MS = 60_000

/**
 * The tool's parameters: the query and nothing else.
 *
 * Upstream pi-web-search also took `urls`, dropped here deliberately (#63): on the Anthropic
 * wire it is just prompt-appended text, and the Tavily fallback cannot honor it — a parameter
 * one backend silently ignores is a capability drop, not a feature.
 *
 * @group Web tools
 */
export const WebSearchToolParameters = Type.Object({
  query: Type.String({ description: 'The search query or question to answer from the live web.' }),
})
/** @group Web tools */
export type WebSearchToolParameters = Static<typeof WebSearchToolParameters>

/**
 * web_search's OPTIONAL section of `enso.config.json`.
 *
 * ⚠ The section is optional AND must stay optional: the whole-file schema is
 * `additionalProperties: false` with a fail-closed parse, so a REQUIRED new section
 * would render every already-committed `enso.config.json` unreadable — and an unreadable
 * config refuses ALL web_fetch calls too. Absent section = the defaults below.
 *
 * - `backend: "deepseek"` pins the dedicated DeepSeek backend (its Anthropic-compatible
 *   search endpoint) instead of current-model routing. It is the ONLY way DeepSeek is
 *   selected — never implicitly, so no provider is billed that this file never named.
 * - `tavily` carries the fallback's only knobs: domain include/exclude lists passed
 *   verbatim to Tavily's search API. The fallback itself is armed by the presence of
 *   `TAVILY_API_KEY` in the environment, deliberately not by config: a key is a secret
 *   and secrets never enter this committed file.
 *
 * @group Web tools
 */
export const WebSearchConfig = Type.Object(
  {
    backend: Type.Optional(Type.Literal('deepseek')),
    tavily: Type.Optional(
      Type.Object(
        {
          includeDomains: Type.Optional(Type.Array(Type.String())),
          excludeDomains: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Web tools */
export type WebSearchConfig = Static<typeof WebSearchConfig>
