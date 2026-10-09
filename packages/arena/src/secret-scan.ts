import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { ARENA_RUN_HOME } from './run-home.ts'
import { ARENA_SHOT_EXTENSION } from './timeline.ts'

/**
 * The run's own check that no known secret reached a file it keeps (#584 A11, #610).
 *
 * Redaction covers what the RECORDER writes (timeline, Enso's output, the evidence). The Playwright
 * trace is the browser's: `tracing.start({ snapshots: true })` keeps every network resource, API
 * response bodies included, and nothing redacts it. Nobody had measured what Enso's own responses
 * put there. So at the stop every file the run keeps is read — inside each trace zip, entry by
 * entry — for the run's secret values, and the manifest says what was found where.
 *
 * ⚠ A HIT NAMES THE FILE, NEVER THE VALUE: the report is shared, and a secret it quoted would be
 * the leak it reports.
 *
 * What it does not see, stated: PNGs (a screenshot is pixels — the README's on-screen caveat stays),
 * a secret the page transformed (base64, split across chunks), and the run home `.enso/`, which holds
 * the credential links by design and is skipped, as is every symlink.
 */

/** Where a secret was found: a file, and the entry inside it when the file is a zip. */
export interface ArenaSecretHit {
  readonly path: string
  readonly entry?: string
}

export interface ArenaSecretScan {
  /** Files read, and zip entries read inside them. */
  readonly files: number
  readonly entries: number
  readonly hits: readonly ArenaSecretHit[]
  /** A file that could not be read — a damaged or zip64 trace — named with why: not scanned is not clean. */
  readonly unreadable: readonly { readonly path: string; readonly error: string }[]
}

/**
 * Scan every file under `runDirectory` for `secretValues` (see the module header for what is skipped).
 *
 * ⚠ NEVER THROWS ON A FILE (PR #613 review). The project is the agent's to shape, and a `chmod 000`
 * file or directory is a legitimate outcome: thrown, it cost the run its manifest, because the scan
 * runs before the manifest is written, and `arena manifest` could not fold it either. Whatever cannot
 * be read is an `unreadable` row, and everything reachable is still scanned.
 */
export function scanRunForSecrets(runDirectory: string, secretValues: readonly string[]): ArenaSecretScan {
  const needles = secretValues.map((secretValue) => Buffer.from(secretValue))
  const found = (bytes: Uint8Array): boolean => {
    const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return needles.some((needle) => haystack.includes(needle))
  }
  const walked = filesToScan(runDirectory)
  const files = walked.files.map((path) => scanFile(path, relative(runDirectory, path), found))
  return {
    files: files.length,
    entries: files.reduce((total, file) => total + file.entries, 0),
    hits: files.flatMap((file) => file.hits),
    unreadable: [
      ...walked.unreadable,
      ...files.flatMap((file) => (file.unreadable === undefined ? [] : [file.unreadable])),
    ],
  }
}

/**
 * The scan a refold writes (`arena manifest`): this scan, plus every hit an earlier scan of the run
 * recorded whose file is still there.
 *
 * ⚠ NEVER DOWNGRADED (PR #613 review). A rescan can only look for the values it knows NOW: an OAuth
 * token that has since rotated, or a `--home` run refolded without its `--home`, is a value it cannot
 * see, and the leaked file would read as clean. A recorded hit cannot be re-checked without its value,
 * so it stands until its file is gone.
 */
export function withEarlierHits(
  current: ArenaSecretScan,
  earlierManifest: unknown,
  runDirectory: string,
): ArenaSecretScan {
  const key = (hit: ArenaSecretHit): string => `${hit.path}\u0000${hit.entry ?? ''}`
  const seen = new Set(current.hits.map(key))
  const carried = earlierHitsOf(earlierManifest).filter(
    (hit) => !seen.has(key(hit)) && existsSync(join(runDirectory, hit.path)),
  )
  return carried.length === 0 ? current : { ...current, hits: [...current.hits, ...carried] }
}

