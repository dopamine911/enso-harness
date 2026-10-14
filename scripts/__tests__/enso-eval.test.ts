import { expect, test } from 'bun:test'
import type { EnsoSessionEval } from '../../packages/core/src/index.ts'
import {
  type EvalIo,
  parseArguments,
  renderComparison,
  renderMarkdown,
  renderRow,
  renderRowHeader,
  ROW_FIELDS,
  run,
  USAGE,
  UsageError,
} from '../enso-eval.ts'

/**
 * `bun run eval` (#441): the flags, and the three renderings over one payload — the markdown's
 * running counters, the row that a header names column for column, the comparison table.
 */

const BASE: EnsoSessionEval = {
  threadId: 'thread-eval-abcdef',
  live: false,
  logDays: ['2026-09-28'],
  events: [
    { kind: 'human', index: 0, at: '2026-09-28T10:00:00.000Z', detail: 'check the tests', words: 3 },
    { kind: 'prompt-queued', at: '2026-09-28T10:00:01.000Z', detail: 'queued on run 1' },
    { kind: 'gate', index: 2, at: '2026-09-28T10:00:02.000Z', detail: 'bun test', outcome: 'pass' },
    { kind: 'ask-rejected', index: 4, at: '2026-09-28T10:00:03.000Z', detail: 'menu at [3] DECLINED' },
    { kind: 'human-correction', index: 5, at: '2026-09-28T10:00:04.000Z', detail: "no, that's wrong", words: 3 },
  ],
  scorecard: {
    entries: 6,
    span: ['2026-09-28T10:00:00.000Z', '2026-09-28T10:00:04.000Z'],
    humanMessages: 2,
    queuedMessages: 1,
    longestQueuedRun: 1,
    corrections: 1,
    confusionMessages: 0,
    interrupts: 0,
    assistantMessages: 2,
    toolCalls: 2,
    assistantPerHuman: 1,
    toolCallsPerHuman: 1,
    writes: 0,
    writesPerHuman: 0,
    askCalls: 1,
    askAnswered: 0,
    askRejected: 1,
    askRejectionRate: 1,
    operatorDenials: 0,
    guardRefusals: 0,
    ruleRefusals: 0,
    providerRefusals: 0,
    refusalsTotal: 1,
    gateRuns: 1,
    gatePassed: 1,
    gateFailed: 0,
    permissionModes: ['default', 'plan'],
    firstCorrectionAt: '2026-09-28T10:00:04.000Z',
    toolHistogram: { bash: 1, ask_user: 1 },
    canary: null,
    canaryPresent: null,
    signals: {
      S1_duplicateToolClusters: 0,
      S3_retryAfterErrorFires: 0,
      toolErrors: 0,
      nonZeroExits: 0,
      S5_outputCollapseSpans: 0,
      S19_timeGaps: 0,
      S20_rareCommandMatches: 0,
      S20_families: [],
      S20_fires: 0,
      S21_authorizationDriftFires: 0,
      S21_events: [],
    },
    dropped: ['S6 plan mode: none'],
    riskLevel: 'low',
    securitySignals: 0,
    riskSignals: [],
  },
}

test('flags: threads are positional; --json and --row exclude each other; --row-header needs no thread', () => {
  expect(parseArguments(['a', 'b', '--json'])).toEqual({
    threads: ['a', 'b'],
    json: true,
    row: false,
    rowHeader: false,
  })
  expect(parseArguments(['--row-header'])).toMatchObject({ threads: [], rowHeader: true })
  expect(() => parseArguments(['a', '--json', '--row'])).toThrow(UsageError)
  expect(() => parseArguments([])).toThrow(UsageError)
  expect(() => parseArguments(['a', '--nope'])).toThrow(UsageError)
})

test('the markdown carries the two running counters, f= for typed friction and r= for clicked refusals, and an unknown as —', () => {
  const markdown = renderMarkdown(BASE)
  const timeline = markdown.split('```')[1] ?? ''
  const counters = timeline
    .trim()
    .split('\n')
    .map((line) =>
      line
        .match(/f=(\d+)\s+r=(\d+)/)
        ?.slice(1)
        .join('/'),
    )
  // human 0/0 → queued 1/0 → gate 1/0 → ask-rejected 1/1 → correction 2/1
  expect(counters).toEqual(['0/0', '1/0', '1/0', '1/1', '2/1'])
  expect(timeline).toContain('[pass]')
  expect(markdown).toContain('| `permissionModes` | default → plan |')
  const unknown = renderMarkdown({
    ...BASE,
    logDays: [],
    scorecard: { ...BASE.scorecard, queuedMessages: null, interrupts: null },
  })
  expect(unknown).toContain('| `queuedMessages` | — |')
  expect(unknown).toContain('No log day was read')
})

test('the row and its header have the same columns, thread id first', () => {
  const header = renderRowHeader().split('\t')
  const row = renderRow(BASE).split('\t')
  expect(header).toEqual(['threadId', ...ROW_FIELDS])
  expect(row).toHaveLength(header.length)
  expect(row[0]).toBe(BASE.threadId)
  expect(row[header.indexOf('refusalsTotal')]).toBe('1')
})

