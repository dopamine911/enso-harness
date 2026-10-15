import { type Static, Type } from 'typebox'
import { WebFetchAllowlistChange, WebToolsProject } from './web-fetch.ts'

/**
 * The web_search tool's shapes and config section (#63).
 *
 * web_search answers a query through the CURRENT MODEL's own native search API
 * (provider-native — Anthropic Messages web_search, Google Gemini grounding, OpenAI
 * Responses web search), through a dedicated DeepSeek backend, or through the Tavily
 * retrieval API as the fallback. The provider wire code lives in
 * `packages/harness/core/web-search/`; the extension that wires IO and owns selection
 * lives in `packages/harness/extensions/web-search/`. This module holds the shared
 * shapes: the tool's parameter schema and its config section.
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
 * web_search's OPTIONAL section of the user's config.
 *
 * ⚠ The section is optional AND must stay optional: the whole-file schema is
 * `additionalProperties: false` with a fail-closed parse, so a REQUIRED new section
 * would render every existing config unreadable — and an unreadable config refuses ALL
 * web_fetch calls too. Absent section = the defaults below.
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

/**
 * Which list of `webSearch.tavily` a Settings change touches (#932).
 *
 * @group Web tools
 */
export const WebSearchDomainList = Type.Union([Type.Literal('includeDomains'), Type.Literal('excludeDomains')])
/** @group Web tools */
export type WebSearchDomainList = Static<typeof WebSearchDomainList>

/**
 * The backend as Settings names it (#932): `model`, the current model's own search (the key
 * absent), or `deepseek`, pinned.
 *
 * @group Web tools
 */
export const WebSearchBackendChoice = Type.Union([Type.Literal('model'), Type.Literal('deepseek')])
/** @group Web tools */
export type WebSearchBackendChoice = Static<typeof WebSearchBackendChoice>

/**
 * One change to the user's `webSearch` from Settings › Web tools › Searching (#932): the backend
 * chosen, or one domain added to or removed from a Tavily list. A domain to add must be in the form
 * `readWebFetchHostInput` gives back for a bare host.
 *
 * @group Web tools
 */
