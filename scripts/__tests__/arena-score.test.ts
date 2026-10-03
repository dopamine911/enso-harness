import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoLogLine } from '../../packages/core/src/log.ts'
import { projectIdOf, realpathOrSelf } from '../../packages/core/src/paths.ts'
import { type EnsoEvalScorecard, type EnsoSessionEval, sessionEvalOf } from '../../packages/core/src/session-eval.ts'
import { ARENA_REFUSED_DETAIL } from '../arena/actions.ts'
import { projectThreads } from '../arena/evidence.ts'
import { foldArenaManifest } from '../arena/manifest.ts'
import { type ArenaScoreInput, readArenaScoreInput, scoreArenaRun, writeArenaScore } from '../arena/score.ts'
import { type ArenaClock, type ArenaEventBody, openTimeline, pagePlace, readTimeline } from '../arena/timeline.ts'

/**
 * Dogfood Arena's score (#556, #584): a run's logs read for problems, and whether the agent really
 * used Enso's UI — checked against Enso's own records, not only the recorder's.
 */

const SHOWN = '0f6c1c4e-5a3b-4c55-9d43-6c1f0a8e2b71'
const UNSEEN = '1a2b3c4d-5a3b-4c55-9d43-6c1f0a8e2b72'
const FORK = '2b3c4d5e-5a3b-4c55-9d43-6c1f0a8e2b73'

function steppingClock(): ArenaClock {
  let tick = 0
  return {
    wallNow: () => new Date(Date.UTC(2026, 9, 1, 12, 0, ++tick)),
    monotonicNow: () => tick * 1000,
  }
}

/** A session eval as the route answers it, with the scorecard counts a test names. */
function sessionEval(threadId: string, counts: Partial<EnsoEvalScorecard> = {}): EnsoSessionEval {
  const computed = sessionEvalOf({ transcript: [], turnStats: [], log: [], logDays: [] })
  return { threadId, live: false, ...computed, scorecard: { ...computed.scorecard, ...counts } }
}

const AGENT_RUN: readonly ArenaEventBody[] = [
  { kind: 'run-start', scenario: 'snake', project: '/runs/p' },
  { kind: 'agent-start', provider: 'anthropic', model: 'm', thinking: 'medium', tools: ['act'] },
  { kind: 'action', via: 'agent', action: 'fill', detail: 'fill textbox', outcome: 'ok', durationMs: 3 },
  { kind: 'action', via: 'agent', action: 'press', detail: 'press Enter', outcome: 'ok', durationMs: 3 },
  { kind: 'note', via: 'agent', note: 'retrospective', trying: 'the whole assignment', happened: 'done' },
  { kind: 'action', via: 'agent', action: 'stop', detail: 'stop', outcome: 'ok', durationMs: 1 },
  { kind: 'agent-end', reason: 'it stopped the run' },
  { kind: 'run-stop', reason: 'the agent stopped the run' },
]

