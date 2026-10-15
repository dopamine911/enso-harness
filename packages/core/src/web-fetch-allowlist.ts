import { isIP } from 'node:net'
import { applyEdits, type Edit, modify } from 'jsonc-parser'
import { type EnsoConfig, type EnsoConfigParseResult, parseEnsoConfig } from './config.ts'
import { readTextIfPresent, replaceFileText } from './paths.ts'
import { isPublicIpAddress, readWebFetchHostInput, type WebFetchAllowlistChange } from './web-fetch.ts'

/**
 * The user's `webFetch.allowedHosts`, changed from Settings › Web tools (#924) instead of by hand.
 *
 * ⚠ ONLY THAT KEY CHANGES. The edit is made on the file's text (`jsonc-parser`'s `modify`), so every
 * other key keeps its place and its formatting (the list itself is written on one line), and it is
 * written as every Settings save of `config.json` is (`editConfigFile`).
 *
 * It also holds web_fetch's address gate (`nonPublicAddressReason`), so the Settings host check and
 * the tool judge an address alike: the harness tool imports it at runtime (hence `node:net` and
 * `jsonc-parser` load in the tool's process too).
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
 * A config file read — the user's, or a trusted project's — or why it can't be (fails closed, as every reader does).
 *
 * @group Web tools
 */
export function readEnsoConfigFile(path: string): EnsoConfigParseResult {
  try {
    return parseEnsoConfig(readTextIfPresent(path))
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: `could not be read: ${String(error)}` }
  }
}

/** What a save makes of a config file's text: the new text, nothing to write, or why not. */
export type ConfigTextChange =
  | { readonly kind: 'edited'; readonly text: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * What a save of a config file did: written or left as it was (`config`, as the file now holds it),
 * or why not — the file is `unreadable` now, the change was `refused`, or its result is `invalid`
 * (not a config Enso reads). Each caller words the reason for its page.
 *
 * @group Configuration
 */
export type ConfigFileEdit =
  | { readonly kind: 'written'; readonly config: EnsoConfig }
  | { readonly kind: 'unchanged'; readonly config: EnsoConfig }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * The ONE writer of the user's `config.json` from Settings — Web tools (#924), and every section
 * `writeConfigSections` saves (Security #933, Projects & threads #934, Providers and Roles #904):
 * `edit` makes the new text of the file as it is (`undefined`: none yet).
 *
 * ⚠ IT IS A POLICY FILE THAT FAILS CLOSED: one that is unreadable now is NEVER written over (its
 * owner fixes it by hand), and a result `parseEnsoConfig` refuses writes nothing. The file is
 * replaced in one step (`replaceFileText`: a symlinked file stays a link) in the mode it had, and a
 * new one is made owner-only (0600) — never the umask's default, which would open the user's config.
 *
 * @group Configuration
 */
export function editConfigFile(
  path: string,
  edit: (text: string | undefined, config: EnsoConfig) => ConfigTextChange,
): ConfigFileEdit {
  let text: string | undefined
  try {
    text = readTextIfPresent(path)
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: `could not be read: ${String(error)}` }
  }
  const read = parseEnsoConfig(text)
  if (read.kind === 'unreadable') return { kind: 'unreadable', reason: read.reason }
  const changed = edit(text, read.config)
  if (changed.kind === 'unchanged') return { kind: 'unchanged', config: read.config }
  if (changed.kind === 'refused') return changed
  const checked = parseEnsoConfig(changed.text)
  if (checked.kind === 'unreadable') return { kind: 'invalid', reason: checked.reason }
  replaceFileText(path, changed.text, text === undefined ? 0o600 : undefined)
  return { kind: 'written', config: checked.config }
}

/** The list after `change`, or what the change came to without one: refused, or already so. */
function changedHosts(hosts: readonly string[], change: WebFetchAllowlistChange): string[] | ConfigTextChange {
  if ('remove' in change) {
    const kept = hosts.filter((host) => host !== change.remove)
    return kept.length === hosts.length ? { kind: 'unchanged' } : kept
  }
  const typed = readWebFetchHostInput(change.add)
  if (typed.kind === 'refused') return { kind: 'refused', reason: typed.reason }
  if (typed.kind !== 'host' || typed.host !== change.add)
    return { kind: 'refused', reason: `add the host itself, ${typed.host}, not ${change.add}` }
  if (hosts.some((host) => host.toLowerCase() === typed.host)) return { kind: 'unchanged' }
  return [...hosts, typed.host]
}

/**
 * Add or remove one host in the user's file at `path`. A host to add must already be in the form
 * `readWebFetchHostInput` gives back — the page has confirmed any reduction of a URL — or it is refused.
 *
 * @group Web tools
 */
export function changeUserAllowedHosts(path: string, change: WebFetchAllowlistChange): WebFetchAllowlistWrite {
  const written = editConfigFile(path, (text, config) => {
    const next = changedHosts(config.webFetch?.allowedHosts ?? [], change)
    if (!Array.isArray(next)) return next
    // ⚠ No formatting options: jsonc-parser's formatter reflows the edit's neighbours too, and they
    // must keep their text. Unformatted, the edit is the value alone; a new file is written whole.
    const after =
      text === undefined
        ? `${JSON.stringify({ webFetch: { allowedHosts: next } }, null, 2)}\n`
        : applyEdits(
            text,
            config.webFetch === undefined
              ? newSectionEdits(text, next)
              : modify(text, ['webFetch', 'allowedHosts'], next, {}),
          )
    return { kind: 'edited', text: after }
  })
  if (written.kind === 'written' || written.kind === 'unchanged')
    return { kind: written.kind, hosts: written.config.webFetch?.allowedHosts ?? [] }
  if (written.kind === 'refused') return written
  if (written.kind === 'invalid')
    return {
      kind: 'refused',
      reason: `the change would not be a config Enso reads (${written.reason}); nothing was changed`,
    }
  return {
    kind: 'refused',
    reason: `${path} is unreadable (${written.reason}); fix it by hand — it is never overwritten`,
  }
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

/**
 * A file with no `webFetch` yet: the section added as a top-level key on a line of its own, at the
 * file's own indent, the keys before it untouched.
 */
function newSectionEdits(text: string, hosts: readonly string[]): Edit[] {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
  return modify(text, ['webFetch'], { allowedHosts: hosts }, {}).map((edit) => ({
    ...edit,
    content: edit.content.startsWith(',') ? `,\n${indent}${edit.content.slice(1)}` : `\n${indent}${edit.content}\n`,
  }))
}
