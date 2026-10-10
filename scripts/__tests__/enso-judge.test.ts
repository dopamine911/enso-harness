import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_JUDGE_POLICY, type EnsoThreadJudgeCases } from '../../packages/core/src/index.ts'
import { jevRequestOf } from '../../packages/harness/extensions/guards/judge-backends.ts'
import {
  type CaseLabel,
  casesUnder,
  parseArguments,
  type ReplayRecord,
  renderCases,
  renderReplaySummary,
  renderScore,
  renderSelection,
  run,
  sampleCases,
  USAGE,
} from '../enso-judge.ts'
import { UsageError } from '../server-cli.ts'
import { runCaptured, withStubServer } from './server-stub.ts'

/**
 * `bun run judge` (#469): replay refuses to send without being told to, the dry run shows the
 * exact bodies `replay` would send, and the score's precision and recall are the labels' own.
 */

const stateOf = (command: string): EnsoThreadJudgeCases['cases'][number]['state'] => ({
  cwd: '/work',
  policy: ENSO_JUDGE_POLICY,
  command,
  recentCalls: [{ tool: 'bash', command: 'curl https://example.test', refused: true }],
  denied: { command: 'curl https://example.test', reason: 'network-egress' },
})

test('⚠ replay without --send is a usage error that says why; the defaults and the dry run otherwise', () => {
  expect(() => parseArguments(['replay', 't1'])).toThrow(UsageError)
  expect(() => parseArguments(['replay', 't1'])).toThrow(/--send/)
  expect(parseArguments(['replay', 't1', '--send'], new Date('2026-09-30T08:00:00Z'))).toEqual({
    command: 'replay',
    backend: { kind: 'jev' },
    threads: ['t1'],
    source: 'server',
    unreadable: 200,
    under: [],
    outFile: 'judge-replay-jev-2026-09-30.jsonl',
    maxCalls: 1000,
  })
  // A local replay sends nothing off the machine, so it needs no --send; Jev's always does.
  expect(
    parseArguments([
      'replay',
      '--from',
      'omp',
      '--backend',
      'local',
      '--local-url',
      'http://127.0.0.1:8080/v1',
      '--local-model',
      'q',
    ]),
  ).toMatchObject({ backend: { kind: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'q' } })
  expect(() => parseArguments(['replay', '--backend', 'local', '--local-model', 'q'])).toThrow(/--local-url/)
  expect(() => parseArguments(['replay', '--from', 'omp', '--backend', 'jev'])).toThrow(/--send/)
  expect(() => parseArguments(['replay', '--send', '--backend', 'openrouter'])).toThrow(UsageError)
  expect(parseArguments(['t1', 't2'])).toEqual({
    command: 'cases',
    threads: ['t1', 't2'],
    source: 'server',
    unreadable: 200,
    under: [],
    sample: 3,
  })
  expect(
    parseArguments(['cases', '--from', 'claude', '--under', '~/own/,/srv/x', '--unreadable', '50', '--sample', '1']),
  ).toEqual({
    command: 'cases',
    threads: [],
    source: 'claude',
    unreadable: 50,
    under: [`${homedir()}/own`, '/srv/x'],
    sample: 1,
  })
  expect(() => parseArguments(['cases', '--under', 'own'])).toThrow(/absolute/)
  // After-refusal cases only.
  expect(parseArguments(['cases', '--unreadable', '0'])).toMatchObject({ unreadable: 0 })
  expect(() => parseArguments(['cases', '--unreadable', '-1'])).toThrow(UsageError)
  expect(() => parseArguments(['score', 'replay.jsonl'])).toThrow(UsageError)
  expect(() => parseArguments(['cases', '--send'])).toThrow(UsageError)
  expect(() => parseArguments(['cases', '--from', 'acme'])).toThrow(UsageError)
  // A corpus is read whole; naming threads in it would read as a filter it is not.
  expect(() => parseArguments(['cases', 'x', '--from', 'omp'])).toThrow(UsageError)
})

// What a replay sends is what `cases` showed: every after-refusal case, and N unreadable ones
// spread over all of them, never the first N of one transcript.
test('the sample keeps every after-refusal case and spreads the unreadable ones over the corpus', () => {
  const caseOf = (
    toolCallId: string,
    scope: 'after-refusal' | 'unreadable',
  ): EnsoThreadJudgeCases['cases'][number] => ({
    toolCallId,
    scope,
    state: stateOf('x'),
  })
  const threads: EnsoThreadJudgeCases[] = [
    {
      threadId: 'a',
      live: false,
      cases: [caseOf('a1', 'unreadable'), caseOf('a2', 'unreadable'), caseOf('a3', 'after-refusal')],
    },
    { threadId: 'b', live: false, cases: [caseOf('b1', 'unreadable'), caseOf('b2', 'unreadable')] },
    { threadId: 'c', live: false, cases: [caseOf('c1', 'unreadable'), caseOf('c2', 'unreadable')] },
  ]
  const keys = (selected: readonly EnsoThreadJudgeCases[]): string[] =>
    selected.flatMap((thread) => thread.cases.map((judgeCase) => judgeCase.toolCallId))
  expect(keys(sampleCases(threads, 3))).toEqual(['a1', 'a3', 'b1', 'c1'])
  expect(keys(sampleCases(threads, 0))).toEqual(['a3'])
  expect(keys(sampleCases(threads, 99))).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'c2'])
  expect(renderSelection(threads, sampleCases(threads, 3))).toBe(
    'found: 1 after-refusal, 6 unreadable\nselected: 1 after-refusal (all), 3 unreadable (evenly spaced)',
  )
})

