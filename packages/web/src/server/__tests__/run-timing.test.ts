import { expect, test } from 'bun:test'
import { forgetRun, noteRunAdmitted, takeFirstDeltaMs } from '../run-timing.ts'

/**
 * Time to first token, once per run (#144). The clock is per thread AND generation, because
 * that pair is what the record joins on and what a second tab does not share.
 *
 * The ids are namespaced: the map is module state and bun runs every suite in one process, so
 * a bare `t1` here and a `t1` in the observation tests would take each other's entries.
 */

test('⚠ one record per run: the first delta takes the latency, every later delta finds nothing', () => {
  noteRunAdmitted('timing-t1', 1, 1000)
  expect(takeFirstDeltaMs('timing-t1', 1, 2180)).toBe(1180)
  expect(takeFirstDeltaMs('timing-t1', 1, 2200)).toBeUndefined()
})

test('a prompt queued behind a run in flight joins it and does not restart its clock (#75)', () => {
  noteRunAdmitted('timing-t2', 1, 1000)
  noteRunAdmitted('timing-t2', 1, 5000) // the queued prompt's admission, same run
  expect(takeFirstDeltaMs('timing-t2', 1, 6000)).toBe(5000)
})

test("threads and generations are separate runs: one thread's delta never answers for another's", () => {
  noteRunAdmitted('timing-a', 1, 1000)
  noteRunAdmitted('timing-b', 1, 2000)
  noteRunAdmitted('timing-a', 2, 3000)
  expect(takeFirstDeltaMs('timing-b', 1, 2500)).toBe(500)
  expect(takeFirstDeltaMs('timing-a', 2, 3400)).toBe(400)
  expect(takeFirstDeltaMs('timing-a', 1, 4000)).toBe(3000)
})

test('a run that never produced a delta is forgotten when it settles — the map holds live runs only', () => {
  noteRunAdmitted('timing-t3', 7, 1000)
  forgetRun('timing-t3', 7)
  expect(takeFirstDeltaMs('timing-t3', 7, 2000)).toBeUndefined()
})

test('a delta on a run whose admission was never seen — a follow attached mid-run — records nothing', () => {
  expect(takeFirstDeltaMs('never-admitted', 1, 9000)).toBeUndefined()
})
