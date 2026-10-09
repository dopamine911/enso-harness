import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldArenaManifest } from '../manifest.ts'
import { threadHistoriesIn } from '../run-state.ts'
import { scanRunForSecrets } from '../secret-scan.ts'
import { type ArenaClock, openTimeline, pagePlace, readTimeline } from '../timeline.ts'
import { gitIn } from './fixture-git.ts'

/** The thread the recorded run was in. */
export const THREAD = '4465dc39-7bd9-4cd3-83fd-d20af4fa2aa6'

/**
 * A recorded run, small: a project with a page, a passing logic script and one commit; a thread
 * whose prompt came at 15 s; three wait→read cycles (polling); one wish at 45 s; a screenshot every
 * 10 seconds.
 */
export function recordedRun(options: { readonly played?: boolean } = {}): string {
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
    // What every run since #610 records; publish refuses a manifest without one (#741).
    secretScan: scanRunForSecrets(run, []),
  })
  writeFileSync(join(run, 'manifest.json'), JSON.stringify(manifest))
  return run
}

/** The tests run under the bun running this suite, with nothing on `PATH` they need. */
export const OPTIONS = {
  runTests: true,
  path: '/usr/bin:/bin',
  bun: process.execPath,
  redact: (text: string): string => text,
}