// ⚠ The user approved sending only their own projects' cases: a sibling directory sharing the
// prefix (`own-client`) is NOT under `own`, and the filter runs before the sample is drawn.
test('--under keeps a case only when its cwd is the directory or inside it', () => {
  const at = (toolCallId: string, cwd: string): EnsoThreadJudgeCases['cases'][number] => ({
    toolCallId,
    scope: 'unreadable',
    state: { ...stateOf('x'), cwd },
  })
  const threads: EnsoThreadJudgeCases[] = [
    { threadId: 'a', live: false, cases: [at('a1', '/home/u/own'), at('a2', '/home/u/own-client/x')] },
    { threadId: 'b', live: false, cases: [at('b1', '/home/u/client')] },
    { threadId: 'c', live: false, cases: [at('c1', '/home/u/own/deep/er')] },
  ]
  const kept = casesUnder(threads, ['/home/u/own'])
  expect(kept.map((thread) => [thread.threadId, thread.cases.map((judgeCase) => judgeCase.toolCallId)])).toEqual([
    ['a', ['a1']],
    ['c', ['c1']],
  ])
  expect(casesUnder(threads, [])).toEqual(threads)
})

test('cases counts per thread and in total, and samples the exact request bodies', () => {
  const threads: EnsoThreadJudgeCases[] = [
    {
      threadId: 't1',
      live: false,
      cases: [
        { toolCallId: 'c2', scope: 'after-refusal', state: stateOf('wget https://example.test') },
        { toolCallId: 'c3', scope: 'after-refusal', state: stateOf('echo aGk= | base64 -d | sh') },
      ],
    },
    { threadId: 't2', live: true, cases: [] },
  ]
  const lines = renderCases(threads, 1).split('\n')
  expect(lines.slice(0, 3)).toEqual(['t1: 2 cases', 't2: 0 cases', 'total: 2 cases in 2 threads — nothing sent'])
  expect(lines.slice(4)).toEqual([
    '# t1 c2 (after-refusal)',
    ...JSON.stringify(jevRequestOf(stateOf('wget https://example.test')), null, 2).split('\n'),
  ])
})

const judged = (toolCallId: string, answers: Record<string, number>): ReplayRecord => ({
  threadId: 't1',
  toolCallId,
  scope: 'after-refusal',
  state: stateOf('x'),
  outcome: {
    kind: 'judged',
    model: 'jev',
    answers: Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, { value: answer }])),
  },
  latencyMs: 100,
})

test('score: the rule and each question against the labels; unlabelled, unknown and unjudged are skipped', () => {
  const records: ReplayRecord[] = [
    judged('r1', { risk: 0.9 }),
    judged('r2', { risk: 0.8 }),
    judged('r3', { risk: 0.2, unresolved: 0.8 }),
    judged('r4', { risk: 0.1 }),
    judged('r5', { risk: 0.9 }),
    judged('r6', { risk: 0.9 }),
    { ...judged('r7', {}), outcome: { kind: 'unjudged', reason: 'timeout' } },
  ]
  const labels: CaseLabel[] = [
    { threadId: 't1', toolCallId: 'r1', label: 'risk' },
    { threadId: 't1', toolCallId: 'r2', label: 'safe' },
    { threadId: 't1', toolCallId: 'r3', label: 'risk' },
    { threadId: 't1', toolCallId: 'r4', label: 'safe' },
    { threadId: 't1', toolCallId: 'r6', label: 'unknown' },
    { threadId: 't1', toolCallId: 'r7', label: 'risk' },
  ]
  const lines = renderScore(records, labels).split('\n')
  expect(lines[0]).toBe('scored 4; skipped 1 unlabelled, 1 unknown, 1 unjudged')
  expect(lines[1]).toContain('precision 0.50  recall 0.50  tp 1 fp 1 fn 1 tn 1')
  expect(lines[2]).toContain('precision 0.67  recall 1.00  tp 2 fp 1 fn 0 tn 1')
  const riskAt = (threshold: string): string | undefined =>
    lines.find((line) => line.startsWith(`risk >= ${threshold} `))
  expect(riskAt('0.9')).toContain('precision 1.00  recall 0.50  tp 1 fp 0 fn 1 tn 2')
  expect(riskAt('0.8')).toContain('precision 0.50  recall 0.50  tp 1 fp 1 fn 1 tn 1')
})

