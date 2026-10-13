import type { Stats } from 'node:fs'
import { type FileHandle, open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { EnsoRecordedModel } from '@enso/core'
import { modelOfEntry } from './transcript.ts'

/**
 * pi's session files, found and summarized without parsing every file per question (#739).
 *
 * pi's session listing (`listAll`) streams and `JSON.parse`s every line of every file and joins every
 * message's text, on every call; the host's `locate` then kept one entry. At 200 threads of 0.9 MB
 * that was 590–650 ms and ~0.8 s CPU per lookup, paid by every cold read, every `createSession` and
 * the rail's listing after every settled run. Here:
 *
 *   - a lookup by id reads the directory listing — pi names a file `<timestamp>_<id>.jsonl` — and
 *     then only the HEADER of the file named for the id, to confirm it;
 *   - the listing summarizes each file once per change of it (inode, size and modification time),
 *     so a listing after a run re-reads the one file the run appended to.
 *
 * ⚠ The summary is pi's `buildSessionInfo`, kept field for field (`modified` is the last user or
 * assistant message's time, `firstMessage` the first user text, `name` the newest `session_info`):
 * the rail's order and titles must not move because the reader changed.
 */

/** What a session file's header says: enough to find a thread, where it runs and what it was forked from. */
export interface SessionFileHeader {
  readonly path: string
  /** The FILE's modification time (ms): what orders two files under one id (#739); not pi's `modified`. */
  readonly fileModifiedMs: number
  /** pi's session id: the thread id. */
  readonly id: string
  /** The directory the session runs in; empty when the header names none, as pi reads it. */
  readonly cwd: string
  /** The header's `timestamp`: when the session (or the fork) was made. */
  readonly created: Date
  /** The parent session FILE a fork's header names (#433); undefined for no fork. */
  readonly parentSessionPath: string | undefined
}

/** A model a session records it ran on: a `model_change`'s, or an assistant reply's own. */
type RecordedModel = NonNullable<EnsoRecordedModel['model']>

/** One session file as the rail lists it: its header, its messages counted, its title and name. */
export interface SessionFileSummary extends SessionFileHeader {
  /** pi's `modified`: the last user or assistant message's time, else the header's, else the file's. */
  readonly modified: Date
  readonly messageCount: number
  /** The first user message's text; empty when there is none. */
  readonly firstMessage: string
  /** The newest `session_info` name, trimmed; undefined when none, or the newest is blank. */
  readonly name: string | undefined
  /**
   * The model the session last ran on (#871), as a cold read's recorded model says it (#434): the last
   * entry that records one (`transcript.ts` `modelOfEntry`) on the path from the leaf — pi's leaf on
   * opening, the file's last entry — to the root, so a change on an abandoned branch is not it.
   * Enso's own field, not one of pi's; undefined when the path records none.
   */
  readonly model: RecordedModel | undefined
}

/** The session files of one host, each read once per change of it (#739). */
export interface SessionFiles {
  /** The file's header, or undefined when it is gone, not a regular file, or no pi session. */
  header(path: string): Promise<SessionFileHeader | undefined>
  /** The file read whole, once per change; undefined as for {@link SessionFiles.header}. */
  summary(path: string): Promise<SessionFileSummary | undefined>
  /** Forget every file not in `present`: what a full listing calls, so deleted files are not held. */
  retainOnly(present: ReadonlySet<string>): void
}

/** pi's bound on a header line (`MAX_SESSION_HEADER_SCAN_BYTES`): past it, the file is no session. */
const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024
const HEADER_CHUNK_BYTES = 4096
const SESSION_FILE_SUFFIX = '.jsonl'

/**
 * The thread id a session file's NAME carries: pi names it `<timestamp>_<id>.jsonl`, and its
 * timestamp (`2026-10-07T18-06-01-633Z`) holds no `_`. Undefined for a name of another shape —
 * such a file is a candidate for every id, and its header decides.
 *
 * ⚠ A hint, never the answer: the header is read to confirm it. A file renamed by hand to another
 * id's name is found by neither id; pi never writes one.
 */
export function threadIdOfFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(SESSION_FILE_SUFFIX)) return undefined
  const separator = fileName.indexOf('_')
  return separator === -1 ? undefined : fileName.slice(separator + 1, -SESSION_FILE_SUFFIX.length)
}

/** The `.jsonl` files of a directory, as paths; none when it cannot be read — pi's listing is as forgiving. */
export async function sessionFilesIn(directory: string): Promise<string[]> {
  try {
    const fileNames = await readdir(directory)
    return fileNames
      .filter((fileName) => fileName.endsWith(SESSION_FILE_SUFFIX))
      .map((fileName) => join(directory, fileName))
  } catch {
    return []
  }
}

/**
 * pi's own default session directories: each folder under `<agent dir>/sessions`, where pi files a
 * session by its cwd. ⚠ The caller passes pi's agent dir AS IT IS NOW (`getAgentDir()`, from the env
 * the host pins), read at each call as `listAll` read it — never one captured at host creation.
 */
