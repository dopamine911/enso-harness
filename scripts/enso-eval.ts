#!/usr/bin/env bun

/**
 * A thread's session eval (#441), from the running server's `GET /api/threads/:id/eval`.
 *
 *   bun run eval <thread>                 markdown: scorecard, agent-side signals, timeline
 *   bun run eval <a> <b> …                the same per thread, then a comparison table
 *   bun run eval <thread> --json          the payload raw, for jq
 *   bun run eval <thread> --row           one tab-separated row, for sampling on an interval
 *   bun run eval --row-header             the row's column names, once, for the file the rows go to
 *
 * Reads THROUGH THE ROUTE, never the session file: `agent-host.ts` is the one file that opens
 * pi's sessions, and the route's cold path is that read — so the CLI, the route and a stored file
 * cannot disagree. The server address defaults to the dev server's; override with ENSO_SERVER_URL.
 *
 * The rendering is a port of `session-timeline.py`'s (attached to #441): the scorecard as a two-column
 * table, the signals under it, the timeline as one line per event with two running counters —
 * `f=` for what the operator TYPED (corrections, queued prompts, confusion, interrupts) and `r=`
 * for what the operator CLICKED (declined asks, denied prompts). They are kept apart because they
 * move at different times; a knee in either column is what the timeline exists to find.
 */

import {
  type EnsoEvalEvent,
  type EnsoEvalScorecard,
  type EnsoSessionEval,
  type EvalEventKind,
  readEnsoSessionEval,
  runningCounters,
} from '../packages/core/src/index.ts'

export interface EvalQuery {
  readonly threads: readonly string[]
  readonly json: boolean
  readonly row: boolean
  readonly rowHeader: boolean
}

export const USAGE = 'usage: bun run eval <thread> [<thread> …] [--json | --row]\n       bun run eval --row-header'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export function parseArguments(argv: readonly string[]): EvalQuery {
  const threads: string[] = []
  let json = false
  let row = false
  let rowHeader = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    if (argument === '--json') json = true
    else if (argument === '--row') row = true
    else if (argument === '--row-header') rowHeader = true
    else if (argument.startsWith('--')) throw new UsageError(`unknown flag ${argument}`)
    else threads.push(argument)
  }
  if (json && row) throw new UsageError('--json and --row are each a whole output; choose one')
  if (!rowHeader && threads.length === 0) throw new UsageError('name at least one thread')
  return { threads, json, row, rowHeader }
}

/** The scorecard rows the markdown shows, in order. */
const SCORECARD_KEYS = [
  'humanMessages',
  'queuedMessages',
  'longestQueuedRun',
  'corrections',
  'confusionMessages',
  'interrupts',
  'assistantMessages',
  'toolCalls',
  'assistantPerHuman',
  'toolCallsPerHuman',
  'writes',
  'writesPerHuman',
  'askCalls',
  'askAnswered',
  'askRejected',
  'askRejectionRate',
  'operatorDenials',
  'guardRefusals',
  'providerRefusals',
  'refusalsTotal',
  'gateRuns',
  'gatePassed',
  'gateFailed',
  'canary',
  'canaryPresent',
  'firstCorrectionAt',
] as const satisfies ReadonlyArray<keyof EnsoEvalScorecard>

const SIGNAL_KEYS = [
  'S1_duplicateToolClusters',
  'S3_retryAfterErrorFires',
  'toolErrors',
  'S5_outputCollapseSpans',
  'S19_timeGaps',
  'S20_rareCommandMatches',
  'S20_families',
  'S20_fires',
  'S21_authorizationDriftFires',
] as const satisfies ReadonlyArray<keyof EnsoEvalScorecard['signals']>

/** Fields `--row` emits, in order. One list, so the header and the rows cannot drift apart. */
export const ROW_FIELDS = [
  'entries',
  'humanMessages',
  'queuedMessages',
  'longestQueuedRun',
  'corrections',
  'confusionMessages',
  'interrupts',
  'assistantMessages',
  'assistantPerHuman',
  'toolCallsPerHuman',
  'writes',
  'writesPerHuman',
  'askCalls',
  'askRejected',
  'operatorDenials',
  'guardRefusals',
  'providerRefusals',
  'refusalsTotal',
  'gateRuns',
  'gatePassed',
  'gateFailed',
] as const satisfies ReadonlyArray<keyof EnsoEvalScorecard>

/** The keys the comparison table lines up, threads across. */
const COMPARISON_KEYS = [
  'humanMessages',
  'queuedMessages',
  'longestQueuedRun',
  'corrections',
  'confusionMessages',
  'interrupts',
  'assistantPerHuman',
  'toolCallsPerHuman',
  'writesPerHuman',
  'askCalls',
  'refusalsTotal',
  'gateRuns',
] as const satisfies ReadonlyArray<keyof EnsoEvalScorecard>

const KIND_GLYPHS: Readonly<Record<EvalEventKind, string>> = {
  human: '  ',
  'human-correction': '!!',
  'human-confusion': '? ',
  'prompt-queued': '><',
  interrupt: 'XX',
  'permission-mode': ' P',
  write: ' w',
  'ask-options': ' ?',
  'ask-answered': ' a',
  'ask-rejected': '!?',
  'tool-denied': '!D',
  'guard-refused': '!G',
  'provider-refused': '!R',
  commit: ' c',
  push: ' ^',
  'pr-create': 'PR',
  'pr-edit': 'pr',
  branch: ' b',
  gate: ' g',
  destructive: ' !',
  outward: 'MP',
}

/** A value as a table cell: `null` is `—` (unknown), a list is joined, the rest as is. */
function cell(value: string | number | boolean | readonly string[] | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ')
  return String(value)
}

