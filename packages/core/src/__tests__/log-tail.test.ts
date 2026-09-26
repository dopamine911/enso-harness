import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensoLogFilename, logChunkDecoder, openLogTail } from '../log-process.ts'
import {
  ENSO_LOG_LEVEL_RANK,
  type EnsoLogFilter,
  logLineMatches,
  logLineMessageParts,
  logLineText,
  parseLogSince,
} from '../log-tail.ts'
import type { EnsoLogLine } from '../log.ts'

/**
 * The reader's question and the tail's answer (#144 slice 2): what a filter admits, and what
 * a poll over a growing, rotating file hands back.
 */

const EVERYTHING: EnsoLogFilter = { levelRank: 0, thread: undefined, process: undefined, notBefore: 0 }

function line(overrides: Partial<EnsoLogLine> = {}): EnsoLogLine {
  return {
    '@timestamp': '2026-09-22T10:00:00.000Z',
    level: 'INFO',
    message: 'run {generation} acquired',
    logger: 'enso.server.threads',
    properties: { generation: 1, threadId: '6923e620-856a-4f1e-9d33-000000000001', process: 'server' },
    ...overrides,
  }
}

test('the level is a FLOOR, the thread a PREFIX, the process EXACT, and --since an instant', () => {
  expect(logLineMatches({ ...EVERYTHING, levelRank: ENSO_LOG_LEVEL_RANK.warning ?? 3 }, line())).toBe(false)
  expect(logLineMatches({ ...EVERYTHING, levelRank: ENSO_LOG_LEVEL_RANK.info ?? 2 }, line({ level: 'ERROR' }))).toBe(
    true,
  )
  expect(logLineMatches({ ...EVERYTHING, thread: '6923e6' }, line())).toBe(true)
  expect(logLineMatches({ ...EVERYTHING, thread: '856a' }, line())).toBe(false)
  expect(logLineMatches({ ...EVERYTHING, process: 'server' }, line())).toBe(true)
  expect(logLineMatches({ ...EVERYTHING, process: 'serv' }, line())).toBe(false)
  const stamped = Date.parse('2026-09-22T10:00:00.000Z')
  expect(logLineMatches({ ...EVERYTHING, notBefore: stamped }, line())).toBe(true)
  expect(logLineMatches({ ...EVERYTHING, notBefore: stamped + 1 }, line())).toBe(false)
})

// ⚠ A record whose clock is unreadable is exactly the record worth seeing, and `--since`
// silently dropping it would be a filter deciding a malformed line is uninteresting.
test('⚠ a line with an unparseable timestamp survives a --since floor', () => {
  expect(logLineMatches({ ...EVERYTHING, notBefore: Date.now() }, line({ '@timestamp': 'whenever' }))).toBe(true)
})

test('--since grammar: the four units, and a refusal that is not a default', () => {
  expect(parseLogSince('30s')).toBe(30_000)
  expect(parseLogSince('10m')).toBe(600_000)
  expect(parseLogSince('2h')).toBe(7_200_000)
  expect(parseLogSince('1d')).toBe(86_400_000)
  expect(parseLogSince('10')).toBeUndefined()
  expect(parseLogSince('10w')).toBeUndefined()
  expect(parseLogSince('')).toBeUndefined()
})

test('the message is the template with its values in place; a placeholder with no property stays itself', () => {
  expect(logLineMessageParts(line())).toEqual(['run ', 1, ' acquired'])
  expect(logLineText(line({ message: 'run {generation} of {absent}' }))).toBe('run 1 of {absent}')
  expect(logLineText(line({ message: 'tool {call}', properties: { call: { name: 'bash' } } }))).toBe(
    'tool {"name":"bash"}',
  )
})

/**
 * `--follow` and the tail route both read a growing file by byte range, so a poll can cut
 * anything in half. Both halves are silent when they go wrong: a split character became
 * `U+FFFD` in the printed record (reproduced live with a 🚀 straddling a poll), and a split
 * line would print a fragment as an unparseable record.
 */
