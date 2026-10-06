import { expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensoProjectsDir, projectIdOf, projectSnapshotsDir, realpathOrSelf } from '@enso/core/paths'
import {
  type ArenaAction,
  describeArenaAction,
  LONGEST_WAIT_MS,
  pageForChange,
  parseArenaAction,
  waitForPageChange,
  typedSecretRefusal,
} from '../actions.ts'
import { collectEnsoEvidence } from '../evidence.ts'
import { foldArenaManifest } from '../manifest.ts'
import { arenaActCommand, arenaBrief, arenaReviewBrief, githubRepositoryOf, SNAKE_SCENARIO } from '../scenario.ts'
import { type ArenaClock, type ArenaEventBody, openTimeline, pagePlace, readTimeline } from '../timeline.ts'

/**
 * Dogfood Arena's own logic (#556): what the agent may send, how the timeline is stamped and read
 * back, what the manifest folds out of it, and how missing Enso evidence is said. The recorder's
 * browser and process half is proven by a live run, not here.
 */

const THREAD = '0f6c1c4e-5a3b-4c55-9d43-6c1f0a8e2b71'

/** A clock one second further on at each event: the k-th event is at 12:00:0k, k seconds into the run. */
function steppingClock(): ArenaClock {
  let tick = 0
  return {
    wallNow: () => new Date(Date.UTC(2026, 9, 1, 12, 0, ++tick)),
    monotonicNow: () => tick * 1000,
  }
}

test('an action is only what a reader of the page could do', () => {
  expect(parseArenaAction({ action: 'click', target: { role: 'button', name: 'send', nth: 1 } })).toEqual({
    ok: true,
    action: { action: 'click', target: { role: 'button', name: 'send', nth: 1 } },
  })
  expect(parseArenaAction({ action: 'fill', target: { placeholder: 'ask' }, text: '' })).toMatchObject({ ok: true })
  expect(parseArenaAction({ action: 'press', key: 'Enter' })).toEqual({
    ok: true,
    action: { action: 'press', key: 'Enter' },
  })
  // No selector, no test id, no script.
  expect(parseArenaAction({ action: 'click', target: { selector: '#send' } })).toMatchObject({ ok: false })
  expect(parseArenaAction({ action: 'evaluate', script: 'fetch("/api/threads")' })).toMatchObject({ ok: false })
  expect(parseArenaAction('click')).toMatchObject({ ok: false })
})

test('every action reads back as one line, and a malformed one says what it takes', () => {
  const lines = [
    { action: 'goto', path: '/' },
    { action: 'hover', target: { text: 'Stats', nth: 2 } },
    { action: 'select', target: { label: 'Mode' }, option: 'default' },
    { action: 'press', key: 'Escape', target: { role: 'dialog' } },
    { action: 'press', key: 'Enter' },
    { action: 'wait', ms: 5 },
    { action: 'note', note: 'friction', trying: 'a', happened: 'b' },
    { action: 'stop', reason: 'done' },
    { action: 'stop' },
    { action: 'reload' },
  ].map((request) => {
    const parsed = parseArenaAction(request)
    if (!parsed.ok) throw new Error(parsed.error)
    return describeArenaAction(parsed.action, [])
  })
  expect(lines).toEqual([
    'goto /',
    'hover text "Stats" #2',
    'select "default" in label "Mode"',
    'press Escape in dialog',
    'press Enter',
    'wait 5 ms',
    'note friction',
    'stop: done',
    'stop',
    'reload',
  ])
  for (const malformed of [
    { action: 'fill', target: { label: 'x' } },
    { action: 'select', target: { label: 'x' } },
    { action: 'press' },
    { action: 'press', key: 'Enter', target: 'composer' },
    { action: 'wait', ms: -1 },
    { action: 'click', target: { role: '' } },
  ]) {
    expect(parseArenaAction(malformed)).toMatchObject({ ok: false })
  }
})

