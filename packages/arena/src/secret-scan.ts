import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
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
 * put there. So every file the run keeps is read — inside each trace zip, entry by entry — for the
 * run's secret values, and the manifest says what was found where.
 *
 * ⚠ A HIT NAMES THE FILE, NEVER THE VALUE: the report is shared, and a secret it quoted would be
 * the leak it reports.
 *
 * ONE ENTRY AT A TIME, ONCE (#741). Reading a whole run's zips and inflating every entry took 13.5 s
 * and 3.4 GB, three times a run, almost all of it screencast JPEGs. A zip is read from its central
 * directory, one kept entry inflated at a time from an open file, so memory is bounded by the largest
 * kept entry. Each trace chunk is scanned as the recorder writes it, and every file read is stamped
 * (`scanned`: path, size, mtime) so a later scan reads only what changed since.
 *
 * What it does not see, stated: pixels — screenshots, the trace's screencast frames and image
 * resources (the README's on-screen caveat stays) — and fonts; a secret the page transformed (base64,
 * split across chunks); and the run home `.enso/`, which holds the credential links by design and is
 * skipped, as is every symlink.
 */

/** Where a secret was found: a file, and the entry inside it when the file is a zip. */
export interface ArenaSecretHit {
  readonly path: string
  readonly entry?: string
}

/** A file the scan read, as it stood when read: unchanged since, a later scan does not read it again (#741). */
export interface ArenaScannedFile {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  /** Zip entries read inside it. */
  readonly entries: number
  /**
   * How many secret values it was read for. ⚠ A scan that knows MORE values reads it again: a token
   * the login rotated mid-run joins the set after earlier chunks were read. The count, never the values.
   */
  readonly soughtValues: number
}

export interface ArenaSecretScan {
  /** Files read, and zip entries read inside them. */
  readonly files: number
  readonly entries: number
  readonly hits: readonly ArenaSecretHit[]
  /** A file that could not be read — a damaged trace — named with why: not scanned is not clean. */
  readonly unreadable: readonly { readonly path: string; readonly error: string }[]
  /** Every file read, stamped (#741); absent on a run scanned before it, whose files are all read again. */
  readonly scanned?: readonly ArenaScannedFile[]
}

/** What a later scan takes from an earlier one: the stamps of the files it need not read, and their hits. */
type EarlierScan = Pick<ArenaSecretScan, 'hits' | 'scanned'>

/**
 * Scan every file under `runDirectory` for `secretValues` (see the module header for what is skipped).
 * A file `earlier` read that is unchanged since is not read again: its stamp and hits are carried.
 *
 * ⚠ NEVER THROWS ON A FILE. The project is the agent's to shape, and a `chmod 000`
 * file or directory is a legitimate outcome: thrown, it cost the run its manifest, because the scan
 * runs before the manifest is written, and `arena manifest` could not fold it either. Whatever cannot
 * be read is an `unreadable` row, and everything reachable is still scanned.
 */
export function scanRunForSecrets(
  runDirectory: string,
  secretValues: readonly string[],
  earlier?: EarlierScan,
): ArenaSecretScan {
  return scanOf(runDirectory, filesToScan(runDirectory), secretValues, earlier)
}

/**
 * Scan these files of the run, each a path relative to `runDirectory`: the trace chunks written so
 * far (the recorder), or the documents a publication carries. Pixels are not read, as in the run's scan.
 */
export function scanFilesForSecrets(
  runDirectory: string,
  paths: readonly string[],
  secretValues: readonly string[],
  earlier?: EarlierScan,
): ArenaSecretScan {
  const files = paths.filter((path) => !isPixels(path)).map((path) => join(runDirectory, path))
  return scanOf(runDirectory, { files, unreadable: [] }, secretValues, earlier)
}

/**
 * The scan a refold writes (`arena manifest`): this scan, plus every hit an earlier scan of the run
 * recorded whose file is still there.
 *
 * ⚠ NEVER DOWNGRADED. A rescan can only look for the values it knows NOW: an OAuth
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
  const carried = recordedScanOf(earlierManifest).hits.filter(
    (hit) => !seen.has(key(hit)) && existsSync(join(runDirectory, hit.path)),
  )
  return carried.length === 0 ? current : { ...current, hits: [...current.hits, ...carried] }
}

/** The scan a manifest on disk recorded, field by field: its hits, and the files it stamped. */
export function recordedScanOf(manifest: unknown): EarlierScan {
  if (typeof manifest !== 'object' || manifest === null || !('secretScan' in manifest)) return { hits: [] }
  const scan: unknown = manifest.secretScan
  if (typeof scan !== 'object' || scan === null) return { hits: [] }
  const hits = 'hits' in scan && Array.isArray(scan.hits) ? scan.hits.flatMap(recordedHitOf) : []
  const scanned = 'scanned' in scan && Array.isArray(scan.scanned) ? scan.scanned.flatMap(recordedStampOf) : []
  return { hits, scanned }
}

function recordedHitOf(hit: unknown): ArenaSecretHit[] {
  if (typeof hit !== 'object' || hit === null || !('path' in hit) || typeof hit.path !== 'string') return []
  const entry: unknown = 'entry' in hit ? hit.entry : undefined
  return [typeof entry === 'string' ? { path: hit.path, entry } : { path: hit.path }]
}

function recordedStampOf(stamp: unknown): ArenaScannedFile[] {
  if (typeof stamp !== 'object' || stamp === null) return []
  const { path, size, mtimeMs, entries, soughtValues } = stamp as Partial<Record<keyof ArenaScannedFile, unknown>>
  if (typeof path !== 'string' || typeof size !== 'number' || typeof mtimeMs !== 'number') return []
  if (typeof entries !== 'number' || typeof soughtValues !== 'number') return []
  return [{ path, size, mtimeMs, entries, soughtValues }]
}

type Unreadable = ArenaSecretScan['unreadable'][number]

const unreadableOf = (path: string, error: unknown): Unreadable => ({
  path,
  error: error instanceof Error ? error.message : String(error),
})

/** One file's part of a scan: its hits, and its stamp when it was read, or why it was not. */
interface FileScan {
  readonly hits: readonly ArenaSecretHit[]
  readonly scanned?: ArenaScannedFile
  readonly unreadable?: Unreadable
}

/** The listed files' scan, each read unless `earlier` read it as it is now; the listing's own failures first. */
function scanOf(
  runDirectory: string,
  listed: { readonly files: readonly string[]; readonly unreadable: readonly Unreadable[] },
  secretValues: readonly string[],
  earlier: EarlierScan | undefined,
): ArenaSecretScan {
  const needles = secretValues.map((secretValue) => Buffer.from(secretValue))
  // Per needle `Buffer.includes`: measured faster than one automaton or one regex below ~90 values (#741).
  const found = (bytes: Uint8Array): boolean => {
    const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return needles.some((needle) => haystack.includes(needle))
  }
  const stamps = new Map((earlier?.scanned ?? []).map((stamp) => [stamp.path, stamp]))
  const scans = listed.files.map((path): FileScan => {
    const shown = relative(runDirectory, path)
    const stamp = stamps.get(shown)
    if (stamp !== undefined && isUnchanged(path, stamp, needles.length)) {
      return { hits: (earlier?.hits ?? []).filter((hit) => hit.path === shown), scanned: stamp }
    }
    return scanFile(path, shown, found, needles.length)
  })
  const scanned = scans.flatMap((scan) => (scan.scanned === undefined ? [] : [scan.scanned]))
  return {
    files: scans.length,
    entries: scanned.reduce((total, stamp) => total + stamp.entries, 0),
    hits: scans.flatMap((scan) => scan.hits),
    unreadable: [
      ...listed.unreadable,
      ...scans.flatMap((scan) => (scan.unreadable === undefined ? [] : [scan.unreadable])),
    ],
    scanned,
  }
}

/** The file is as its stamp says, and was read for at least as many values as this scan knows. */
function isUnchanged(path: string, stamp: ArenaScannedFile, soughtValues: number): boolean {
  if (stamp.soughtValues < soughtValues) return false
  try {
    const stats = statSync(path)
    return stats.size === stamp.size && stats.mtimeMs === stamp.mtimeMs
  } catch {
    return false
  }
}

/**
 * One file's scan: the whole file, or a zip entry by entry. A file or zip that does not read is said,
 * not skipped. The stamp is taken before the read: a file written during it differs next time.
 */
function scanFile(path: string, shown: string, found: (bytes: Uint8Array) => boolean, soughtValues: number): FileScan {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const { size, mtimeMs } = fstatSync(descriptor)
    const read = path.endsWith('.zip')
      ? zipScanOf(descriptor, size, { path, shown, found })
      : { entries: 0, hits: found(readFileSync(descriptor)) ? [{ path: shown }] : [] }
    return { hits: read.hits, scanned: { path: shown, size, mtimeMs, entries: read.entries, soughtValues } }
  } catch (error) {
    return { hits: [], unreadable: unreadableOf(shown, error) }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** A screenshot is pixels, not text: this run's JPEGs, and an older run's PNGs on a refold (#740). */
const isPixels = (name: string): boolean => name.endsWith(ARENA_SHOT_EXTENSION) || name.endsWith('.png')

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
      else if (child.isFile() && !isPixels(child.name)) files.push(path)
    }
  }
  walk(runDirectory)
  return { files, unreadable }
}