export async function piSessionDirectories(agentDirectory: string): Promise<string[]> {
  const root = join(agentDirectory, 'sessions')
  try {
    const children = await readdir(root, { withFileTypes: true })
    return children
      .filter((child) => child.isDirectory() || child.isSymbolicLink())
      .map((child) => join(root, child.name))
  } catch {
    return []
  }
}

/** What is known of one file at one state of it: each read once, shared by concurrent callers. */
interface KnownFile {
  readonly stamp: string
  header?: Promise<SessionFileHeader | undefined>
  summary?: Promise<SessionFileSummary | undefined>
}

export function createSessionFiles(): SessionFiles {
  const known = new Map<string, KnownFile>()

  /** The file's record at its current state; a fresh one when it changed. Undefined when it is no regular file. */
  async function knownFile(path: string): Promise<{ record: KnownFile; stats: Stats } | undefined> {
    const stats = await stat(path).catch(() => undefined)
    // ⚠ A regular file only: a FIFO named like a session would block its reader for good.
    if (stats === undefined || !stats.isFile()) {
      known.delete(path)
      return undefined
    }
    const stamp = `${stats.ino}:${stats.size}:${stats.mtimeMs}`
    const current = known.get(path)
    if (current?.stamp === stamp) return { record: current, stats }
    const record: KnownFile = { stamp }
    known.set(path, record)
    return { record, stats }
  }

  /** `read`'s answer, cached on the record; a read that FAILED is not cached, so it is tried again next time. */
  function settled<T>(path: string, record: KnownFile, read: Promise<T | undefined>): Promise<T | undefined> {
    return read.catch(() => {
      if (known.get(path) === record) known.delete(path)
      return undefined
    })
  }

  return {
    async header(path) {
      const found = await knownFile(path)
      if (found === undefined) return undefined
      const { record, stats } = found
      record.header ??= settled(path, record, readHeader(path, stats.mtimeMs))
      return record.header
    },
    async summary(path) {
      const found = await knownFile(path)
      if (found === undefined) return undefined
      const { record, stats } = found
      record.summary ??= settled(path, record, readSummary(path, stats))
      // The summary holds the header: a lookup after a listing reads nothing.
      record.header ??= record.summary
      return record.summary
    },
    retainOnly(present) {
      for (const path of known.keys()) if (!present.has(path)) known.delete(path)
    },
  }
}

/**
 * The fields of one pi session line the header and the summary read — pi's persisted entry shapes
 * (`session`, `session_info`, `message`), each field checked where it is read: a file is anyone's to
 * have edited.
 */
interface SessionLine {
  readonly type?: unknown
  readonly id?: unknown
  readonly parentId?: unknown
  readonly cwd?: unknown
  readonly timestamp?: unknown
  readonly parentSession?: unknown
  readonly name?: unknown
  readonly message?: unknown
}

/** The header facts of `line` when it is pi's session header (`type: 'session'`, a string id). */
function headerFacts(line: SessionLine, path: string, fileModifiedMs: number): SessionFileHeader | undefined {
  if (line.type !== 'session' || typeof line.id !== 'string') return undefined
  return {
    path,
    fileModifiedMs,
    id: line.id,
    cwd: typeof line.cwd === 'string' ? line.cwd : '',
    created: new Date(String(line.timestamp)),
    parentSessionPath: typeof line.parentSession === 'string' ? line.parentSession : undefined,
  }
}

/**
 * A line parsed, or undefined for a blank or malformed one — both skipped, as pi skips them, and for
 * a falsy JSON value, which pi skips too. A line of any other non-object JSON is an entry of no type.
 */
function parsedLine(line: string): SessionLine | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!parsed) return undefined
  return typeof parsed === 'object' ? parsed : {}
}

/**
 * The first entry of `buffered`, or `'incomplete'` when no whole line parsed yet. At the end of the
 * file (`atEnd`) the unterminated rest is a line too. pi's discovery rule: blank and malformed
 * lines before the header are skipped, and the first entry that parses is the header or nothing.
 */
function firstEntryOf(buffered: string, atEnd: boolean): SessionLine | 'incomplete' | undefined {
  let lineStart = 0
  for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n', lineStart)) {
    const parsed = parsedLine(buffered.slice(lineStart, newline))
    if (parsed !== undefined) return parsed
    lineStart = newline + 1
  }
  if (!atEnd) return 'incomplete'
  return parsedLine(buffered.slice(lineStart))
}

/** The header of the file at `path`, reading from its start only as far as the header line ends. */
async function readHeader(path: string, fileModifiedMs: number): Promise<SessionFileHeader | undefined> {
  const handle = await open(path, 'r')
  try {
    const first = await firstEntryRead(handle)
    return first === undefined ? undefined : headerFacts(first, path, fileModifiedMs)
  } finally {
    await handle.close()
  }
}

