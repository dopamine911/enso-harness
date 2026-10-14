import type { EnsoConfig } from './config.ts'
import { editUserConfig, hostListEdit, type UserConfigEdit, type UserConfigWrite } from './user-config-write.ts'
import type { WebSearchConfig, WebSearchSettingsChange } from './web-search.ts'

/**
 * The user's `webSearch`, changed from Settings › Web tools › Searching (#932) instead of by hand:
 * `webSearch.backend`, `webSearch.tavily.includeDomains`, `webSearch.tavily.excludeDomains`.
 *
 * ⚠ ONLY THE TOUCHED KEY CHANGES, through `editUserConfig` (`user-config-write.ts`): the file passes
 * `parseEnsoConfig` before it replaces the old one, and an unreadable file is never overwritten.
 * The `TAVILY_API_KEY` secret is not here: it is never in the config (`secrets.ts`, `writeSecret`).
 */

/** The edit `change` makes to `webSearch` as the file holds it. */
function planWebSearch(search: WebSearchConfig | undefined, change: WebSearchSettingsChange): UserConfigEdit {
  if ('backend' in change) {
    const backend = change.backend === 'deepseek' ? 'deepseek' : undefined
    return search?.backend === backend ? { kind: 'unchanged' } : { at: ['webSearch', 'backend'], value: backend }
  }
  return hostListEdit(['webSearch', 'tavily', change.list], search?.tavily?.[change.list] ?? [], change, 'domain')
}

/**
 * Apply one Searching change to the user's file at `path`. A domain to add must already be a bare
 * host as `readWebFetchHostInput` gives it back, or it is refused.
 *
 * @group Web tools
 */
export function changeUserWebSearch(path: string, change: WebSearchSettingsChange): UserConfigWrite {
  return editUserConfig(path, (config: EnsoConfig) => planWebSearch(config.webSearch, change))
}
