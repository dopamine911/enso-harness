import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EnsoEvalScorecard, type EnsoLogLine, type EnsoSessionEval, sessionEvalOf } from '@enso/core'
import { projectIdOf, realpathOrSelf } from '@enso/core/paths'
import { ARENA_REFUSED_DETAIL } from '../actions.ts'
import { projectThreads } from '../evidence.ts'
import { foldArenaManifest } from '../manifest.ts'
import { type ArenaScoreInput, readArenaScoreInput, scoreArenaRun, writeArenaScore } from '../score.ts'
import { type ArenaClock, type ArenaEventBody, openTimeline, pagePlace, readTimeline } from '../timeline.ts'
import { gitIn } from './fixture-git.ts'

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
    modelUse: { enso: [] },
  })
})

// #674: a run set to Enso's model X whose sessions ran on Y would sit in X's column of a comparison.
test('a run whose Enso never ran on the model it set says so; one that did, or whose model is unknown, does not', () => {
  const [start, ...rest] = AGENT_RUN
  if (start?.kind !== 'run-start') throw new Error('AGENT_RUN changed shape')
  const setTo = (model: string): ArenaEventBody[] => [{ ...start, ensoModel: model }, ...rest]
  const warned = (input: ArenaScoreInput): string[] =>
    scoreArenaRun(input)
      .problems.filter((problem) => problem.message.includes('--enso-model'))
      .map((problem) => problem.examples.join('; '))
  expect(warned(inputOf(setTo('anthropic/claude-opus-5-5'), { ensoModels: ['anthropic/claude-fable-5'] }))).toEqual([
    'set anthropic/claude-opus-5-5; ran anthropic/claude-fable-5',
  ])
  // Ran on it first, then switched: it ran on it.
  const switched = ['anthropic/claude-fable-5', 'anthropic/claude-opus-5-5']
  expect(warned(inputOf(setTo('anthropic/claude-opus-5-5'), { ensoModels: switched }))).toEqual([])
  // No thread's record collected: nothing to compare.
  expect(warned(inputOf(setTo('anthropic/claude-opus-5-5'), { ensoModels: [] }))).toEqual([])
  // Not set at all.
  expect(warned(inputOf(AGENT_RUN, { ensoModels: ['anthropic/claude-fable-5'] }))).toEqual([])
})