test('⚠ a character and a line split across polls each survive the boundary', () => {
  const decoder = logChunkDecoder()
  const rocket = Buffer.from('🚀', 'utf8')
  expect(rocket.length).toBe(4)

  // A character cut in half: nothing is printable yet, and no replacement char is invented.
  expect(decoder.decode(Buffer.concat([Buffer.from('launch '), rocket.subarray(0, 2)]))).toBe('')
  // The rest of the character arrives with the rest of the line.
  expect(decoder.decode(Buffer.concat([rocket.subarray(2), Buffer.from(' done\ntail')]))).toBe('launch 🚀 done')
  // …and the fragment after the last newline waits rather than printing half a record.
  expect(decoder.decode(Buffer.from(' end\n'))).toBe('tail end')
  // …and the decoder says how many bytes it is holding, so a reader can name the resume point.
  expect(decoder.carried()).toBe(0)
  decoder.decode(Buffer.from('half a rec'))
  expect(decoder.carried()).toBe('half a rec'.length)
})

// ⚠ THE RESUME TOKEN (PR #336 review). A poll can end mid-record; the tail keeps the fragment
// and the next poll completes it. But the OFFSET it publishes is what a reconnecting page hands
// back as `?from=`, and a new tail has no fragment: an offset past the last newline puts it
// mid-record, the record's tail parses as malformed, and the record is gone.
test('⚠ a step that ended mid-record publishes the offset of the last complete line, so a resume loses nothing', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-resume-'))
  const file = join(logsDir, ensoLogFilename(DAY))
  const whole = JSON.stringify(line({ message: 'complete' }))
  const split = JSON.stringify(line({ message: 'split across polls' }))
  writeFileSync(file, `${whole}\n${split.slice(0, 20)}`)
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY })
  const first = step()
  expect(first.lines.map((record) => record.message)).toEqual(['complete'])
  expect(first.malformed).toBe(0)
  expect(first.offset).toBe(Buffer.byteLength(`${whole}\n`))

  writeFileSync(file, `${split.slice(20)}\n`, { flag: 'a' })
  // The same tail completes the record from its carry…
  expect(step().lines.map((record) => record.message)).toEqual(['split across polls'])
  close()
  // …and a NEW tail resumed at the published offset reads the whole record, not its tail.
  const resumed = openLogTail({
    logsDir,
    filter: EVERYTHING,
    from: { offset: first.offset, day: first.day },
    now: () => DAY,
  }).step()
  expect(resumed.malformed).toBe(0)
  expect(resumed.lines.map((record) => record.message)).toEqual(['split across polls'])
  rmSync(logsDir, { recursive: true })
})

// ⚠ THE DAY THE OFFSET BELONGS TO (PR #336 review, rounds two and three). The route validates
// the resume day against one `now()`; the tail picks its file with another. A midnight between
// the two must not apply yesterday's byte to today's file — and nothing exercised that path,
// so an unconditional `offset = from.offset` passed every test.
test('⚠ a resume offset for another day than the file the first step resolves is dropped, not applied', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-stale-day-'))
  append(logsDir, DAY, line({ message: 'yesterday' }))
  append(logsDir, NEXT_DAY, line({ message: 'today, first' }), line({ message: 'today, second' }))
  const yesterday = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY }).step()
  // Validated against DAY, opened after the clock has crossed into NEXT_DAY.
  let today = DAY
  const { step, close } = openLogTail({
    logsDir,
    filter: EVERYTHING,
    from: { offset: yesterday.offset, day: yesterday.day },
    now: () => today,
  })
  today = NEXT_DAY
  const first = step()
  expect(first.type).toBe('backlog')
  expect(first.day).toBe('2026-09-23')
  expect(first.lines.map((record) => record.message)).toEqual(['today, first', 'today, second'])
  close()
  rmSync(logsDir, { recursive: true })
})

