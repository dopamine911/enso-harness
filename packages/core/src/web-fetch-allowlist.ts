import { isIP } from 'node:net'
import { editUserConfig, hostListEdit } from './user-config-write.ts'
import { isPublicIpAddress, type WebFetchAllowlistChange } from './web-fetch.ts'

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

/**
 * web_fetch's address gate (#54), the one copy: why a request to `host` would be refused by its
 * addresses — it did not resolve, it resolved to nothing, or any one address is not public
 * (`isPublicIpAddress`) — or undefined when every address is public. An IP literal is classified as
 * it is, without a lookup (URL brackets on an IPv6 literal are dropped). The tool and Settings' host
 * check (#924) both ask here, each adding its own tail to the reason.
 *
 * ⚠ ADVISORY: `resolve` answers now, the request resolves again later (the stated non-coverage in
 * `web-fetch-policy.ts`). The lookup carries no deadline of its own: the system resolver's bounds it.
 *
 * @group Web tools
 */
export async function nonPublicAddressReason(
  host: string,
  resolve: (host: string) => Promise<readonly string[]>,
): Promise<string | undefined> {
  const bareHost = host.replace(/^\[/, '').replace(/\]$/, '')
  let addresses: readonly string[]
  try {
    addresses = isIP(bareHost) === 0 ? await resolve(bareHost) : [bareHost]
  } catch (error: unknown) {
    return `"${bareHost}" did not resolve (${String(error)})`
  }
  const nonPublic = addresses.find((address) => !isPublicIpAddress(address))
  if (addresses.length > 0 && nonPublic === undefined) return undefined
  return `"${bareHost}" resolves to a non-public address${nonPublic === undefined ? '' : ` (${nonPublic})`}`
}