/** The hits a manifest on disk recorded, field by field. */
function earlierHitsOf(manifest: unknown): ArenaSecretHit[] {
  if (typeof manifest !== 'object' || manifest === null || !('secretScan' in manifest)) return []
  const scan: unknown = manifest.secretScan
  if (typeof scan !== 'object' || scan === null || !('hits' in scan) || !Array.isArray(scan.hits)) return []
  return scan.hits.flatMap((hit: unknown): ArenaSecretHit[] => {
    if (typeof hit !== 'object' || hit === null || !('path' in hit) || typeof hit.path !== 'string') return []
    const entry: unknown = 'entry' in hit ? hit.entry : undefined
    return [typeof entry === 'string' ? { path: hit.path, entry } : { path: hit.path }]
  })
}

type Unreadable = ArenaSecretScan['unreadable'][number]

const unreadableOf = (path: string, error: unknown): Unreadable => ({
  path,
  error: error instanceof Error ? error.message : String(error),
})

/** One file's scan: the whole file, or a zip entry by entry. A file or zip that does not read is said, not skipped. */
function scanFile(
  path: string,
  shown: string,
  found: (bytes: Uint8Array) => boolean,
): { readonly entries: number; readonly hits: readonly ArenaSecretHit[]; readonly unreadable?: Unreadable } {
  try {
    const bytes = readFileSync(path)
    if (!path.endsWith('.zip')) return { entries: 0, hits: found(bytes) ? [{ path: shown }] : [] }
    const entries = zipEntries(bytes)
    const hits = entries
      .filter((zipEntry) => found(zipEntry.data))
      .map((zipEntry) => ({ path: shown, entry: zipEntry.name }))
    return { entries: entries.length, hits }
  } catch (error) {
    return { entries: 0, hits: [], unreadable: unreadableOf(shown, error) }
  }
}

/** The files to read, and the directories that could not be listed. Links are skipped by their entry's own type. */
function filesToScan(runDirectory: string): { readonly files: string[]; readonly unreadable: Unreadable[] } {
  const files: string[] = []
  const unreadable: Unreadable[] = []
  const walk = (directory: string): void => {
    let children
    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      unreadable.push(unreadableOf(relative(runDirectory, directory), error))
      return
    }
    for (const child of children) {
      const path = join(directory, child.name)
      if (directory === runDirectory && child.name === ARENA_RUN_HOME) continue
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) walk(path)
      // A screenshot is pixels, not text: this run's JPEGs, and an older run's PNGs on a refold (#740).
      else if (child.isFile() && !child.name.endsWith(ARENA_SHOT_EXTENSION) && !child.name.endsWith('.png'))
        files.push(path)
    }
  }
  walk(runDirectory)
  return { files, unreadable }
}

const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50
const CENTRAL_DIRECTORY_ENTRY = 0x02_01_4b_50
const LOCAL_HEADER = 0x04_03_4b_50
const STORED = 0
const DEFLATED = 8
const ZIP64_MARKER = 0xff_ff_ff_ff

/**
 * A zip's entries, decompressed: enough of the format to read a Playwright trace (stored and
 * deflated entries, sizes from the central directory). Throws on what it does not read — zip64, an
 * unknown method, a damaged header — so the scan says "unreadable" rather than "clean".
 */
export function zipEntries(bytes: Uint8Array): Array<{ readonly name: string; readonly data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = endOfCentralDirectory(view)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  if (at === ZIP64_MARKER) throw new Error('zip64 is not read')
  const entries: Array<{ readonly name: string; readonly data: Uint8Array }> = []
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    if (view.getUint32(at, true) !== CENTRAL_DIRECTORY_ENTRY) throw new Error(`no central directory entry at ${at}`)
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    entries.push({ name, data: entryData(bytes, view, { localOffset, compressedSize, method, name }) })
  }
  return entries
}

function endOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of at most 65,535: search back from the end.
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xff_ff); at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at
  }
  throw new Error('not a zip: no end of central directory')
}

function entryData(
  bytes: Uint8Array,
  view: DataView,
  entry: {
    readonly localOffset: number
    readonly compressedSize: number
    readonly method: number
    readonly name: string
  },
): Uint8Array {
  if (entry.compressedSize === ZIP64_MARKER || entry.localOffset === ZIP64_MARKER) throw new Error('zip64 is not read')
  if (view.getUint32(entry.localOffset, true) !== LOCAL_HEADER) throw new Error(`no local header for ${entry.name}`)
  const start =
    entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true)
  const raw = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === STORED) return raw
  if (entry.method === DEFLATED) return inflateRawSync(raw)
  throw new Error(`${entry.name}: compression method ${entry.method} is not read`)
}
