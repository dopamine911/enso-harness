import { applyEdits, type Edit, modify } from 'jsonc-parser'
import { type EnsoConfigParseResult, parseEnsoConfig } from './config.ts'
import { readTextIfPresent, replaceFileText } from './paths.ts'
import { readWebFetchHostInput, type WebFetchAllowlistChange } from './web-fetch.ts'

/**
 * The user's `webFetch.allowedHosts`, changed from Settings › Web tools (#924) instead of by hand.
 *
 * ⚠ ONLY THAT KEY CHANGES. The edit is made on the file's text (`jsonc-parser`'s `modify`), so every
 * other key keeps its place and its formatting (the list itself is written on one line); the result must pass `parseEnsoConfig` before it
 * replaces the file (`replaceFileText`: a symlinked file stays a link, the file keeps its mode), and a result that does not changes
 * nothing. A file that is there and unreadable is NEVER overwritten: the reason comes back.
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

/** The list after `change`, or what the change came to without one: refused, or already so. */
function changedHosts(hosts: string[], change: WebFetchAllowlistChange): string[] | WebFetchAllowlistWrite {
  if ('remove' in change) {
    const kept = hosts.filter((host) => host !== change.remove)
    return kept.length === hosts.length ? { kind: 'unchanged', hosts } : kept
  }
  const typed = readWebFetchHostInput(change.add)
  if (typed.kind === 'refused') return { kind: 'refused', reason: typed.reason }
  if (typed.kind !== 'host' || typed.host !== change.add)
    return { kind: 'refused', reason: `add the host itself, ${typed.host}, not ${change.add}` }
  if (hosts.some((host) => host.toLowerCase() === typed.host)) return { kind: 'unchanged', hosts }
  return [...hosts, typed.host]
}

/**
 * Add or remove one host in the user's file at `path`. A host to add must already be in the form
 * `readWebFetchHostInput` gives back — the page has confirmed any reduction of a URL — or it is refused.
 *
 * @group Web tools
 */
export function changeUserAllowedHosts(path: string, change: WebFetchAllowlistChange): WebFetchAllowlistWrite {
  let text: string | undefined
  try {
    text = readTextIfPresent(path)
  } catch (error: unknown) {
    return { kind: 'refused', reason: `${path} could not be read (${String(error)}); nothing was changed` }
  }
  const read = parseEnsoConfig(text)
  if (read.kind === 'unreadable')
    return {
      kind: 'refused',
      reason: `${path} is unreadable (${read.reason}); fix it by hand — it is never overwritten`,
    }
  const hosts = read.config.webFetch?.allowedHosts ?? []
  const next = changedHosts(hosts, change)
  if (!Array.isArray(next)) return next
  // ⚠ No formatting options: jsonc-parser's formatter reflows the edit's neighbours too, and they
  // must keep their text. Unformatted, the edit is the value alone; a new file is written whole.
  const after =
    text === undefined
      ? `${JSON.stringify({ webFetch: { allowedHosts: next } }, null, 2)}\n`
      : applyEdits(
          text,
          read.config.webFetch === undefined
            ? newSectionEdits(text, next)
            : modify(text, ['webFetch', 'allowedHosts'], next, {}),
        )
  const checked = parseEnsoConfig(after)
  if (checked.kind === 'unreadable')
    return {
      kind: 'refused',
      reason: `the change would not be a config Enso reads (${checked.reason}); nothing was changed`,
    }
  replaceFileText(path, after)
  return { kind: 'written', hosts: next }
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
