import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ArenaCheckedGap, readFindings } from '../findings.ts'
import { buildArenaReport, renderArenaReport } from '../report.ts'
import { OPTIONS, recordedRun, THREAD } from './recorded-run.ts'

/**
 * The run's report (#624, #584 B4 and B5): the application outcome apart from Enso's findings, and
 * the reviewer's gaps standing as verified only when what they cite is in the run.
 */

/** A gap as the review brief asks for it, citing what the caller passes. */
function gap(evidence: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'the mode selector is disabled mid-run',
    classification: 'defect',
    reproduction: 'start a session, then open the mode selector while it runs',
    impact: 'seven approval clicks',
    observed: 'the selector is greyed out at 165 s',
    issue: 'dopamine911/zen-harness-foundation#618',
    evidence,
    ...overrides,
  }
}

function checkedGaps(run: string, gaps: unknown[]): ArenaCheckedGap[] {
  const findings = readFindings(JSON.stringify({ gaps }), {
    runDirectory: run,
    runMs: 360_000,
    threadIds: new Set([THREAD]),
  })
  if (findings.status !== 'read') throw new Error(`findings not read: ${JSON.stringify(findings)}`)
  return [...findings.gaps]
}

test('⚠ a gap stands as verified only when everything it cites is in the run (#624)', () => {
  const run = mkdtempSync(join(tmpdir(), 'arena-findings-'))
  mkdirSync(join(run, 'screenshots'))
  writeFileSync(join(run, 'screenshots', '00007-sample.png'), '')
  const [kept, late, missingShot, outsideShot, strangeThread, bare, emptyCitation] = checkedGaps(run, [
    gap([{ elapsedMs: 165_000 }, { screenshot: 'screenshots/00007-sample.png' }, { threadId: THREAD }]),
    gap([{ elapsedMs: 400_000 }]),
    gap([{ screenshot: 'screenshots/00099-sample.png' }]),
    gap([{ screenshot: '../elsewhere.png' }]),
    gap([{ threadId: 'not-a-thread-of-this-run' }]),
    gap([]),
    gap([{}]),
  ])
  expect(kept).toMatchObject({ verified: true, unresolved: [] })
  expect(late?.unresolved).toEqual(['evidence 1: 400000 ms is outside the run (0–360000 ms)'])
  expect(missingShot?.unresolved).toEqual(['evidence 1: no screenshot screenshots/00099-sample.png in the run'])
  expect(outsideShot?.verified).toBe(false)
  expect(strangeThread?.unresolved).toEqual(['evidence 1: thread not-a-thread-of-this-run is not one the run was in'])
  expect(bare?.unresolved).toEqual(['cites nothing'])
  expect(emptyCitation?.unresolved).toEqual(['evidence 1: names no second, screenshot or thread'])
})

test('a screenshot citation that names a directory of the run is not a screenshot: "", "." and "screenshots" (PR #626 review)', () => {
  const run = mkdtempSync(join(tmpdir(), 'arena-directory-citation-'))
  mkdirSync(join(run, 'screenshots'))
  const gaps = checkedGaps(run, [
    gap([{ screenshot: '' }]),
    gap([{ screenshot: '.' }]),
    gap([{ screenshot: 'screenshots' }]),
  ])
  expect(gaps.map((checked) => checked.verified)).toEqual([false, false, false])
})

test('a defect with no issue is flagged unmapped; a gap of another class needs none', () => {
  const run = mkdtempSync(join(tmpdir(), 'arena-unmapped-'))
  const [defect, mistake] = checkedGaps(run, [
    gap([{ threadId: THREAD }], { issue: undefined }),
    gap([{ threadId: THREAD }], { issue: undefined, classification: 'agent-mistake' }),
  ])
  expect(defect).toMatchObject({ verified: true, unmapped: true })
  expect(mistake).toMatchObject({ verified: true, unmapped: false })
})

test('findings that do not read as gaps say which gap and why; no file is absent, not empty', () => {
  const extent = { runDirectory: '/run', runMs: 1, threadIds: new Set<string>() }
  expect(readFindings(undefined, extent)).toEqual({ status: 'absent' })
  expect(readFindings('{', extent)).toMatchObject({ status: 'invalid' })
  expect(readFindings(JSON.stringify({ gaps: [gap([]), gap([], { classification: 'bug' })] }), extent)).toEqual({
    status: 'invalid',
    reason: 'gap 2: `classification` is not one of defect, undiscoverable, agent-mistake, not-needed',
  })
  expect(readFindings(JSON.stringify({ gaps: [gap([], { impact: 3 })] }), extent)).toEqual({
    status: 'invalid',
    reason: 'gap 1: `impact` is missing or not text',
  })
})