test('the comparison table lines threads up as columns, one metric per row', () => {
  const other: EnsoSessionEval = {
    ...BASE,
    threadId: 'thread-eval-zzzzzz',
    scorecard: { ...BASE.scorecard, corrections: 4 },
  }
  const table = renderComparison([BASE, other])
  expect(table).toContain('| Metric | `thread-e` | `thread-e` |')
  expect(table).toContain('| `corrections` | 1 | 4 |')
})

/**
 * A stand-in for the server's eval route: each known thread's payload, `malformed` a body that is
 * no eval, anything else a 404. A `slow-` thread is held until another thread's request has
 * arrived, so it answers after one named later — a test can see the output keep argument order.
 * (A `slow-` thread must therefore never be asked for alone.)
 */
async function withEvalServer(
  payloads: readonly EnsoSessionEval[],
  body: (serverUrl: string, paths: string[]) => Promise<void>,
): Promise<void> {
  const paths: string[] = []
  const otherArrived = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      paths.push(pathname)
      const threadId = decodeURIComponent(pathname.split('/')[3] ?? '')
      if (threadId.startsWith('slow-')) await otherArrived.promise
      else otherArrived.resolve()
      if (threadId === 'malformed') return Response.json({ threadId, nothing: 'else' })
      const payload = payloads.find((each) => each.threadId === threadId)
      if (payload === undefined) return new Response('no such thread', { status: 404 })
      return Response.json(payload)
    },
  })
  try {
    await body(server.url.origin, paths)
  } finally {
    await server.stop(true)
  }
}

async function runCaptured(
  argv: readonly string[],
  serverUrl: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const io: EvalIo = {
    serverUrl,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const SLOW: EnsoSessionEval = { ...BASE, threadId: 'slow-thread-1' }

test('run: a usage error exits 2 with the problem and the usage on stderr, and asks the server nothing', async () => {
  await withEvalServer([BASE], async (serverUrl, paths) => {
    const result = await runCaptured(['a', '--json', '--row'], serverUrl)
    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: `enso-eval: --json and --row are each a whole output; choose one\n\n${USAGE}\n`,
    })
    expect(paths).toEqual([])
  })
})

test('run: --row-header alone prints the header and never reaches the server; with a thread, the row follows it', async () => {
  await withEvalServer([BASE], async (serverUrl, paths) => {
    expect(await runCaptured(['--row-header'], serverUrl)).toEqual({
      code: 0,
      stdout: `${renderRowHeader()}\n`,
      stderr: '',
    })
    expect(paths).toEqual([])

    const both = await runCaptured(['--row-header', BASE.threadId, '--row'], serverUrl)
    expect(both.code).toBe(0)
    expect(both.stdout).toBe(`${renderRowHeader()}\n${renderRow(BASE)}\n`)
    expect(paths).toEqual([`/api/threads/${BASE.threadId}/eval`])
  })
})

test('run: --json is the payload itself for one thread and an array in argument order for several', async () => {
  await withEvalServer([BASE, SLOW], async (serverUrl) => {
    const one = await runCaptured([BASE.threadId, '--json'], serverUrl)
    expect(one.code).toBe(0)
    expect(JSON.parse(one.stdout)).toEqual(BASE)

    // `slow-thread-1` answers last, yet comes first: the order is the arguments', not the answers'.
    const several = await runCaptured([SLOW.threadId, BASE.threadId, '--json'], serverUrl)
    expect(JSON.parse(several.stdout)).toEqual([SLOW, BASE])
  })
})

test('run: the markdown is one section per thread, with the comparison table only past one thread', async () => {
  await withEvalServer([BASE, SLOW], async (serverUrl) => {
    const one = await runCaptured([BASE.threadId], serverUrl)
    expect(one).toEqual({ code: 0, stdout: `${renderMarkdown(BASE)}\n`, stderr: '' })

    const several = await runCaptured([SLOW.threadId, BASE.threadId], serverUrl)
    expect(several.stdout).toBe(
      `${renderMarkdown(SLOW)}\n\n${renderMarkdown(BASE)}\n\n${renderComparison([SLOW, BASE])}\n`,
    )
  })
})

test('run: a thread the server cannot evaluate exits 1, naming the URL and its answer, and prints no partial output', async () => {
  await withEvalServer([BASE], async (serverUrl) => {
    const missing = await runCaptured([BASE.threadId, 'gone'], serverUrl)
    expect(missing).toEqual({
      code: 1,
      stdout: '',
      stderr: `enso-eval: ${serverUrl}/api/threads/gone/eval answered 404: no such thread\n`,
    })

    const malformed = await runCaptured(['malformed'], serverUrl)
    expect(malformed.code).toBe(1)
    expect(malformed.stderr).toBe(
      `enso-eval: ${serverUrl}/api/threads/malformed/eval: the payload did not match EnsoSessionEval\n`,
    )
  })
})

test('run: a thread id is one path segment, escaped, so a slash in it cannot reach another route', async () => {
  await withEvalServer([], async (serverUrl, paths) => {
    await runCaptured(['a/../b'], serverUrl)
    expect(paths).toEqual(['/api/threads/a%2F..%2Fb/eval'])
  })
})