test('goto stays on the web origin and off the API', () => {
  expect(parseArenaAction({ action: 'goto', path: '/?thread=abc' })).toEqual({
    ok: true,
    action: { action: 'goto', path: '/?thread=abc' },
  })
  for (const path of [
    '/api/threads',
    '/api',
    '/api?x=1',
    'http://127.0.0.1:5179/api/threads',
    '//evil.example/',
    'debug.html',
    // As the browser reads them, not as typed (PR #562 review): encoded, dot-segment, case and backslash forms.
    '/%61pi/threads',
    '/%2561pi/threads',
    '/x/../api/threads',
    '/./api',
    '/x/%252e%252e/api/threads',
    '/API/threads',
    '/\\evil.example/',
    '/%E0%A4%A',
  ]) {
    expect(parseArenaAction({ action: 'goto', path })).toMatchObject({ ok: false })
  }
})

test('a wait is capped, a note needs what was tried and what happened', () => {
  expect(parseArenaAction({ action: 'wait', ms: 10 * LONGEST_WAIT_MS })).toEqual({
    ok: true,
    action: { action: 'wait', ms: LONGEST_WAIT_MS },
  })
  expect(parseArenaAction({ action: 'note', note: 'wish', trying: 'find the diff' })).toMatchObject({ ok: false })
  expect(parseArenaAction({ action: 'note', note: 'complaint', trying: 'a', happened: 'b' })).toMatchObject({
    ok: false,
  })
  expect(parseArenaAction({ action: 'note', note: 'wish', trying: 'a', happened: 'b', wanted: 'c' })).toEqual({
    ok: true,
    action: { action: 'note', note: 'wish', trying: 'a', happened: 'b', wanted: 'c' },
  })
})

test('a wait until change is parsed, capped and worded as one; any other `until` is refused (#637)', () => {
  expect(parseArenaAction({ action: 'wait', ms: 10 * LONGEST_WAIT_MS, until: 'change' })).toEqual({
    ok: true,
    action: { action: 'wait', ms: LONGEST_WAIT_MS, until: 'change' },
  })
  expect(parseArenaAction({ action: 'wait', ms: 1000, until: 'idle' })).toEqual({
    ok: false,
    error: 'wait "until" takes "change"',
  })
  expect(describeArenaAction({ action: 'wait', ms: 60_000, until: 'change' }, [])).toBe(
    'wait until change, up to 60000 ms',
  )
  expect(describeArenaAction({ action: 'wait', ms: 30_000 }, [])).toBe('wait 30000 ms')
})

// ⚠ #637, measured on a live run: while a permission card waits, the rail's relative age is the only
// thing on the page that moves (now → 6s → 11s … → 1m). A wait that counted it would return at once.
test('⚠ the rail’s ages are not a change; a new control is', () => {
  const waiting = (age: string): string =>
    `- button "waiting on you Write notes.md… ${age}"\n- button "Yes"\n- text: limit 5s per call`
  for (const age of ['6s', '1m', '3h', '2d']) expect(pageForChange(waiting(age))).toBe(pageForChange(waiting('now')))
  // A count of seconds inside a name, not ending it, is the page's words and stays.
  expect(pageForChange('- text: limit 5s per call')).toBe('- text: limit 5s per call')
  expect(pageForChange(`${waiting('6s')}\n- button "No"`)).not.toBe(pageForChange(waiting('6s')))
})

/** A clock that moves only when the wait sleeps: each outcome's `waitedMs` is exact. */
function sleepingClock(): { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } {
  let at = 0
  return {
    now: () => at,
    sleep: (ms) => {
      at += ms
      return Promise.resolve()
    },
  }
}

test('⚠ a wait until change returns at the first look that differs, and at its limit unchanged (#637)', async () => {
  const looks = ['same', 'same', 'card']
  const changed = await waitForPageChange({
    baseline: 'same',
    look: () => Promise.resolve(looks.shift() ?? 'card'),
    ms: 60_000,
    pollMs: 1000,
    ...sleepingClock(),
  })
  expect(changed).toEqual({ changed: true, waitedMs: 3000 })
  expect(looks).toEqual([])

  // Nothing moves: it waits out the limit exactly, the last sleep cut to fit.
  const unchanged = await waitForPageChange({
    baseline: 'same',
    look: () => Promise.resolve('same'),
    ms: 2500,
    pollMs: 1000,
    ...sleepingClock(),
  })
  expect(unchanged).toEqual({ changed: false, waitedMs: 2500 })
})

