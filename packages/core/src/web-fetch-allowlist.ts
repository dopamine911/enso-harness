import { editUserConfig, hostListEdit } from './user-config-write.ts'
import type { WebFetchAllowlistChange } from './web-fetch.ts'

/**
 * The user's `webFetch.allowedHosts`, changed from Settings › Web tools (#924) instead of by hand.
 *
 * ⚠ ONLY THAT KEY CHANGES, through `editUserConfig` (`user-config-write.ts`): the list is written on
 * one line, every other key keeps its text, and an unreadable file is never overwritten.
 */

/**
 * What a change did: the list as the file now holds it, or why the file was left as it was.
 *
 * @group Web tools
 */
export type WebFetchAllowlistWrite =
  | { readonly kind: 'written' | 'unchanged'; readonly hosts: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Add or remove one host in the user's file at `path`. A host to add must already be in the form
 * `readWebFetchHostInput` gives back — the page has confirmed any reduction of a URL — or it is refused.
 * Only `webFetch.allowedHosts` changes (`editUserConfig`).
 *
 * @group Web tools
 */
export function changeUserAllowedHosts(path: string, change: WebFetchAllowlistChange): WebFetchAllowlistWrite {
  const written = editUserConfig(path, (config) =>
    hostListEdit(['webFetch', 'allowedHosts'], config.webFetch?.allowedHosts ?? [], change, 'host'),
  )
  if (written.kind === 'refused') return written
  return { kind: written.kind, hosts: written.config.webFetch?.allowedHosts ?? [] }
}
