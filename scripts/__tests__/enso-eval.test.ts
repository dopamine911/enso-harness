import { expect, test } from 'bun:test'
import type { EnsoSessionEval } from '../../packages/core/src/index.ts'
import {
  parseArguments,
  renderComparison,
  renderMarkdown,
  renderRow,
  renderRowHeader,
  ROW_FIELDS,
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