test('what the agent typed reaches the timeline redacted', () => {
  const secret = 'sk-live-notarealsecret-0123456789'
  const parsed = parseArenaAction({ action: 'fill', target: { label: 'Prompt' }, text: `use API_KEY=${secret} please` })
  if (!parsed.ok) throw new Error(parsed.error)
  const line = describeArenaAction(parsed.action, [secret])
  expect(line).toStartWith('fill label "Prompt" with ')
  expect(line).not.toContain(secret)
  // A refused `select` is recorded by this line too (PR #562 review): its option is redacted the same way.
  const selected = parseArenaAction({ action: 'select', target: { label: 'Key' }, option: secret })
  if (!selected.ok) throw new Error(selected.error)
  expect(describeArenaAction(selected.action, [secret])).not.toContain(secret)
})

test('text that looks like a credential is never typed into the page', () => {
  const secret = 'notarealsecret-known-value-0123'
  const action = (request: unknown): ArenaAction => {
    const parsed = parseArenaAction(request)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.action
  }
  const target = { label: 'Prompt' }
  expect(typedSecretRefusal(action({ action: 'fill', target, text: `here: ${secret}` }), [secret])).toStartWith(
    'refused',
  )
  expect(
    typedSecretRefusal(action({ action: 'fill', target, text: 'Authorization: Bearer abc.def.ghi' }), []),
  ).toStartWith('refused')
  expect(typedSecretRefusal(action({ action: 'select', target, option: secret }), [secret])).toStartWith('refused')
  expect(typedSecretRefusal(action({ action: 'fill', target, text: 'build a snake game' }), [secret])).toBeUndefined()
  expect(typedSecretRefusal(action({ action: 'click', target }), [secret])).toBeUndefined()
})

test('the page place names the thread its URL names, and only a real thread id', () => {
  expect(pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`)).toEqual({
    url: `http://127.0.0.1:5178/?thread=${THREAD}`,
    threadId: THREAD,
  })
  expect(pagePlace('http://127.0.0.1:5178/?thread=../../etc')).toEqual({
    url: 'http://127.0.0.1:5178/?thread=../../etc',
  })
  expect(pagePlace('about:blank')).toEqual({ url: 'about:blank' })
  expect(pagePlace('not a url')).toEqual({ url: 'not a url' })
})