function timelineLine(event: EnsoEvalEvent, friction: number, refusals: number): string {
  const stamp = event.at === undefined ? '  ·  ' : event.at.slice(11, 19)
  const index = event.index === undefined ? '  log' : String(event.index).padStart(5)
  const words = event.words === undefined ? '' : `(${event.words}w)`
  const outcome = event.outcome === undefined ? '' : ` [${event.outcome}]`
  const detail = event.detail.replace(/\s+/g, ' ').slice(0, 88)
  return `${stamp} [${index}] ${KIND_GLYPHS[event.kind]} f=${String(friction).padEnd(3)} r=${String(refusals).padEnd(3)} ${event.kind.padEnd(16)} ${words.padEnd(7)} ${detail}${outcome}`
}

/** The markdown for one thread: scorecard, signals, timeline. */
export function renderMarkdown(evaluated: EnsoSessionEval): string {
  const { scorecard } = evaluated
  const lines = [`## ${evaluated.threadId}${evaluated.live ? ' (live)' : ''}`, '']
  lines.push(
    scorecard.span === null
      ? `\`${scorecard.entries}\` entries`
      : `\`${scorecard.entries}\` entries · span \`${scorecard.span[0]}\` → \`${scorecard.span[1]}\``,
  )
  if (evaluated.logDays.length === 0) {
    lines.push('', '> No log day was read: queued prompts and interrupts are unknown, not zero.')
  }
  lines.push('', '### Scorecard', '', '| Metric | Value |', '|---|---|')
  for (const key of SCORECARD_KEYS) lines.push(`| \`${key}\` | ${cell(scorecard[key])} |`)
  lines.push(
    `| \`permissionModes\` | ${scorecard.permissionModes.length === 0 ? '—' : scorecard.permissionModes.join(' → ')} |`,
  )
  lines.push('', '### Agent-side signals (per kind, unweighted)', '', '| Signal | Value |', '|---|---|')
  for (const key of SIGNAL_KEYS) lines.push(`| \`${key}\` | ${cell(scorecard.signals[key])} |`)
  for (const fire of scorecard.signals.S21_events) {
    lines.push(
      `| \`S21\` at [${fire.eventIndex}] | ${fire.action} after [${fire.humanIndex}] "${fire.humanText.slice(0, 60)}" (${fire.unattendedRun} unattended assistant messages) |`,
    )
  }
  lines.push('', '### Dropped (no pi fact)', '')
  for (const dropped of scorecard.dropped) lines.push(`- ${dropped}`)
  lines.push('', '### Timeline', '', '```')
  for (const { event, friction, refusals } of runningCounters(evaluated.events)) {
    lines.push(timelineLine(event, friction, refusals))
  }
  lines.push('```', '')
  lines.push(
    '`f=` is cumulative friction — what the operator **types**: corrections, queued prompts, confusion, interrupts. `r=` is cumulative refusals — what the operator **clicks**: declined asks, denied prompts. Counted apart because they move at different times.',
  )
  return lines.join('\n')
}

/** One tab-separated row of `ROW_FIELDS`, the thread id first; `--row-header` prints the names. */
export function renderRow(evaluated: EnsoSessionEval): string {
  return [evaluated.threadId, ...ROW_FIELDS.map((key) => cell(evaluated.scorecard[key]))].join('\t')
}

export function renderRowHeader(): string {
  return ['threadId', ...ROW_FIELDS].join('\t')
}

/** The comparison table across several threads: one metric per row, one column per thread. */
export function renderComparison(evaluated: readonly EnsoSessionEval[]): string {
  const lines = [
    '## Comparison',
    '',
    `| Metric | ${evaluated.map((item) => `\`${item.threadId.slice(0, 8)}\``).join(' | ')} |`,
  ]
  lines.push(`|---${'|---'.repeat(evaluated.length)}|`)
  for (const key of COMPARISON_KEYS) {
    lines.push(`| \`${key}\` | ${evaluated.map((item) => cell(item.scorecard[key])).join(' | ')} |`)
  }
  return lines.join('\n')
}

async function fetchEval(serverUrl: string, threadId: string): Promise<EnsoSessionEval> {
  const url = new URL(`/api/threads/${encodeURIComponent(threadId)}/eval`, serverUrl)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url.href} answered ${response.status}: ${await response.text()}`)
  const payload = readEnsoSessionEval(await response.json())
  if (payload === undefined) throw new Error(`${url.href}: the payload did not match EnsoSessionEval`)
  return payload
}

async function main(argv: readonly string[]): Promise<void> {
  let query: EvalQuery
  try {
    query = parseArguments(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`enso-eval: ${error.message}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (query.rowHeader) {
    process.stdout.write(`${renderRowHeader()}\n`)
    if (query.threads.length === 0) return
  }
  const serverUrl = process.env.ENSO_SERVER_URL ?? 'http://127.0.0.1:5179'
  let evaluated: EnsoSessionEval[]
  try {
    evaluated = await Promise.all(query.threads.map((threadId) => fetchEval(serverUrl, threadId)))
  } catch (error) {
    process.stderr.write(`enso-eval: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  if (query.json) {
    process.stdout.write(`${JSON.stringify(evaluated.length === 1 ? evaluated[0] : evaluated, null, 2)}\n`)
    return
  }
  if (query.row) {
    process.stdout.write(`${evaluated.map(renderRow).join('\n')}\n`)
    return
  }
  process.stdout.write(`${evaluated.map(renderMarkdown).join('\n\n')}\n`)
  if (evaluated.length > 1) process.stdout.write(`\n${renderComparison(evaluated)}\n`)
}

if (import.meta.main) await main(process.argv.slice(2))