/** A run's input: the timeline (every event in the shown thread unless it is the run's own), plus Enso's side. */
function inputOf(bodies: readonly ArenaEventBody[], rest: Partial<ArenaScoreInput> = {}): ArenaScoreInput {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-score-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${SHOWN}`)
  for (const body of bodies) {
    const ownLine = body.kind.startsWith('run-') || body.kind.startsWith('agent-')
    timeline.record(body, ownLine ? undefined : inThread)
  }
  const events = readTimeline(path)
  return {
    manifest: foldArenaManifest({ runId: 'snake-1', events, evidence: [] }),
    events,
    transcript: [{ role: 'user' }, { role: 'assistant', stopReason: 'toolUse' }],
    evals: new Map([[SHOWN, sessionEval(SHOWN, { humanMessages: 2, toolCalls: 9 })]]),
    logRecords: [],
    projectThreads: [{ threadId: SHOWN, messageCount: 12 }],
    project: { changedFiles: 3, commits: 1, workspaces: ['/runs/p'] },
    ...rest,
  }
}

const checkStatus = (input: ArenaScoreInput, name: string): string | undefined =>
  scoreArenaRun(input).uiChecks.find((check) => check.name === name)?.status

test('a clean agent run passes: the boundary held, Enso was prompted, every thread was on screen, Enso did the work', () => {
  const score = scoreArenaRun(inputOf(AGENT_RUN))
  expect(score.uiChecks.map((check) => [check.name, check.status])).toEqual([
    ['agent-only-tool', 'pass'],
    ['acted-on-page', 'pass'],
    ['prompted-enso', 'pass'],
    ['no-thread-outside-ui', 'pass'],
    ['enso-did-the-work', 'pass'],
  ])
  expect(score).toMatchObject({ verdict: 'pass', errors: 0, uiUsed: true })
  expect(score.metrics).toEqual({
    minutes: 0.1,
    actions: { total: 3, failed: 0 },
    enso: { prompts: 2, toolCalls: 9, toolErrors: 0 },
    threads: { shown: 1, stored: 1 },
    screenshots: 0,
    notes: { wish: 0, friction: 0, retrospective: 1 },
    work: { changedFiles: 3, commits: 1, workspaces: ['/runs/p'] },
  })
})

test('the UI checks fail on what Enso recorded, not only on what the recorder saw', () => {
  // No agent runner: the boundary was never held.
  const manual = AGENT_RUN.filter((body) => body.kind !== 'agent-start' && body.kind !== 'agent-end').map((body) =>
    body.kind === 'action' || body.kind === 'note' ? { ...body, via: 'control' as const } : body,
  )
  expect(checkStatus(inputOf(manual), 'agent-only-tool')).toBe('fail')
  expect(checkStatus(inputOf(manual), 'acted-on-page')).toBe('fail')
  // A thread Enso holds prompts for that the page never named was driven another way; a fork of a shown one was not.
  const outside = inputOf(AGENT_RUN, {
    projectThreads: [
      { threadId: SHOWN, messageCount: 12 },
      { threadId: FORK, messageCount: 4, parentThreadId: SHOWN },
      // A fork of that fork: its chain reaches a shown thread, so it came from the UI too.
      { threadId: '4d5e6f70-5a3b-4c55-9d43-6c1f0a8e2b75', messageCount: 1, parentThreadId: FORK },
      { threadId: UNSEEN, messageCount: 2 },
      { threadId: '3c4d5e6f-5a3b-4c55-9d43-6c1f0a8e2b74', messageCount: 0 },
    ],
  })
  const unseen = scoreArenaRun(outside).uiChecks.find((check) => check.name === 'no-thread-outside-ui')
  // Plain asserts: bun 1.4.0's `toMatchObject` writes an asymmetric matcher into the object it checks.
  expect(unseen?.status).toBe('fail')
  expect(unseen?.detail).toContain(UNSEEN)
  expect(unseen?.detail).not.toContain(FORK)
  expect(unseen?.detail).not.toContain('4d5e6f70')
  // Files changed with no Enso tool call: the work was done outside Enso.
  const noTools = inputOf(AGENT_RUN, {
    evals: new Map([[SHOWN, sessionEval(SHOWN, { humanMessages: 1, toolCalls: 0 })]]),
  })
  expect(checkStatus(noTools, 'enso-did-the-work')).toBe('fail')
  // Enso never got a prompt.
  expect(checkStatus(inputOf(AGENT_RUN, { evals: new Map([[SHOWN, sessionEval(SHOWN)]]) }), 'prompted-enso')).toBe(
    'fail',
  )
})

test('a UI check that cannot be made is unknown, and unknown fails the run', () => {
  const blind = { ...inputOf(AGENT_RUN), evals: new Map() }
  delete (blind as { projectThreads?: unknown }).projectThreads
  delete (blind as { project?: unknown }).project
  const score = scoreArenaRun(blind)
  expect(score.uiChecks.filter((check) => check.status === 'unknown').map((check) => check.name)).toEqual([
    'prompted-enso',
    'no-thread-outside-ui',
    'enso-did-the-work',
  ])
  expect(score).toMatchObject({ verdict: 'fail', uiUsed: false })
})

test('every log is read for problems: errors fail the run, warnings are counted, the same problem is one line', () => {
  const run: ArenaEventBody[] = [
    ...AGENT_RUN.filter((body) => body.kind !== 'note' && body.kind !== 'run-stop'),
    { kind: 'console-error', text: 'Failed to load resource' },
    { kind: 'console-error', text: 'Failed to load resource' },
    {
      kind: 'request-failed',
      request: 'GET http://127.0.0.1:5178/api/threads/x/follow?since=3',
      failure: 'net::ERR_ABORTED',
    },
    {
      kind: 'request-failed',
      request: 'GET http://127.0.0.1:5178/api/about?x=1',
      failure: 'net::ERR_CONNECTION_REFUSED',
    },
    { kind: 'page-error', text: 'TypeError: x is undefined' },
    { kind: 'response-error', request: 'GET http://127.0.0.1:5178/api/threads/x/git?y=1', status: 404 },
    { kind: 'response-error', request: 'POST http://127.0.0.1:5178/api/threads/x/prompt', status: 500 },
    { kind: 'enso-exit', exit: '1' },
    { kind: 'agent-tool-refused', tool: 'bash' },
    {
      kind: 'action',
      via: 'agent',
      action: 'goto',
      detail: ARENA_REFUSED_DETAIL,
      outcome: 'failed',
      error: 'not /api',
      durationMs: 0,
    },
    {
      kind: 'action',
      via: 'agent',
      action: 'click',
      detail: 'click button "Run"',
      outcome: 'failed',
      error: 'timeout',
      durationMs: 9,
    },
    { kind: 'run-stop', reason: 'budget: 120 minutes' },
  ]
  const log = (level: EnsoLogLine['level'], message: string): EnsoLogLine => ({
    '@timestamp': '2026-10-01T12:00:05.000Z',
    level,
    logger: 'enso.server',
    message,
  })
  const score = scoreArenaRun(
    inputOf(run, {
      transcript: [
        { role: 'user' },
        { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' },
        { role: 'user' },
        { role: 'assistant', stopReason: 'stop' },
      ],
      logRecords: [log('ERROR', 'run failed'), log('WARN', 'slow follow'), log('INFO', 'fine')],
      evals: new Map([
        [SHOWN, sessionEval(SHOWN, { humanMessages: 2, toolCalls: 9, providerRefusals: 1, gateFailed: 2 })],
      ]),
    }),
  )
  const lines = score.problems.map(
    (problem) => `${problem.severity} ${problem.source} ${problem.message} ×${problem.count}`,
  )
  expect(lines).toEqual(
    expect.arrayContaining([
      'error timeline Enso exited (1) ×1',
      'error timeline uncaught error in the page: TypeError: x is undefined ×1',
      'error agent a model call failed: overloaded ×1',
      'error enso-log enso.server: run failed ×1',
      "error enso-eval the provider refused Enso's request ×1",
      'error timeline HTTP 500: POST /api/threads/x/prompt ×1',
      'warning timeline HTTP 404: GET /api/threads/x/git ×1',
      'warning run the run ran out of budget before the agent finished ×1',
      'warning run the agent wrote no retrospective ×1',
      'warning timeline console error: Failed to load resource ×2',
      'warning timeline request failed: GET /api/about (net::ERR_CONNECTION_REFUSED) ×1',
      'warning agent the agent asked for a tool it was not given: bash ×1',
      'warning agent refused before the page: goto — not /api ×1',
      'warning timeline action failed: click button "Run" ×1',
      'warning agent the agent ended a turn without stopping and was nudged ×1',
      'warning enso-log enso.server: slow follow ×1',
      'warning enso-eval a gate run failed ×2',
    ]),
  )
  // An aborted request is the page cancelling its own fetch: not a problem.
  expect(lines.join('\n')).not.toContain('/follow')
  // Errors first, and the verdict is theirs.
  expect(score.problems[0]?.severity).toBe('error')
  expect(score).toMatchObject({ verdict: 'fail', errors: 6 })
})

test('a run directory is read and scored to score.json and score.md', () => {
  const runDirectory = mkdtempSync(join(tmpdir(), 'arena-scored-'))
  const project = join(runDirectory, 'project')
  mkdirSync(project)
  spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project })
  writeFileSync(join(project, 'snake.js'), 'game()\n')
  const timeline = openTimeline(join(runDirectory, 'timeline.jsonl'), steppingClock())
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${SHOWN}`)
  for (const body of AGENT_RUN) {
    const ownLine = body.kind.startsWith('run-') || body.kind.startsWith('agent-')
    timeline.record(body.kind === 'run-start' ? { ...body, project } : body, ownLine ? undefined : inThread)
  }
  const evidence = join(runDirectory, 'enso', 'evidence')
  mkdirSync(evidence, { recursive: true })
  // Enso ran the thread in a tree of its own (#551), named by the thread record's `cwd`.
  const tree = join(runDirectory, 'home', 'projects', 'p', 'trees', SHOWN)
  mkdirSync(join(tree, 'src'), { recursive: true })
  writeFileSync(join(tree, 'src', 'snake.js'), 'game()\n')
  writeFileSync(join(evidence, `thread-${SHOWN}.json`), JSON.stringify({ threadId: SHOWN, cwd: tree }))
  writeFileSync(
    join(evidence, `thread-${SHOWN}-eval.json`),
    JSON.stringify(sessionEval(SHOWN, { humanMessages: 1, toolCalls: 4 })),
  )
  const record = JSON.stringify({
    '@timestamp': '2026-10-01T12:00:05.000Z',
    level: 'ERROR',
    logger: 'enso.host',
    message: 'boom',
  })
  // Two bundles of one day carry the same record: it is one problem, once.
  for (const name of [`thread-${SHOWN}-bundle.md`, `thread-${UNSEEN}-bundle.md`]) {
    writeFileSync(join(evidence, name), `# bundle\n\n## log\n\`\`\`jsonl\n${record}\n\`\`\`\n`)
  }
  const projectId = projectIdOf(realpathOrSelf(project))
  writeFileSync(
    join(evidence, 'stored-threads.json'),
    JSON.stringify([
      { threadId: SHOWN, projectId, messageCount: 4, lastActivityAt: 'x', busy: false },
      { threadId: UNSEEN, projectId: 'another-project', messageCount: 9, lastActivityAt: 'x', busy: false },
    ]),
  )
  writeFileSync(
    join(runDirectory, 'manifest.json'),
    JSON.stringify(
      foldArenaManifest({ runId: 'snake-2', events: readTimeline(join(runDirectory, 'timeline.jsonl')), evidence: [] }),
    ),
  )

  const input = readArenaScoreInput(runDirectory)
  // The project (git, one untracked file) and the thread's own tree (not a repository, one file): both counted.
  expect(input.project).toEqual({ changedFiles: 2, commits: 0, workspaces: [project, tree] })
  expect(input.projectThreads).toEqual([{ threadId: SHOWN, messageCount: 4 }])
  expect(input.logRecords).toHaveLength(1)

  const score = writeArenaScore(runDirectory)
  expect(score).toMatchObject({ verdict: 'fail', uiUsed: true, errors: 1 })
  expect(JSON.parse(readFileSync(join(runDirectory, 'score.json'), 'utf8'))).toMatchObject({ verdict: 'fail' })
  const markdown = readFileSync(join(runDirectory, 'score.md'), 'utf8')
  expect(markdown).toContain('**FAIL** — 1 error(s)')
  expect(markdown).toContain('enso.host: boom')
})