/** The file's first entry, read a chunk at a time up to pi's bound; undefined past it, or for none. */
async function firstEntryRead(handle: FileHandle): Promise<SessionLine | undefined> {
  const decoder = new StringDecoder('utf8')
  const chunk = Buffer.allocUnsafe(HEADER_CHUNK_BYTES)
  let buffered = ''
  for (let scanned = 0; scanned < HEADER_SCAN_LIMIT_BYTES;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, scanned)
    if (bytesRead === 0) {
      const last = firstEntryOf(buffered + decoder.end(), true)
      return last === 'incomplete' ? undefined : last
    }
    scanned += bytesRead
    buffered += decoder.write(chunk.subarray(0, bytesRead))
    const first = firstEntryOf(buffered, false)
    if (first !== 'incomplete') return first
  }
  return undefined
}

/** The running counts of a summary, as pi's `buildSessionInfo` keeps them. */
interface Tally {
  messageCount: number
  firstMessage: string
  name: string | undefined
  lastActivity: number | undefined
  /** The leaf's: pi's leaf on opening a file is its last entry, so the last entry's model so far. */
  model: RecordedModel | undefined
  /** Each entry's model on the path to it — its own, else its parent's — by entry id (#871). */
  readonly modelAt: Map<string, RecordedModel | undefined>
}

/** The file read whole and summarized; undefined when its first entry is no session header. */
async function readSummary(path: string, stats: Stats): Promise<SessionFileSummary | undefined> {
  const contents = await readFile(path, 'utf8')
  let header: SessionFileHeader | undefined
  const tally: Tally = {
    messageCount: 0,
    firstMessage: '',
    name: undefined,
    lastActivity: undefined,
    model: undefined,
    modelAt: new Map(),
  }
  for (const parsed of parsedLines(contents)) {
    if (header !== undefined) {
      tallyEntry(tally, parsed)
      continue
    }
    header = headerFacts(parsed, path, stats.mtimeMs)
    if (header === undefined) return undefined
  }
  if (header === undefined) return undefined
  return {
    ...header,
    modified: modifiedOf(tally.lastActivity, header.created, stats.mtime),
    messageCount: tally.messageCount,
    firstMessage: tally.firstMessage,
    name: tally.name,
    model: tally.model,
  }
}

/** pi's `modified`: the last message's time when there is one, else the header's, else the file's. */
function modifiedOf(lastActivity: number | undefined, created: Date, fileModified: Date): Date {
  if (lastActivity !== undefined && lastActivity > 0) return new Date(lastActivity)
  return Number.isNaN(created.getTime()) ? fileModified : created
}

/** Every line of `contents` that parses, in order — one at a time, never all of them held. */
function* parsedLines(contents: string): Generator<SessionLine> {
  let lineStart = 0
  while (lineStart < contents.length) {
    const newline = contents.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? contents.length : newline
    const parsed = parsedLine(contents.slice(lineStart, lineEnd))
    if (parsed !== undefined) yield parsed
    lineStart = lineEnd + 1
  }
}

/** A message's fields the summary reads. */
interface SessionLineMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly timestamp?: unknown
}

/**
 * The model on the path to this entry (#871): its own, else its parent's — so the last entry's is the
 * leaf's, walked as `recordedModelOf` walks a branch, in one pass over the file. An entry with no
 * `parentId` at all (a file from before pi's tree, which pi links in file order when it opens it)
 * follows the entry before it; `null` is a root, with nothing before it.
 */
function tallyModel(tally: Tally, line: SessionLine): void {
  let inherited: RecordedModel | undefined
  if (typeof line.parentId === 'string') inherited = tally.modelAt.get(line.parentId)
  else if (line.parentId === undefined) inherited = tally.model
  const model = modelOfEntry(line) ?? inherited
  if (typeof line.id === 'string') tally.modelAt.set(line.id, model)
  tally.model = model
}

/** One entry after the header counted into `tally`, as pi's `buildSessionInfo` counts it. */
function tallyEntry(tally: Tally, line: SessionLine): void {
  // The newest `session_info` names the session; a blank one clears the name (pi's own reading).
  if (line.type === 'session_info')
    tally.name = typeof line.name === 'string' ? line.name.trim() || undefined : undefined
  tallyModel(tally, line)
  if (line.type !== 'message') return
  tally.messageCount += 1
  if (typeof line.message !== 'object' || line.message === null || !('content' in line.message)) return
  const message = line.message as SessionLineMessage
  if (message.role !== 'user' && message.role !== 'assistant') return
  const activity = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(String(line.timestamp))
  if (!Number.isNaN(activity)) tally.lastActivity = Math.max(tally.lastActivity ?? 0, activity)
  if (tally.firstMessage === '' && message.role === 'user') tally.firstMessage = textOf(message.content)
}

/** A message's text as pi's listing reads it: a string, or its text parts joined by a space. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content as ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown } | null>
  return parts.flatMap((part) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join(' ')
}