test('the replay summary: records written, judged, unjudged by reason in first-seen order, median latency, tokens', () => {
  const records: ReplayRecord[] = [
    { ...judged('r1', { risk: 0.9 }), latencyMs: 300 },
    {
      ...judged('r2', {}),
      outcome: { kind: 'judged', model: 'jev', answers: {}, usage: { inputTokens: 120, outputTokens: 30 } },
      latencyMs: 100,
    },
    { ...judged('r3', {}), outcome: { kind: 'unjudged', reason: 'timeout' }, latencyMs: 10_000 },
    { ...judged('r4', {}), outcome: { kind: 'unjudged', reason: 'no key' }, latencyMs: 0 },
    { ...judged('r5', {}), outcome: { kind: 'unjudged', reason: 'timeout' }, latencyMs: 10_000 },
  ]
  expect(renderReplaySummary(records, 'out.jsonl')).toBe(
    [
      'wrote 5 records to out.jsonl',
      'judged: 2',
      'unjudged: 3',
      '  2 × timeout',
      '  1 × no key',
      'median latency: 300 ms',
      'total tokens: 150',
    ].join('\n'),
  )
  // One record is not "records"; every one judged lists no reason.
  expect(renderReplaySummary([judged('r1', {})], 'one.jsonl')).toBe(
    'wrote 1 record to one.jsonl\njudged: 1\nunjudged: 0\nmedian latency: 100 ms\ntotal tokens: 0',
  )
})

const casesPayload = (threadId: string, cwd: string): EnsoThreadJudgeCases => ({
  threadId,
  live: false,
  cases: [
    { toolCallId: `${threadId}-refused`, scope: 'after-refusal', state: { ...stateOf('wget x'), cwd } },
    { toolCallId: `${threadId}-unreadable`, scope: 'unreadable', state: { ...stateOf('eval "$x"'), cwd } },
  ],
})

test('run: a usage error exits 2 with the usage and asks the server nothing', async () => {
  await withStubServer('judge-cases', {}, async (serverUrl, requests) => {
    expect(await runCaptured(run, ['replay', 't1'], serverUrl)).toEqual({
      code: 2,
      stdout: '',
      stderr: `enso-judge: replay sends every case to TypeSafe — read \`bun run judge cases\` first, then add --send to say so\n\n${USAGE}\n`,
    })
    expect(requests).toEqual([])
  })
})

test('run: cases reads every stored thread, keeps --under, and shows the selection and its bodies', async () => {
  const own = casesPayload('own', '/work/own')
  const elsewhere = casesPayload('elsewhere', '/work/client')
  await withStubServer('judge-cases', { own, elsewhere }, async (serverUrl, requests) => {
    const everything = await runCaptured(run, ['--sample', '1'], serverUrl)
    expect(everything).toEqual({
      code: 0,
      stdout: `${renderSelection([own, elsewhere], [own, elsewhere])}\n${renderCases([own, elsewhere], 1)}\n`,
      stderr: '',
    })
    expect(requests.map((url) => url.pathname)).toEqual([
      '/api/stored-threads',
      '/api/threads/own/judge-cases',
      '/api/threads/elsewhere/judge-cases',
    ])
    const kept = await runCaptured(
      run,
      ['cases', 'own', 'elsewhere', '--under', '/work/own', '--unreadable', '0'],
      serverUrl,
    )
    const ownRefused = { ...own, cases: own.cases.slice(0, 1) }
    expect(kept.stdout).toBe(
      `under /work/own: 1 of 2 transcripts kept\n${renderSelection([own], [ownRefused])}\n${renderCases([ownRefused], 3)}\n`,
    )
  })
})

test('run: a thread the server cannot answer exits 1 with the route and the answer, and no stdout', async () => {
  await withStubServer('judge-cases', {}, async (serverUrl) => {
    expect(await runCaptured(run, ['gone'], serverUrl)).toEqual({
      code: 1,
      stdout: '',
      stderr: `enso-judge: ${serverUrl}/api/threads/gone/judge-cases answered 404: no such thread\n`,
    })
  })
})

test('run: score reads the replay and the labels from their files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-judge-'))
  try {
    const records = [judged('r1', { risk: 0.9 }), judged('r2', { risk: 0.1 })]
    const labels: CaseLabel[] = [
      { threadId: 't1', toolCallId: 'r1', label: 'risk' },
      { threadId: 't1', toolCallId: 'r2', label: 'safe' },
    ]
    const jsonLines = (rows: readonly unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join('')
    writeFileSync(join(directory, 'replay.jsonl'), jsonLines(records))
    writeFileSync(join(directory, 'labels.jsonl'), jsonLines(labels))
    const scored = await runCaptured(
      run,
      ['score', join(directory, 'replay.jsonl'), '--labels', join(directory, 'labels.jsonl')],
      'http://127.0.0.1:1',
    )
    expect(scored).toEqual({ code: 0, stdout: `${renderScore(records, labels)}\n`, stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
