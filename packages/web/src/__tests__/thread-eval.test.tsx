import { expect, test } from 'bun:test'
import type { EnsoSessionEval } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadEvalView } from '../thread-eval.tsx'

/**
 * #441's Stats-tab panel: a static render of what the eval says it counted, what it could not,
 * and the timeline's two counters — never a verdict.
 */

const EVALUATED: EnsoSessionEval = {
  threadId: 'thread-eval-view',
  live: false,
  logDays: ['2026-09-29'],
  events: [
    { kind: 'human', index: 0, at: '2026-09-29T10:00:00.000Z', detail: 'check the tests', words: 3 },
    { kind: 'prompt-queued', detail: 'queued on run 1' },
    { kind: 'gate', index: 2, at: '2026-09-29T10:00:02.000Z', detail: 'bun test', outcome: 'fail' },
    { kind: 'tool-denied', index: 4, at: '2026-09-29T10:00:03.000Z', detail: 'operator denied Run command: No' },
    { kind: 'human-correction', index: 5, at: '2026-09-29T10:00:04.000Z', detail: "no, that's wrong", words: 3 },
  ],
  scorecard: {
    entries: 6,
    span: ['2026-09-29T10:00:00.000Z', '2026-09-29T10:00:04.000Z'],
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
    askCalls: 0,
    askAnswered: 0,
    askRejected: 0,
    askRejectionRate: null,
    operatorDenials: 1,
    guardRefusals: 0,
    providerRefusals: 0,
    refusalsTotal: 1,
    gateRuns: 1,
    gatePassed: 0,
    gateFailed: 1,
    permissionModes: ['default', 'acceptEdits'],
    firstCorrectionAt: '2026-09-29T10:00:04.000Z',
    toolHistogram: { bash: 1 },
    canary: null,
    canaryPresent: null,
    signals: {
      S1_duplicateToolClusters: 0,
      S3_retryAfterErrorFires: 1,
      toolErrors: 1,
      S5_outputCollapseSpans: 0,
      S19_timeGaps: 0,
      S20_rareCommandMatches: 0,
      S20_families: [],
      S20_fires: 0,
      S21_authorizationDriftFires: 1,
      S21_events: [
        { eventIndex: 9, humanIndex: 0, humanText: 'check the tests', action: 'push: git push', unattendedRun: 3 },
      ],
    },
    dropped: ['S6 plan mode entries and exits: pi has no plan mode attachment'],
  },
}

const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')

test('the panel says what it counted: the metrics, the refusal channels apart, the gate outcomes, the modes', () => {
  const rendered = text(renderToStaticMarkup(<ThreadEvalView outcome={{ kind: 'read', payload: EVALUATED }} />))
  expect(rendered).toContain('5 events')
  expect(rendered).toContain('from the file')
  expect(rendered).toContain('refusal channels 1 guard 0 · operator 1 · provider 0')
  expect(rendered).toContain('0 passed · 1 failed')
  expect(rendered).toContain('longest run 1')
  expect(rendered).toContain('modes default → acceptEdits')
  expect(rendered).toContain('first correction 10:00:04')
  expect(rendered).toContain('S21 push: git push after “check the tests” (3 unattended)')
  expect(rendered).toContain('S6 plan mode entries and exits')
})

test('⚠ the timeline carries the two counters per row, f= for what was typed and r= for what was clicked', () => {
  const markup = renderToStaticMarkup(<ThreadEvalView outcome={{ kind: 'read', payload: EVALUATED }} />)
  const counters = [...markup.matchAll(/f=(\d+)<\/span><span[^>]*>r=(\d+)/g)].map((match) => `${match[1]}/${match[2]}`)
  // human 0/0 → queued 1/0 → gate 1/0 → denied 1/1 → correction 2/1
  expect(counters).toEqual(['0/0', '1/0', '1/0', '1/1', '2/1'])
  // an event the log gave no stamp for (the queued prompt) shows a placeholder, not a broken slice
  expect(text(markup)).toContain('· · · >< f=1 r=0 prompt-queued')
  // a gate row carries its words-free detail and its outcome
  expect(text(markup)).toContain('gate bun test [fail]')
})

test('a log-side count with no day file read is —, not 0, and the panel says why', () => {
  const unknown: EnsoSessionEval = {
    ...EVALUATED,
    logDays: [],
    scorecard: { ...EVALUATED.scorecard, queuedMessages: null, longestQueuedRun: null, interrupts: null },
  }
  const rendered = text(renderToStaticMarkup(<ThreadEvalView outcome={{ kind: 'read', payload: unknown }} />))
  expect(rendered).toContain('queued prompts —')
  expect(rendered).toContain('interrupts —')
  expect(rendered).toContain('unknown, not zero')
  expect(rendered).not.toContain('longest run')
})

test('reading and failed outcomes are said as such', () => {
  expect(text(renderToStaticMarkup(<ThreadEvalView outcome={{ kind: 'reading' }} />))).toContain(
    "reading the thread's eval",
  )
  expect(
    text(renderToStaticMarkup(<ThreadEvalView outcome={{ kind: 'failed', problem: 'nothing has run' }} />)),
  ).toContain('no eval: nothing has run')
})