test('the timeline is stamped, on disk at once, and survives a torn last line', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-timeline-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  timeline.record({ kind: 'run-start', scenario: 'snake', project: '/p' })
  expect(readTimeline(path)).toHaveLength(1)
  timeline.record({ kind: 'navigation' }, pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`))
  appendFileSync(path, '{"kind":"screensh')
  const events = readTimeline(path)
  expect(events.map((event) => event.kind)).toEqual(['run-start', 'navigation'])
  expect(events[1]).toMatchObject({ at: '2026-10-01T12:00:02.000Z', elapsedMs: 2000, page: { threadId: THREAD } })
  expect(readTimeline(join(tmpdir(), 'no-such-timeline.jsonl'))).toEqual([])
})

test('the manifest joins screenshots to threads and keeps the agent’s notes apart from what was observed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-manifest-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`)
  timeline.record({
    kind: 'run-start',
    scenario: 'snake',
    project: '/p',
    ensoBuild: { commit: 'abc123', dirty: true, diffHash: 'f00d' },
  })
  timeline.record({ kind: 'screenshot', cause: 'sample', path: '/s/0.png' }, pagePlace('http://127.0.0.1:5178/'))
  timeline.record(
    { kind: 'action', via: 'control', action: 'click', detail: 'click button "x"', outcome: 'ok', durationMs: 5 },
    inThread,
  )
  timeline.record(
    {
      kind: 'action',
      via: 'control',
      action: 'click',
      detail: 'click button "y"',
      outcome: 'failed',
      error: 'timeout',
      durationMs: 9,
    },
    inThread,
  )
  timeline.record({ kind: 'screenshot', cause: 'action-failed', path: '/s/1.png' }, inThread)
  timeline.record({ kind: 'console-error', text: 'boom' }, inThread)
  timeline.record({ kind: 'enso-exit', exit: '1' })
  timeline.record({ kind: 'trace-chunk', path: '/t/trace-000.zip' })
  timeline.record({ kind: 'recorder-error', during: 'trace chunk', error: 'Must start tracing before stopping' })
  timeline.record(
    { kind: 'note', via: 'control', note: 'wish', trying: 'see the diff', happened: 'no button', wanted: 'a diff tab' },
    inThread,
  )
  timeline.record({
    kind: 'workspace-sample',
    workspaces: [{ path: 'project', files: 1, bytes: 4, fingerprint: 'aa' }],
  })
  timeline.record({ kind: 'run-stop', reason: 'budget: 1 minutes' })

  const manifest = foldArenaManifest({
    runId: 'snake-1',
    events: readTimeline(path),
    evidence: [{ kind: 'stats', status: 'missing', reason: 'down' }],
  })
  expect(manifest).toMatchObject({
    runId: 'snake-1',
    scenario: 'snake',
    project: '/p',
    ensoBuild: { commit: 'abc123', dirty: true, diffHash: 'f00d' },
    filesystem: [
      {
        at: expect.any(String),
        elapsedMs: expect.any(Number),
        workspaces: [{ path: 'project', files: 1, bytes: 4, fingerprint: 'aa' }],
      },
    ],
    stopReason: 'budget: 1 minutes',
    traceChunks: ['/t/trace-000.zip'],
    actions: { total: 2, failed: 1 },
    observed: { consoleErrors: 1, ensoExits: 1, pageErrors: 0 },
    // No agent runner: whoever sent these had a shell, and the manifest says the boundary did not hold.
    driver: { kind: 'control' },
    boundary: { held: false, actionsBy: { agent: 0, control: 3 } },
  })
  expect(manifest.screenshots.map((shot) => [shot.cause, shot.threadId])).toEqual([
    ['sample', undefined],
    ['action-failed', THREAD],
  ])
  expect(manifest.threads).toEqual([
    {
      threadId: THREAD,
      firstSeenAt: '2026-10-01T12:00:03.000Z',
      lastSeenAt: '2026-10-01T12:00:10.000Z',
      screenshots: 1,
      actions: 2,
    },
  ])
  expect(manifest.agentNotes.wish).toEqual([
    {
      at: '2026-10-01T12:00:10.000Z',
      elapsedMs: 10_000,
      trying: 'see the diff',
      happened: 'no button',
      wanted: 'a diff tab',
      threadId: THREAD,
    },
  ])
  expect(manifest.agentNotes.friction).toEqual([])
  // A chunk the recorder failed to write is named, not only absent from `traceChunks`.
  expect(manifest.recorderErrors).toEqual([
    {
      at: '2026-10-01T12:00:09.000Z',
      elapsedMs: 9000,
      during: 'trace chunk',
      error: 'Must start tracing before stopping',
    },
  ])
})

test('every observed signal is counted by its own kind', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-observed-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  timeline.record({ kind: 'request-failed', request: 'GET /x', failure: 'net::ERR_ABORTED' })
  timeline.record({ kind: 'request-failed', request: 'GET /y', failure: 'net::ERR_FAILED' })
  timeline.record({ kind: 'response-error', request: 'GET /z', status: 404 })
  timeline.record({ kind: 'dialog', dialog: 'confirm', message: 'leave?' })
  timeline.record({ kind: 'page-crash' })
  timeline.record({ kind: 'page-error', text: 'TypeError' })
  timeline.record({ kind: 'console-error', text: 'boom' })
  timeline.record({ kind: 'enso-exit', exit: '1' })
  timeline.record({ kind: 'enso-exit', exit: 'SIGKILL' })
  expect(foldArenaManifest({ runId: 'r', events: readTimeline(path), evidence: [] }).observed).toEqual({
    consoleErrors: 1,
    pageErrors: 1,
    failedRequests: 2,
    httpErrors: 1,
    dialogs: 1,
    pageCrashes: 1,
    ensoExits: 2,
  })
})

test('a run whose recorder died says so', () => {
  expect(foldArenaManifest({ runId: 'r', events: [], evidence: [] })).toMatchObject({
    scenario: 'unknown',
    stopReason: 'not stopped',
  })
})

