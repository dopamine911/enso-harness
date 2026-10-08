import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type EnsoConfig, type EnsoConfigParseResult, parseEnsoConfig } from './config.ts'
import { projectConfigPath, projectLocalConfigPath, readTextIfPresent } from './paths.ts'
import type {
  EnsoConfigTier,
  EnsoProjectSettingsUpdate,
  EnsoProjectThreadSettings,
  EnsoProjectTier,
} from './project-settings.ts'

/**
 * A project's `threads` settings read from its tiers (#754), and written to its own files by the
 * project page. Node-only: it reads and writes the project's `.enso/` (`project-settings.ts` holds
 * the shapes and the tier rules).
 *
 * ⚠ READ FRESH, EVERY TIME: nothing here caches, so an edit applies to the next tree made. And the
 * files are the PROJECT's — the checkout's path — never a thread's tree, whose `.enso/` is the
 * agent's to write.
 */

/** A file of the project's own tiers that is there and could not be read: resolved as if absent. */
interface UnreadableTier {
  readonly tier: EnsoProjectTier
  readonly path: string
  readonly reason: string
}

/** The project's resolved `threads` settings, and each of its own files that could not be read. */
interface ProjectThreadSettingsRead {
  readonly threads: EnsoProjectThreadSettings
  /** Skipped: the resolution FAILS CLOSED to the tiers below, and the caller says so. */
  readonly unreadable: readonly UnreadableTier[]
}

type ThreadsSection = NonNullable<EnsoConfig['threads']>

/** One tier's `threads`, highest first; `undefined` when the tier sets none. */
interface TierLayer {
  readonly tier: EnsoConfigTier
  readonly threads: ThreadsSection | undefined
}

/**
 * Resolve a new tree's settings for `project` (a canonical path): local > shared > user > Enso's
 * default (`worktree`, no setup, nothing to copy), each key's whole value from one tier — a list
 * in a higher tier REPLACES a lower one's. The user tier's mode is its `threads.projects` entry for
 * the project, else its `threads.tree`; `canonical` turns a key as the user wrote it (`~/code/app`,
 * a trailing slash, a symlink) into the canonical path `project` is (PR #561 review): matched as
 * written, such a key silently fell through to the default.
 *
 * ⚠ THE PROJECT'S OWN TIERS ARE READ ONLY WHEN `trusted` (pi's trust for the project's path): an
 * untrusted checkout's config cannot move its threads out of their trees, nor run a command. ⚠ ON
 * BY DEFAULT (#551 decision 1): each tree adds a worktree registration and an `enso/<thread-id>`
 * branch to the user's repository until its thread is deleted (#571).
 *
 * @group Project settings
 */
export function readProjectThreadSettings(request: {
  readonly project: string
  readonly user: EnsoConfig
  readonly canonical: (key: string) => string
  readonly trusted: boolean
}): ProjectThreadSettingsRead {
  const layers: TierLayer[] = []
  const unreadable: UnreadableTier[] = []
  if (request.trusted) {
    for (const tier of ['local', 'shared'] as const) {
      const path = projectTierPath(request.project, tier)
      const read = readTierFile(path)
      if (read.kind === 'unreadable') unreadable.push({ tier, path, reason: read.reason })
      else layers.push({ tier, threads: read.config.threads })
    }
  }
  const userThreads = request.user.threads
  const ownMode = Object.entries(userThreads?.projects ?? {}).find(
    ([key]) => request.canonical(key) === request.project,
  )?.[1]
  // The user's own entry for this project beats their `threads.tree`.
  layers.push({ tier: 'user', threads: ownMode === undefined ? userThreads : { ...userThreads, tree: ownMode } })
  return {
    threads: {
      tree: highest(layers, 'tree') ?? { value: 'worktree', tier: 'default' },
      setup: highest(layers, 'setup') ?? { value: [], tier: 'default' },
      copy: highest(layers, 'copy') ?? { value: [], tier: 'default' },
    },
    unreadable,
  }
}

/** The first layer that sets `key`, with its tier. */
function highest<Key extends 'tree' | 'setup' | 'copy'>(
  layers: readonly TierLayer[],
  key: Key,
): { value: NonNullable<ThreadsSection[Key]>; tier: EnsoConfigTier } | undefined {
  for (const layer of layers) {
    const value = layer.threads?.[key]
    if (value !== undefined) return { value, tier: layer.tier }
  }
  return undefined
}

/** The file behind one of the project's own tiers: shared `config.json`, local `config.local.json`. */
function projectTierPath(project: string, tier: EnsoProjectTier): string {
  return tier === 'local' ? projectLocalConfigPath(project) : projectConfigPath(project)
}

/** A tier file's parse; one that is there and cannot be read is `unreadable`, never "no settings". */
function readTierFile(path: string): EnsoConfigParseResult {
  try {
    return parseEnsoConfig(readTextIfPresent(path))
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: `could not be read: ${String(error)}` }
  }
}

/**
 * Set or clear `threads` keys in one of the project's own files (#754), the project page's write:
 * a key given is set, `null` removes it, a key absent is left; every other key in the file is kept,
 * and a `threads` left empty goes. Written as 2-space JSON with a final newline, `<project>/.enso/`
 * made if needed. ⚠ A file that is there and unreadable — not JSON, or not a config this version
 * reads — is NEVER overwritten: the reason comes back, and the operator fixes the file. Writing
 * needs no trust: it is the operator's own action, and reading it back into a resolution does.
 *
 * @group Project settings
 */
export function writeProjectThreadSettings(
  project: string,
  update: EnsoProjectSettingsUpdate,
): { kind: 'written' } | { kind: 'unreadable'; path: string; reason: string } {
  const path = projectTierPath(project, update.tier)
  const read = readTierFile(path)
  if (read.kind === 'unreadable') return { kind: 'unreadable', path, reason: read.reason }
  const threads = Object.fromEntries(
    Object.entries({ ...read.config.threads, ...update.threads }).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  )
  const others = Object.entries(read.config).filter(([key]) => key !== 'threads')
  const next = Object.keys(threads).length === 0 ? Object.fromEntries(others) : { ...read.config, threads }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return { kind: 'written' }
}