export const WebSearchSettingsChange = Type.Union([
  Type.Object({ backend: WebSearchBackendChoice }, { additionalProperties: false }),
  Type.Object({ list: WebSearchDomainList, add: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ list: WebSearchDomainList, remove: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
])
/** @group Web tools */
export type WebSearchSettingsChange = Static<typeof WebSearchSettingsChange>

/**
 * The secret that arms web_search's Tavily fallback: read per call by the harness from
 * `ENSO_HOME/secrets.env`, and set there by Settings (#932). One name for both, so neither can drift.
 *
 * @group Web tools
 */
export const TAVILY_API_KEY_VARIABLE = 'TAVILY_API_KEY'

/**
 * The `TAVILY_API_KEY` change from Settings (#932): a key to set (or replace), or the key removed.
 * ⚠ The key travels this way only, once; nothing answers it back.
 *
 * @group Web tools
 */
export const TavilyKeyChange = Type.Union([
  Type.Object({ set: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ remove: Type.Literal(true) }, { additionalProperties: false }),
])
/** @group Web tools */
export type TavilyKeyChange = Static<typeof TavilyKeyChange>

/**
 * A trusted project's own `webSearch` (#932), read only in Settings: its backend replaces the
 * user's for its threads, its domains add to the user's lists (`mergeEnsoConfig`).
 *
 * @group Web tools
 */
export const WebSearchProjectSettings = Type.Object({
  ...WebToolsProject.properties,
  backend: Type.Optional(Type.Literal('deepseek')),
  includeDomains: Type.Array(Type.String()),
  excludeDomains: Type.Array(Type.String()),
})
/** @group Web tools */
export type WebSearchProjectSettings = Static<typeof WebSearchProjectSettings>

/**
 * Settings › Web tools › Searching (#932): the user's `webSearch` and the file it is in, whether
 * `TAVILY_API_KEY` is set in the secrets file (never the key), each trusted project's own
 * `webSearch`, and the live threads still running on the settings as they were before the last
 * change made here (they are read at session start; the key is read per call).
 *
 * @group Web tools
 */
export const WebSearchSettings = Type.Object({
  path: Type.String(),
  backend: WebSearchBackendChoice,
  includeDomains: Type.Array(Type.String()),
  excludeDomains: Type.Array(Type.String()),
  /** Why the user's file could not be read; it is never overwritten then. */
  unreadable: Type.Optional(Type.String()),
  /** `ENSO_HOME/secrets.env`, where the key is kept. */
  secretsPath: Type.String(),
  /** Why the secrets file could not be read: whether a key is set is unknown, and none is read at call time either. */
  secretsUnreadable: Type.Optional(Type.String()),
  /** False when the secrets file holds no key — or could not be read, and then `secretsUnreadable` says why. */
  tavilyKeySet: Type.Boolean(),
  projects: Type.Array(WebSearchProjectSettings),
  /** Thread ids still running on the settings as they were before the last change made here. */
  staleThreads: Type.Array(Type.String()),
})
/** @group Web tools */
export type WebSearchSettings = Static<typeof WebSearchSettings>

/**
 * One change to a project's own web tools from its page's Web tools tab (#937): a `web_fetch` host
 * added or removed, or a Searching change. `{ backend: 'model' }` removes the project's backend, so
 * the user's applies there.
 *
 * @group Web tools
 */
export const ProjectWebToolsChange = Type.Union([WebFetchAllowlistChange, WebSearchSettingsChange])
/** @group Web tools */
export type ProjectWebToolsChange = Static<typeof ProjectWebToolsChange>

/**
 * A project's page › Web tools (#937): its shared `.enso/config.json` (`path`) — the one project
 * tier a session merges (`.enso/config.local.json` is never read for web tools) — and, beside it,
 * the user's own settings it adds to. ⚠ `own` is the file AS THE OPERATOR APPROVED IT (#753), what a
 * session applies, and there only when the project is trusted: an untrusted project's file is never
 * read, and its tab is read only. `pending`: the file is not that version — changed, removed or never
 * approved — so nothing is written to it until it is approved. `staleThreads`: the project's live
 * threads still on its settings as they were before the last change made there.
 *
 * @group Web tools
 */
export const ProjectWebTools = Type.Object({
  ...WebToolsProject.properties,
  trusted: Type.Boolean(),
  own: Type.Optional(
    Type.Object({
      hosts: Type.Array(Type.String()),
      backend: Type.Optional(Type.Literal('deepseek')),
      includeDomains: Type.Array(Type.String()),
      excludeDomains: Type.Array(Type.String()),
    }),
  ),
  /** Why the approved version of the project's file no longer reads (a key a newer Enso wrote): nothing in it applies. */
  unreadable: Type.Optional(Type.String()),
  /**
   * How the file differs from the version approved, as `EnsoProjectTierPending` says it (not imported:
   * `config.ts` reads this module, and `project-settings.ts` reads `config.ts`); absent when it is
   * that version, or there is neither.
   */
  pending: Type.Optional(Type.Union([Type.Literal('changed'), Type.Literal('removed'), Type.Literal('unapproved')])),
  /** The user's own `webFetch` and `webSearch`, which the project's add to (lists) or replace (the backend). */
  yours: Type.Object({
    path: Type.String(),
    hosts: Type.Array(Type.String()),
    backend: WebSearchBackendChoice,
    includeDomains: Type.Array(Type.String()),
    excludeDomains: Type.Array(Type.String()),
    unreadable: Type.Optional(Type.String()),
  }),
  staleThreads: Type.Array(Type.String()),
})
/** @group Web tools */
export type ProjectWebTools = Static<typeof ProjectWebTools>