test('Enso evidence: collected bodies are redacted, everything else is a missing row naming why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-evidence-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const secret = 'sk-live-notarealsecret-0123456789'
  const rows = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence'),
    threadIds: [THREAD],
    home,
    project,
    secretValues: [secret],
    fetchText: (url) => {
      if (url.endsWith('/api/about')) return Promise.reject(new Error('refused'))
      if (url.includes('/events')) return Promise.resolve({ status: 404, text: 'no such thread' })
      return Promise.resolve({ status: 200, text: `{"said":"${secret}"}` })
    },
  })
  const byKind = new Map(rows.map((row) => [row.kind, row]))
  const threads = byKind.get('live threads')
  if (threads?.status !== 'collected') throw new Error('live threads not collected')
  expect(readFileSync(threads.path, 'utf8')).not.toContain(secret)
  expect(byKind.get('about')).toMatchObject({ status: 'missing', reason: expect.stringContaining('refused') })
  expect(byKind.get(`thread ${THREAD} events`)).toMatchObject({
    status: 'missing',
    reason: expect.stringContaining('404'),
  })
  expect(byKind.get('snapshot store')).toMatchObject({ status: 'missing' })
  expect(byKind.get('diff viewer')).toMatchObject({ status: 'missing' })

  // With a thread in the project's snapshot store (#551), the store is collected — as the run's
  // own copy (#607): the row names the copy, never the home.
  const store = projectSnapshotsDir(ensoProjectsDir(home), projectIdOf(realpathOrSelf(project)))
  mkdirSync(join(store, THREAD), { recursive: true })
  const again = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence-2'),
    threadIds: [],
    home,
    project,
    secretValues: [],
    fetchText: () => Promise.resolve({ status: 200, text: '[]' }),
  })
  const copy = join(root, 'evidence-2', 'snapshot-store')
  expect(again.find((row) => row.kind === 'snapshot store')).toEqual({
    kind: 'snapshot store',
    status: 'collected',
    path: copy,
  })
  expect(existsSync(join(copy, THREAD))).toBe(true)
  expect(again.find((row) => row.kind === 'threads')).toMatchObject({ status: 'missing' })
  expect(existsSync(join(root, 'evidence-2', 'stats.json'))).toBe(true)
})

test('the brief carries the assignment verbatim and no internals', () => {
  for (const channel of ['tool', 'command'] as const) {
    const brief = arenaBrief(SNAKE_SCENARIO, channel)
    expect(brief).toContain(SNAKE_SCENARIO.assignment)
    expect(brief).not.toContain('/api')
    expect(brief).not.toContain('5179')
  }
  // The agent runner's brief names its one tool and no command: it has no shell to run one in.
  expect(arenaBrief(SNAKE_SCENARIO, 'tool')).not.toContain('bun run')
  expect(arenaBrief(SNAKE_SCENARIO, 'tool')).toContain('only tool you have')
  expect(arenaBrief(SNAKE_SCENARIO, 'command')).toContain('bun run arena act')
})

test('the boundary holds only when the agent had the one UI tool and every action came through it', () => {
  const fold = (bodies: readonly ArenaEventBody[]): ReturnType<typeof foldArenaManifest> => {
    const path = join(mkdtempSync(join(tmpdir(), 'arena-boundary-')), 'timeline.jsonl')
    const timeline = openTimeline(path, steppingClock())
    for (const body of bodies) timeline.record(body)
    return foldArenaManifest({ runId: 'r', events: readTimeline(path), evidence: [] })
  }
  const agentStart = (tools: readonly string[]): ArenaEventBody => ({
    kind: 'agent-start',
    provider: 'anthropic',
    model: 'm',
    thinking: 'medium',
    tools,
  })
  const read = (via: 'agent' | 'control'): ArenaEventBody => ({
    kind: 'action',
    via,
    action: 'read',
    detail: 'read',
    outcome: 'ok',
    durationMs: 1,
  })

  const held = fold([
    agentStart(['act']),
    read('agent'),
    { kind: 'agent-tool-refused', tool: 'bash' },
    { kind: 'note', via: 'agent', note: 'friction', trying: 'a', happened: 'b' },
    { kind: 'agent-end', reason: 'it stopped the run' },
  ])
  expect(held.boundary).toMatchObject({ held: true, actionsBy: { agent: 2, control: 0 } })
  expect(held.driver).toEqual({
    kind: 'agent',
    provider: 'anthropic',
    model: 'm',
    thinking: 'medium',
    tools: ['act'],
    refusedToolCalls: ['bash'],
    endReason: 'it stopped the run',
  })
  // A tool beyond the UI, an action that came in another way, or no UI tool at all: not held, and why.
  expect(fold([agentStart(['act', 'bash']), read('agent')]).boundary).toMatchObject({
    held: false,
    why: expect.stringContaining('bash'),
  })
  expect(fold([agentStart(['act']), read('agent'), read('control')]).boundary).toMatchObject({
    held: false,
    why: expect.stringContaining('control endpoint'),
  })
  expect(fold([agentStart([])]).boundary).toMatchObject({ held: false })
  // A line written before `via` existed counts as the control endpoint's, never as the agent's.
  const legacy = JSON.parse(JSON.stringify(read('agent'))) as Record<string, unknown>
  delete legacy.via
  expect(fold([agentStart(['act']), legacy as unknown as ArenaEventBody]).boundary.held).toBe(false)
})

