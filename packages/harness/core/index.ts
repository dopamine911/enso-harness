/**
 * The harness's own core — path resolution and per-session guard state.
 *
 * ⚠ Schemas are NOT declared here. Every TypeBox schema in this repo lives in `@zen/core`,
 * so that a shape is either declared there or does not exist. Re-exporting them from here
 * would defeat that: a consumer could import `GuardPolicy` from two places and neither
 * import would look wrong.
 *
 * Import schemas from `@zen/core` directly. Import path helpers from here.
 */
// Named for the same reason as @zen/core's barrel: the list IS the public inventory.

export { type EnvironmentDumpMatch, findEnvironmentDump } from './environment-dump.ts'
export { findDeniedNetworkEgress, type NetworkEgressMatch } from './network-egress.ts'
export {
  isInsideAnyRoot,
  isInsideRoot,
  isPersistenceWriteTarget,
  isProtectedForWrite,
  looksLikeSecret,
  realpathOfNearestExisting,
  resolveAgainstCwd,
} from './paths.ts'
export {
  createSessionReadTracker,
  type KnownPathState,
  type SessionReadTracker,
} from './read-tracker.ts'
export {
  extractFlatShellCommandSegments,
  type FlatShellCommandSegment,
  withoutLeadingEnvironmentAssignments,
} from './shell-segments.ts'
export { canonicalToolName } from './tool-identity.ts'
export {
  isFetchableContentType,
  isHostAllowed,
  isPublicIpAddress,
  parseWebFetchUrl,
  type WebFetchUrlDecision,
} from './web-fetch-policy.ts'
export { ANTHROPIC_WEB_SEARCH_TOOL_TYPE, runAnthropicWireSearch } from './web-search/anthropic-wire.ts'
export { type ModelAuthSource, resolveModelAuth } from './web-search/auth.ts'
export { runAnthropicProviderSearch } from './web-search/providers/anthropic.ts'
export {
  DEEPSEEK_API_KEY_VARIABLE,
  DEEPSEEK_SEARCH_BASE_URL,
  DEEPSEEK_SEARCH_MODEL_ID,
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
  type FetchUrl,
  type ModelSearchRequest,
  type ResolvedProviderAuth,
  routedProviderIdForModel,
  type WebSearchOutcome,
  WebSearchProviderError,
  type WebSearchProviderId,
  type WebSearchSnippet,
  type WebSource,
} from './web-search/vocabulary.ts'
