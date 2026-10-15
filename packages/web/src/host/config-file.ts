import { type EnsoConfig, type EnsoConfigParseResult, parseEnsoConfig } from '@enso/core'
import { ensoConfigPath } from '@enso/core/paths'
import { editConfigFile } from '@enso/core/web-fetch-allowlist'
import { bytesOf, conflictOf, etagOf, type WriteCondition } from './atomic-file.ts'

/**
 * The user's `config.json` as Settings' sections read and save it (Security #933, Projects & threads
 * #934, the `models` section of Providers and Roles #904). ⚠ IT IS A POLICY FILE THAT FAILS CLOSED:
 * every consumer refuses an unreadable one, so a section's save is the whole file, every key the
 * section does not own kept as it is on disk, written by the one `config.json` writer, shared with
 * Web tools (`editConfigFile`: validated before it replaces the file atomically, in the mode the
 * file had, 0600 when there was none; a file that is already unreadable is never written over — its
 * owner fixes it by hand: the page cannot know what they meant). Under the `ETag` the page read, so
 * a hand edit made meanwhile is never overwritten unseen.
 */

/** The file's path, its `ETag` when there is one, and what it parses to. */
export function readConfigFile(home: string): {
  readonly path: string
  readonly etag?: string
  readonly parsed: EnsoConfigParseResult
} {
  const path = ensoConfigPath(home)
  const bytes = bytesOf(path)
  return {
    path,
    ...(bytes === undefined ? {} : { etag: etagOf(bytes) }),
    parsed: parseEnsoConfig(bytes?.toString('utf8')),
  }
}

/** Where Settings' `config.json` sections' files are, and how a `threads.projects` key is matched. */
export interface SettingsPlaces {
  /** `ENSO_HOME`: its `config.json`. */
  readonly home: string
  /** pi's agent directory: its `settings.json` holds `defaultProjectTrust`. */
  readonly agentDir: string
  /** A key as written to the canonical path the resolver matches it as (`canonicalConfigPath`). */
  readonly canonical: (key: string) => string
}

/** @group Configuration */
export type ConfigSectionWrite<Read> =
  | { readonly kind: 'written'; readonly read: Read }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Write the file `replace` makes of the one on disk, under `condition`, and answer `reread()`. A
 * file that is unreadable now, or a result `parseEnsoConfig` refuses, writes nothing.
 */
export function writeConfigSections<Read>(
  home: string,
  condition: WriteCondition,
  replace: (config: EnsoConfig) => EnsoConfig,
  reread: () => Read,
): ConfigSectionWrite<Read> {
  const configPath = ensoConfigPath(home)
  const conflict = conflictOf(configPath, condition)
  if (conflict !== undefined) return { kind: 'conflict', reason: conflict }
  const written = editConfigFile(configPath, (_text, config) => ({
    kind: 'edited',
    text: `${JSON.stringify(replace(config), null, 2)}\n`,
  }))
  if (written.kind === 'unreadable') {
    return {
      kind: 'refused',
      reason: `${configPath} is unreadable, so nothing was saved: fix it by hand first (${written.reason})`,
    }
  }
  if (written.kind === 'invalid' || written.kind === 'refused')
    return { kind: 'refused', reason: `nothing was saved: ${written.reason}` }
  return { kind: 'written', read: reread() }
}