test('⚠ the report keeps what was built apart from Enso’s findings, and places each finding on a screenshot and its turn (#624)', () => {
  const run = recordedRun()
  const report = buildArenaReport(run, OPTIONS)

  // The application outcome: what the work holds, its history, its tests run.
  expect(report.outcome).toHaveLength(1)
  expect(report.outcome[0]).toMatchObject({ path: 'project', fileCount: 2 })
  expect(report.outcome[0]?.git).toMatchObject({ kind: 'repository', commits: [{ subject: 'Snake, first playable' }] })
  expect(report.outcome[0]?.tests).toEqual([
    { path: 'test_logic.js', run: { command: 'bun ./test_logic.js', exit: 0, tail: 'ALL LOGIC TESTS PASSED' } },
  ])

  // Friction from the timeline, each cycle on the screenshot nearest it and the turn that shot shows:
  // at 20 s the prompt (15 s) is in and its reply (25 s) is not.
  const polling = report.friction.find((found) => found.pattern === 'polling')
  expect(polling?.moments).toEqual([
    { second: 20, screenshot: 'screenshots/20.png', turn: { turnId: 'prompt-1', messageId: 'prompt-1' } },
    { second: 30, screenshot: 'screenshots/30.png', turn: { turnId: 'prompt-1', messageId: 'reply-1' } },
    { second: 40, screenshot: 'screenshots/40.png', turn: { turnId: 'prompt-1', messageId: 'reply-1' } },
  ])
  // The agent's wish is its own account, with where it was written.
  expect(report.notes).toEqual([
    {
      kind: 'wish',
      trying: 'see the game',
      happened: 'no preview',
      wanted: 'a run button',
      moment: { second: 45, screenshot: 'screenshots/40.png', turn: { turnId: 'prompt-1', messageId: 'reply-1' } },
    },
  ])
  expect(report.findings).toEqual({ status: 'absent' })

  // The two parts, in that order, and the three kinds of finding each under its own heading.
  const markdown = renderArenaReport(report)
  const headings = markdown.split('\n').filter((line) => line.startsWith('#'))
  expect(headings).toEqual([
    '# Arena report — snake-r',
    '## Application outcome',
    '### `project`',
    '### What playing found',
    '## Enso findings',
    '### Observed friction',
    '### The agent’s account',
    '### Verified gaps',
  ])
})

// ⚠ #675: what the agent found by using the built page is the application's outcome, kept apart from
// Enso's findings — its moves there, what the page itself logged, and what it noted while there.
test('⚠ what playing found is read off the application’s own page, and a run that never played says so', () => {
  const played = buildArenaReport(recordedRun({ played: true }), { ...OPTIONS, runTests: false })
  // Rendered first: bun's `toMatchObject` with an asymmetric matcher inside an array replaces the
  // matched element in the received object (measured here: `examples` was gone after it).
  const markdown = renderArenaReport(played)
  expect(played.played).toMatchObject({
    moves: 1,
    from: { second: 50 },
    problems: [
      expect.objectContaining({
        source: 'application',
        message: 'uncaught error in the page: TypeError: paddle is undefined',
      }),
    ],
    notes: [expect.objectContaining({ kind: 'friction', trying: 'move the paddle' })],
  })
  // The note made on Enso's page is not one of playing's.
  expect(played.played?.notes.map((note) => note.trying)).not.toContain('see the game')
  const section = markdown.slice(markdown.indexOf('### What playing found'), markdown.indexOf('## Enso findings'))
  expect(section).toContain('1 move(s)')
  expect(section).toContain('TypeError: paddle is undefined')

  const never = buildArenaReport(recordedRun(), { ...OPTIONS, runTests: false })
  expect(never.played).toBeUndefined()
  expect(renderArenaReport(never)).toContain('never acted on the application’s own page')
})

test('the tests run only when asked: by default the report names them and says how to run them', () => {
  const run = recordedRun()
  const report = buildArenaReport(run, { ...OPTIONS, runTests: false })
  expect(report.outcome[0]?.tests).toEqual([{ path: 'test_logic.js' }])
  expect(renderArenaReport(report)).toContain('Not run: `bun run arena report <run> --run-tests` runs them.')
})
