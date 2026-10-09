import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { type EnsoDayFold, openDayFold } from '@enso/core'
import { parseEnsoLogLine } from '@enso/core/log-process'

/**
 * A day file's fold, kept and extended from the byte offset it reached (#739). The day's stats
 * and a thread's stats both re-folded the whole file per request: 1.3 s and +443 MB on a 52 MB
 * day, and with the drawer open that was every turn. Now a request reads only the bytes appended
 * since the last one; a day that no longer grows costs one `fstat`.
 *
 * ⚠ ONLY COMPLETE LINES are folded: a writer caught mid-record leaves a last line without its
 * newline, which waits in the file for the next read instead of counting as malformed now and
 * then as a record twice. The offset is the byte after the last newline folded.
 *
 * ⚠ A FILE THAT IS NO LONGER THE ONE FOLDED is folded again from byte 0: another file at the path
 * (its device and inode changed — a rotation, a prune then a new write) or the same file shorter
 * than the offset (truncated). A file gone is an empty day, as the whole-file reader answered.
 * What none of the three can see — a file rewritten in place to at least its old length — is not
 * how the day files are written: they are only appended to.
 */

/**
 * How much of the file one read holds. The first fold of a 52 MB day never has it whole in memory,
 * only a chunk and the records' fold.
 */
const CHUNK_BYTES = 1024 * 1024

const NEWLINE = 0x0a

/**
 * Each complete line of `descriptor` between `from` and `to`, in order, to `line`; the offset after
 * the last newline read, so a trailing partial line is read again next time.
 */
function readCompleteLines(descriptor: number, from: number, to: number, line: (raw: string) => void): number {
  let position = from
  let consumed = from
  let pending = Buffer.alloc(0)
  while (position < to) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, to - position))
    const read = readSync(descriptor, chunk, 0, chunk.length, position)
    if (read === 0) break
    position += read
    // The bytes after the last newline belong to the next chunk's first line.
    const bytes = pending.length === 0 ? chunk.subarray(0, read) : Buffer.concat([pending, chunk.subarray(0, read)])
    const lastNewline = bytes.lastIndexOf(NEWLINE)
    if (lastNewline === -1) {
      pending = bytes
      continue
    }
    // Decoded only up to a newline: a multi-byte character split by the chunk stays in `pending`.
    for (const raw of bytes.toString('utf8', 0, lastNewline).split('\n')) if (raw.length > 0) line(raw)
    pending = Buffer.from(bytes.subarray(lastNewline + 1))
    consumed = position - pending.length
  }
  return consumed
}

/** The open file, or nothing when the path names none. Any other failure throws. */
function openOrNothing(file: string): number | undefined {
  try {
    return openSync(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * `file`, the day file of `day`, folded so far: each call folds the complete lines appended since
 * the last and answers the fold (see the header for when it starts over). Given `threadId`, only
 * that thread's records are folded — the raw id test first, so most lines are never parsed, then
 * the record's own `threadId`, as `threadLines` reads one thread.
 */
export function followDayFile(file: string, day: string, threadId?: string): () => EnsoDayFold {
  let fold = openDayFold(day)
  /** Which file `offset` is into: `device:inode`, or nothing before the first read. */
  let identity: string | undefined
  let offset = 0
  const startOver = (current: string | undefined): void => {
    fold = openDayFold(day)
    identity = current
    offset = 0
  }
  const take = (raw: string): void => {
    // ⚠ Thread-scoped, a line is tested for the id's TEXT before it is parsed, as `threadLines`
    // always has (most lines are never parsed). So a malformed line counts toward a thread's
    // `malformed` only if it carries the id: one too broken to name its thread is the day's alone.
    if (threadId !== undefined && !raw.includes(threadId)) return
    const parsed = parseEnsoLogLine(raw)
    if (typeof parsed === 'string') fold.addMalformed()
    else if (threadId === undefined || parsed.properties?.threadId === threadId) fold.add(parsed)
  }
  return (): EnsoDayFold => {
    const descriptor = openOrNothing(file)
    if (descriptor === undefined) {
      if (identity !== undefined) startOver(undefined)
      return fold
    }
    try {
      const { dev: device, ino: inode, size } = fstatSync(descriptor)
      const current = `${device}:${inode}`
      if (current !== identity || size < offset) startOver(current)
      offset = readCompleteLines(descriptor, offset, size, take)
    } finally {
      closeSync(descriptor)
    }
    return fold
  }
}