test('over the act command the brief runs in three phases, naming the run, its evidence and where bugs go', () => {
  const run = '/runs/snake-2026-10-03T14-00-00Z'
  const brief = arenaBrief(SNAKE_SCENARIO, 'command', {
    act: arenaActCommand('/runs'),
    runDirectory: run,
    repository: 'owner/enso',
  })
  const phases = ['# Phase 1: the assignment', '# Phase 2: review the experience', '# Phase 3: file the bugs']
  const at = phases.map((phase) => brief.indexOf(phase))
  expect(at.every((index) => index >= 0)).toBe(true)
  expect(at).toEqual(at.toSorted((left, right) => left - right))
  expect(brief).toContain(`bun run arena act --out '/runs' '<json>'`)
  expect(brief).toContain(`${run}/manifest.json`)
  expect(brief).toContain(`${run}/review.md`)
  expect(brief).toContain('Your memory of the run is not the evidence')
  // Duplicates are searched before anything is filed, and what is filed says it is unverified (#556).
  expect(brief).toContain('gh issue list --repo owner/enso --state all')
  expect(brief).toContain('not yet verified by a person')
  expect(brief.indexOf('Search first')).toBeLessThan(brief.indexOf('Otherwise open one'))
})

test('the runner gets the assignment alone, and its review is a prompt of its own for afterwards', () => {
  // The runner's agent has no files: a review or a `gh` command in its brief could not be done.
  const tool = arenaBrief(SNAKE_SCENARIO, 'tool', { repository: 'owner/enso' })
  expect(tool).not.toContain('Phase 2')
  expect(tool).not.toContain('gh issue')
  const review = arenaReviewBrief({ runDirectory: '/runs/r', repository: 'owner/enso' }, 'other')
  expect(review).toStartWith('You are reviewing a Dogfood Arena run')
  expect(review).toContain('`/runs/r/brief.md`')
  expect(review).toContain("The agent's notes are its account, not the evidence")
  // On its own the review has no assignment before it, so it numbers its own phases from 1.
  expect(review).toContain('# Phase 1: review the experience')
  expect(review).toContain('# Phase 2: file the bugs')
  expect(review).not.toContain('Phase 3')
})

test('without a run or a repository the review asks for them instead of guessing', () => {
  const review = arenaReviewBrief({}, 'other')
  expect(review).toContain('`<run directory>/review.md`')
  expect(review).toContain('<the Enso repository, owner/name>')
})

test('the repository is read from a GitHub remote, and only from one', () => {
  expect(githubRepositoryOf('https://github.com/dopamine911/zen-harness-foundation\n')).toBe(
    'dopamine911/zen-harness-foundation',
  )
  expect(githubRepositoryOf('https://github.com/o/n.git')).toBe('o/n')
  expect(githubRepositoryOf('git@github.com:o/n.git')).toBe('o/n')
  expect(githubRepositoryOf('https://gitlab.com/o/n.git')).toBeUndefined()
  expect(githubRepositoryOf('/local/path')).toBeUndefined()
})

test('the act command carries a non-default --out, quoted', () => {
  expect(arenaActCommand()).toBe('bun run arena act')
  expect(arenaActCommand('/my runs')).toBe("bun run arena act --out '/my runs'")
  expect(arenaActCommand("/it's")).toBe("bun run arena act --out '/it'\\''s'")
})
