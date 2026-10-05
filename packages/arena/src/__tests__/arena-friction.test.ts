import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareRunDirectories } from '../compare.ts'
import { observedFriction } from '../friction.ts'
import { foldArenaManifest } from '../manifest.ts'
import { type ArenaClock, type ArenaEvent, type ArenaEventBody, openTimeline, readTimeline } from '../timeline.ts'

/**
 * Friction the recorder saw, and two runs side by side (#611 B3, B6). Each pattern is pinned at its
 * threshold, from both sides, on timelines shaped like the reference runs': the second run's nine
 * wait→read cycles and seven "Yes, allow …" clicks are exactly what `polling` and `approvals` read.
 */

/** A clock ten seconds further on at each event. */
function tenSecondClock(): ArenaClock {
  let tick = 0
  return {
    wallNow: () => new Date(Date.UTC(2026, 9, 5, 23, 0, 0) + ++tick * 10_000),
    monotonicNow: () => tick * 10_000,
  }
}

/** One action the agent made: `detail` is the timeline's one line, as `describeArenaAction` writes it. */
function action(
  name: string,
  detail: string,
  options: { readonly outcome?: 'ok' | 'failed'; readonly durationMs?: number } = {},
): ArenaEventBody {
  return {
    kind: 'action',
    via: 'agent',
    action: name,
    detail,
    outcome: options.outcome ?? 'ok',
    durationMs: options.durationMs ?? 100,
    ...(options.outcome === 'failed' ? { error: 'locator.click: Timeout 15000ms exceeded.' } : {}),
  }
}

const wait = (ms: number): ArenaEventBody => action('wait', `wait ${ms} ms`, { durationMs: ms })
const read = (): ArenaEventBody => action('read', 'read')

/** The bodies as a timeline: written and read back, so each event has its stamp. */
function timelineOf(bodies: readonly ArenaEventBody[], directory?: string): ArenaEvent[] {
  const path = join(directory ?? mkdtempSync(join(tmpdir(), 'arena-friction-')), 'timeline.jsonl')
  const timeline = openTimeline(path, tenSecondClock())
  for (const body of bodies) timeline.record(body)
  return readTimeline(path)
}

test('⚠ waiting then looking is polling from its third cycle; the share of the run spent waiting is said', () => {
  expect(observedFriction(timelineOf([wait(30_000), read(), wait(30_000), read()]))).toEqual([])
  const friction = observedFriction(timelineOf([wait(30_000), read(), wait(30_000), read(), wait(30_000), read()]))
  expect(friction).toEqual([
    {
      pattern: 'polling',
      summary: '3 wait→look cycles: 1.5 of 1.0 minutes spent waiting for Enso',
      count: 3,
      at: [10, 30, 50],
    },
  ])
  // A wait followed by anything but a look is not a poll.
  expect(
    observedFriction(timelineOf([wait(1), action('click', 'click button "x"'), wait(1), read(), wait(1)])),
  ).toEqual([])
})

test('⚠ approval clicks count from the third, taken ones only; a click on any other button is not one', () => {
  const approvals = [
    action('click', 'click button "Yes, allow write"'),
    action('click', 'click button "Yes"'),
    action('click', 'click button "Send"'),
    action('click', 'click button "Yes, allow bash \\"node *\\" for this session"', { outcome: 'failed' }),
  ]
  expect(observedFriction(timelineOf(approvals))).toEqual([])
  expect(observedFriction(timelineOf([...approvals, action('click', 'click button "Allow"')]))).toEqual([
    { pattern: 'approvals', summary: "3 approval clicks to let Enso's agent go on", count: 3, at: [10, 20, 50] },
  ])
})

test('⚠ an action tried again after it failed is a retry; the same action twice with no failure is not', () => {
  const start = action('click', 'click button "Start session"')
  expect(observedFriction(timelineOf([start, read(), start]))).toEqual([])
  const failed = action('click', 'click button "Start session"', { outcome: 'failed' })
  expect(observedFriction(timelineOf([failed, read(), failed, start]))).toEqual([
    {
      pattern: 'retry',
      summary: '2 action(s) tried again after failing, 1 of them failing again',
      count: 2,
      at: [30, 40],
    },
  ])
})

test('backtracking from the second back or reload, and a path visited a third time, are friction', () => {
  expect(observedFriction(timelineOf([action('back', 'back')]))).toEqual([])
  expect(observedFriction(timelineOf([action('back', 'back'), action('reload', 'reload')]))).toMatchObject([
    { pattern: 'backtracking', count: 2, at: [10, 20] },
  ])
  const home = action('goto', 'goto /')
  expect(observedFriction(timelineOf([home, home, action('goto', 'goto /?thread=x'), home]))).toEqual([
    { pattern: 'repeated-navigation', summary: 'goto / ×3', count: 3, at: [10, 20, 40] },
  ])
})

/** A run directory as the stop leaves it, enough for the score: its timeline and its manifest. */
function runDirectory(runId: string, bodies: readonly ArenaEventBody[]): string {
  const directory = join(mkdtempSync(join(tmpdir(), 'arena-compare-')), runId)
  mkdirSync(directory)
  const events = timelineOf(
    [
      { kind: 'run-start', scenario: 'snake', project: join(directory, 'project') },
      ...bodies,
      { kind: 'run-stop', reason: 'test' },
    ],
    directory,
  )
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(foldArenaManifest({ runId, events, evidence: [] })))
  return directory
}

test('⚠ two run directories compare side by side: outcome, problems by which run has them, friction per run (#611)', () => {
  const thread = (id: string): ArenaEventBody => ({
    kind: 'response-error',
    request: `GET http://127.0.0.1:5178/api/threads/${id}/git`,
    status: 404,
  })
  const before = runDirectory('snake-a', [
    thread('0f6c1c4e-5a3b-4c55-9d43-6c1f0a8e2b71'),
    action('click', 'click button "Start session"', { outcome: 'failed' }),
    wait(60_000),
    read(),
  ])
  const after = runDirectory('snake-b', [
    // A thread id need not be a UUID (`isEnsoThreadId`): the comparison matches the path segment.
    thread('stored-1'),
    ...[1, 2, 3].flatMap(() => [wait(30_000), read(), action('click', 'click button "Yes, allow write"')]),
  ])

  const compared = compareRunDirectories(before, after)
  expect(compared).toContain('# Arena compare — snake-a vs snake-b')
  expect(compared).toContain('| actions (failed) | 3 (1) | 9 (0) |')
  // The same 404 on each run's own thread is one problem the runs share.
  expect(sectionOf(compared, 'In both')).toContain('- **warning** (timeline) HTTP 404: GET /api/threads/<thread>/git')
  expect(sectionOf(compared, 'Only in snake-a')).toContain(
    '- **warning** (timeline) action failed: click button "Start session"',
  )
  expect(sectionOf(compared, 'Only in snake-b').some((line) => line.includes('HTTP 404'))).toBe(false)
  expect(compared).toContain('| polling | — | 3 |')
  expect(compared).toContain('| approvals | — | 3 |')
})

/** The bullet lines under one problems heading (`In both:`, `Only in <run>:`), up to the next blank line. */
function sectionOf(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n')
  const start = lines.indexOf(`${heading}:`)
  if (start === -1) return []
  const end = lines.indexOf('', start)
  return lines.slice(start + 1, end === -1 ? undefined : end)
}
