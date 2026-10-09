import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_LOG_EVENTS } from '@enso/core'
import { followDayFile } from '../day-file-fold.ts'

/**
 * #739: a day file folded from the offset it reached — appended records join the kept fold, a
 * writer's half-written last line waits for its newline, and a file that is no longer the one
 * folded (truncated, rotated, gone) is folded again from its start.
 */

const DAY = '2026-09-22'

const acquired = (threadId: string, generation: number): string =>
  `${JSON.stringify({
    '@timestamp': '2026-09-22T10:00:00.000Z',
    level: 'INFO',
    message: ENSO_LOG_EVENTS.runAcquired,
    logger: 'enso.server.registry',
    properties: { process: 'server', threadId, generation },
  })}\n`

function dayFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'enso-day-fold-')), `enso-${DAY}.jsonl`)
}

test('appended records join the next fold; a half-written last line waits for its newline', () => {
  const file = dayFile()
  writeFileSync(file, acquired('t', 1))
  const fold = followDayFile(file, DAY)
  expect(fold().stats()).toMatchObject({ records: 1, malformed: 0, totals: { runs: 1 } })

  const next = acquired('t', 2)
  appendFileSync(file, `not json\n${next.slice(0, 20)}`)
  // The partial record is neither malformed nor a record yet.
  expect(fold().stats()).toMatchObject({ records: 1, malformed: 1, totals: { runs: 1 } })
  appendFileSync(file, next.slice(20))
  expect(fold().stats()).toMatchObject({ records: 2, malformed: 1, totals: { runs: 2 } })
  // Nothing appended: the same answer, nothing folded twice.
  expect(fold().stats()).toMatchObject({ records: 2, malformed: 1, totals: { runs: 2 } })
})

test('a truncated, a rotated and a deleted file are each folded again from the start', () => {
  const file = dayFile()
  writeFileSync(file, acquired('t', 1) + acquired('t', 2))
  const fold = followDayFile(file, DAY)
  expect(fold().stats()).toMatchObject({ records: 2, totals: { runs: 2 } })

  truncateSync(file, 0)
  appendFileSync(file, acquired('t', 3))
  expect(fold().stats()).toMatchObject({ records: 1, totals: { runs: 1 } })

  // Another file renamed into place, longer than the offset reached: a new inode, not an append.
  const rotated = `${file}.next`
  writeFileSync(rotated, acquired('u', 1) + acquired('u', 2) + acquired('u', 3))
  renameSync(rotated, file)
  const after = fold().stats()
  expect(after).toMatchObject({ records: 3, totals: { runs: 3 } })
  expect(after.threads.map((thread) => thread.threadId)).toEqual(['u'])

  rmSync(file)
  expect(fold().stats()).toMatchObject({ records: 0, totals: { runs: 0 } })
})

test("given a thread, only that thread's records are folded, as they are appended", () => {
  const file = dayFile()
  writeFileSync(file, acquired('t', 1) + acquired('other', 1))
  const fold = followDayFile(file, DAY, 't')
  expect(fold().stats()).toMatchObject({ records: 1, totals: { runs: 1 } })
  appendFileSync(file, acquired('other', 2) + acquired('t', 2))
  expect(
    fold()
      .stats()
      .runs.map((run) => [run.threadId, run.generation]),
  ).toEqual([
    ['t', 1],
    ['t', 2],
  ])
})

test('a day larger than one read folds every record, whichever byte a read ends on', () => {
  const file = dayFile()
  // Multi-byte ids, so some read ends inside a character as well as inside a line.
  const records = Array.from({ length: 12_000 }, (_, generation) => acquired('thread-é-ü-🙂', generation)).join('')
  writeFileSync(file, records)
  expect(Buffer.byteLength(records)).toBeGreaterThan(2 * 1024 * 1024)
  expect(followDayFile(file, DAY)().stats()).toMatchObject({ records: 12_000, malformed: 0, totals: { runs: 12_000 } })
})