/**
 * The trace entries not read: the screencast frames and the page's images and fonts. 638 MB of a
 * 656 MB chunk were screencast JPEGs (#741), and pixels cannot hold a text secret. Everything else is
 * read — `trace.trace`, `trace.network`, every json, js, css and html resource, and any name not known.
 */
const UNREAD_ENTRY = /^screencast\/[^/]+\.jpeg$|^resources\/[^/]+\.(?:png|jpeg|jpg|woff2)$|\.png$/

const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06_06_4b_50
const ZIP64_LOCATOR = 0x07_06_4b_50
const CENTRAL_DIRECTORY_ENTRY = 0x02_01_4b_50
const LOCAL_HEADER = 0x04_03_4b_50
const STORED = 0
const DEFLATED = 8
const ZIP64_MARKER = 0xff_ff_ff_ff
const ZIP64_COUNT_MARKER = 0xff_ff
const ZIP64_EXTRA_FIELD = 0x00_01
const END_RECORD_LENGTH = 22
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_END_RECORD_LENGTH = 56
const LOCAL_HEADER_LENGTH = 30
const LONGEST_COMMENT = 0xff_ff

/**
 * A zip's scan, streamed; else, when the stream cannot read it, the whole-file read it replaced.
 * ⚠ NEVER SKIPPED: a zip neither reads throws, and the file is an `unreadable` row with the reason.
 */