// ⚠ `stat` is by path and `read` is by descriptor (PR #336 review). Unlink-and-recreate under
// the same name — a rotation, an editor's save-by-rename — gives a new inode; once the new file
// grew past the old offset, `size < offset` never fired and the old inode answered zero bytes
// forever. The inode is the tell.
test('⚠ a file replaced under the same name by a LONGER one restarts the tail instead of wedging it', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-replaced-'))
  const file = join(logsDir, ensoLogFilename(DAY))
  writeFileSync(file, `${JSON.stringify(line({ message: 'old' }))}\n`)
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY })
  expect(step().lines.map((record) => record.message)).toEqual(['old'])

  rmSync(file)
  writeFileSync(
    file,
    [1, 2, 3]
      .map((ordinal) => JSON.stringify(line({ message: `new ${ordinal}, and longer than before` })))
      .join('\n')
      .concat('\n'),
  )
  const replaced = step()
  expect(replaced.type).toBe('backlog')
  expect(replaced.lines.map((record) => record.message)).toHaveLength(3)
  close()
  rmSync(logsDir, { recursive: true })
})

// The removal branch dropped the offset but kept the carry: a partial line read just before
// the file vanished was prepended to the next file's first record (PR #336 review).
test('a file removed with a partial line in hand does not prepend that fragment to the next file', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-removed-'))
  const file = join(logsDir, ensoLogFilename(DAY))
  writeFileSync(file, `${JSON.stringify(line({ message: 'gone' }))}\n{"half":`)
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY })
  step()
  rmSync(file)
  expect(step()).toMatchObject({ type: 'backlog', lines: [], offset: 0 })
  writeFileSync(file, `${JSON.stringify(line({ message: 'fresh' }))}\n`)
  const fresh = step()
  expect(fresh.malformed).toBe(0)
  expect(fresh.lines.map((record) => record.message)).toEqual(['fresh'])
  close()
  rmSync(logsDir, { recursive: true })
})

// ── the tail over the day's file ──────────────────────────────────────────────────────────

const DAY = new Date('2026-09-22T10:00:00')
const NEXT_DAY = new Date('2026-09-23T00:00:30')

function append(logsDir: string, date: Date, ...records: EnsoLogLine[]): void {
  const file = join(logsDir, ensoLogFilename(date))
  const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  writeFileSync(file, text, { flag: 'a' })
}

test('the first step is the day so far, the next carries only what landed after it', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-'))
  append(logsDir, DAY, line({ message: 'first' }), line({ message: 'second' }))
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY })

  const backlog = step()
  expect(backlog.type).toBe('backlog')
  expect(backlog.day).toBe('2026-09-22')
  expect(backlog.lines.map((record) => record.message)).toEqual(['first', 'second'])
  expect(backlog.offset).toBeGreaterThan(0)

  // Nothing new: an append step with no lines, and the offset where it left off.
  const idle = step()
  expect(idle.type).toBe('records')
  expect(idle.lines).toEqual([])
  expect(idle.offset).toBe(backlog.offset)

  append(logsDir, DAY, line({ message: 'third' }))
  const appended = step()
  expect(appended.type).toBe('records')
  expect(appended.lines.map((record) => record.message)).toEqual(['third'])
  close()
  rmSync(logsDir, { recursive: true })
})

// ⚠ THE RULE THE TYPE RESTS ON: a step that began at byte 0 is the file's whole view. `from`
// is how a reconnecting client says "I already have the day", and it must NOT come back as a
// backlog the client would render a second time.
test('⚠ a step resumed at an offset is an append, not a second copy of the day', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-from-'))
  append(logsDir, DAY, line({ message: 'already seen' }))
  const seen = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY }).step()
  append(logsDir, DAY, line({ message: 'new' }))

  const resumed = openLogTail({
    logsDir,
    filter: EVERYTHING,
    from: { offset: seen.offset, day: seen.day },
    now: () => DAY,
  }).step()
  expect(resumed.type).toBe('records')
  expect(resumed.lines.map((record) => record.message)).toEqual(['new'])
  rmSync(logsDir, { recursive: true })
})

