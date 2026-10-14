import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queuedReviews } from '../review/review-queue.ts'
import { lastToolCall, readableDuration, renderReviewStatus, runFolderOf, workerFrom } from '../review/review-status.ts'

test('a run folder name reads back as its pull request, head and start; anything else is not a run', () => {
  expect(runFolderOf('pr-993-85b034f-1791993464525')).toEqual({
    number: 993,
    shortHead: '85b034f',
    startedAt: 1_791_993_464_525,
  })
  expect(runFolderOf('queue')).toBeUndefined()
  expect(runFolderOf('worker.log')).toBeUndefined()
})

test('durations read as seconds, minutes and seconds, or hours and minutes', () => {
  expect(readableDuration(42_000)).toBe('42s')
  expect(readableDuration(185_000)).toBe('3m 05s')
  expect(readableDuration(4_320_000)).toBe('1h 12m')
  expect(readableDuration(-5)).toBe('0s')
})

test("the last tool call is the decision log's last line: tool, decision, and its command's first line", () => {
  const line = (tool: string, input: object, kind: string): string =>
    JSON.stringify({ tool, input, decision: { kind } })
  const log = [
    line('Read', { file_path: '/t/a.ts' }, 'allow'),
    line('Bash', { command: "gh pr comment 1 --body-file - <<'EOF'\nbody\nEOF" }, 'capture'),
  ].join('\n')
  expect(lastToolCall(`${log}\n`)).toBe("Bash capture gh pr comment 1 --body-file - <<'EOF'")
  expect(lastToolCall('')).toBeUndefined()
})

test('the queue can be read without taking from it', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-status-queue-'))
  writeFileSync(join(queue, '993'), '')
  writeFileSync(join(queue, '970'), '')
  expect(queuedReviews(queue)).toEqual([970, 993])
  expect(queuedReviews(queue)).toEqual([970, 993])
  expect(queuedReviews(join(queue, 'missing'))).toEqual([])
})

test('the status names the worker, the queue, each review in progress, and the recent log', () => {
  const rendered = renderReviewStatus({
    worker: {
      kind: 'running',
      pid: 841_451,
      uptime: '15m 02s',
      checkout: '/repos/zen-harness-foundation (fd277b2 Merge …)',
    },
    queued: [970, 993],
    inProgress: [
      { run: { number: 969, shortHead: 'c9d85de', startedAt: 0 }, elapsed: '2m 10s', lastCall: 'Read allow /t/a.ts' },
    ],
    recent: ['2026-10-14T16:05:00Z #968: reviewed (full); …'],
  })
  expect(rendered).toContain('worker:      running, pid 841451, up 15m 02s, from /repos/zen-harness-foundation')
  expect(rendered).toContain('queue:       #970 #993')
  expect(rendered).toContain('in progress: #969 at c9d85de, 2m 10s so far; last call: Read allow /t/a.ts')
  expect(rendered).toContain('  2026-10-14T16:05:00Z #968: reviewed (full); …')
  const idle = renderReviewStatus({ worker: { kind: 'stale', pid: 7 }, queued: [], inProgress: [], recent: [] })
  expect(idle).toContain('stale lock names pid 7')
  expect(idle).toContain('queue:       empty')
  expect(idle).toContain('in progress: nothing')
})

test('the worker is none without a lock, stale when its pid is gone, and running with an uptime otherwise', () => {
  const now = new Date('2026-10-14T16:30:00Z').getTime()
  expect(workerFrom(undefined, undefined, '', now)).toEqual({ kind: 'none' })
  expect(workerFrom('4242', undefined, '', now)).toEqual({ kind: 'stale', pid: 4242 })
  expect(workerFrom('4242', '', '', now)).toEqual({ kind: 'stale', pid: 4242 })
  expect(workerFrom('4242', '2026-10-14T16:15:00Z', '/repos/x (abc)', now)).toEqual({
    kind: 'running',
    pid: 4242,
    uptime: '15m 00s',
    checkout: '/repos/x (abc)',
  })
})
