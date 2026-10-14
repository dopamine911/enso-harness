/**
 * The harness's own core — path resolution, guard state, and the web-search seam's vocabulary.
 *
 * ⚠ Schemas are NOT declared here. Every TypeBox schema in this repo lives in `@enso/core`,
 * so that a shape is either declared there or does not exist. Re-exporting them from here
 * would defeat that: a consumer could import `GuardPolicy` from two places and neither
 * import would look wrong.
 *
 * Import schemas from `@enso/core` directly. Import path helpers from here.
 *
 * ⚠ THE LIST IS WHAT THE EXTENSIONS IMPORT, AND NOTHING ELSE (#263). It used to be the
 * modules' full public surface, which is a different claim and an unfalsifiable one: 17 names
 * were exported here and imported nowhere, and they sat in `fallow-baseline.json` — a
 * suppression whose own note said it was waiting on #173's zone rule, which shipped without
 * taking it. A barrel entry nothing imports is not an inventory, it is a name a reader must
 * check before concluding that removing something is safe.
 *
 * So the surface is derived from consumption and `test/harness-barrel-gate.test.ts` holds
 * the two directions: a name here that no extension imports is red, and an extension
 * importing a name that is not here does not compile. Internal helpers keep living in their
 * modules — `shell-segments.ts` and `web-search/anthropic-wire.ts` are imported by their
 * siblings and by their own tests, which is what "internal" means. Adding one back here is
 * adding a consumer, and the gate asks for it.
 *
 * @module
 */

export { runUnderDeadline } from './deadline.ts'
export { inputRecordOf, type ShellAnalyzerDenial } from './guard-denials.ts'
export { createGuardSession, type GuardProject, type GuardSession } from './guard-session.ts'
export {
  decidedProjectTrust,
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionConfigEnvironment,
  sessionEnsoConfig,
  sessionIncidentPolicy,
  userJudgeConfig,
} from './session-config.ts'
export { isFetchableContentType, isHostAllowed, isPublicIpAddress, parseWebFetchUrl } from './web-fetch-policy.ts'
export { resolveModelAuth } from './web-search/auth.ts'
export { runAnthropicProviderSearch } from './web-search/providers/anthropic.ts'
export {
  DEEPSEEK_API_KEY_VARIABLE,
  type DeepseekSearchRequest,
  runDeepseekProviderSearch,
} from './web-search/providers/deepseek.ts'
export { runGoogleProviderSearch } from './web-search/providers/google.ts'
export { runOpenAiProviderSearch } from './web-search/providers/openai.ts'
export {
  runTavilyProviderSearch,
  TAVILY_API_KEY_VARIABLE,
  type TavilySearchRequest,
} from './web-search/providers/tavily.ts'
export {
  type FetchUrlInit,
  type ModelSearchRequest,
  type ResolvedProviderAuth,
  routedProviderIdForModel,
  type SearchModel,
  type WebSearchOutcome,
  WebSearchProviderError,
  type WebSearchProviderId,
} from './web-search/vocabulary.ts'