function zipScanOf(
  descriptor: number,
  size: number,
  file: { readonly path: string; readonly shown: string; readonly found: (bytes: Uint8Array) => boolean },
): { readonly entries: number; readonly hits: readonly ArenaSecretHit[] } {
  try {
    return streamedZipScan(descriptor, size, file)
  } catch {
    const entries = zipEntries(readFileSync(file.path))
    const hits = entries
      .filter((zipEntry) => file.found(zipEntry.data))
      .map((zipEntry) => ({ path: file.shown, entry: zipEntry.name }))
    return { entries: entries.length, hits }
  }
}

/** A zip read from its central directory, each kept entry read and inflated on its own (#741). */
function streamedZipScan(
  descriptor: number,
  size: number,
  file: { readonly shown: string; readonly found: (bytes: Uint8Array) => boolean },
): { readonly entries: number; readonly hits: readonly ArenaSecretHit[] } {
  const place = centralDirectoryPlace(descriptor, size)
  const centralDirectory = readAt(descriptor, place.offset, place.size)
  const hits: ArenaSecretHit[] = []
  let entries = 0
  for (const zipEntry of centralDirectoryEntries(centralDirectory, place.count)) {
    if (zipEntry.name.endsWith('/') || UNREAD_ENTRY.test(zipEntry.name)) continue
    entries += 1
    if (file.found(streamedEntryData(descriptor, zipEntry))) hits.push({ path: file.shown, entry: zipEntry.name })
  }
  // ⚠ COLLECTED HERE, not when the collector gets to it: each chunk's `trace.trace` inflates to about
  // 16 MB that nothing holds after its search, yet the heap kept every one, and a nine-chunk run
  // peaked at 157–222 MB. Collected per zip, 139–157 MB, for about 8 ms a zip (#741).
  Bun.gc(true)
  return { entries, hits }
}

/** `length` bytes of the file from `position`, all of them: a zip shorter than its directory says is damaged. */
function readAt(descriptor: number, position: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length)
  let done = 0
  while (done < length) {
    const count = readSync(descriptor, bytes, done, length - done, position + done)
    if (count === 0) throw new Error(`the zip ends before byte ${position + length}`)
    done += count
  }
  return bytes
}

/** Where the central directory is and how many entries it lists, from the end record — zip64's when it says so. */
function centralDirectoryPlace(
  descriptor: number,
  size: number,
): { readonly offset: number; readonly size: number; readonly count: number } {
  const tailLength = Math.min(size, END_RECORD_LENGTH + LONGEST_COMMENT + ZIP64_LOCATOR_LENGTH)
  const tail = readAt(descriptor, size - tailLength, tailLength)
  const end = endOfCentralDirectory(new DataView(tail.buffer, tail.byteOffset, tail.byteLength))
  const count = tail.readUInt16LE(end + 10)
  const directorySize = tail.readUInt32LE(end + 12)
  const offset = tail.readUInt32LE(end + 16)
  if (count !== ZIP64_COUNT_MARKER && directorySize !== ZIP64_MARKER && offset !== ZIP64_MARKER) {
    return { offset, size: directorySize, count }
  }
  // A zip64 end record says the same, in 64 bits; the locator just before the end record says where.
  const locator = end - ZIP64_LOCATOR_LENGTH
  if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Error('no zip64 end record locator')
  const record = readAt(descriptor, Number(tail.readBigUInt64LE(locator + 8)), ZIP64_END_RECORD_LENGTH)
  if (record.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) throw new Error('no zip64 end record')
  return {
    count: Number(record.readBigUInt64LE(32)),
    size: Number(record.readBigUInt64LE(40)),
    offset: Number(record.readBigUInt64LE(48)),
  }
}

