import { renameSync, writeFileSync } from 'node:fs'
import { applyEdits, type Edit, modify } from 'jsonc-parser'
import { type EnsoConfig, type EnsoConfigParseResult, parseEnsoConfig } from './config.ts'
import { readTextIfPresent } from './paths.ts'
import { readWebFetchHostInput } from './web-fetch.ts'

/**
 * One key of the user's `ENSO_HOME/config.json`, changed from Settings (#924, #932) instead of by hand.
 *
 * ⚠ ONLY THAT KEY CHANGES. The edit is made on the file's text (`jsonc-parser`'s `modify`), so every
 * other key keeps its place and its formatting; the result must pass `parseEnsoConfig` before it
 * replaces the file (written beside it, then renamed over it), and a result that does not changes
 * nothing. A file that is there and unreadable is NEVER overwritten: the reason comes back.
 */

/**
 * What a change to the user's config comes to: the key at `at` set to `value` (`undefined` removes
 * it), or no write at all — already so, or refused with the reason.
 *
 * @group Configuration
 */
export type UserConfigEdit =
  | { readonly at: readonly [string, ...string[]]; readonly value: unknown }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * What a change did: the config as the file now holds it, or why the file was left as it was.
 *
 * @group Configuration
 */
export type UserConfigWrite =
  | { readonly kind: 'written' | 'unchanged'; readonly config: EnsoConfig }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * A config file read — the user's, or a trusted project's — or why it can't be (fails closed, as every reader does).
 *
 * @group Configuration
 */
export function readEnsoConfigFile(path: string): EnsoConfigParseResult {
  try {
    return parseEnsoConfig(readTextIfPresent(path))
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: `could not be read: ${String(error)}` }
  }
}

/**
 * One host name added to or removed from `hosts`, the list kept at `at` — the allowlist's hosts
 * (#924), a Tavily domain list (#932). A name to add must already be in the form
 * `readWebFetchHostInput` gives back for a bare host, or it is refused; one already there, by any
 * case, is already so.
 *
 * @group Configuration
 */
export function hostListEdit(
  at: readonly [string, ...string[]],
  hosts: readonly string[],
  change: { readonly add: string } | { readonly remove: string },
  noun: 'host' | 'domain',
): UserConfigEdit {
  if ('remove' in change) {
    const kept = hosts.filter((host) => host !== change.remove)
    return kept.length === hosts.length ? { kind: 'unchanged' } : { at, value: kept }
  }
  const typed = readWebFetchHostInput(change.add)
  if (typed.kind === 'refused') return { kind: 'refused', reason: typed.reason }
  if (typed.kind !== 'host' || typed.host !== change.add)
    return { kind: 'refused', reason: `add the ${noun} itself, ${typed.host}, not ${change.add}` }
  if (hosts.some((host) => host.toLowerCase() === typed.host)) return { kind: 'unchanged' }
  return { at, value: [...hosts, typed.host] }
}

/** `value` under the keys of `path`, as a new object. */
function nested(path: readonly string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
}

/**
 * Change one key of the user's file at `path`: `plan` reads the config as the file holds it and
 * names the edit. A missing file is written whole; an unreadable one is refused.
 *
 * @group Configuration
 */
export function editUserConfig(path: string, plan: (config: EnsoConfig) => UserConfigEdit): UserConfigWrite {
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
  const edit = plan(read.config)
  if (!('at' in edit)) return edit.kind === 'refused' ? edit : { kind: 'unchanged', config: read.config }
  const [section, ...rest] = edit.at
  const sectionMissing = (read.config as Record<string, unknown>)[section] === undefined
  if (sectionMissing && edit.value === undefined) return { kind: 'unchanged', config: read.config }
  // ⚠ No formatting options: jsonc-parser's formatter reflows the edit's neighbours too, and they
  // must keep their text. Unformatted, the edit is the value alone; a new file is written whole.
  const after =
    text === undefined
      ? `${JSON.stringify(nested(edit.at, edit.value), null, 2)}\n`
      : applyEdits(
          text,
          sectionMissing
            ? newSectionEdits(text, section, nested(rest, edit.value))
            : modify(text, [...edit.at], edit.value, {}),
        )
  const checked = parseEnsoConfig(after)
  if (checked.kind === 'unreadable')
    return {
      kind: 'refused',
      reason: `the change would not be a config Enso reads (${checked.reason}); nothing was changed`,
    }
  const staged = `${path}.${process.pid}.tmp`
  writeFileSync(staged, after)
  renameSync(staged, path)
  return { kind: 'written', config: checked.config }
}

/**
 * A file without `section` yet: the section added as a top-level key on a line of its own, at the
 * file's own indent, the keys before it untouched.
 */
function newSectionEdits(text: string, section: string, value: unknown): Edit[] {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
  return modify(text, [section], value, {}).map((edit) => ({
    ...edit,
    content: edit.content.startsWith(',') ? `,\n${indent}${edit.content.slice(1)}` : `\n${indent}${edit.content}\n`,
  }))
}