// ⚠ The CLI never had this: `--follow` polls ONE filename for the life of the process, so a
// terminal left open across local midnight silently stops. A browser tab is left open for
// days, so the tail follows the rotation onto the new day's file and says so with a fresh
// backlog rather than going quiet.
test('⚠ local midnight rotates the tail onto the new day, as a backlog', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-midnight-'))
  append(logsDir, DAY, line({ message: 'yesterday' }))
  let today = DAY
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => today })
  expect(step().lines.map((record) => record.message)).toEqual(['yesterday'])

  today = NEXT_DAY
  append(logsDir, NEXT_DAY, line({ message: 'today' }))
  const rotated = step()
  expect(rotated.type).toBe('backlog')
  expect(rotated.day).toBe('2026-09-23')
  expect(rotated.lines.map((record) => record.message)).toEqual(['today'])
  close()
  rmSync(logsDir, { recursive: true })
})

test('a file truncated under the tail is re-read from its head instead of read past its end', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-truncated-'))
  append(logsDir, DAY, line({ message: 'before' }), line({ message: 'and more' }))
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY })
  expect(step().lines).toHaveLength(2)

  writeFileSync(join(logsDir, ensoLogFilename(DAY)), `${JSON.stringify(line({ message: 'after' }))}\n`)
  const restarted = step()
  expect(restarted.type).toBe('backlog')
  expect(restarted.lines.map((record) => record.message)).toEqual(['after'])
  close()
  rmSync(logsDir, { recursive: true })
})

test('no file yet is an empty backlog, and the tail picks the day up when a process writes it', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-absent-'))
  const { step, close } = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY })
  expect(step()).toMatchObject({ type: 'backlog', day: '2026-09-22', lines: [], matched: 0, offset: 0 })

  append(logsDir, DAY, line({ message: 'the first process of the day' }))
  expect(step().lines.map((record) => record.message)).toEqual(['the first process of the day'])
  close()
  rmSync(logsDir, { recursive: true })
})

// ⚠ The cap is the bundle's honesty in a different place: `matched` is what answered the
// filter, `lines` is what fits. Without the pair, "the last 2 of 5" reads as the whole day.
test('⚠ the cap keeps the NEWEST records and says how many matched before it', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-cap-'))
  append(logsDir, DAY, ...[1, 2, 3, 4, 5].map((ordinal) => line({ message: `record ${ordinal}` })))
  const capped = openLogTail({ logsDir, filter: EVERYTHING, maxRecords: 2, now: () => DAY }).step()
  expect(capped.matched).toBe(5)
  expect(capped.lines.map((record) => record.message)).toEqual(['record 4', 'record 5'])
  rmSync(logsDir, { recursive: true })
})

test('a line that is not a record is counted, never parsed into the stream', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-malformed-'))
  writeFileSync(
    join(logsDir, ensoLogFilename(DAY)),
    `not json\n${JSON.stringify({ '@timestamp': 'x', level: 'NOPE' })}\n${JSON.stringify(line())}\n`,
  )
  const found = openLogTail({ logsDir, filter: EVERYTHING, now: () => DAY }).step()
  expect(found.malformed).toBe(2)
  expect(found.lines).toHaveLength(1)
  rmSync(logsDir, { recursive: true })
})

test('the filter runs server-side: a step carries only the thread and tier that were asked for', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-filter-'))
  append(
    logsDir,
    DAY,
    line({ message: 'wanted' }),
    line({ message: 'other thread', properties: { threadId: 'aaaaaaaa-0000-4000-8000-000000000002' } }),
    line({ message: 'too quiet', level: 'DEBUG' }),
  )
  const found = openLogTail({
    logsDir,
    filter: { levelRank: 2, thread: '6923e6', process: undefined, notBefore: 0 },
    now: () => DAY,
  }).step()
  expect(found.lines.map((record) => record.message)).toEqual(['wanted'])
  expect(found.matched).toBe(1)
  rmSync(logsDir, { recursive: true })
})