test("stored threads are the project's only, and a body that is not a list is unknown rather than empty", () => {
  expect(projectThreads(undefined, 'p')).toBeUndefined()
  expect(projectThreads('{"no":"list"}', 'p')).toBeUndefined()
  expect(projectThreads('not json', 'p')).toBeUndefined()
  expect(
    projectThreads(
      JSON.stringify([
        { threadId: 'a', projectId: 'p', messageCount: 2, parentThreadId: 'b' },
        { threadId: 'c', projectId: 'q', messageCount: 1 },
        { projectId: 'p' },
      ]),
      'p',
    ),
  ).toEqual([{ threadId: 'a', messageCount: 2, parentThreadId: 'b' }])
})

test('an agent runner whose end is missing, or that outlived the stop, is a warning, not silence', () => {
  const noEnd = AGENT_RUN.filter((body) => body.kind !== 'agent-end')
  const missing = scoreArenaRun(inputOf(noEnd)).problems.map((problem) => problem.message)
  expect(missing).toContain("the agent runner's end was not recorded")
  const outlived = scoreArenaRun(
    inputOf([...noEnd, { kind: 'agent-end', reason: 'still running 15 s after the run stopped: its end is unknown' }]),
  ).problems.map((problem) => problem.message)
  expect(outlived).toContain('the agent runner was still running when the run was folded')
  // A runner that ended normally carries neither.
  const clean = scoreArenaRun(inputOf(AGENT_RUN)).problems.map((problem) => problem.message)
  expect(clean.join('\n')).not.toContain('runner')
})