// ⚠ #680: a visual agent clicks at points and types into what has focus. Counted only by name, its
// moves would be none, and every visual run would fail `acted-on-page` for a reason that isn't Enso's.
test('⚠ a visual run’s pointer and typed moves are moves on the page; a run from before records none and reads as tree', () => {
  const [start, agentStart, , , ...rest] = AGENT_RUN
  if (start?.kind !== 'run-start' || agentStart === undefined) throw new Error('AGENT_RUN changed shape')
  const visualRun: ArenaEventBody[] = [
    { ...start, perception: 'visual' },
    agentStart,
    {
      kind: 'action',
      via: 'agent',
      action: 'click',
      detail: 'click at 510,530',
      outcome: 'ok',
      durationMs: 3,
      under: 'textbox "Prompt"',
    },
    { kind: 'action', via: 'agent', action: 'type', detail: 'type "hello"', outcome: 'ok', durationMs: 3 },
    ...rest,
  ]
  const score = scoreArenaRun(inputOf(visualRun))
  // Both moves count: the click at a point, and the text typed into what it focused.
  expect(score.uiChecks.find((check) => check.name === 'acted-on-page')).toMatchObject({
    status: 'pass',
    detail: expect.stringContaining('2 move(s)'),
  })
  expect(score).toMatchObject({ perception: 'visual', agent: 'anthropic/m', verdict: 'pass' })
  expect(scoreArenaRun(inputOf(AGENT_RUN)).perception).toBe('tree')
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

// ⚠ #675: once the agent plays what it built, the built page's own errors reach the timeline. They
// are the application's — a game bug must not fail Enso's run — but a 5xx serving it is Enso's.
test('⚠ what the built page logs in its Preview tab is the application’s; a 5xx serving that page is Enso’s', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-score-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${SHOWN}`)
  for (const body of AGENT_RUN) {
    timeline.record(body, body.kind.startsWith('run-') || body.kind.startsWith('agent-') ? undefined : inThread)
  }
  const preview = { ...pagePlace(`http://127.0.0.1:5178/preview/threads/${SHOWN}/index.html`), tab: 1 }
  timeline.record({ kind: 'tab-opened', tab: 1, opener: 0 }, preview)
  timeline.record({ kind: 'page-error', text: 'ReferenceError: score is not defined' }, preview)
  timeline.record(
    { kind: 'response-error', request: `GET ${preview.url.replace('index.html', 'sprite.png')}`, status: 404 },
    preview,
  )
  // #689, as the arena saw it: Preview's sandbox blocked the page's own module script. Enso's, not the app's.
  const corsBlocked = `Access to script at '${preview.url.replace('index.html', 'app.mjs')}' from origin 'null' has been blocked by CORS policy`
  timeline.record({ kind: 'console-error', text: corsBlocked }, preview)
  const scoreOf = (): ReturnType<typeof scoreArenaRun> => {
    const events = readTimeline(path)
    return scoreArenaRun({
      ...inputOf(AGENT_RUN),
      events,
      manifest: foldArenaManifest({ runId: 'snake-1', events, evidence: [] }),
    })
  }
  const played = scoreOf()
  expect(played.verdict).toBe('pass')
  const application = played.problems.filter((problem) => problem.source === 'application')
  expect(
    application
      .map((problem) => [problem.severity, problem.message])
      .toSorted((left, right) => String(left[1]).localeCompare(String(right[1]))),
  ).toEqual([
    ['warning', `HTTP 404: GET /preview/threads/${SHOWN}/sprite.png`],
    ['warning', 'uncaught error in the page: ReferenceError: score is not defined'],
  ])
  expect(application[0]?.examples[0]).toContain('tab 1')

  const cors = played.problems.find((problem) => problem.message.includes('blocked by CORS policy'))
  expect(cors).toMatchObject({ severity: 'warning', source: 'timeline' })

  timeline.record({ kind: 'response-error', request: `GET ${preview.url}`, status: 500 }, preview)
  const failedToServe = scoreOf()
  expect(failedToServe.verdict).toBe('fail')
  expect(failedToServe.problems).toContainEqual(
    expect.objectContaining({
      severity: 'error',
      source: 'timeline',
      message: `HTTP 500: GET /preview/threads/${SHOWN}/index.html`,
    }),
  )
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
  gitIn(project, 'init', '--quiet', '--initial-branch=main')
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
  // What each thread's session ran on (#674), from its record of its conditions — the models a
  // comparison by Enso's model reads, each once, whatever else the evidence holds.
  const ranOn = (provider: string, modelId: string): string =>
    JSON.stringify({ conditions: { model: { provider, modelId } } })
  writeFileSync(join(evidence, `thread-${SHOWN}-manifest.json`), ranOn('anthropic', 'claude-fable-5'))
  writeFileSync(join(evidence, `thread-${UNSEEN}-manifest.json`), ranOn('anthropic', 'claude-haiku-4-5'))
  writeFileSync(join(evidence, `thread-${FORK}-manifest.json`), ranOn('anthropic', 'claude-fable-5'))
  writeFileSync(join(evidence, 'thread-torn-manifest.json'), '{"conditions":')
  const projectId = projectIdOf(realpathOrSelf(project))
  writeFileSync(
    join(evidence, 'stored-threads.json'),
    JSON.stringify([
      { threadId: SHOWN, projectId, messageCount: 4, lastActivityAt: 'x', busy: false },
      { threadId: UNSEEN, projectId: 'another-project', messageCount: 9, lastActivityAt: 'x', busy: false },
    ]),
  )
  // A manifest written before #680 names no perception: every run then read the tree.
  const { perception: _dropped, ...beforePerception } = foldArenaManifest({
    runId: 'snake-2',
    events: readTimeline(join(runDirectory, 'timeline.jsonl')),
    evidence: [],
  })
  writeFileSync(join(runDirectory, 'manifest.json'), JSON.stringify(beforePerception))

  const input = readArenaScoreInput(runDirectory)
  // The project (git, one untracked file) and the thread's own tree (not a repository, one file): both counted.
  expect(input.project).toEqual({ changedFiles: 2, commits: 0, workspaces: [project, tree] })
  expect(input.projectThreads).toEqual([{ threadId: SHOWN, messageCount: 4 }])
  expect(input.logRecords).toHaveLength(1)
  expect(input.ensoModels).toEqual(['anthropic/claude-fable-5', 'anthropic/claude-haiku-4-5'])
  expect(input.manifest.perception).toBe('tree')

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

test('⚠ a known secret in a file the run keeps fails a run that otherwise passes; an unreadable trace only warns (#610)', () => {
  const clean = inputOf(AGENT_RUN)
  const withScan = (secretScan: NonNullable<ArenaScoreInput['manifest']['secretScan']>): ArenaScoreInput => ({
    ...clean,
    manifest: { ...clean.manifest, secretScan },
  })
  const leaked = scoreArenaRun(
    withScan({
      files: 9,
      entries: 40,
      hits: [{ path: 'trace/trace-000.zip', entry: 'resources/abc.json' }],
      unreadable: [],
    }),
  )
  expect(leaked).toMatchObject({ verdict: 'fail', errors: 1 })
  expect(leaked.problems[0]).toEqual({
    severity: 'error',
    source: 'evidence',
    message: 'a known secret is in a file the run keeps',
    count: 1,
    examples: ['trace/trace-000.zip › resources/abc.json'],
  })

  const unread = scoreArenaRun(
    withScan({
      files: 9,
      entries: 0,
      hits: [],
      unreadable: [{ path: 'trace/trace-001.zip', error: 'zip64 is not read' }],
    }),
  )
  expect(unread).toMatchObject({ verdict: 'pass', errors: 0 })
  expect(unread.problems.map((problem) => problem.message)).toContain('not scanned for secrets')
})

test('⚠ the call the runner aborts after the agent’s own stop is not a failed model call; one before it still is (#611)', () => {
  const stopAnswer = {
    role: 'toolResult',
    content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { stopping: true }, phase: 'running' }) }],
  }
  const aborted = { role: 'assistant', stopReason: 'error', errorMessage: 'The operation was aborted.' }
  const failures = (transcript: unknown[]): string[] =>
    scoreArenaRun(inputOf(AGENT_RUN, { transcript }))
      .problems.filter((problem) => problem.message.startsWith('a model call failed'))
      .map((problem) => problem.message)

  // The reference run's shape: note and stop in one batch, then the call the stop aborted.
  expect(failures([{ role: 'user' }, stopAnswer, aborted])).toEqual([])
  // A model call that fails before any stop is still the agent's failure.
  expect(failures([{ role: 'user' }, aborted, stopAnswer])).toEqual(['a model call failed: The operation was aborted.'])
  // A stop the recorder refused (the run had already stopped) is not the agent's own stop.
  const refusedStop = {
    role: 'toolResult',
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'stopped' }) }],
  }
  expect(failures([{ role: 'user' }, refusedStop, aborted])).toEqual([
    'a model call failed: The operation was aborted.',
  ])
})