interface CentralDirectoryEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly localOffset: number
}

function centralDirectoryEntries(centralDirectory: Buffer, count: number): CentralDirectoryEntry[] {
  const entries: CentralDirectoryEntry[] = []
  let at = 0
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    if (centralDirectory.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`no central directory entry at ${at}`)
    }
    const nameLength = centralDirectory.readUInt16LE(at + 28)
    const extraLength = centralDirectory.readUInt16LE(at + 30)
    const nameEnd = at + 46 + nameLength
    entries.push({
      name: centralDirectory.toString('utf8', at + 46, nameEnd),
      method: centralDirectory.readUInt16LE(at + 10),
      ...entryPlace(centralDirectory, at, centralDirectory.subarray(nameEnd, nameEnd + extraLength)),
    })
    at = nameEnd + extraLength + centralDirectory.readUInt16LE(at + 32)
  }
  return entries
}

/** An entry's compressed size and local header offset; a size too big for 32 bits is in its zip64 extra field. */
function entryPlace(
  centralDirectory: Buffer,
  at: number,
  extra: Buffer,
): { readonly compressedSize: number; readonly localOffset: number } {
  const uncompressedSize = centralDirectory.readUInt32LE(at + 24)
  const compressedSize = centralDirectory.readUInt32LE(at + 20)
  const localOffset = centralDirectory.readUInt32LE(at + 42)
  if (compressedSize !== ZIP64_MARKER && localOffset !== ZIP64_MARKER) return { compressedSize, localOffset }
  // The field holds, in this order, only the values the entry marked as too big.
  const field = zip64FieldOf(extra)
  let cursor = uncompressedSize === ZIP64_MARKER ? 8 : 0
  const wideCompressedSize = compressedSize === ZIP64_MARKER ? Number(field.readBigUInt64LE(cursor)) : compressedSize
  if (compressedSize === ZIP64_MARKER) cursor += 8
  const wideLocalOffset = localOffset === ZIP64_MARKER ? Number(field.readBigUInt64LE(cursor)) : localOffset
  return { compressedSize: wideCompressedSize, localOffset: wideLocalOffset }
}

function zip64FieldOf(extra: Buffer): Buffer {
  let at = 0
  while (at + 4 <= extra.length) {
    const fieldLength = extra.readUInt16LE(at + 2)
    if (extra.readUInt16LE(at) === ZIP64_EXTRA_FIELD) return extra.subarray(at + 4, at + 4 + fieldLength)
    at += 4 + fieldLength
  }
  throw new Error('a zip64 size without its zip64 field')
}

function streamedEntryData(descriptor: number, entry: CentralDirectoryEntry): Uint8Array {
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`${entry.name}: compression method ${entry.method} is not read`)
  }
  const header = readAt(descriptor, entry.localOffset, LOCAL_HEADER_LENGTH)
  if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error(`no local header for ${entry.name}`)
  const start = entry.localOffset + LOCAL_HEADER_LENGTH + header.readUInt16LE(26) + header.readUInt16LE(28)
  const raw = readAt(descriptor, start, entry.compressedSize)
  return entry.method === STORED ? raw : inflateRawSync(raw)
}

/**
 * A zip's kept entries, decompressed, from the whole file in memory: the read the stream replaced,
 * kept as its fallback, and skipping what the stream skips. Enough of the format to read a Playwright
 * trace (stored and deflated entries, sizes from the central directory). Throws on what it does not
 * read — zip64, an unknown method, a damaged header — so the scan says "unreadable" rather than "clean".
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
    // The same entries the stream skips (`UNREAD_ENTRY`): pixels and fonts hold no text secret, and
    // inflating screencast frames is the cost #741 removed.
    if (name.endsWith('/') || UNREAD_ENTRY.test(name)) continue
    entries.push({ name, data: entryData(bytes, view, { localOffset, compressedSize, method, name }) })
  }
  return entries
}

function endOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of at most 65,535: search back from the end.
  for (
    let at = view.byteLength - END_RECORD_LENGTH;
    at >= Math.max(0, view.byteLength - END_RECORD_LENGTH - LONGEST_COMMENT);
    at -= 1
  ) {
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
    entry.localOffset +
    LOCAL_HEADER_LENGTH +
    view.getUint16(entry.localOffset + 26, true) +
    view.getUint16(entry.localOffset + 28, true)
  const raw = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === STORED) return raw
  if (entry.method === DEFLATED) return inflateRawSync(raw)
  throw new Error(`${entry.name}: compression method ${entry.method} is not read`)
}
