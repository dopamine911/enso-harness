import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The one walk over the source tree (#174, #162 workstream 6: one walker per gate family).
 * Five copies existed — three gates' and four generators' — each a slightly different
 * filter over the same recursion, and `SKIPPED_DIRECTORIES` declared three times verbatim.
 * The recursion is here once; what differs is a predicate.
 *
 * Order is sorted by name at every level, so a generator's output does not depend on the
 * filesystem's directory order.
 *
 * `SOURCE_FILE` is every JS/TS flavour, a superset of each copy's own regex (`tsx?`, `tsx?|mjs`,
 * `tsx?|jsx?|mjs|cjs`, …). Measured at each fold: 0 files newly scanned. A flavour that appears
 * later is scanned by every gate, not invisible to some — the widening is the safe direction.
 */

/** Build outputs and dependencies: never entered, by any caller. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'dist-types', 'coverage'])

/**
 * A TypeScript or JavaScript module, any flavour. Exported because a reader of source
 * FILENAMES has the same question as this walker and must not answer it more narrowly:
 * `scripts/docs/source-citations.ts` recognises a file a page cites with it, and the
 * hand-rolled `tsx?|mjs` it replaced would have stopped seeing a `.cjs` or `.mts` page
 * citation the day one appeared — silently, since an unrecognised mention is simply not a
 * citation (PR #323 review). One extension set, every caller.
 */
export const SOURCE_FILE: RegExp = /\.(?:[cm]?[jt]sx?)$/

export interface WalkOptions {
  /** Directory names not entered, beyond `SKIPPED_DIRECTORIES`. */
  readonly skipDirectories?: readonly string[]
  /** Keep this source file? Called with its name and absolute path; only `SOURCE_FILE` matches are offered. */
  readonly keep?: (name: string, path: string) => boolean
}

/** Every kept source file under `directory`, absolute paths, depth-first in name order. */
export function filesUnder(directory: string, options: WalkOptions = {}): string[] {
  const keep = options.keep ?? ((): boolean => true)
  const found: string[] = []
  const entries = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const dirent of entries) {
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(dirent.name) || options.skipDirectories?.includes(dirent.name)) continue
      found.push(...filesUnder(path, options))
    } else if (dirent.isFile() && SOURCE_FILE.test(dirent.name) && keep(dirent.name, path)) {
      found.push(path)
    }
  }
  return found
}
