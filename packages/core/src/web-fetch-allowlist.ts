import { isIP } from 'node:net'
import { editUserConfig, hostListEdit } from './user-config-write.ts'
import { isPublicIpAddress, type WebFetchAllowlistChange } from './web-fetch.ts'

/**
 * The user's `webFetch.allowedHosts`, changed from Settings › Web tools (#924) instead of by hand.
 *
 * ⚠ ONLY THAT KEY CHANGES, through `editUserConfig` (`user-config-write.ts`): the list is written on
 * one line, every other key keeps its text, and an unreadable file is never overwritten.
 *
 * It also holds web_fetch's address gate (`nonPublicAddressReason`), so the Settings host check and
 * the tool judge an address alike: the harness tool imports it at runtime (hence `node:net` and the
 * config writer load in the tool's process too).
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
 * Why web_fetch's address gate refuses a host: it did not resolve (`unresolved` — the host is
 * missing, not private), or it resolved to nothing or to any one non-public address (`non-public`).
 * Each caller words its own tail; only `non-public` earns "the public web only".
 *
 * @group Web tools
 */
export type AddressRefusal = { readonly kind: 'unresolved' | 'non-public'; readonly reason: string }

/**
 * web_fetch's address gate (#54), the one copy: why a request to `host` would be refused by its
 * addresses (`AddressRefusal`), or undefined when every address is public (`isPublicIpAddress`).
 * An IP literal is classified as it is, without a lookup (URL brackets on an IPv6 literal are
 * dropped). The tool and Settings' host check (#924) both ask here.
 *
 * ⚠ ADVISORY: `resolve` answers now, the request resolves again later (the stated non-coverage in
 * `web-fetch-policy.ts`). The lookup carries no deadline of its own: the system resolver's bounds it.
 *
 * @group Web tools
 */
export async function nonPublicAddressReason(
  host: string,
  resolve: (host: string) => Promise<readonly string[]>,
): Promise<AddressRefusal | undefined> {
  const bareHost = host.replace(/^\[/, '').replace(/\]$/, '')
  let addresses: readonly string[]
  try {
    addresses = isIP(bareHost) === 0 ? await resolve(bareHost) : [bareHost]
  } catch (error: unknown) {
    return { kind: 'unresolved', reason: `"${bareHost}" did not resolve (${String(error)})` }
  }
  const nonPublic = addresses.find((address) => !isPublicIpAddress(address))
  if (addresses.length > 0 && nonPublic === undefined) return undefined
  return {
    kind: 'non-public',
    reason: `"${bareHost}" resolves to a non-public address${nonPublic === undefined ? '' : ` (${nonPublic})`}`,
  }
}
