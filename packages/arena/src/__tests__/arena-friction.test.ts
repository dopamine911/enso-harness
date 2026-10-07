import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeArenaAction } from '../actions.ts'
import { compareByModel, compareRunDirectories } from '../compare.ts'
import { observedFriction } from '../friction.ts'
import { foldArenaManifest } from '../manifest.ts'
import { type ArenaClock, type ArenaEvent, type ArenaEventBody, openTimeline, readTimeline } from '../timeline.ts'
import { agentUsageOf } from '../usage.ts'

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

// ⚠ #637: a wait until change returns when Enso does something — it is not waiting blind, and a
// comparison counting it as polling would read the cure as more of the disease.
test('a wait until change, then a look, is not polling; fixed sleeps around it still are', () => {
  const changeWait = action('wait', describeArenaAction({ action: 'wait', ms: 60_000, until: 'change' }, []), {
    durationMs: 4000,
  })
  expect(observedFriction(timelineOf([changeWait, read(), changeWait, read(), changeWait, read()]))).toEqual([])
  expect(
    observedFriction(
      timelineOf([changeWait, read(), wait(30_000), read(), wait(30_000), read(), wait(30_000), read()]),
    ),
  ).toEqual([expect.objectContaining({ pattern: 'polling', count: 3, summary: expect.stringContaining('1.5 of') })])
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

// ⚠ #641: an agent clicked all three approvals of a run by TEXT, and the pattern that took `button`
// alone counted none — `arena compare` read the 7 → 3 as 7 → none. Every target kind counts the same.
test('⚠ an approval counts whatever named its target: by role or by text', () => {
  const byText = [
    action('click', 'click text "Yes, allow write"'),
    action('click', 'click text "Yes, allow bash"'),
    action('click', 'click text "Yes, for this session"'),
  ]
  expect(observedFriction(timelineOf(byText))).toEqual([
    { pattern: 'approvals', summary: "3 approval clicks to let Enso's agent go on", count: 3, at: [10, 20, 30] },
  ])
  // A text or option that merely contains the word is not one: the name must start with it.
  const lookalikes = ['click text "Not yet"', 'click option "Okay later"', 'click text "Say yes"'].map((detail) =>
    action('click', detail),
  )
  expect(observedFriction(timelineOf([...lookalikes, ...lookalikes]))).toEqual([])
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

/** A run an agent drove: its model, in a perception, with its own transcript of priced calls. */
function agentRun(
  runId: string,
  agent: { readonly provider: string; readonly model: string; readonly perception: 'tree' | 'visual' },
  costs: readonly number[],
  bodies: readonly ArenaEventBody[] = [],
): string {
  const directory = runDirectory(runId, [
    { kind: 'agent-start', provider: agent.provider, model: agent.model, thinking: 'medium', tools: ['act'] },
    ...bodies,
  ])
  // The perception comes from the run's start (#680); `runDirectory` starts in the tree.
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, perception: agent.perception }))
  mkdirSync(join(directory, 'agent'))
  const calls = costs.map((cost) => ({ role: 'assistant', usage: { input: 100, output: 10, cost: { total: cost } } }))
  writeFileSync(join(directory, 'agent', 'transcript.jsonl'), calls.map((call) => JSON.stringify(call)).join('\n'))
  return directory
}

// ⚠ #674: one run per model can't tell a model's difference from noise, so each column says how many
// runs it has; a model and a perception are two columns, never pooled; and a problem is "only under"
// one model only when no other column has it.
test('⚠ runs compare by model: grouped by agent and perception, each column its run count, problems only one model has', () => {
  const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5', perception: 'tree' } as const
  const failedStart = action('click', 'click button "Start session"', { outcome: 'failed' })
  const compared = compareByModel([
    agentRun('sonnet-1', sonnet, [0.1, 0.1]),
    agentRun('sonnet-2', sonnet, [0.3, 0.1], [failedStart]),
    agentRun('sonnet-visual', { ...sonnet, perception: 'visual' }, [1]),
    agentRun('opus-1', { ...sonnet, model: 'claude-opus-5-5' }, [0.5], [failedStart]),
  ])
  const tableRow = (label: string): string | undefined =>
    compared.split('\n').find((line) => line.startsWith(`| ${label} |`))
  expect(compared.split('\n').find((line) => line.startsWith('| |'))).toBe(
    '| | anthropic/claude-sonnet-5-5 · tree | anthropic/claude-sonnet-5-5 · visual | anthropic/claude-opus-5-5 · tree |',
  )
  expect(tableRow('runs')).toBe('| runs | 2 | 1 | 1 |')
  // The mean of each run's own total: (0.2 + 0.4) / 2.
  expect(tableRow('mean agent cost ($)')).toBe('| mean agent cost ($) | 0.30 | 1.00 | 0.50 |')
  // The failed start is under two models' runs, so it is no one model's alone.
  expect(compared).not.toContain('Only under')
  const alone = compareByModel([
    agentRun('sonnet-3', sonnet, [0.1]),
    agentRun('opus-2', { ...sonnet, model: 'claude-opus-5-5' }, [0.5], [failedStart]),
  ])
  expect(sectionOf(alone, 'Only under anthropic/claude-opus-5-5 · tree')).toEqual([
    '- **warning** (timeline) action failed: click button "Start session"',
  ])
})

// ⚠ #692: a model that lists no price spends tokens at $0. Its cost is unknown, never $0 — averaged as
// $0 it would make the costliest model look free.
test('an agent’s calls are priced at its model’s listed rates; tokens spent at $0 are unpriced, not free', () => {
  const call = (cost: number, output = 10): unknown => ({
    role: 'assistant',
    usage: { input: 100, cacheRead: 50, output, cost: { total: cost } },
  })
  expect(agentUsageOf([call(0.25), { role: 'user' }, call(0.5)])).toEqual({
    calls: 2,
    inputTokens: 300,
    outputTokens: 20,
    costUsd: 0.75,
  })
  expect(agentUsageOf([call(0), call(0)])).toEqual({ calls: 2, inputTokens: 300, outputTokens: 20 })
  expect(agentUsageOf([{ role: 'user' }])).toBeUndefined()
})
