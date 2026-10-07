import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ArenaCheckedGap, readFindings } from '../findings.ts'
import { foldArenaManifest } from '../manifest.ts'
import { buildArenaReport, renderArenaReport } from '../report.ts'
import { threadHistoriesIn } from '../run-state.ts'
import { type ArenaClock, openTimeline, pagePlace, readTimeline } from '../timeline.ts'
import { gitIn } from './fixture-git.ts'

/**
 * The run's report (#624, #584 B4 and B5): the application outcome apart from Enso's findings, and
 * the reviewer's gaps standing as verified only when what they cite is in the run.
 */

const THREAD = '4465dc39-7bd9-4cd3-83fd-d20af4fa2aa6'

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

/**
 * A recorded run, small: a project with a page, a passing logic script and one commit; a thread
 * whose prompt came at 15 s; three wait→read cycles (polling); one wish at 45 s; a screenshot every
 * 10 seconds.
 */
function recordedRun(options: { readonly played?: boolean } = {}): string {
  const run = mkdtempSync(join(tmpdir(), 'arena-report-'))
  const project = join(run, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'index.html'), '<canvas id="board"></canvas>')
  writeFileSync(join(project, 'test_logic.js'), 'console.log("ALL LOGIC TESTS PASSED")\n')
  gitIn(project, 'init', '--quiet', '--initial-branch=main')
  gitIn(project, 'add', '.')
  gitIn(project, 'commit', '--quiet', '-m', 'Snake, first playable')

  const evidence = join(run, 'enso', 'evidence')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(
    join(evidence, `thread-${THREAD}-history.json`),
    JSON.stringify({
      threadId: THREAD,
      messages: [
        { id: 'prompt-1', role: 'user', parts: [], createdAt: '2026-10-06T10:00:15.000Z' },
        { id: 'reply-1', role: 'assistant', parts: [], createdAt: '2026-10-06T10:00:25.000Z' },
      ],
    }),
  )
  mkdirSync(join(run, 'screenshots'))
  let tick = 0
  const clock: ArenaClock = {
    wallNow: () => new Date(Date.parse('2026-10-06T10:00:00.000Z') + tick * 5000),
    monotonicNow: () => tick * 5000,
  }
  const timeline = openTimeline(join(run, 'timeline.jsonl'), clock)
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`)
  const at = (seconds: number): void => {
    tick = seconds / 5
  }
  at(0)
  timeline.record({ kind: 'run-start', scenario: 'snake', project })
  for (let second = 0; second <= 60; second += 5) {
    at(second)
    if (second % 10 === 0) {
      const path = join(run, 'screenshots', `${second}.png`)
      writeFileSync(path, '')
      timeline.record({ kind: 'screenshot', cause: 'sample', path }, inThread)
    }
    if (second >= 20 && second <= 40 && second % 10 === 0) {
      timeline.record(
        { kind: 'action', via: 'control', action: 'wait', detail: 'wait 5000ms', outcome: 'ok', durationMs: 5000 },
        inThread,
      )
      timeline.record(
        { kind: 'action', via: 'control', action: 'read', detail: 'read', outcome: 'ok', durationMs: 10 },
        inThread,
      )
    }
    if (second === 45) {
      timeline.record(
        {
          kind: 'note',
          via: 'control',
          note: 'wish',
          trying: 'see the game',
          happened: 'no preview',
          wanted: 'a run button',
        },
        inThread,
      )
    }
    // #675: the agent plays the built page in Preview's tab, finds an error, and notes it there.
    if (options.played === true && second === 50) {
      // The thread's preview, on an origin of its own (#713).
      const game = { ...pagePlace('http://127.0.0.1:41234/index.html'), tab: 1 }
      timeline.record(
        { kind: 'action', via: 'control', action: 'press', detail: 'press ArrowLeft', outcome: 'ok', durationMs: 4 },
        game,
      )
      timeline.record({ kind: 'page-error', text: 'TypeError: paddle is undefined' }, game)
      timeline.record(
        { kind: 'note', via: 'control', note: 'friction', trying: 'move the paddle', happened: 'the game froze' },
        game,
      )
    }
  }
  timeline.record({ kind: 'run-stop', reason: 'the agent stopped the run' })
  const manifest = foldArenaManifest({
    runId: 'snake-r',
    events: readTimeline(join(run, 'timeline.jsonl')),
    evidence: [],
    histories: threadHistoriesIn(evidence),
  })
  writeFileSync(join(run, 'manifest.json'), JSON.stringify(manifest))
  return run
}

/** The tests run under the bun running this suite, with nothing on `PATH` they need. */
const OPTIONS = { runTests: true, path: '/usr/bin:/bin', bun: process.execPath, redact: (text: string) => text }

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
