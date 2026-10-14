import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunFolder, runFolderName, runFolderOf } from '../review/review-paths.ts'
import { queuedReviews } from '../review/review-queue.ts'
import { lastToolCall, readableDuration, renderReviewStatus, workerFrom } from '../review/review-status.ts'

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
      startedAt: 0,
    },
    queued: [970, 993],
    inProgress: [
      { run: { number: 969, shortHead: 'c9d85de', startedAt: 0 }, elapsed: '2m 10s', lastCall: 'Read allow /t/a.ts' },
    ],
    recent: ['2026-10-14T16:05:00Z #968: reviewed (full); …'],
  })
  expect(rendered).toContain('worker:      running, pid 841451, up 15m 02s, from /repos/zen-harness-foundation')
  expect(rendered).toContain('queue:       #970 #993')
  expect(rendered).toContain('in progress: #969 at c9d85de, started 2m 10s ago; last call: Read allow /t/a.ts')
  expect(rendered).toContain('  2026-10-14T16:05:00Z #968: reviewed (full); …')
  const idle = renderReviewStatus({ worker: { kind: 'stale', pid: 7 }, queued: [], inProgress: [], recent: [] })
  expect(idle).toContain('stale lock names pid 7')
  expect(idle).toContain('queue:       empty')
  expect(idle).toContain('in progress: nothing')
})

test('the worker is none without a lock, stale when its pid is gone, and running with an uptime and a start otherwise', () => {
  const now = 1_000_000
  expect(workerFrom(undefined, undefined, '', now)).toEqual({ kind: 'none' })
  expect(workerFrom('4242', undefined, '', now)).toEqual({ kind: 'stale', pid: 4242 })
  expect(workerFrom('4242', '  ', '', now)).toEqual({ kind: 'stale', pid: 4242 })
  expect(workerFrom('4242', '  900\n', '/repos/x (abc)', now)).toEqual({
    kind: 'running',
    pid: 4242,
    uptime: '15m 00s',
    checkout: '/repos/x (abc)',
    startedAt: 100_000,
  })
})

test('a decision log line still being written reads as such, and Grep and Glob show their target', () => {
  expect(
    lastToolCall('{"tool":"Read","input":{"file_path":"/a"},"decision":{"kind":"allow"}}\n{"tool":"Bash","inp'),
  ).toBe('(being written)')
  expect(lastToolCall('{"tool":"Grep","input":{"pattern":"TODO","path":"src"},"decision":{"kind":"allow"}}')).toBe(
    'Grep allow src',
  )
  expect(lastToolCall('{"tool":"Glob","input":{"pattern":"**/*.ts"},"decision":{"kind":"allow"}}')).toBe(
    'Glob allow **/*.ts',
  )
})

test('with no worker running, a run folder that kept its worktree is shown as abandoned', () => {
  const run = { run: { number: 969, shortHead: 'c9d85de', startedAt: 0 }, elapsed: '2h 10m', lastCall: undefined }
  expect(renderReviewStatus({ worker: { kind: 'none' }, queued: [], inProgress: [run], recent: [] })).toContain(
    'abandoned  : #969 at c9d85de, started 2h 10m ago',
  )
})

/** ⚠ A FOLDER OLDER THAN THE RUNNING WORKER IS NOT ITS REVIEW (#993's review). */
test('⚠ with a worker running, a run folder that started before it is abandoned; one after it is in progress', () => {
  const worker = { kind: 'running', pid: 1, uptime: '5m', checkout: '/x', startedAt: 5000 } as const
  const run = (startedAt: number): { run: RunFolder; elapsed: string; lastCall: undefined } => ({
    run: { number: 7, shortHead: 'abcdef0', startedAt },
    elapsed: '1m',
    lastCall: undefined,
  })
  const rendered = renderReviewStatus({ worker, queued: [], inProgress: [run(4000), run(6000)], recent: [] })
  expect(rendered).toContain('abandoned  : #7 at abcdef0')
  expect(rendered).toContain('in progress: #7 at abcdef0')
})

test('a run folder name is written and read back by one definition', () => {
  const name = runFolderName(994, 'cb6d0a99a62078291f3816a7463c9f1708595d8a', 1_791_997_871_168)
  expect(name).toBe('pr-994-cb6d0a9-1791997871168')
  expect(runFolderOf(name)).toEqual({ number: 994, shortHead: 'cb6d0a9', startedAt: 1_791_997_871_168 })
})
